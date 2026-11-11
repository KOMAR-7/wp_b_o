/**
 * RESTOPRO — HTTP Server Entry Point
 */
const app = require('./app');
const config = require('./config/env');
const logger = require('./utils/logger');
const prisma = require('./config/database');
const { NotificationWorker } = require('./jobs/notification-worker');

let worker = null;

// Start in-process notification worker unless explicitly disabled or running isolated tests
if (process.env.ENABLE_BACKGROUND_WORKER !== 'false' && process.env.NODE_ENV !== 'test') {
  worker = new NotificationWorker();
  worker.start();
  logger.info('In-process NotificationWorker started alongside Express HTTP server.');
}

const bindHost = process.env.HOST || (config.nodeEnv === 'production' ? '127.0.0.1' : '0.0.0.0');

const server = app.listen(config.port, bindHost, () => {
  logger.info(`RESTOPRO Backend listening on ${bindHost}:${config.port}`, {
    environment: config.nodeEnv,
    host: bindHost,
    port: config.port,
    webhookEndpoint: `http://${bindHost}:${config.port}/api/webhook`,
    healthEndpoint: `http://${bindHost}:${config.port}/health`
  });
});

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down HTTP server gracefully...`);

  // Stop background worker first so in-flight work completes and polling halts
  if (worker) {
    try {
      await worker.stop();
      logger.info('In-process NotificationWorker stopped cleanly.');
    } catch (wErr) {
      logger.warn('Warning during notification worker stop', { error: wErr.message });
    }
  }

  // Close idle keep-alive connections if supported (Node.js 18.2+)
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  server.close(async () => {
    try {
      await prisma.$disconnect();
      logger.info('Prisma database client disconnected cleanly.');
    } catch (err) {
      logger.error('Error during database disconnection', { error: err.message });
    }
    logger.info('HTTP server closed successfully.');
    process.exit(0);
  });

  // Force close after 10 seconds if hanging
  setTimeout(() => {
    logger.error('Forceful shutdown triggered after 10s timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('message', (msg) => {
  if (msg === 'shutdown' || msg === 'SIGTERM') {
    gracefulShutdown('PM2_SHUTDOWN');
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception thrown', {
    error: err.message,
    stack: err.stack
  });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

server.worker = worker;

module.exports = server;
