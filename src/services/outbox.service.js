/**
 * RESTOPRO — Durable Outbox Message Dispatcher Service
 * Stage 5.1: PostgreSQL Atomic Leases, Fenced Dispatch & Bounded Retries
 *
 * Implements:
 * - Atomic order + outbox persistence in the same transaction (ST5-01)
 * - Row-level locking with FOR UPDATE SKIP LOCKED
 * - Leased worker claiming with expiration fencing
 * - Zero database transactions open during external Meta HTTP calls
 * - Bounded retries with backoff and UNCERTAIN_DISPATCH handling
 * - Secret and token redaction across all logs
 */
const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { resolveRestaurantCredentials, sendWhatsAppMessage, buildConversationReplyPayload } = require('./whatsapp.service');
const { resolveCentralCredentials } = require('./central-whatsapp.service');

const DEFAULT_LEASE_TTL_MS = 60 * 1000; // 60 seconds lease TTL
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Lazily invokes in-process worker cycle trigger to prevent circular module dependencies.
 */
function notifyWorkerCycle() {
  try {
    const workerModule = require('../jobs/notification-worker');
    if (typeof workerModule.triggerWorkerCycle === 'function') {
      workerModule.triggerWorkerCycle();
    }
  } catch (err) {
    logger.debug('Worker trigger skipped', { reason: err.message });
  }
}

/**
 * Persists an outbound conversational reply into outbox_messages table.
 * Idempotency is enforced using inbound event.messageId (e.g. reply_wamid.xxx).
 *
 * @param {Object} params
 * @param {string} params.restaurantId - Restaurant tenant UUID
 * @param {string} params.customerPhone - Customer phone string
 * @param {Object} params.action - Action object returned by conversation engine
 * @param {string} [params.inboundMessageId] - Inbound WhatsApp message ID
 * @param {string} [params.restaurantName=''] - Commercial restaurant name
 * @param {Object} [params.txClient] - Optional Prisma transaction client
 * @returns {Promise<Object|null>} Created OutboxMessage or null if no reply needed
 */
async function enqueueConversationReply({
  restaurantId,
  customerPhone,
  action,
  inboundMessageId = null,
  restaurantName = '',
  txClient = null
}) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[OUTBOX ERROR] enqueueConversationReply requires valid restaurantId');
  }

  if (!customerPhone || typeof customerPhone !== 'string') {
    throw new Error('[OUTBOX ERROR] enqueueConversationReply requires valid customerPhone');
  }

  if (!action || typeof action !== 'object' || action.type === 'SILENT_FALLBACK') {
    return null;
  }

  const payload = buildConversationReplyPayload({
    action,
    recipientPhone: customerPhone,
    restaurantName
  });

  if (!payload) {
    logger.debug('No outbound payload generated for conversational action; skipping outbox enqueue', {
      restaurantId,
      actionType: action.type
    });
    return null;
  }

  const cleanCustomerPhone = customerPhone.replace(/[^\d]/g, '');
  const cleanMsgId = (typeof inboundMessageId === 'string' && inboundMessageId.trim())
    ? inboundMessageId.trim()
    : `${restaurantId.slice(0, 8)}_${cleanCustomerPhone}_${Date.now()}`;
  const idempotencyKey = `reply_${cleanMsgId}`.slice(0, 128);

  const db = txClient || prisma;

  try {
    const outboxMessage = await db.outboxMessage.create({
      data: {
        restaurant_id: restaurantId,
        recipient_phone: cleanCustomerPhone,
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload,
        idempotency_key: idempotencyKey,
        status: 'PENDING'
      }
    });

    logger.info('Customer conversational reply enqueued into outbox', {
      outboxId: outboxMessage.id,
      restaurantId,
      recipientPhone: cleanCustomerPhone,
      actionType: action.type,
      idempotencyKey
    });

    // Notify in-process background worker to trigger an immediate cycle
    notifyWorkerCycle();

    return outboxMessage;
  } catch (err) {
    const isDuplicateKey = err.code === 'P2002' && (
      (Array.isArray(err.meta?.target) && err.meta.target.includes('idempotency_key')) ||
      (typeof err.meta?.target === 'string' && err.meta.target.includes('idempotency_key')) ||
      (err.message && err.message.includes('idempotency_key'))
    );

    if (isDuplicateKey) {
      logger.info('Duplicate conversational reply prevented by idempotency key', {
        idempotencyKey,
        restaurantId,
        actionType: action.type
      });
      return await db.outboxMessage.findUnique({
        where: { idempotency_key: idempotencyKey }
      });
    }

    logger.error('Failed to enqueue conversational reply into outbox', {
      error: err.message,
      restaurantId,
      actionType: action.type
    });
    throw err;
  }
}

