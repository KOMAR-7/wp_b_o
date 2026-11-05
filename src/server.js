/**
 * RESTOPRO — HTTP Server Entry Point
 */
const app = require('./app');
const config = require('./config/env');
const logger = require('./utils/logger');
const prisma = require('./config/database');

const server = app.listen(config.port, () => {
  logger.info(`RESTOPRO Backend listening on port ${config.port}`, {
    environment: config.nodeEnv,
    port: config.port,
    webhookEndpoint: `http://localhost:${config.port}/api/webhook`,
    healthEndpoint: `http://localhost:${config.port}/health`
  });
});

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down HTTP server gracefully...`);
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
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = server;
