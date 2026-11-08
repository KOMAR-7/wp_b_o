/**
 * RESTOPRO — Meta WhatsApp Cloud API Webhook Event Parser
 * Safely parses and normalizes incoming Meta payloads with defensive numeric handling.
 */

/**
 * Safely parses coordinate float, preserving 0.0 values without falsy coercion.
 */
function safeParseCoordinate(val) {
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = parseFloat(val);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Sanitizes and normalizes Meta Cloud API status error objects.
 * Extracts code, title, message, and error_data.details safely.
 * Redacts any accidental tokens or authorization keys.
 *
 * @param {Array<Object>|Object|null} rawErrors
 * @returns {Array<{code: number|null, title: string|null, message: string|null, details: string|null, href: string|null}>|null}
 */
function sanitizeStatusErrors(rawErrors) {
  if (!rawErrors) return null;
  const list = Array.isArray(rawErrors) ? rawErrors : [rawErrors];
  if (list.length === 0) return null;

  return list.map(err => {
    if (!err || typeof err !== 'object') {
      const sanitizedStr = String(err).replace(/EAA[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]');
      return { code: null, title: null, message: sanitizedStr, details: null, href: null };
    }

    const code = typeof err.code === 'number'
      ? err.code
      : (err.code ? (Number(err.code) || null) : null);

    const title = typeof err.title === 'string'
      ? err.title.replace(/EAA[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]')
      : null;

    const message = typeof err.message === 'string'
      ? err.message.replace(/EAA[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]')
      : null;

    const rawDetails = err.error_data && typeof err.error_data.details === 'string'
      ? err.error_data.details
      : (typeof err.details === 'string' ? err.details : null);

    const details = rawDetails
      ? rawDetails.replace(/EAA[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]')
      : null;

    const href = typeof err.href === 'string'
      ? err.href.replace(/EAA[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]')
      : null;

    return { code, title, message, details, href };
  });
}

/**
 * Extracts and parses all actionable messages from an incoming Meta webhook body.
 * Returns an array of normalized message event objects.
 *
 * @param {Object} payload Raw JSON body from Meta webhook
 * @returns {Array<Object>} Normalized event array
 */
function parseWebhookPayload(payload) {
  const events = [];

  if (!payload || typeof payload !== 'object') {
    return events;
  }

  // Meta WhatsApp webhooks have object: "whatsapp_business_account"
  if (payload.object !== 'whatsapp_business_account') {
    return events;
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      if (!change || change.field !== 'messages') continue;

      const value = change.value;
      if (!value || typeof value !== 'object') continue;

      // Extract business phone number metadata (Tenant context key)
      const metadata = value.metadata || {};
      const phoneNumberId = metadata.phone_number_id || null;
      const displayPhoneNumber = metadata.display_phone_number || null;

      // Check if this is a delivery status update receipt (sent, delivered, read)
      if (Array.isArray(value.statuses) && value.statuses.length > 0) {
        for (const statusObj of value.statuses) {
          events.push({
            category: 'STATUS_RECEIPT',
            phoneNumberId,
            displayPhoneNumber,
            messageId: statusObj.id || null,
            status: statusObj.status || null, // 'sent', 'delivered', 'read', 'failed'
            recipientId: statusObj.recipient_id || null,
            timestamp: statusObj.timestamp || null,
            errors: sanitizeStatusErrors(statusObj.errors)
          });
        }
        continue;
      }

      // Extract contact profile details if available
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const contactMap = {};
      for (const contact of contacts) {
        if (contact && contact.wa_id) {
          contactMap[contact.wa_id] = contact.profile ? contact.profile.name : null;
        }
      }

      // Extract incoming customer/owner messages
      const messages = Array.isArray(value.messages) ? value.messages : [];

      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;

        const senderPhone = message.from || null;
        const senderName = senderPhone ? contactMap[senderPhone] || null : null;
        const messageId = message.id || null;
        const timestamp = message.timestamp || null;
        const messageType = message.type || 'unknown';

        const baseEvent = {
          category: 'INCOMING_MESSAGE',
          phoneNumberId,
          displayPhoneNumber,
          senderPhone,
          senderName,
          messageId,
          timestamp,
          messageType
        };

        const parsedDetail = parseMessageDetails(messageType, message);
        events.push({ ...baseEvent, ...parsedDetail });
      }
    }
  }

  return events;
}

/**
 * Parses type-specific details from a Meta message object.
 */
function parseMessageDetails(type, message) {
  switch (type) {
    case 'text': {
      const textObj = message.text || {};
      return {
        text: typeof textObj.body === 'string' ? textObj.body : ''
      };
    }

    case 'order': {
      // Native WhatsApp Catalog Order / Cart submission
      const orderObj = message.order || {};
      const catalogId = orderObj.catalog_id || null;
      const customerNotes = typeof orderObj.text === 'string' ? orderObj.text : '';
      const rawItems = Array.isArray(orderObj.product_items) ? orderObj.product_items : [];

      let calculatedSubtotal = 0;
      let primaryCurrency = null;
      let hasCurrencyMismatch = false;

      const items = rawItems.map(item => {
        const rawQty = parseInt(item.quantity, 10);
        const quantity = (!isNaN(rawQty) && rawQty > 0) ? rawQty : 1;

        const rawPrice = parseFloat(item.item_price);
        const unitPrice = (!isNaN(rawPrice) && rawPrice >= 0)
          ? Math.round(rawPrice * 100) / 100
          : 0;

        const currency = (typeof item.currency === 'string' && item.currency.trim())
          ? item.currency.trim().toUpperCase()
          : 'INR';

        if (!primaryCurrency) {
          primaryCurrency = currency;
        } else if (currency !== primaryCurrency) {
          hasCurrencyMismatch = true;
        }

        const lineTotal = Math.round(quantity * unitPrice * 100) / 100;
        calculatedSubtotal += lineTotal;

        const candidateName = (typeof item.name === 'string' && item.name.trim())
          || (typeof item.title === 'string' && item.title.trim())
          || (typeof item.product_name === 'string' && item.product_name.trim())
          || (typeof item.productName === 'string' && item.productName.trim())
          || null;

        return {
          productRetailerId: typeof item.product_retailer_id === 'string' ? item.product_retailer_id : '',
          name: candidateName,
          quantity,
          unitPrice,
          currency,
          lineTotal
        };
      });

      return {
        order: {
          catalogId,
          customerNotes,
          itemCount: items.length,
          items,
          calculatedSubtotal: Math.round(calculatedSubtotal * 100) / 100,
          currency: primaryCurrency || 'INR',
          currencyMismatch: hasCurrencyMismatch
        },
        rawOrder: message.order
      };
    }

    case 'location': {
      // Customer GPS or Pinned Location Sharing
      const locObj = message.location || {};
      const isLive = Boolean(locObj.is_live || message.live_location || locObj.live_period);
      return {
        location: {
          latitude: safeParseCoordinate(locObj.latitude),
          longitude: safeParseCoordinate(locObj.longitude),
          name: typeof locObj.name === 'string' ? locObj.name : null,
          address: typeof locObj.address === 'string' ? locObj.address : null,
          isLive
        }
      };
    }

    case 'button': {
      // Quick Reply Button Tap from Meta Message Template
      const buttonObj = message.button || {};
      const contextObj = message.context || {};
      return {
        buttonReply: {
          payload: typeof buttonObj.payload === 'string' ? buttonObj.payload : '',
          text: typeof buttonObj.text === 'string' ? buttonObj.text : '',
          contextMessageId: typeof contextObj.id === 'string' ? contextObj.id : null
        }
      };
    }

    case 'interactive': {
      // Interactive Button or List Reply from free-form interactive message
      const interactiveObj = message.interactive || {};
      const interactiveType = interactiveObj.type;

      if (interactiveType === 'button_reply') {
        const reply = interactiveObj.button_reply || {};
        return {
          interactiveReply: {
            subType: 'button_reply',
            id: typeof reply.id === 'string' ? reply.id : '',
            title: typeof reply.title === 'string' ? reply.title : ''
          }
        };
      }

      if (interactiveType === 'list_reply') {
        const reply = interactiveObj.list_reply || {};
        return {
          interactiveReply: {
            subType: 'list_reply',
            id: typeof reply.id === 'string' ? reply.id : '',
            title: typeof reply.title === 'string' ? reply.title : '',
            description: typeof reply.description === 'string' ? reply.description : null
          }
        };
      }

      return {
        interactiveReply: {
          subType: interactiveType || 'unknown',
          raw: interactiveObj
        }
      };
    }

    default: {
      return {
        unhandledType: type,
        rawKeys: Object.keys(message)
      };
    }
  }
}

module.exports = {
  parseWebhookPayload,
  parseMessageDetails,
  safeParseCoordinate,
  sanitizeStatusErrors
};
