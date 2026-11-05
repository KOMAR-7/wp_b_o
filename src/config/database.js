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
  logger.error('Prisma Database Error', { message: e.message, target: e.target });
});

prisma.$on('warn', (e) => {
  logger.warn('Prisma Database Warning', { message: e.message });
});

module.exports = prisma;

