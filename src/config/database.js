/**
 * RESTOPRO — Database Client Singleton (Prisma ORM)
 * Shared across services to maintain a single connection pool.
 *
 * Includes fail-closed database safety guard to ensure automated tests
 * cannot connect to, mutate, or seed production or remote databases.
 */
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

/**
 * Detects whether the current process is executing as part of an automated test,
 * test runner, or test script. Uses defense-in-depth across multiple signals:
 * - process.env.NODE_ENV === 'test' or 'testing'
 * - process.env.RESTOPRO_TEST_MODE === 'true'
 * - process.env.npm_lifecycle_event containing 'test'
 * - Entry point file path (require.main / process.argv[1]) residing within /test/ or named *.test.js / *.spec.js
 * - Command-line arguments targeting test paths or known test runners (jest, mocha, vitest, ava, playwright, cypress)
 * - Global test runner functions (describe + it)
 *
 * @returns {boolean} true if running in a test process
 */
function isTestProcess() {
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'testing') {
    return true;
  }
  if (process.env.RESTOPRO_TEST_MODE === 'true') {
    return true;
  }
  const lifecycle = (process.env.npm_lifecycle_event || '').toLowerCase();
  if (lifecycle === 'test' || lifecycle.startsWith('test:') || lifecycle.includes('test')) {
    return true;
  }
  const mainFile = (require.main && require.main.filename)
    ? require.main.filename.replace(/\\/g, '/')
    : '';
  if (mainFile.includes('/test/') || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(mainFile)) {
    return true;
  }
  for (const arg of process.argv) {
    if (typeof arg !== 'string') continue;
    const normalized = arg.replace(/\\/g, '/').toLowerCase();
    if (
      normalized.includes('/test/') ||
      /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized) ||
      /\b(jest|mocha|ava|vitest|playwright|cypress)\b/i.test(normalized)
    ) {
      return true;
    }
  }
  if (typeof global.describe === 'function' && typeof global.it === 'function') {
    return true;
  }
  return false;
}

/**
 * Safely parses the database name and host from a database connection string.
 *
 * @param {string} [dbUrl]
 * @returns {{ dbName: string, dbHost: string, isLocalHost: boolean }}
 */
function parseDatabaseTarget(dbUrl = process.env.DATABASE_URL || '') {
  if (!dbUrl || typeof dbUrl !== 'string') {
    return { dbName: '', dbHost: '', isLocalHost: false };
  }
  let dbName = '';
  let dbHost = '';
  try {
    const parsed = new URL(dbUrl);
    dbName = (parsed.pathname || '').replace(/^\//, '').split('?')[0] || '';
    dbHost = (parsed.hostname || '').toLowerCase();
  } catch {
    const nameMatch = dbUrl.match(/\/([^/?#]+)(\?.*)?$/);
    dbName = nameMatch ? nameMatch[1] : '';
    const hostMatch = dbUrl.match(/@([^:/]+)/);
    dbHost = hostMatch ? hostMatch[1].toLowerCase() : '';
  }
  const isLocalHost =
    dbHost === 'localhost' ||
    dbHost === '127.0.0.1' ||
    dbHost === '0.0.0.0' ||
    dbHost === 'host.docker.internal' ||
    dbHost === 'postgres' ||
    dbHost === '';

  return { dbName: dbName.toLowerCase(), dbHost, isLocalHost };
}

/**
 * Enforces fail-closed test database isolation on initialization.
 * Prevents automated tests from ever connecting to, mutating, or seeding
 * production or remote databases.
 *
 * @param {string} [context='Database Client Initialization']
 * @param {object} [options]
 * @param {string} [options.dbUrl] - Optional URL override for testing/validation
 * @param {boolean} [options.isTestOverride] - Optional test detection override for testing/validation
 * @returns {boolean} true if validation passes
 * @throws {Error} [DATABASE SAFETY VIOLATION] if a test targets a non-test database
 */
function enforceDatabaseSafety(context = 'Database Client Initialization', { dbUrl, isTestOverride } = {}) {
  const isTest = typeof isTestOverride === 'boolean' ? isTestOverride : isTestProcess();
  if (!isTest) {
    // Normal runtime/production startup permitted without test isolation constraints
    return true;
  }

  const effectiveUrl = dbUrl !== undefined ? dbUrl : (process.env.DATABASE_URL || '');
  if (!effectiveUrl || !effectiveUrl.trim()) {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] ${context}: DATABASE_URL is not set or empty during test execution. Tests must explicitly target the dedicated local "restopro_test" database.`
    );
  }

  const { dbName, dbHost, isLocalHost } = parseDatabaseTarget(effectiveUrl);

  if (!isLocalHost || dbName !== 'restopro_test') {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] ${context}: Test process rejected database "${dbName || 'unknown'}" on host "${dbHost || 'unknown'}". ` +
      `Automated tests are strictly forbidden from connecting to production, remote, or non-test databases. ` +
      `Tests are restricted exclusively to the local "restopro_test" database.`
    );
  }

  return true;
}

// Enforce fail-closed database safety guard BEFORE PrismaClient is instantiated
enforceDatabaseSafety('Prisma Client Initialization');

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

// Attach safety utilities to prisma instance and exports for inspection and test verification
prisma.isTestExecution = isTestProcess;
prisma.parseDatabaseTarget = parseDatabaseTarget;
prisma.enforceDatabaseSafety = enforceDatabaseSafety;

module.exports = prisma;
module.exports.isTestExecution = isTestProcess;
module.exports.parseDatabaseTarget = parseDatabaseTarget;
module.exports.enforceDatabaseSafety = enforceDatabaseSafety;
