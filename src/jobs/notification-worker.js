/**
 * RESTOPRO — Durable Outbox Notification & Background Worker
 * Stage 7: Standalone Render Background Worker Process
 *
 * Implements:
 * - Continuous polling and dispatching of pending outbox messages
 * - Distributed row-level lease claiming via PostgreSQL FOR UPDATE SKIP LOCKED
 * - Stale worker fencing with lease token verification
 * - Periodic background session cleanup & 30-min unacknowledged order timeout
 * - Clean SIGTERM/SIGINT graceful shutdown for Render deployment
 */
const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { dispatchPendingOutboxMessages } = require('../services/outbox.service');
const { cleanupExpiredSessions } = require('./session-cleanup');
const { expireUnacknowledgedOrders } = require('./order-timeout');

const DEFAULT_POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '2000', 10);
const DEFAULT_BATCH_SIZE = parseInt(process.env.OUTBOX_BATCH_SIZE || '10', 10);
const PERIODIC_TASK_INTERVAL_MS = 60 * 1000; // Run maintenance every 60 seconds

class NotificationWorker {
  constructor({
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    workerId = null,
    db = prisma
  } = {}) {
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.workerId = workerId || `render_worker_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    this.db = db;
    this.isRunning = false;
    this.isProcessing = false;
    this.pollTimer = null;
    this.lastMaintenanceRun = 0;
  }

  /**
   * Performs a single outbox processing cycle.
   */
  async processCycle(customSender = null) {
    if (this.isProcessing) return null;
    this.isProcessing = true;

    try {
      // 1. Dispatch batch of pending outbox messages
      const dispatchSummary = await dispatchPendingOutboxMessages({
        batchSize: this.batchSize,
        workerId: this.workerId,
        customSender
      });

      if (dispatchSummary.processedCount > 0) {
        const batchLog = {
          workerId: this.workerId,
          processed: dispatchSummary.processedCount,
          succeeded: dispatchSummary.succeededCount,
          uncertain: dispatchSummary.uncertainCount,
          failed: dispatchSummary.failedCount
        };

        if (dispatchSummary.failedCount > 0 || dispatchSummary.uncertainCount > 0) {
          batchLog.failures = (dispatchSummary.results || [])
            .filter(r => !r.dispatchResult?.success)
            .map(r => ({
              id: r.id,
              status: r.outcome?.status,
              isRetryable: r.dispatchResult?.isRetryable,
              error: (r.dispatchResult?.error || '').slice(0, 150)
            }));
          logger.warn('Notification worker processed outbox batch with errors', batchLog);
        } else {
          logger.info('Notification worker processed outbox batch', batchLog);
        }
      }

      // 2. Run periodic maintenance tasks (session cleanup & order timeout)
      const now = Date.now();
      if (now - this.lastMaintenanceRun >= PERIODIC_TASK_INTERVAL_MS) {
        this.lastMaintenanceRun = now;
        try {
          await cleanupExpiredSessions(this.db);
          await expireUnacknowledgedOrders({ db: this.db });
        } catch (mErr) {
          logger.warn('Periodic background maintenance warning', { error: mErr.message });
        }
      }

      return dispatchSummary;
    } catch (err) {
      logger.error('Error in notification worker process cycle', {
        workerId: this.workerId,
        error: err.message
      });
      return { error: err.message };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Triggers an immediate processing cycle if worker is idle, without waiting for next poll tick.
   */
  triggerImmediateCycle(customSender = null) {
    if (this.isRunning && !this.isProcessing) {
      setImmediate(() => {
        this.processCycle(customSender).catch(err => {
          logger.warn('Immediate outbox cycle warning', { error: err.message });
        });
      });
    }
  }

  /**
   * Starts the continuous background polling loop.
   */
  start(customSender = null) {
    if (this.isRunning) return;
    this.isRunning = true;
    setActiveWorker(this);

    logger.info('Starting RESTOPRO Render Notification Worker', {
      workerId: this.workerId,
      pollIntervalMs: this.pollIntervalMs,
      batchSize: this.batchSize
    });

    const loop = async () => {
      if (!this.isRunning) return;

      await this.processCycle(customSender);

      if (this.isRunning) {
        this.pollTimer = setTimeout(loop, this.pollIntervalMs);
      }
    };

    loop();
  }

  /**
   * Gracefully stops the worker process, allowing active cycle to complete.
   */
  async stop() {
    this.isRunning = false;
    setActiveWorker(null);

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait if a cycle is currently processing
    let waitCycles = 0;
    while (this.isProcessing && waitCycles < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitCycles++;
    }

    logger.info('Notification worker stopped cleanly', { workerId: this.workerId });
  }
}

// Module-level worker instance tracking for instantaneous cycle triggers
let activeWorkerInstance = null;

function setActiveWorker(worker) {
  activeWorkerInstance = worker;
}

function getActiveWorker() {
  return activeWorkerInstance;
}

function triggerWorkerCycle(customSender = null) {
  if (activeWorkerInstance) {
    activeWorkerInstance.triggerImmediateCycle(customSender);
  }
}

// Standalone CLI execution
if (require.main === module) {
  const worker = new NotificationWorker();
  worker.start();

  async function handleSignal(sig) {
    logger.info(`Received ${sig}. Shutting down Render Background Worker gracefully...`);
    await worker.stop();
    try {
      await prisma.$disconnect();
      logger.info('Database client disconnected cleanly.');
    } catch (e) {
      logger.error('Error during database disconnection', { error: e.message });
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
}

module.exports = {
  NotificationWorker,
  setActiveWorker,
  getActiveWorker,
  triggerWorkerCycle
};

