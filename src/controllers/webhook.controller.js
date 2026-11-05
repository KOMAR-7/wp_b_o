/**
 * RESTOPRO — Webhook Controller
 * Orchestrates verification challenges and durable event ingestion into PostgreSQL.
 */
const { verifyWebhookChallenge } = require('../middleware/verifyWebhook');
const { parseWebhookPayload } = require('../parsers/webhook-parser');
const { recordIncomingEvent, markEventCompleted } = require('../services/webhook.service');
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
 *
 * Webhook Reliability Contract:
 * - Persists incoming events to PostgreSQL BEFORE acknowledging with HTTP 200.
 * - Detects and deduplicates retried webhooks via event_key.
 * - If database persistence fails, returns HTTP 500 so Meta automatically retries delivery.
 */
async function handleIncomingEvent(req, res) {
  try {
    const rawPayload = req.body;
    const events = parseWebhookPayload(rawPayload);

    if (events.length === 0) {
      logger.debug('Received webhook payload with no actionable messages or status receipts', {
        entryCount: Array.isArray(rawPayload?.entry) ? rawPayload.entry.length : 0
      });
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Persist all events into PostgreSQL first for durable storage and idempotency
    for (const event of events) {
      const { isDuplicate, eventRecord } = await recordIncomingEvent(event);

      if (isDuplicate) {
        logger.info('Duplicate webhook event received; dropping safely without reprocessing', {
          messageId: event.messageId
        });
        continue;
      }

      if (event.category === 'STATUS_RECEIPT') {
        logger.info('WhatsApp status receipt persisted', {
          recipientId: event.recipientId,
          status: event.status,
          messageId: event.messageId
        });
        if (eventRecord) {
          await markEventCompleted(eventRecord.id);
        }
        continue;
      }

      if (event.category === 'INCOMING_MESSAGE') {
        logger.info(`Incoming WhatsApp message persisted [type: ${event.messageType}]`, {
          phoneNumberId: event.phoneNumberId,
          senderPhone: event.senderPhone,
          senderName: event.senderName,
          messageId: event.messageId,
          messageType: event.messageType
        });

        // Stage 2: Event is durably recorded in PostgreSQL.
        // Stage 3 & 4 will connect this to the conversation and order state machines.
        if (eventRecord) {
          await markEventCompleted(eventRecord.id);
        }
      }
    }

    // Acknowledge to Meta only after all events are durably persisted
    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logger.error('Critical failure during webhook database persistence', {
      error: err.message,
      stack: err.stack
    });
    // Return HTTP 500 so Meta's delivery engine retries the event
    return res.status(500).json({ error: 'Durable event persistence failed' });
  }
}

module.exports = {
  handleGetVerification,
  handleIncomingEvent
};
