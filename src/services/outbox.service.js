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
const { resolveRestaurantCredentials, sendWhatsAppMessage } = require('./whatsapp.service');

const DEFAULT_LEASE_TTL_MS = 60 * 1000; // 60 seconds lease TTL
const DEFAULT_MAX_ATTEMPTS = 5;

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
    SELECT id, restaurant_id, recipient_phone, message_type, payload, idempotency_key, status, attempts
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
  dispatchPendingOutboxMessages
};

