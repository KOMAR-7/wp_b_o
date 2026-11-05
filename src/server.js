/**
 * RESTOPRO — HTTP Server Entry Point
 */
const app = require('./app');
const config = require('./config/env');
const logger = require('./utils/logger');
const prisma = require('./config/database');

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`RESTOPRO Backend listening on port ${config.port}`, {
    environment: config.nodeEnv,
    port: config.port,
    webhookEndpoint: `http://localhost:${config.port}/api/webhook`,
    healthEndpoint: `http://localhost:${config.port}/health`
  });
});

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down HTTP server gracefully...`);

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

module.exports = server;
