/**
 * RESTOPRO — Durable Webhook Persistence & Idempotency Service
 * Guarantees that every incoming Meta webhook event is persisted to PostgreSQL
 * before HTTP 200 is returned, and duplicate webhook deliveries are safely deduplicated.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { resolveTenantByPhoneNumberId } = require('./tenant.service');

/**
 * Persists an incoming webhook event record to PostgreSQL for idempotency and auditability.
 * Uses event_key (wamid) unique constraint to detect duplicate deliveries.
 *
 * @param {Object} event - Normalized event object from webhook-parser
 * @returns {Promise<{isDuplicate: boolean, eventRecord?: Object}>}
 */
async function recordIncomingEvent(event) {
  const eventKey = event.messageId;

  // If payload has no messageId (e.g. empty ping or non-message change), don't deduplicate
  if (!eventKey) {
    return { isDuplicate: false, eventRecord: null };
  }

  // Resolve tenant context if phone_number_id is present
  let restaurantId = null;
  if (event.phoneNumberId) {
    const tenant = await resolveTenantByPhoneNumberId(event.phoneNumberId);
    if (tenant) {
      restaurantId = tenant.id;
    }
  }

  // Minimized audit summary (no sensitive secrets or unnecessary PII)
  const payloadSummary = {
    category: event.category,
    messageType: event.messageType,
    senderPhone: event.senderPhone,
    phoneNumberId: event.phoneNumberId,
    timestamp: event.timestamp
  };

  try {
    const eventRecord = await prisma.webhookEvent.create({
      data: {
        restaurant_id: restaurantId,
        event_key: eventKey,
        event_type: event.messageType || event.category || 'unknown',
        payload_summary: payloadSummary,
        processing_status: 'RECEIVED'
      }
    });

    logger.debug('Webhook event persisted to database', {
      eventId: eventRecord.id,
      eventKey,
      restaurantId
    });

    return { isDuplicate: false, eventRecord };
  } catch (err) {
    // Prisma P2002 is Unique constraint violation on event_key
    if (err.code === 'P2002') {
      logger.info('Duplicate webhook event detected via event_key; safely ignored', {
        eventKey,
        phoneNumberId: event.phoneNumberId
      });
      return { isDuplicate: true };
    }

    logger.error('Failed to persist webhook event to database', {
      eventKey,
      error: err.message
    });
    throw err; // Re-throw to trigger HTTP 500 retry from Meta
  }
}

/**
 * Updates status of an event to COMPLETED.
 */
async function markEventCompleted(eventId) {
  if (!eventId) return;
  return prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      processing_status: 'COMPLETED',
      processed_at: new Date()
    }
  });
}

/**
 * Updates status of an event to FAILED with error trace.
 */
async function markEventFailed(eventId, errorMessage) {
  if (!eventId) return;
  return prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      processing_status: 'FAILED',
      processed_at: new Date(),
      payload_summary: { error: errorMessage }
    }
  });
}

module.exports = {
  recordIncomingEvent,
  markEventCompleted,
  markEventFailed
};
