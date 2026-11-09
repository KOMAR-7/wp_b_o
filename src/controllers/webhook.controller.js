/**
 * RESTOPRO — Webhook Controller
 * Orchestrates verification challenges, durable event ingestion, and conversation routing.
 */
const { verifyWebhookChallenge } = require('../middleware/verifyWebhook');
const { parseWebhookPayload } = require('../parsers/webhook-parser');
const { recordIncomingEvent, markEventCompleted, markEventFailed } = require('../services/webhook.service');
const { resolveTenantByPhoneNumberId, isCentralPhoneNumberId } = require('../services/tenant.service');
const { handleCentralInformationalMessage } = require('../services/central-whatsapp.service');
const { handleIncomingMessage } = require('../services/conversation.service');
const { processOwnerOrderDecision } = require('../services/order.service');
const { enqueueConversationReply } = require('../services/outbox.service');
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
 * - Dispatches customer messages to conversation.service.js for deterministic state updates.
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
        if (event.status === 'failed') {
          // Asynchronous delivery failure reported by Meta Cloud API (e.g. template error, undeliverable, 24h window)
          logger.warn('WhatsApp message delivery failed asynchronously by Meta Cloud API', {
            messageId: event.messageId,
            recipientId: event.recipientId,
            phoneNumberId: event.phoneNumberId,
            status: event.status,
            errors: event.errors || []
          });
        } else {
          logger.info('WhatsApp status receipt persisted', {
            recipientId: event.recipientId,
            status: event.status,
            messageId: event.messageId
          });
        }
        if (eventRecord) {
          await markEventCompleted(eventRecord.id);
        }
        continue;
      }

      if (event.category === 'INCOMING_MESSAGE') {
        const isCentral = await isCentralPhoneNumberId(event.phoneNumberId);

        if (isCentral) {
          logger.info(`Central WhatsApp message received [type: ${event.messageType}]`, {
            phoneNumberId: event.phoneNumberId,
            senderPhone: event.senderPhone,
            senderName: event.senderName,
            messageId: event.messageId,
            messageType: event.messageType
          });

          // Check if message is an owner interactive action (e.g. OWNER_ACCEPT:<id>, OWNER_REJECT:<id>, or signed OWNER_SIG:)
          const actionPayload = event.interactiveReply?.id || event.buttonReply?.payload || null;
          if (actionPayload && typeof actionPayload === 'string' && (actionPayload.startsWith('OWNER_') || actionPayload.startsWith('OWNER_SIG:'))) {
            logger.info('Received owner decision interactive payload on Central WhatsApp number', {
              phoneNumberId: event.phoneNumberId,
              senderPhone: event.senderPhone,
              payload: actionPayload
            });

            // Process decision without pre-resolving restaurantId (order ID inside verified payload resolves restaurant context)
            const decisionResult = await processOwnerOrderDecision({
              senderPhone: event.senderPhone,
              buttonPayload: actionPayload
            });

            if (!decisionResult.success) {
              logger.warn('Owner decision on Central number rejected', {
                phoneNumberId: event.phoneNumberId,
                senderPhone: event.senderPhone,
                code: decisionResult.code,
                error: decisionResult.error
              });
              if (eventRecord) {
                await markEventFailed(eventRecord.id, `Owner decision rejected: ${decisionResult.error}`);
              }
              continue;
            }

            logger.info('Central owner decision processed successfully', {
              orderId: decisionResult.order?.id,
              orderReference: decisionResult.order?.order_reference,
              restaurantId: decisionResult.order?.restaurant_id,
              status: decisionResult.order?.status,
              isDuplicate: decisionResult.isDuplicate || false
            });

            if (eventRecord) {
              await markEventCompleted(eventRecord.id);
            }
            continue;
          }

          // Central webhook events must never accidentally enter the restaurant customer conversation engine.
          // Handle unknown text messages received on XYZ with a safe informational response.
          logger.info('Non-owner message received on Central WhatsApp number; returning informational response', {
            phoneNumberId: event.phoneNumberId,
            senderPhone: event.senderPhone,
            messageType: event.messageType
          });

          await handleCentralInformationalMessage({
            senderPhone: event.senderPhone,
            messageId: event.messageId
          });

          if (eventRecord) {
            await markEventCompleted(eventRecord.id);
          }
          continue;
        }

        // Restaurant-specific webhook flow (Legacy or normal restaurant incoming)
        logger.info(`Incoming WhatsApp message persisted [type: ${event.messageType}]`, {
          phoneNumberId: event.phoneNumberId,
          senderPhone: event.senderPhone,
          senderName: event.senderName,
          messageId: event.messageId,
          messageType: event.messageType
        });

        // Resolve tenant context exclusively via Meta incoming phone_number_id
        const tenant = event.phoneNumberId
          ? await resolveTenantByPhoneNumberId(event.phoneNumberId)
          : null;

        if (!tenant) {
          logger.warn('Message received for unmapped or inactive tenant', {
            phoneNumberId: event.phoneNumberId
          });
          if (eventRecord) {
            await markEventFailed(eventRecord.id, 'Tenant not resolved or inactive');
          }
          continue;
        }

        // Legacy restaurant-number Accept/Reject handler eliminated:
        // Owner decisions are strictly disallowed on restaurant numbers. They MUST be routed through Central number XYZ.
        const actionPayload = event.interactiveReply?.id || event.buttonReply?.payload || null;
        if (actionPayload && typeof actionPayload === 'string' && (actionPayload.startsWith('OWNER_') || actionPayload.startsWith('OWNER_SIG:'))) {
          logger.warn('Owner decision interactive payload rejected on restaurant number; owner decisions must be routed via Central WhatsApp number', {
            phoneNumberId: event.phoneNumberId,
            senderPhone: event.senderPhone,
            payload: actionPayload
          });
          if (eventRecord) {
            await markEventFailed(eventRecord.id, 'Owner decisions not permitted on restaurant number; must use Central number');
          }
          continue;
        }

        // Dispatch incoming customer message to the conversation engine
        const engineResult = await handleIncomingMessage(
          tenant.id,
          event.senderPhone,
          event
        );

        if (!engineResult.success) {
          logger.warn('Conversation engine rejected message', {
            senderPhone: event.senderPhone,
            code: engineResult.code,
            error: engineResult.error
          });
          if (eventRecord) {
            await markEventFailed(eventRecord.id, `Engine error: ${engineResult.error}`);
          }
          continue;
        }

        // Enqueue outbound conversational reply if an actionable response was generated
        if (engineResult.action && engineResult.action.type !== 'SILENT_FALLBACK') {
          try {
            await enqueueConversationReply({
              restaurantId: tenant.id,
              customerPhone: event.senderPhone,
              action: engineResult.action,
              inboundMessageId: event.messageId,
              restaurantName: tenant.name
            });
          } catch (replyErr) {
            logger.error('Failed to enqueue conversational reply into outbox', {
              phoneNumberId: event.phoneNumberId,
              senderPhone: event.senderPhone,
              actionType: engineResult.action?.type,
              error: replyErr.message
            });
          }
        }

        if (eventRecord) {
          await markEventCompleted(eventRecord.id);
        }
        continue;
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
