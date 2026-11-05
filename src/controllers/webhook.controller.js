/**
 * RESTOPRO — Webhook Controller
 * Orchestrates verification challenges and incoming event logging.
 */
const { verifyWebhookChallenge } = require('../middleware/verifyWebhook');
const { parseWebhookPayload } = require('../parsers/webhook-parser');
const logger = require('../utils/logger');

/**
 * HTTP GET /api/webhook
 * Handshake endpoint for Meta Webhook setup.
 */
function handleGetVerification(req, res) {
  return verifyWebhookChallenge(req, res);
}

/**
 * HTTP POST /api/webhook
 * Receives and processes real-time events from Meta WhatsApp Cloud API.
 * Signature has already been verified by verifyWebhookSignature middleware.
 */
function handleIncomingEvent(req, res) {
  // Always acknowledge immediately with HTTP 200 to satisfy Meta's 20-second timeout
  res.status(200).send('EVENT_RECEIVED');

  try {
    const rawPayload = req.body;
    const events = parseWebhookPayload(rawPayload);

    if (events.length === 0) {
      logger.debug('Received webhook payload with no actionable messages or status receipts', {
        entryCount: Array.isArray(rawPayload?.entry) ? rawPayload.entry.length : 0
      });
      return;
    }

    for (const event of events) {
      if (event.category === 'STATUS_RECEIPT') {
        logger.info('WhatsApp status receipt received', {
          recipientId: event.recipientId,
          status: event.status,
          messageId: event.messageId
        });
        continue;
      }

      if (event.category === 'INCOMING_MESSAGE') {
        logger.info(`Received incoming WhatsApp message [type: ${event.messageType}]`, {
          phoneNumberId: event.phoneNumberId,
          senderPhone: event.senderPhone,
          senderName: event.senderName,
          messageId: event.messageId,
          messageType: event.messageType,
          ...(event.text ? { text: event.text } : {}),
          ...(event.order ? {
            orderCatalogId: event.order.catalogId,
            itemCount: event.order.itemCount,
            subtotal: event.order.calculatedSubtotal,
            currency: event.order.currency,
            items: event.order.items
          } : {}),
          ...(event.location ? {
            latitude: event.location.latitude,
            longitude: event.location.longitude,
            locationName: event.location.name,
            address: event.location.address
          } : {}),
          ...(event.buttonReply ? {
            buttonPayload: event.buttonReply.payload,
            buttonText: event.buttonReply.text,
            contextMessageId: event.buttonReply.contextMessageId
          } : {}),
          ...(event.interactiveReply ? {
            interactiveType: event.interactiveReply.subType,
            replyId: event.interactiveReply.id,
            replyTitle: event.interactiveReply.title
          } : {})
        });
      }
    }
  } catch (err) {
    logger.error('Error processing parsed webhook payload', { error: err.message, stack: err.stack });
  }
}

module.exports = {
  handleGetVerification,
  handleIncomingEvent
};
