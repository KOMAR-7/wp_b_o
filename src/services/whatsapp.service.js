/**
 * RESTOPRO — Meta WhatsApp Cloud API Integration Service
 * Stage 5.1: Restaurant-Scoped Credential Resolution & Message Dispatch
 *
 * Implements:
 * - Dynamic restaurant credential resolution
 * - WhatsApp Cloud API message formatting for owner alerts
 * - Secure HTTP dispatch via axios with timeouts and token redaction
 * - Error classification (Timeout / 4xx non-retryable / 5xx retryable)
 */
const axios = require('axios');
const prisma = require('../config/database');
const config = require('../config/env');
const logger = require('../utils/logger');
const { decryptToken } = require('../utils/crypto');

const META_GRAPH_VERSION = 'v21.0';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Builds the Meta interactive button payload for owner order notifications.
 *
 * @param {Object} params
 * @param {string} params.ownerPhone - Owner WhatsApp phone number
 * @param {Object} params.order - Created order record
 * @param {string} [params.restaurantName] - Commercial restaurant name
 * @returns {Object} WhatsApp Cloud API payload
 */
function buildOwnerNotificationPayload({ ownerPhone, order, restaurantName = '' }) {
  if (!ownerPhone || typeof ownerPhone !== 'string') {
    throw new Error('[WHATSAPP PAYLOAD ERROR] Missing ownerPhone.');
  }

  if (!order || !order.order_reference) {
    throw new Error('[WHATSAPP PAYLOAD ERROR] Missing valid order object.');
  }

  // Normalize recipient phone to clean digits (e.g. "+91 987..." -> "91987...")
  const cleanPhone = ownerPhone.replace(/[^\d]/g, '');

  const items = Array.isArray(order.items) ? order.items : [];
  const currencySymbol = order.currency === 'INR' ? '₹' : `${order.currency} `;

  let bodyText = `🔔 *NEW ORDER: #${order.order_reference}*\n`;
  bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
  bodyText += `👤 *Customer:* ${order.customer_name || 'Customer'} (${order.customer_phone})\n`;
  bodyText += `🥡 *Fulfilment:* ${order.order_type === 'DELIVERY' ? '🚚 Delivery' : '🥡 Takeaway (Self-Pickup)'}\n`;

  if (order.order_type === 'DELIVERY' && order.address_snapshot) {
    bodyText += `📍 *Address:* ${order.address_snapshot}\n`;
  }

  bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
  bodyText += '*Items:*\n';
  for (const item of items) {
    const unitPrice = typeof item.unitPrice === 'number' ? item.unitPrice.toFixed(2) : item.unitPrice;
    bodyText += `• ${item.quantity}x ${item.productName || item.productRetailerId} @ ${currencySymbol}${unitPrice}\n`;
  }

  const total = typeof order.total_amount === 'object' && order.total_amount !== null
    ? Number(order.total_amount).toFixed(2)
    : Number(order.total_amount || 0).toFixed(2);

  bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
  bodyText += `*Total Amount:* ${currencySymbol}${total}\n`;
  bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
  bodyText += 'Please accept or reject this order within 30 minutes.';

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: {
        type: 'text',
        text: '🔔 NEW ORDER RECEIVED'
      },
      body: {
        text: bodyText
      },
      footer: {
        text: restaurantName ? `RESTOPRO • ${restaurantName}` : 'RESTOPRO Order Alert'
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: `OWNER_ACCEPT:${order.id}`,
              title: '✅ Accept Order'
            }
          },
          {
            type: 'reply',
            reply: {
              id: `OWNER_REJECT:${order.id}`,
              title: '❌ Reject Order'
            }
          }
        ]
      }
    }
  };
}

/**
 * Builds the Meta WhatsApp Cloud API payload for customer order decision notifications.
 *
 * @param {Object} params
 * @param {Object} params.order - Persisted order record
 * @param {string} params.decision - 'ACCEPT' | 'REJECT'
 * @param {string} [params.restaurantName] - Commercial restaurant name
 * @returns {Object} WhatsApp Cloud API payload
 */
