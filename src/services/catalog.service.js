/**
 * RESTOPRO — WhatsApp Catalogue & Menu Resolution Service
 * R6.3 & Issue 1: Menu Item Mapping & Catalogue Resolution Engine
 *
 * Resolves incoming WhatsApp catalogue product selections to genuine menu item names.
 * Ensures orders, owner alerts, and customer summaries never display raw SKUs, retailer IDs,
 * generic fallbacks, or incorrect properties.
 *
 * Resolution Priority:
 * 1. Direct Payload Attributes (name, title, product_name) if non-empty and distinct from SKU
 * 2. In-Memory Tenant TTL Cache (cached from previous lookups or API sync)
 * 3. Dynamic In-Memory Tenant Overrides (runtime/test fixtures)
 * 4. Restaurant Metadata Catalogue (Restaurant.internal_notes -> menuCatalog)
 * 5. Meta Graph API Catalogue Lookup (GET /{catalog_id}/products with token, cached for 24h)
 * 6. Registered / Built-In Catalogue Mapping (tenant-scoped or global known SKUs)
 * 7. Missing/Unmatched Detection (safely flagged with clear fallback, logged, never silently echoes raw SKU)
 */
const axios = require('axios');
const { parseInternalNotes } = require('./admin-restaurant.service');
const logger = require('../utils/logger');
const config = require('../config/env');

// Built-in registry of known restaurant catalogue items
// Pre-configured for known production and test tenant SKUs
const BUILT_IN_CATALOG_REGISTRY = {
  // RestPro Production Catalogue (WABA 1620323530136933, Phone 1427497060448125)
  'sezp6n6uee': {
    name: 'Chicken Dum Biryani (Special)',
    price: 800,
    category: 'Main Course'
  }
};

// Dynamic in-memory catalogue overrides (useful for testing or runtime updates)
const dynamicTenantCatalogs = new Map();

// In-memory TTL cache for resolved catalogue items
// Key: `${restaurantId || 'global'}:${productRetailerId}`
// Value: { name: string, price?: number, source: string, cachedAt: number }
const tenantCatalogCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours TTL

/**
 * Retrieves a cached product entry if not expired.
 *
 * @param {string} [restaurantId='global']
 * @param {string} productRetailerId
 * @returns {{name: string, price?: number, source: string}|null}
 */
function getCachedProduct(restaurantId = 'global', productRetailerId = '') {
  if (!productRetailerId) return null;
  const key = `${restaurantId || 'global'}:${productRetailerId.trim()}`;
  const entry = tenantCatalogCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    tenantCatalogCache.delete(key);
    return null;
  }
  return { name: entry.name, price: entry.price, source: entry.source };
}

/**
 * Stores a resolved product entry in cache.
 *
 * @param {string} [restaurantId='global']
 * @param {string} productRetailerId
 * @param {{name: string, price?: number, source?: string}} data
 */
function setCachedProduct(restaurantId = 'global', productRetailerId = '', data = {}) {
  if (!productRetailerId || !data.name) return;
  const key = `${restaurantId || 'global'}:${productRetailerId.trim()}`;
  tenantCatalogCache.set(key, {
    name: data.name.trim(),
    price: typeof data.price === 'number' ? data.price : undefined,
    source: data.source || 'CACHE',
    cachedAt: Date.now()
  });
}

/**
 * Clears the in-memory catalogue cache.
 */
function clearCatalogCache() {
  tenantCatalogCache.clear();
}

/**
 * Registers custom catalogue items for a specific restaurant or globally.
 *
 * @param {string} [restaurantId='global']
 * @param {Object.<string, {name: string, price?: number}>} items
 */
function registerTenantCatalog(restaurantId = 'global', items = {}) {
  const existing = dynamicTenantCatalogs.get(restaurantId) || {};
  dynamicTenantCatalogs.set(restaurantId, { ...existing, ...items });
}

/**
 * Clears all dynamic tenant catalogues (primarily for isolated test fixtures).
 */
function clearDynamicCatalogs() {
  dynamicTenantCatalogs.clear();
}

/**
 * Resolves the genuine menu item name synchronously for a given product_retailer_id.
 *
 * @param {Object} params
 * @param {string} [params.restaurantId] - Restaurant UUID
 * @param {string} [params.catalogId] - Meta catalog ID
 * @param {string} params.productRetailerId - Product SKU / retailer ID
 * @param {Object} [params.rawItem] - Raw item object from WhatsApp order payload
 * @param {string} [params.internalNotes] - Restaurant internal_notes string
 * @param {boolean} [params.fallbackIfUnresolved=false] - Whether to assign fallback name if unresolvable
 * @returns {{name: string|null, isResolved: boolean, source: string, productRetailerId: string}}
 */