/**
 * Claims a batch of pending outbox messages within a short database transaction.
 * Uses PostgreSQL row-level locking (FOR UPDATE SKIP LOCKED) to prevent concurrent workers
 * from claiming the same row.
 *
 * @param {Object} tx - Active Prisma transaction client
 * @param {Object} [options]
 * @param {number} [options.limit=10]
 * @param {number} [options.maxAttempts=5]
 * @param {number} [options.leaseTtlMs=60000]
 * @param {string} [options.workerId]
 * @returns {Promise<Array<Object>>} Claimed outbox messages
 */
async function claimPendingOutboxMessages(tx, {
  limit = 10,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  workerId = null
} = {}) {
  const assignedWorkerId = workerId || `worker_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();

  // Raw query using FOR UPDATE SKIP LOCKED for atomic distributed worker claiming
  const claimedRows = await tx.$queryRaw`
    SELECT id, restaurant_id, recipient_phone, message_type, sender_channel, payload, idempotency_key, status, attempts
    FROM outbox_messages
    WHERE (
      (status = 'PENDING' AND attempts < ${maxAttempts})
      OR (status = 'UNCERTAIN_DISPATCH' AND attempts < ${maxAttempts} AND (
        (payload->'lease'->>'lease_expires_at') IS NULL 
        OR (payload->'lease'->>'lease_expires_at')::timestamptz < ${now}
      ))
    )
    AND (
      (payload->'lease'->>'lease_expires_at') IS NULL
      OR (payload->'lease'->>'lease_expires_at')::timestamptz < ${now}
    )
    ORDER BY created_at ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED;
  `;

  const claimedMessages = [];

  for (const row of claimedRows) {
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    const nextAttempts = row.attempts + 1;

    const currentPayload = typeof row.payload === 'object' && row.payload !== null ? row.payload : {};
    const updatedPayload = {
      ...currentPayload,
      lease: {
        claimed_by: assignedWorkerId,
        lease_token: leaseToken,
        lease_expires_at: leaseExpiresAt,
        claimed_at: now.toISOString()
      }
    };

    await tx.outboxMessage.update({
      where: { id: row.id },
      data: {
        attempts: nextAttempts,
        payload: updatedPayload,
        updated_at: now
      }
    });

    claimedMessages.push({
      id: row.id,
      restaurant_id: row.restaurant_id,
      recipient_phone: row.recipient_phone,
      message_type: row.message_type,
      sender_channel: row.sender_channel || 'RESTAURANT',
      payload: row.payload,
      idempotency_key: row.idempotency_key,
      status: row.status,
      attempts: nextAttempts,
      leaseToken,
      leaseExpiresAt,
      workerId: assignedWorkerId
    });
  }

  return claimedMessages;
}

/**
 * Fenced update of outbox message outcome after HTTP dispatch.
 * Checks lease_token before mutating row state to fence out stale or expired workers.
 *
 * @param {Object} params
 * @param {string} params.id - Outbox message UUID
 * @param {string} params.leaseToken - Lease token acquired during claim
 * @param {Object} params.dispatchResult - Result from sendWhatsAppMessage()
 * @param {number} params.attempts - Attempt count after claim
 * @param {number} [params.maxAttempts=5]
 * @param {Object} [params.db=prisma]
 * @returns {Promise<{updated: boolean, status?: string, reason?: string}>}
 */
async function updateOutboxResult({
  id,
  leaseToken,
  dispatchResult,
  attempts,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  db = prisma
}) {
  return db.$transaction(async (tx) => {
    const currentMsg = await tx.outboxMessage.findUnique({
      where: { id }
    });

    if (!currentMsg) {
      return { updated: false, reason: 'NOT_FOUND' };
    }

    // Fencing check: Does the row still belong to this worker's leaseToken?
    const currentLeaseToken = currentMsg.payload?.lease?.lease_token;
    if (currentLeaseToken && currentLeaseToken !== leaseToken) {
      logger.warn('Outbox fenced update rejected: lease token mismatch (worker stolen or expired)', {
        id,
        workerLease: leaseToken,
        currentLease: currentLeaseToken
      });
      return { updated: false, reason: 'FENCED_OUT' };
    }

    // 1. Success Outcome: Accepted by Meta API
    if (dispatchResult.success) {
      const updatedPayload = {
        ...(currentMsg.payload || {}),
        meta_message_id: dispatchResult.metaMessageId,
        sent_at: new Date().toISOString()
      };

      await tx.outboxMessage.update({
        where: { id },
        data: {
          status: 'ACCEPTED',
          payload: updatedPayload,
          last_error: null
        }
      });

      // Update order_notifications status if present
      await tx.orderNotification.updateMany({
        where: {
          restaurant_id: currentMsg.restaurant_id,
          recipient_phone: currentMsg.recipient_phone,
          delivery_status: 'PENDING'
        },
        data: {
          delivery_status: 'SENT',
          sent_at: new Date()
        }
      });

      return { updated: true, status: 'ACCEPTED' };
    }

    // 2. Timeout / Uncertain Outcome: Meta may have received message
    if (dispatchResult.isTimeout) {
      await tx.outboxMessage.update({
        where: { id },
        data: {
          status: 'UNCERTAIN_DISPATCH',
          last_error: dispatchResult.error || 'HTTP dispatch timed out. Status uncertain.'
        }
      });
      return { updated: true, status: 'UNCERTAIN_DISPATCH' };
    }

    // 3. Terminal Failure: Non-retryable error or attempts exhausted
    if (!dispatchResult.isRetryable || attempts >= maxAttempts) {
      await tx.outboxMessage.update({
        where: { id },
        data: {
          status: 'FAILED',
          last_error: dispatchResult.error
        }
      });
      return { updated: true, status: 'FAILED' };
    }

    // 4. Retryable Failure with remaining attempts: Return to PENDING for retry
    await tx.outboxMessage.update({
      where: { id },
      data: {
        status: 'PENDING',
        last_error: dispatchResult.error
      }
    });

    return { updated: true, status: 'PENDING' };
  });
}

/**
 * Classifies outbox dispatch failures into standardized, sanitized categories.
 *
 * @param {Object} dispatchResult - Result from sendWhatsAppMessage or customSender
 * @param {string} [rawError] - Error message string
 * @returns {string} Sanitized failure category
 */
function classifyFailureCategory(dispatchResult, rawError = '') {
  const errStr = (rawError || dispatchResult?.error || '').toLowerCase();
  const statusCode = dispatchResult?.statusCode;

  if (errStr.includes('[central credential error]') || errStr.includes('missing_central_credentials') || errStr.includes('no active central whatsapp account')) {
    return 'CENTRAL_CREDENTIAL_ERROR';
  }

  if (errStr.includes('[credential error]')) {
    if (errStr.includes('begin with "eaa"') || errStr.includes('invalid whatsapp access token') || errStr.includes('format is invalid')) {
      return 'INVALID_ACCESS_TOKEN_FORMAT';
    }
    if (errStr.includes('decrypt') || errStr.includes('key mismatch') || errStr.includes('corrupted data')) {
      return 'TOKEN_DECRYPTION_FAILED';
    }
    if (errStr.includes('inactive or suspended')) {
      return 'TENANT_INACTIVE_OR_SUSPENDED';
    }
    return 'CREDENTIAL_RESOLUTION_ERROR';
  }

  if (dispatchResult?.isAuthError || statusCode === 401) {
    return 'META_AUTHENTICATION_ERROR_401';
  }

  if (dispatchResult?.isTimeout) {
    return 'DISPATCH_TIMEOUT';
  }

  if (typeof statusCode === 'number') {
    if (statusCode === 429) return 'META_RATE_LIMIT_429';
    if (statusCode >= 500) return 'META_SERVER_ERROR_5XX';
    if (statusCode >= 400) return 'META_CLIENT_ERROR_4XX';
  }

  if (errStr.includes('blocked_template_not_configured')) {
    return 'BLOCKED_TEMPLATE_NOT_CONFIGURED';
  }

  return 'DISPATCH_ERROR';
}

/**
 * High-level outbox dispatcher runner.
 * Claims messages atomically, closes DB transaction, dispatches to Meta, and fences result.
 *
 * @param {Object} [options]
 * @param {number} [options.batchSize=10]
 * @param {number} [options.maxAttempts=5]
 * @param {number} [options.leaseTtlMs=60000]
 * @param {string} [options.workerId]
 * @param {Function} [options.customSender] - Injectable sender for unit testing
 * @returns {Promise<{processedCount: number, succeededCount: number, failedCount: number, uncertainCount: number, results: Array}>}
 */
async function dispatchPendingOutboxMessages({
  batchSize = 10,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  workerId = null,
  customSender = null
} = {}) {
  // Step 1: Claim messages inside a short database transaction
  const claimed = await prisma.$transaction(async (tx) => {
    return claimPendingOutboxMessages(tx, {
      limit: batchSize,
      maxAttempts,
      leaseTtlMs,
      workerId
    });
  });

  if (claimed.length === 0) {
    return {
      processedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      uncertainCount: 0,
      results: []
    };
  }

  const results = [];
  let succeededCount = 0;
  let failedCount = 0;
  let uncertainCount = 0;

  // Step 2: Dispatch outside of any database transaction
  for (const msg of claimed) {
    let dispatchResult;

    try {
      if (customSender) {
        dispatchResult = await customSender(msg);
      } else if (msg.sender_channel === 'CENTRAL') {
        const creds = await resolveCentralCredentials({ restaurantId: msg.restaurant_id });
        dispatchResult = await sendWhatsAppMessage({
          phoneNumberId: creds.phoneNumberId,
          accessToken: creds.accessToken,
          payload: msg.payload
        });
      } else {
        const creds = await resolveRestaurantCredentials(msg.restaurant_id);
        dispatchResult = await sendWhatsAppMessage({
          phoneNumberId: creds.phoneNumberId,
          accessToken: creds.accessToken,
          payload: msg.payload
        });
      }
    } catch (err) {
      dispatchResult = {
        success: false,
        isTimeout: false,
        isRetryable: false,
        error: err.message
      };
    }

    // Step 3: Fenced result update
    const updateOutcome = await updateOutboxResult({
      id: msg.id,
      leaseToken: msg.leaseToken,
      dispatchResult,
      attempts: msg.attempts,
      maxAttempts
    });

    if (updateOutcome.status === 'ACCEPTED') succeededCount++;
    else if (updateOutcome.status === 'UNCERTAIN_DISPATCH') uncertainCount++;
    else if (updateOutcome.status === 'FAILED') failedCount++;

    // Detailed failure visibility: Log rich context for any non-successful outcome
    if (!dispatchResult.success) {
      const failureCategory = classifyFailureCategory(dispatchResult, dispatchResult.error);
      const isRetryAllowed = Boolean(dispatchResult.isRetryable && msg.attempts < maxAttempts);

      // Redact sensitive tokens from log messages
      let sanitizedError = dispatchResult.error || 'Unknown dispatch failure';
      sanitizedError = sanitizedError.replace(/EAA[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]');

      logger.warn('Outbox message dispatch failed', {
        outboxId: msg.id,
        restaurantId: msg.restaurant_id,
        senderChannel: msg.sender_channel,
        messageType: msg.message_type,
        category: failureCategory,
        statusCode: dispatchResult.statusCode || null,
        metaErrorCode: dispatchResult.metaErrorCode || null,
        isRetryable: Boolean(dispatchResult.isRetryable),
        isRetryAllowed,
        attempts: msg.attempts,
        maxAttempts,
        status: updateOutcome.status,
        error: sanitizedError
      });
    }

    results.push({
      id: msg.id,
      outcome: updateOutcome,
      dispatchResult
    });
  }

  return {
    processedCount: claimed.length,
    succeededCount,
    failedCount,
    uncertainCount,
    results
  };
}

module.exports = {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
  claimPendingOutboxMessages,
  updateOutboxResult,
  dispatchPendingOutboxMessages,
  enqueueConversationReply
};