function buildCustomerDecisionNotificationPayload({ order, decision, restaurantName = '' }) {
  if (!order || typeof order !== 'object') {
    throw new Error('[WHATSAPP PAYLOAD ERROR] Missing valid order object.');
  }

  if (!order.customer_phone || typeof order.customer_phone !== 'string') {
    throw new Error('[WHATSAPP PAYLOAD ERROR] Missing customer_phone in order.');
  }

  if (!order.order_reference) {
    throw new Error('[WHATSAPP PAYLOAD ERROR] Missing order_reference in order.');
  }

  const cleanPhone = order.customer_phone.replace(/[^\d]/g, '');
  const rName = restaurantName ? restaurantName.trim() : 'The restaurant';

  if (decision === 'ACCEPT') {
    const isDelivery = order.order_type === 'DELIVERY';
    const fulfilmentText = isDelivery ? '🚚 Delivery' : '🥡 Takeaway (Self-Pickup)';
    const currencySymbol = order.currency === 'INR' ? '₹' : `${order.currency} `;

    let bodyText = `✅ *ORDER ACCEPTED!*\n`;
    bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
    bodyText += `Great news! *${rName}* has accepted your order *#${order.order_reference}* and is preparing it.\n\n`;
    bodyText += `🥡 *Fulfilment:* ${fulfilmentText}\n`;

    if (isDelivery && order.address_snapshot) {
      bodyText += `📍 *Delivery Address:* ${order.address_snapshot}\n`;
    }

    const items = Array.isArray(order.items) ? order.items : [];
    if (items.length > 0) {
      bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
      bodyText += '*Order Details:*\n';
      for (const item of items) {
        const qty = item.quantity;
        const name = item.productName || item.productRetailerId || 'Item';
        const unitPrice = typeof item.unitPrice === 'number' ? item.unitPrice.toFixed(2) : item.unitPrice;
        bodyText += `• ${qty}x ${name} @ ${currencySymbol}${unitPrice}\n`;
      }
    }

    if (order.total_amount !== undefined && order.total_amount !== null) {
      const total = typeof order.total_amount === 'object' && order.total_amount !== null
        ? Number(order.total_amount).toFixed(2)
        : Number(order.total_amount).toFixed(2);
      bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
      bodyText += `*Total Amount:* ${currencySymbol}${total}\n`;
    }

    bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
    bodyText += 'Thank you for ordering with us!';

    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: {
        preview_url: false,
        body: bodyText
      }
    };
  }

  if (decision === 'REJECT') {
    let bodyText = `❌ *ORDER UPDATE: #${order.order_reference}*\n`;
    bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
    bodyText += `We are sorry, but *${rName}* was unable to accept your order *#${order.order_reference}* at this time.\n\n`;
    bodyText += 'You have not been charged. If you would like to place a new order, please reply with "Hi" to view the menu.\n';
    bodyText += '━━━━━━━━━━━━━━━━━━━━\n';
    bodyText += 'Thank you for understanding.';

    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: {
        preview_url: false,
        body: bodyText
      }
    };
  }

  throw new Error(`[WHATSAPP PAYLOAD ERROR] Invalid decision "${decision}". Must be ACCEPT or REJECT.`);
}

/**
 * Resolves Meta WhatsApp Cloud API credentials for a restaurant tenant.
 *
 * @param {string} restaurantId - Restaurant UUID
 * @param {Object} [db=prisma] - Prisma client or transaction client
 * @returns {Promise<{restaurantId: string, restaurantName: string, phoneNumberId: string, accessToken: string, ownerPhone: string}>}
 */
