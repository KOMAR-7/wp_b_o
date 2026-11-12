/**
 * RESTOPRO — Restaurant Catalogue Synchronization Service
 * Handles browser companion catalogue ingestion, validation, metadata persistence,
 * cache updates, and strict tenant isolation.
 *
 * Persists data inside Restaurant.internal_notes metadata (<!--RESTOPRO_METADATA:{"menuCatalog":...}-->)
 * without requiring any database schema changes or migrations.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { parseInternalNotes, formatInternalNotes } = require('./admin-restaurant.service');
const {
  setCachedProduct,
  evictCachedProduct,
  evictTenantCatalogCache,
  clearCatalogCache
} = require('./catalog.service');
const { generateRestaurantSyncToken, verifyRestaurantSyncToken } = require('../utils/sync-auth');

/**
 * Validates a single incoming catalogue product item.
 *
 * @param {Object} item
 * @param {number} index
 * @returns {{isValid: boolean, error?: string, product?: Object}}
 */
function validateCatalogProduct(item, index) {
  if (!item || typeof item !== 'object') {
    return { isValid: false, error: `Item at index ${index} must be an object` };
  }

  const retailerId = typeof item.productRetailerId === 'string'
    ? item.productRetailerId.trim()
    : (typeof item.retailer_id === 'string'
      ? item.retailer_id.trim()
      : (typeof item.id === 'string' ? item.id.trim() : ''));

  if (!retailerId) {
    return { isValid: false, error: `Item at index ${index} is missing productRetailerId` };
  }

  const name = typeof item.name === 'string'
    ? item.name.trim()
    : (typeof item.title === 'string' ? item.title.trim() : '');

  if (!name) {
    return { isValid: false, error: `Item "${retailerId}" is missing product name` };
  }

  // Reject echoing retailer ID or generic placeholder
  if (
    name.toLowerCase() === retailerId.toLowerCase() ||
    name.toLowerCase().startsWith('item (') ||
    name.toLowerCase() === 'item'
  ) {
    return { isValid: false, error: `Item "${retailerId}" has invalid or placeholder product name "${name}"` };
  }

  let price = undefined;
  if (item.price !== undefined && item.price !== null && item.price !== '') {
    const parsedPrice = typeof item.price === 'number' ? item.price : parseFloat(item.price);
    if (!isNaN(parsedPrice) && isFinite(parsedPrice) && parsedPrice >= 0) {
      price = parsedPrice;
    }
  }

  let currency = undefined;
  if (typeof item.currency === 'string' && item.currency.trim()) {
    const cur = item.currency.trim().toUpperCase();
    if (cur.length === 3) currency = cur;
  }

  const description = typeof item.description === 'string' && item.description.trim()
    ? item.description.trim().slice(0, 1000)
    : undefined;

  return {
    isValid: true,
    product: {
      productRetailerId: retailerId,
      name,
      price,
      currency,
      description
    }
  };
}

/**
 * Synchronizes catalogue items for a specific restaurant.
 * Updates the restaurant's internal_notes metadata without changing database schema.
 * Refreshes in-memory cache for immediate query resolution.
 *
 * @param {Object} params
 * @param {string} params.restaurantId - Restaurant UUID
 * @param {Array<Object>} params.products - Array of extracted catalogue products
 * @param {'MERGE'|'REPLACE'} [params.mode='MERGE'] - Whether to merge or replace existing catalogue
 * @param {string} [params.syncSource='BROWSER_COMPANION'] - Source identifier
 * @returns {Promise<{success: boolean, restaurantId: string, syncedCount: number, totalCatalogCount: number, catalog: Object, syncedAt: string}>}
 */
