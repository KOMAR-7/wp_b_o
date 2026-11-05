/**
 * RESTOPRO — Meta WhatsApp Cloud API Webhook Event Parser
 * Safely parses and normalizes incoming Meta payloads.
 */

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
            errors: statusObj.errors || null
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
        text: textObj.body || ''
      };
    }

    case 'order': {
      // Native WhatsApp Catalog Order / Cart submission
      const orderObj = message.order || {};
      const catalogId = orderObj.catalog_id || null;
      const customerNotes = orderObj.text || '';
      const rawItems = Array.isArray(orderObj.product_items) ? orderObj.product_items : [];

      let calculatedSubtotal = 0;
      let orderCurrency = 'INR';

      const items = rawItems.map(item => {
        const quantity = parseInt(item.quantity || 1, 10);
        const unitPrice = parseFloat(item.item_price || 0);
        const currency = item.currency || 'INR';
        orderCurrency = currency;
        const lineTotal = quantity * unitPrice;
        calculatedSubtotal += lineTotal;

        return {
          productRetailerId: item.product_retailer_id || '',
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
          currency: orderCurrency
        }
      };
    }

    case 'location': {
      // Customer GPS or Pinned Location Sharing
      const locObj = message.location || {};
      return {
        location: {
          latitude: typeof locObj.latitude === 'number' ? locObj.latitude : parseFloat(locObj.latitude) || null,
          longitude: typeof locObj.longitude === 'number' ? locObj.longitude : parseFloat(locObj.longitude) || null,
          name: locObj.name || null,
          address: locObj.address || null
        }
      };
    }

    case 'button': {
      // Quick Reply Button Tap from Meta Message Template
      const buttonObj = message.button || {};
      const contextObj = message.context || {};
      return {
        buttonReply: {
          payload: buttonObj.payload || '',
          text: buttonObj.text || '',
          contextMessageId: contextObj.id || null
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
            id: reply.id || '',
            title: reply.title || ''
          }
        };
      }

      if (interactiveType === 'list_reply') {
        const reply = interactiveObj.list_reply || {};
        return {
          interactiveReply: {
            subType: 'list_reply',
            id: reply.id || '',
            title: reply.title || '',
            description: reply.description || null
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
  parseMessageDetails
};
