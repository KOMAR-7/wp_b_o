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

/**
 * Builds Meta WhatsApp Cloud API v21.0 payload for customer conversational actions.
 * Strictly adheres to Meta constraints:
 * - Button titles: <= 20 chars
 * - Max buttons: 3
 * - List rows: <= 10 rows
 * - List row title: <= 24 chars, description: <= 72 chars
 * - Interactive body: <= 1024 chars
 * - Text body: <= 4096 chars
 *
 * @param {Object} params
 * @param {Object} params.action - Action object returned by conversation engine
 * @param {string} params.recipientPhone - Customer WhatsApp phone number
 * @param {string} [params.restaurantName=''] - Commercial restaurant name
 * @param {string} [params.catalogId=null] - Optional catalog ID
 * @returns {Object|null} Meta Cloud API payload object, or null if no outbound message needed
 */
function buildConversationReplyPayload({ action, recipientPhone, restaurantName = '', catalogId = null }) {
  if (!action || typeof action !== 'object' || !action.type) {
    return null;
  }

  if (action.type === 'SILENT_FALLBACK') {
    return null;
  }

  if (!recipientPhone || typeof recipientPhone !== 'string') {
    throw new Error('[WHATSAPP PAYLOAD ERROR] Missing recipientPhone.');
  }

  const cleanPhone = recipientPhone.replace(/[^\d]/g, '');
  if (!cleanPhone) {
    throw new Error('[WHATSAPP PAYLOAD ERROR] Recipient phone contains no digits.');
  }

  const rName = restaurantName ? restaurantName.trim() : '';
  const footerText = rName ? `RESTOPRO • ${rName}`.slice(0, 60) : 'RESTOPRO';

  // Defensive clamping to adhere to Meta character limitations
  const clampBody = (text) => {
    if (typeof text !== 'string') return '';
    return text.length > 1024 ? `${text.slice(0, 1020)}...` : text;
  };

  switch (action.type) {
    case 'SEND_WELCOME_CATALOG': {
      const greetingName = action.customerName ? ` ${action.customerName}` : '';
      const welcomeRestaurant = rName || 'our restaurant';
      const bodyText = action.message || `Hello${greetingName} 👋\n\nWelcome to ${welcomeRestaurant}!\n\nWhat would you like to enjoy today?`;

      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'catalog_message',
          body: { text: clampBody(bodyText) },
          footer: { text: footerText },
          action: {
            name: 'catalog_message'
          }
        }
      };
    }

    case 'REDIRECT_TO_CATALOG': {
      const bodyText = action.message || 'To select items or modify your order, please use our menu catalogue below.';
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'catalog_message',
          body: { text: clampBody(bodyText) },
          footer: { text: footerText },
          action: {
            name: 'catalog_message'
          }
        }
      };
    }

    case 'PROMPT_LOCATION_REQUEST': {
      const bodyText = action.message || 'Please tap the button below to share your delivery location pin 📍';
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'location_request_message',
          body: { text: clampBody(bodyText) },
          action: {
            name: 'send_location'
          }
        }
      };
    }

    case 'PROMPT_ADDRESS_COLLECTION':
    case 'PROMPT_ADDRESS_CHOICE': {
      const saved = Array.isArray(action.savedAddresses) ? action.savedAddresses : [];
      const custGreeting = action.customerName ? `, ${action.customerName}` : '';
      let defaultBody = `Select your delivery address${custGreeting}:`;

      const itemCount = action.itemCount || (Array.isArray(action.cart?.items) ? action.cart.items.length : null);
      const subtotal = action.subtotal !== undefined ? action.subtotal : action.cart?.subtotal;
      let headerPrefix = '';
      if (itemCount !== null && subtotal !== undefined && subtotal !== null) {
        headerPrefix = `🛒 *Cart Received:* ${itemCount} item(s) (₹${Number(subtotal).toFixed(2)})\n━━━━━━━━━━━━━━━━━━━━\n`;
      }

      const bodyText = clampBody(headerPrefix + (action.message || defaultBody));

      // If customer has saved addresses -> Send interactive list message with saved addresses + options
      if (saved.length > 0) {
        const rows = saved.slice(0, 7).map((addr, idx) => ({
          id: `ADDR_SAVED_${addr.id}`.slice(0, 200),
          title: (addr.label || `Address ${idx + 1}`).slice(0, 24),
          description: (addr.address || '').slice(0, 72)
        }));

        rows.push({
          id: 'BTN_SHARE_LOCATION',
          title: '📍 Share Location'.slice(0, 24),
          description: 'Share your WhatsApp location pin'.slice(0, 72)
        });

        rows.push({
          id: 'BTN_ENTER_MANUAL_ADDRESS',
          title: '✍️ Enter Manually'.slice(0, 24),
          description: 'Type your full delivery address'.slice(0, 72)
        });

        rows.push({
          id: 'BTN_CANCEL_ORDER',
          title: '❌ Cancel Order'.slice(0, 24),
          description: 'Cancel this ordering process'.slice(0, 72)
        });

        return {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text: bodyText },
            footer: { text: footerText },
            action: {
              button: 'Select Address'.slice(0, 20),
              sections: [
                {
                  title: 'Delivery Options'.slice(0, 24),
                  rows
                }
              ]
            }
          }
        };
      }

      // If customer has NO saved addresses -> Send 3 interactive buttons (Share Location, Enter Manually, Cancel Order)
      const buttons = [
        {
          type: 'reply',
          reply: {
            id: 'BTN_SHARE_LOCATION',
            title: '📍 Share Location'.slice(0, 20)
          }
        },
        {
          type: 'reply',
          reply: {
            id: 'BTN_ENTER_MANUAL_ADDRESS',
            title: '✍️ Enter Manually'.slice(0, 20)
          }
        },
        {
          type: 'reply',
          reply: {
            id: 'BTN_CANCEL_ORDER',
            title: '❌ Cancel Order'.slice(0, 20)
          }
        }
      ];

      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          footer: { text: footerText },
          action: { buttons }
        }
      };
    }

    case 'PROMPT_SAVE_CONSENT':
    case 'VALID_TEXT_INPUT': {
      const addressText = action.address?.addressText || '';
      let bodyText = action.message;
      if (!bodyText) {
        bodyText = addressText
          ? `Address received! 📍\n\n${addressText}\n\nWould you like to save this address for future orders?`
          : 'Address received! 📍\n\nWould you like to save this address for future orders?';
      }

      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: clampBody(bodyText) },
          footer: { text: footerText },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'BTN_CONSENT_YES',
                  title: '💾 Save Address'.slice(0, 20)
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'BTN_CONSENT_NO',
                  title: '⚡ Use Once'.slice(0, 20)
                }
              }
            ]
          }
        }
      };
    }

    case 'PROMPT_ORDER_TYPE': {
      const bodyText = action.message || 'How would you like to receive your order?';

      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: clampBody(bodyText) },
          footer: { text: footerText },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'BTN_ORDER_DELIVERY',
                  title: '🚚 Home Delivery'.slice(0, 20)
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'BTN_ORDER_TAKEAWAY',
                  title: '🥡 Takeaway'.slice(0, 20)
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'BTN_CANCEL_ORDER',
                  title: '❌ Cancel Order'.slice(0, 20)
                }
              }
            ]
          }
        }
      };
    }

    case 'PROMPT_ORDER_CONFIRMATION': {
      const summaryText = action.summary?.summaryText || action.message || 'Please review and confirm your order:';
      const actionButtons = Array.isArray(action.buttons) && action.buttons.length > 0
        ? action.buttons
        : [
            { id: `BTN_CONFIRM_ORDER:${action.confirmationToken || ''}`, title: '✅ Confirm Order' },
            { id: 'BTN_CANCEL_ORDER', title: '❌ Cancel Order' }
          ];

      // Meta limits: max 3 buttons, title <= 20 chars, id <= 256 chars
      const buttons = actionButtons.slice(0, 3).map(b => ({
        type: 'reply',
        reply: {
          id: String(b.id).slice(0, 256),
          title: String(b.title).slice(0, 20)
        }
      }));

      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: clampBody(summaryText) },
          footer: { text: footerText },
          action: { buttons }
        }
      };
    }

    case 'VALID_LOCATION_INPUT':
    case 'PROMPT_ROOM_NUMBER':
    case 'PROMPT_ADDRESS_INPUT':
    case 'ORDER_CONFIRMED':
    case 'ORDER_CANCELLED':
    case 'CONTEXTUAL_REPROMPT': {
      const bodyText = action.message || 'Please follow the on-screen options to continue your order.';

      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: {
          preview_url: false,
          body: bodyText.slice(0, 4096)
        }
      };
    }

    default: {
      // If action has a message string, fallback to safe text reply
      if (typeof action.message === 'string' && action.message.trim()) {
        return {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'text',
          text: {
            preview_url: false,
            body: action.message.trim().slice(0, 4096)
          }
        };
      }
      return null;
    }
  }
}

module.exports = {
  META_GRAPH_VERSION,
  DEFAULT_TIMEOUT_MS,
  buildOwnerNotificationPayload,
  buildCustomerDecisionNotificationPayload,
  buildConversationReplyPayload,
  resolveRestaurantCredentials,
  sendWhatsAppMessage
};

