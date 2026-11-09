/**
 * RESTOPRO — Tenant Resolution & Scoping Service
 * Enforces strict multi-tenant isolation across all restaurant operations.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { isCentralPhoneNumberId, isCentralSenderPhone, isRestaurantPhoneNumber } = require('./central-whatsapp.service');

/**
 * Resolves a restaurant tenant using Meta's incoming recipient phone_number_id.
 * NEVER identifies a tenant using the customer's phone number.
 *
 * @param {string} phoneNumberId - Meta incoming metadata.phone_number_id
 * @returns {Promise<Object|null>} - Active restaurant tenant record or null
 */
async function resolveTenantByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId || typeof phoneNumberId !== 'string') {
    logger.warn('Tenant resolution rejected: missing or invalid phone_number_id', { phoneNumberId });
    return null;
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { phone_number_id: phoneNumberId.trim() }
  });

  if (!restaurant) {
    logger.warn('Tenant resolution failed: no restaurant matched phone_number_id', { phoneNumberId });
    return null;
  }

  if (!restaurant.is_active) {
    logger.warn('Tenant resolution rejected: restaurant is inactive', {
      restaurantId: restaurant.id,
      name: restaurant.name
    });
    return null;
  }

  return restaurant;
}

/**
 * Enforces mandatory restaurant_id scoping on any tenant-owned database query.
 * Guarantees zero cross-tenant query execution.
 *
 * @param {string} restaurantId - Verified UUID of the restaurant tenant
 * @param {Object} queryFilter - User query filter
 * @returns {Object} - Strictly scoped query filter
 */
function scopeQuery(restaurantId, queryFilter = {}) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[TENANT VIOLATION] Query execution blocked: missing mandatory restaurant_id');
  }

  return {
    ...queryFilter,
    restaurant_id: restaurantId
  };
}

/**
 * Tenant-scoped order lookup. Guarantees Tenant A cannot read Tenant B's order.
 */
async function findTenantOrder(restaurantId, orderId) {
  return prisma.order.findFirst({
    where: scopeQuery(restaurantId, { id: orderId })
  });
}

/**
 * Tenant-scoped customer conversation session lookup.
 */
async function findTenantSession(restaurantId, customerPhone) {
  return prisma.conversationSession.findUnique({
    where: {
      restaurant_id_customer_phone: {
        restaurant_id: restaurantId,
        customer_phone: customerPhone
      }
    }
  });
}

/**
 * Tenant-scoped saved address list lookup.
 */
async function findTenantAddresses(restaurantId, customerPhone) {
  return prisma.savedAddress.findMany({
    where: scopeQuery(restaurantId, { customer_phone: customerPhone })
  });
}

module.exports = {
  resolveTenantByPhoneNumberId,
  isCentralPhoneNumberId,
  isCentralSenderPhone,
  isRestaurantPhoneNumber,
  scopeQuery,
  findTenantOrder,
  findTenantSession,
  findTenantAddresses
};