function resolveMenuItemName({
  restaurantId = null,
  catalogId = null,
  productRetailerId,
  rawItem = null,
  internalNotes = null,
  fallbackIfUnresolved = false
}) {
  const retailerId = typeof productRetailerId === 'string' ? productRetailerId.trim() : '';

  if (!retailerId) {
    return {
      name: null,
      isResolved: false,
      source: 'EMPTY_SKU',
      productRetailerId: ''
    };
  }

  // 1. Direct Payload Attributes (item.name, item.title, item.product_name, item.productName)
  if (rawItem && typeof rawItem === 'object') {
    const candidateName = rawItem.name || rawItem.title || rawItem.product_name || rawItem.productName;
    if (typeof candidateName === 'string') {
      const trimmed = candidateName.trim();
      // Ensure candidate name is non-empty and not just echoing the raw SKU / product ID
      if (trimmed.length > 0 && trimmed.toLowerCase() !== retailerId.toLowerCase()) {
        return {
          name: trimmed,
          isResolved: true,
          source: 'PAYLOAD',
          productRetailerId: retailerId
        };
      }
    }
  }

  // 2. In-memory TTL Cache (tenant-scoped or global)
  const cached = getCachedProduct(restaurantId, retailerId) || getCachedProduct('global', retailerId);
  if (cached && cached.name) {
    return {
      name: cached.name,
      isResolved: true,
      source: cached.source || 'CACHE',
      productRetailerId: retailerId
    };
  }

  // 3. Dynamic in-memory tenant overrides (if set)
  if (restaurantId && dynamicTenantCatalogs.has(restaurantId)) {
    const tenantMap = dynamicTenantCatalogs.get(restaurantId);
    if (tenantMap && tenantMap[retailerId]) {
      const entry = tenantMap[retailerId];
      const name = typeof entry === 'string' ? entry : entry.name;
      if (typeof name === 'string' && name.trim()) {
        return {
          name: name.trim(),
          isResolved: true,
          source: 'DYNAMIC_TENANT_CATALOG',
          productRetailerId: retailerId
        };
      }
    }
  }

  if (dynamicTenantCatalogs.has('global')) {
    const globalMap = dynamicTenantCatalogs.get('global');
    if (globalMap && globalMap[retailerId]) {
      const entry = globalMap[retailerId];
      const name = typeof entry === 'string' ? entry : entry.name;
      if (typeof name === 'string' && name.trim()) {
        return {
          name: name.trim(),
          isResolved: true,
          source: 'DYNAMIC_GLOBAL_CATALOG',
          productRetailerId: retailerId
        };
      }
    }
  }

  // 4. Restaurant Metadata Catalogue from internal_notes
  if (internalNotes && typeof internalNotes === 'string') {
    try {
      const parsed = parseInternalNotes(internalNotes);
      const menuCatalog = parsed.menuCatalog || parsed.catalog || null;
      if (menuCatalog && typeof menuCatalog === 'object') {
        const entry = menuCatalog[retailerId];
        if (entry) {
          const name = typeof entry === 'string' ? entry : entry.name;
          if (typeof name === 'string' && name.trim()) {
            return {
              name: name.trim(),
              isResolved: true,
              source: 'TENANT_METADATA',
              productRetailerId: retailerId
            };
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to parse restaurant internal_notes for menuCatalog', {
        error: err.message,
        restaurantId
      });
    }
  }

  // 5. Built-in registry of known SKUs
  if (BUILT_IN_CATALOG_REGISTRY[retailerId]) {
    const entry = BUILT_IN_CATALOG_REGISTRY[retailerId];
    return {
      name: entry.name,
      isResolved: true,
      source: 'BUILT_IN_REGISTRY',
      productRetailerId: retailerId
    };
  }

  // 6. Missing / Unmatched Catalogue ID
  if (fallbackIfUnresolved) {
    const fallbackName = `Item (${retailerId})`;
    logger.warn('Catalogue product retailer ID could not be resolved to a human-readable product name; using fallback', {
      restaurantId,
      catalogId,
      productRetailerId: retailerId,
      fallbackName
    });
    return {
      name: fallbackName,
      isResolved: false,
      source: 'FALLBACK_UNRESOLVED',
      productRetailerId: retailerId
    };
  }

  return {
    name: null,
    isResolved: false,
    source: 'UNMATCHED',
    productRetailerId: retailerId
  };
}

/**
 * Queries Meta Graph API to fetch product details from a catalogue.
 * GET https://graph.facebook.com/v21.0/{catalog_id}/products?filter={"retailer_id":{"eq":"..."}}
 *
 * @param {Object} params
 * @param {string} [params.restaurantId]
 * @param {string} params.catalogId
 * @param {string} params.productRetailerId
 * @param {string} params.accessToken
 * @returns {Promise<{name: string, price?: number, source: string}|null>}
 */
async function fetchMetaCatalogProduct({
  restaurantId = null,
  catalogId,
  productRetailerId,
  accessToken
}) {
  if (!catalogId || !productRetailerId || !accessToken) return null;
  if (accessToken.startsWith('mock_')) return null;

  const graphVersion = config.meta?.apiVersion || 'v21.0';
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(catalogId)}/products`;

  try {
    const res = await axios.get(url, {
      params: {
        filter: JSON.stringify({ retailer_id: { eq: productRetailerId } }),
        fields: 'id,retailer_id,name,price,currency'
      },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 3000
    });

    const items = res.data?.data;
    if (Array.isArray(items) && items.length > 0) {
      const match = items[0];
      if (match && typeof match.name === 'string' && match.name.trim()) {
        const resolvedName = match.name.trim();
        if (resolvedName.toLowerCase() !== productRetailerId.toLowerCase()) {
          return {
            name: resolvedName,
            price: match.price ? parseFloat(match.price) : undefined,
            source: 'META_CATALOG_API'
          };
        }
      }
    }
    return null;
  } catch (err) {
    logger.debug('Meta Catalog API product query failed or unauthorized', {
      restaurantId,
      catalogId,
      productRetailerId,
      error: err.response?.data?.error?.message || err.message
    });
    return null;
  }
}

/**
 * Asynchronously resolves product details using local sources, cache, and Meta Graph API fallback.
 *
 * @param {Object} params
 * @param {string} [params.restaurantId]
 * @param {string} [params.catalogId]
 * @param {string} params.productRetailerId
 * @param {Object} [params.rawItem]
 * @param {string} [params.internalNotes]
 * @param {string} [params.accessToken]
 * @returns {Promise<{name: string, isResolved: boolean, source: string, productRetailerId: string}>}
 */
async function resolveMenuItemNameAsync({
  restaurantId = null,
  catalogId = null,
  productRetailerId,
  rawItem = null,
  internalNotes = null,
  accessToken = null
}) {
  // 1. Try synchronous resolution first (payload, cache, dynamic tenant, metadata, built-in)
  const syncResult = resolveMenuItemName({
    restaurantId,
    catalogId,
    productRetailerId,
    rawItem,
    internalNotes,
    fallbackIfUnresolved: false
  });

  if (syncResult && syncResult.isResolved) {
    return syncResult;
  }

  const retailerId = typeof productRetailerId === 'string' ? productRetailerId.trim() : '';
  if (!retailerId) {
    return {
      name: null,
      isResolved: false,
      source: 'EMPTY_SKU',
      productRetailerId: ''
    };
  }

  // 2. If Meta API credentials and catalog ID are present, attempt live query
  if (catalogId && accessToken) {
    const apiResult = await fetchMetaCatalogProduct({
      restaurantId,
      catalogId,
      productRetailerId: retailerId,
      accessToken
    });

    if (apiResult && apiResult.name) {
      // Cache for this tenant
      setCachedProduct(restaurantId, retailerId, {
        name: apiResult.name,
        price: apiResult.price,
        source: 'META_CATALOG_API'
      });

      return {
        name: apiResult.name,
        isResolved: true,
        source: 'META_CATALOG_API',
        productRetailerId: retailerId
      };
    }
  }

  // 3. Fallback when unresolvable: Never display raw SKU as if it were a valid product name
  const fallbackName = `Item (${retailerId})`;
  logger.warn('Catalogue product retailer ID could not be resolved to a human-readable product name; using fallback', {
    restaurantId,
    catalogId,
    productRetailerId: retailerId,
    fallbackName
  });

  return {
    name: fallbackName,
    isResolved: false,
    source: 'FALLBACK_UNRESOLVED',
    productRetailerId: retailerId
  };
}

/**
 * Returns the resolved catalogue map for a restaurant.
 *
 * @param {string} [restaurantId]
 * @param {string} [internalNotes]
 * @returns {Object.<string, {name: string, price?: number}>}
 */
function getRestaurantCatalog(restaurantId = null, internalNotes = null) {
  const combined = { ...BUILT_IN_CATALOG_REGISTRY };

  if (internalNotes) {
    try {
      const parsed = parseInternalNotes(internalNotes);
      if (parsed.menuCatalog && typeof parsed.menuCatalog === 'object') {
        Object.assign(combined, parsed.menuCatalog);
      }
    } catch (_) {}
  }

  if (restaurantId && dynamicTenantCatalogs.has(restaurantId)) {
    Object.assign(combined, dynamicTenantCatalogs.get(restaurantId));
  }

  return combined;
}

module.exports = {
  resolveMenuItemName,
  resolveMenuItemNameAsync,
  fetchMetaCatalogProduct,
  getCachedProduct,
  setCachedProduct,
  clearCatalogCache,
  getRestaurantCatalog,
  registerTenantCatalog,
  clearDynamicCatalogs,
  BUILT_IN_CATALOG_REGISTRY
};