async function syncRestaurantCatalog({
  restaurantId,
  products,
  mode = 'MERGE',
  syncSource = 'BROWSER_COMPANION'
}) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    const err = new Error('Valid restaurant ID is required');
    err.statusCode = 400;
    throw err;
  }

  if (!Array.isArray(products)) {
    const err = new Error('Products payload must be an array of catalogue items');
    err.statusCode = 400;
    throw err;
  }

  // 1. Fetch target restaurant
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId }
  });

  if (!restaurant || restaurant.is_platform_account) {
    const err = new Error(`Restaurant with ID "${restaurantId}" not found`);
    err.statusCode = 404;
    throw err;
  }

  if (!restaurant.is_active || restaurant.tenant_status !== 'ACTIVE') {
    const err = new Error(`Restaurant "${restaurant.name}" is not active or suspended`);
    err.statusCode = 403;
    throw err;
  }

  // 2. Validate all incoming products
  const validProducts = [];
  const errors = [];

  for (let i = 0; i < products.length; i++) {
    const res = validateCatalogProduct(products[i], i);
    if (res.isValid) {
      validProducts.push(res.product);
    } else {
      errors.push(res.error);
    }
  }

  if (products.length > 0 && validProducts.length === 0) {
    const err = new Error(`No valid products found in payload: ${errors.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  // 3. Parse existing metadata
  const existingNotes = restaurant.internal_notes || '';
  const parsed = parseInternalNotes(existingNotes);

  const menuCatalog = (mode === 'REPLACE' || !parsed.menuCatalog)
    ? {}
    : { ...parsed.menuCatalog };

  const now = new Date().toISOString();

  // 4. Update / Merge items
  for (const item of validProducts) {
    menuCatalog[item.productRetailerId] = {
      name: item.name,
      price: item.price !== undefined ? item.price : menuCatalog[item.productRetailerId]?.price,
      currency: item.currency || menuCatalog[item.productRetailerId]?.currency || 'INR',
      description: item.description !== undefined ? item.description : menuCatalog[item.productRetailerId]?.description,
      source: syncSource,
      updatedAt: now
    };
  }

  // 5. Serialize and persist into Restaurant.internal_notes
  const updatedInternalNotes = formatInternalNotes(parsed.textNotes, parsed.ownerConsent, menuCatalog);

  await prisma.restaurant.update({
    where: { id: restaurantId },
    data: {
      internal_notes: updatedInternalNotes
    }
  });

  // 6. Update in-memory TTL cache immediately
  if (mode === 'REPLACE') {
    evictTenantCatalogCache(restaurantId);
  }
  for (const item of validProducts) {
    setCachedProduct(restaurantId, item.productRetailerId, {
      name: item.name,
      price: item.price,
      currency: item.currency || 'INR',
      source: 'BROWSER_COMPANION_SYNC'
    });
  }

  logger.info('Catalogue products successfully synchronized', {
    restaurantId,
    restaurantName: restaurant.name,
    mode,
    syncedCount: validProducts.length,
    totalCatalogCount: Object.keys(menuCatalog).length,
    syncSource
  });

  return {
    success: true,
    restaurantId,
    restaurantName: restaurant.name,
    mode,
    syncedCount: validProducts.length,
    totalCatalogCount: Object.keys(menuCatalog).length,
    catalog: menuCatalog,
    syncedAt: now
  };
}

/**
 * Retrieves the current synchronized catalogue for a restaurant.
 *
 * @param {string} restaurantId
 * @returns {Promise<Object>}
 */
async function getRestaurantSyncedCatalog(restaurantId) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    const err = new Error('Valid restaurant ID is required');
    err.statusCode = 400;
    throw err;
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId }
  });

  if (!restaurant || restaurant.is_platform_account) {
    const err = new Error(`Restaurant with ID "${restaurantId}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const parsed = parseInternalNotes(restaurant.internal_notes);
  const menuCatalog = parsed.menuCatalog || {};

  return {
    success: true,
    restaurantId,
    restaurantName: restaurant.name,
    totalCatalogCount: Object.keys(menuCatalog).length,
    catalog: menuCatalog
  };
}

/**
 * Removes a specific product from a restaurant's catalogue.
 *
 * @param {string} restaurantId
 * @param {string} productRetailerId
 * @returns {Promise<Object>}
 */
async function deleteCatalogProduct(restaurantId, productRetailerId) {
  if (!restaurantId || !productRetailerId) {
    const err = new Error('Valid restaurant ID and productRetailerId are required');
    err.statusCode = 400;
    throw err;
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId }
  });

  if (!restaurant) {
    const err = new Error(`Restaurant with ID "${restaurantId}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const parsed = parseInternalNotes(restaurant.internal_notes);
  const menuCatalog = { ...(parsed.menuCatalog || {}) };

  const trimmedId = productRetailerId.trim();
  const existed = Boolean(menuCatalog[trimmedId]);
  delete menuCatalog[trimmedId];

  // Evict from in-memory cache
  evictCachedProduct(restaurantId, trimmedId);

  const updatedNotes = formatInternalNotes(parsed.textNotes, parsed.ownerConsent, menuCatalog);

  await prisma.restaurant.update({
    where: { id: restaurantId },
    data: { internal_notes: updatedNotes }
  });

  return {
    success: true,
    restaurantId,
    productRetailerId: trimmedId,
    deleted: existed,
    totalCatalogCount: Object.keys(menuCatalog).length
  };
}

module.exports = {
  validateCatalogProduct,
  syncRestaurantCatalog,
  getRestaurantSyncedCatalog,
  deleteCatalogProduct
};