async function resolveRestaurantCredentials(restaurantId, db = prisma) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[TENANT ERROR] resolveRestaurantCredentials requires valid restaurantId');
  }

  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId }
  });

  if (!restaurant) {
    throw new Error(`[TENANT ERROR] Restaurant "${restaurantId}" does not exist.`);
  }

  if (!restaurant.is_active) {
    throw new Error(`[TENANT ERROR] Restaurant "${restaurant.name}" is inactive.`);
  }

  const phoneNumberId = restaurant.phone_number_id;
  if (!phoneNumberId) {
    throw new Error(`[CREDENTIAL ERROR] Restaurant "${restaurant.name}" has no configured phone_number_id.`);
  }

  let accessToken = restaurant.access_token_encrypted;
  if (accessToken && accessToken.startsWith('enc:v1:')) {
    try {
      accessToken = decryptToken(accessToken);
    } catch (decryptErr) {
      logger.error('Failed to decrypt restaurant access token', { restaurantId, error: decryptErr.message });
      throw new Error(`[CREDENTIAL ERROR] Failed to decrypt WhatsApp access token for "${restaurant.name}".`);
    }
  } else if (!accessToken || accessToken.startsWith('mock_')) {
    accessToken = config.meta.accessToken || accessToken || 'mock_access_token';
  }

  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    phoneNumberId,
    accessToken,
    ownerPhone: restaurant.owner_phone
  };
}

/**
 * Dispatches an outbound WhatsApp Cloud API message.
 *
 * @param {Object} params
 * @param {string} params.phoneNumberId
 * @param {string} params.accessToken
 * @param {Object} params.payload
 * @param {number} [params.timeoutMs=10000]
 * @param {Object} [params.httpClient=axios] - Optional injectable client for tests
 * @returns {Promise<{success: boolean, metaMessageId?: string, isTimeout?: boolean, isRetryable?: boolean, statusCode?: number, error?: string, data?: Object}>}
 */
async function sendWhatsAppMessage({
  phoneNumberId,
  accessToken,
  payload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  httpClient = null
}) {
  if (!phoneNumberId) {
    throw new Error('[WHATSAPP CONFIG ERROR] Missing phoneNumberId.');
  }

  if (!accessToken) {
    throw new Error('[WHATSAPP CONFIG ERROR] Missing accessToken.');
  }

  const client = httpClient || axios;
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/messages`;

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };

  try {
    const response = await client.post(url, payload, {
      headers,
      timeout: timeoutMs
    });

    const data = response.data || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const metaMessageId = messages[0]?.id || null;

    logger.info('WhatsApp message dispatched to Meta API successfully', {
      phoneNumberId,
      recipient: payload.to,
      metaMessageId
    });

    return {
      success: true,
      metaMessageId,
      data
    };
  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' ||
      err.code === 'ETIMEDOUT' ||
      (typeof err.message === 'string' && err.message.toLowerCase().includes('timeout'));

    const statusCode = err.response?.status || null;
    const isRetryable = isTimeout || (typeof statusCode === 'number' && statusCode >= 500);

    let rawErrorMessage = err.response?.data?.error?.message || err.message || 'Meta API error';
    // Redact access token from error string safely by escaping regex metacharacters
    let cleanError = rawErrorMessage;
    if (typeof accessToken === 'string' && accessToken.length > 0) {
      const escapedToken = accessToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleanError = rawErrorMessage.replace(new RegExp(escapedToken, 'g'), '[REDACTED]');
    }

    logger.error('WhatsApp API message dispatch failed', {
      phoneNumberId,
      recipient: payload?.to,
      statusCode,
      isTimeout,
      isRetryable,
      error: cleanError
    });

    return {
      success: false,
      isTimeout,
      isRetryable,
      statusCode,
      error: cleanError
    };
  }
}

module.exports = {
  META_GRAPH_VERSION,
  DEFAULT_TIMEOUT_MS,
  buildOwnerNotificationPayload,
  buildCustomerDecisionNotificationPayload,
  resolveRestaurantCredentials,
  sendWhatsAppMessage
};

