/**
 * RESTOPRO — Restaurant Catalogue Synchronization Controller
 * Exposes internal endpoints for the WhatsApp Web Browser Companion.
 * Enforces strict multi-tenant authentication and authorization.
 */
const {
  syncRestaurantCatalog,
  getRestaurantSyncedCatalog,
  deleteCatalogProduct
} = require('../services/catalog-sync.service');
const { generateRestaurantSyncToken, verifyRestaurantSyncToken } = require('../utils/sync-auth');
const { validateSession } = require('../services/admin-auth.service');
const { parseInternalNotes } = require('../services/admin-restaurant.service');
const prisma = require('../config/database');
const logger = require('../utils/logger');

/**
 * Extracts and verifies tenant authentication credentials from incoming HTTP request.
 * Supports both Restaurant Sync Token and Super Admin session tokens.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{isAuthorized: boolean, restaurantId?: string, error?: string, statusCode?: number}>}
 */
async function authenticateSyncRequest(req) {
  // 1. Identify Target Restaurant ID
  const rawRestaurantId = req.headers['x-restaurant-id'] ||
    req.headers['x-tenant-id'] ||
    req.query.restaurantId ||
    req.body?.restaurantId;

  if (!rawRestaurantId || typeof rawRestaurantId !== 'string') {
    return {
      isAuthorized: false,
      statusCode: 400,
      error: 'Missing required header: X-Restaurant-Id'
    };
  }

  const restaurantId = rawRestaurantId.trim();

  // Basic UUID format check
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(restaurantId)) {
    return {
      isAuthorized: false,
      statusCode: 400,
      error: 'Invalid restaurant ID format (must be UUID)'
    };
  }

  // 2. Extract credential token
  let candidateToken = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      candidateToken = parts[1].trim();
    }
  }

  if (!candidateToken) {
    candidateToken = req.headers['x-sync-key'] ||
      req.headers['x-sync-token'] ||
      req.headers['x-admin-token'] ||
      req.query.syncKey;
  }

  if (!candidateToken || typeof candidateToken !== 'string') {
    return {
      isAuthorized: false,
      statusCode: 401,
      error: 'Unauthorized: Sync authentication token required (X-Sync-Key or Authorization header)'
    };
  }

  const tokenStr = candidateToken.trim();

  // 3. Check if token is a valid Super Admin session
  try {
    const adminSession = await validateSession(tokenStr);
    if (adminSession && adminSession.user) {
      return {
        isAuthorized: true,
        restaurantId,
        isAdmin: true,
        adminUser: adminSession.user
      };
    }
  } catch (_) {}

  // 4. Validate as Restaurant Sync Token
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId }
  });

  if (!restaurant || restaurant.is_platform_account) {
    return {
      isAuthorized: false,
      statusCode: 404,
      error: `Restaurant with ID "${restaurantId}" not found`
    };
  }

  if (!restaurant.is_active || restaurant.tenant_status !== 'ACTIVE') {
    return {
      isAuthorized: false,
      statusCode: 403,
      error: `Restaurant "${restaurant.name}" is not active or suspended`
    };
  }

  let customToken = null;
  if (restaurant.internal_notes) {
    const parsed = parseInternalNotes(restaurant.internal_notes);
    if (parsed.menuCatalog?.syncToken) {
      customToken = parsed.menuCatalog.syncToken;
    }
  }

  const isValidSyncToken = verifyRestaurantSyncToken(restaurantId, tokenStr, customToken);
  if (!isValidSyncToken) {
    logger.warn('Catalogue sync authentication rejected for tenant', {
      restaurantId,
      restaurantName: restaurant.name
    });
    return {
      isAuthorized: false,
      statusCode: 401,
      error: 'Unauthorized: Invalid restaurant sync key'
    };
  }

  return {
    isAuthorized: true,
    restaurantId,
    restaurant
  };
}

/**
 * POST /api/catalog/sync
 * Receives catalogue items extracted by the browser companion and updates the menu catalog.
 */
async function handleSyncCatalog(req, res) {
  try {
    const auth = await authenticateSyncRequest(req);
    if (!auth.isAuthorized) {
      return res.status(auth.statusCode || 401).json({ error: auth.error });
    }

    const { products, mode = 'MERGE', syncSource = 'BROWSER_COMPANION' } = req.body;

    if (!Array.isArray(products)) {
      return res.status(400).json({ error: 'Body field "products" must be an array of catalogue items' });
    }

    const result = await syncRestaurantCatalog({
      restaurantId: auth.restaurantId,
      products,
      mode: mode === 'REPLACE' ? 'REPLACE' : 'MERGE',
      syncSource
    });

    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error in handleSyncCatalog', { error: err.message, stack: err.stack });
      return res.status(500).json({ error: 'Internal server error during catalogue sync' });
    }
    return res.status(status).json({ error: err.message });
  }
}

/**
 * GET /api/catalog/sync
 * Returns the currently synchronized catalogue and connection status for the authenticated restaurant.
 */
async function handleGetCatalog(req, res) {
  try {
    const auth = await authenticateSyncRequest(req);
    if (!auth.isAuthorized) {
      return res.status(auth.statusCode || 401).json({ error: auth.error });
    }

    const result = await getRestaurantSyncedCatalog(auth.restaurantId);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error in handleGetCatalog', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

/**
 * DELETE /api/catalog/sync/:retailerId
 * Removes an individual product from the restaurant's catalogue.
 */
async function handleDeleteProduct(req, res) {
  try {
    const auth = await authenticateSyncRequest(req);
    if (!auth.isAuthorized) {
      return res.status(auth.statusCode || 401).json({ error: auth.error });
    }

    const { retailerId } = req.params;
    if (!retailerId) {
      return res.status(400).json({ error: 'Missing retailerId parameter in URL' });
    }

    const result = await deleteCatalogProduct(auth.restaurantId, retailerId);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error in handleDeleteProduct', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

/**
 * GET /api/admin/restaurants/:id/sync-token
 * Returns the authoritative sync token and instructions for a specific restaurant.
 * Strictly requires Super Admin session.
 */
async function handleGetRestaurantSyncToken(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Valid restaurant ID is required' });
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id }
    });

    if (!restaurant || restaurant.is_platform_account) {
      return res.status(404).json({ error: `Restaurant with ID "${id}" not found` });
    }

    const syncToken = generateRestaurantSyncToken(restaurant.id);

    return res.status(200).json({
      success: true,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      syncToken,
      syncEndpoint: '/api/catalog/sync',
      documentation: 'Configure this token and Restaurant ID in the RestPro WhatsApp Web Companion extension.'
    });
  } catch (err) {
    logger.error('Error generating restaurant sync token', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  handleSyncCatalog,
  handleGetCatalog,
  handleDeleteProduct,
  handleGetRestaurantSyncToken,
  authenticateSyncRequest
};
