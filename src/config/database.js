/**
 * RESTOPRO — Database Client Singleton (Prisma ORM)
 * Shared across services to maintain a single connection pool.
 */
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' }
      ]
    : [{ emit: 'event', level: 'error' }]
});

prisma.$on('error', (e) => {
  // If the error is an expected idempotency conflict (e.g. unique constraint on event_key or idempotency_key),
  // suppress loud error logging as it is safely handled by application-level idempotency catch blocks.
  if (e.message && e.message.includes('Unique constraint failed') &&
      (e.message.includes('event_key') || e.message.includes('idempotency_key'))) {
    logger.debug('Prisma expected idempotency unique constraint deduplicated safely', {
      target: e.target
    });
    return;
  }
  logger.error('Prisma Database Error', { message: e.message, target: e.target });
});

prisma.$on('warn', (e) => {
  logger.warn('Prisma Database Warning', { message: e.message });
});

module.exports = prisma;

