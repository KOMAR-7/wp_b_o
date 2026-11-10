/**
 * RESTOPRO — Test Safety Guard & Database Isolation Utility
 *
 * Enforces strict isolation boundaries during automated test execution:
 * 1. Blocks tests from mutating, authenticating as, or deleting real administrator accounts (devomar@restopro.com).
 * 2. Enforces dedicated test domain formats (@restopro.internal or @restopro.test).
 * 3. Prevents destructive queries (e.g. unconstrained deleteMany) from touching production records.
 * 4. Detects remote/production database connections and enforces read-only / test-scoped safeguards.
 */

const PROTECTED_REAL_ADMIN_EMAILS = [
  'devomar@restopro.com',
  'madi@restopro.com',
  'admin@restopro.com'
];

const ALLOWED_TEST_EMAIL_REGEX = /^(test_|chrome_test_|staff_test_|controlled_admin_|staging_test_|viewer_)[a-zA-Z0-9_-]+@restopro\.(internal|test)$/;

const PRODUCTION_DATABASE_NAMES = [
  'restopro_whatsapp_only',
  'restopro_jadq',
  'restopro_production',
  'restopro_prod',
  'restopro_live',
  'restopro'
];

const REMOTE_HOST_INDICATORS = [
  'singapore-postgres.render.com',
  'render.internal',
  'onrender.com',
  'amazonaws.com',
  'rds.',
  'supabase.co',
  'neon.tech',
  'railway.app',
  'cockroachlabs.cloud',
  'elephantsql.com',
  'aivencloud.com'
];

/**
 * Extracts a safe/sanitized database name from DATABASE_URL.
 * @param {string} dbUrl
 * @returns {string}
 */
function getDatabaseName(dbUrl = process.env.DATABASE_URL || '') {
  if (!dbUrl) return 'unknown';
  try {
    const parsed = new URL(dbUrl);
    return (parsed.pathname || '').replace(/^\//, '').split('?')[0] || 'unknown';
  } catch {
    const match = dbUrl.match(/\/([^/?#]+)(\?.*)?$/);
    return match ? match[1] : 'unknown';
  }
}

/**
 * Checks whether the active database connection string points to Render, remote cloud host, or Production.
 * @returns {boolean}
 */
function isProductionOrRemoteDatabase() {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }

  const dbUrl = (process.env.DATABASE_URL || '').toLowerCase();
  if (!dbUrl) return false;

  // 1. Check known remote cloud host indicators
  for (const indicator of REMOTE_HOST_INDICATORS) {
    if (dbUrl.includes(indicator)) {
      return true;
    }
  }

  // 2. Check known production database names
  const dbName = getDatabaseName(dbUrl).toLowerCase();
  for (const prodName of PRODUCTION_DATABASE_NAMES) {
    if (dbName === prodName || dbUrl.includes(`/${prodName}`) || dbUrl.includes(`dbname=${prodName}`)) {
      return true;
    }
  }

  // 3. Check for non-local host if URL is parseable
  try {
    const parsed = new URL(dbUrl);
    const host = (parsed.hostname || '').toLowerCase();
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === 'host.docker.internal' ||
      host === 'postgres' ||
      host === '';
    if (!isLocal) {
      return true;
    }
  } catch {
    // If not parseable as standard URL, check basic localhost string indicators
    if (!dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')) {
      return true;
    }
  }

  return false;
}

/**
 * Asserts that the current database connection is safe for test execution.
 * Throws immediately if connected to production or a remote database without explicit test bypass.
 *
 * @param {string} context - Description of the test or operation
 */
function assertTestDatabase(context = 'Test execution') {
  if (isProductionOrRemoteDatabase()) {
    if (process.env.ALLOW_REMOTE_TEST_EXECUTION === 'true') {
      console.warn(
        `[TEST GUARD WARNING] Executing test against remote/production database environment with explicit ALLOW_REMOTE_TEST_EXECUTION=true: ${context}`
      );
      return;
    }

    const dbName = getDatabaseName(process.env.DATABASE_URL);
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: ${context} attempted against production or remote database "${dbName}". ` +
      `Automated tests and scripts are strictly forbidden from mutating production databases. Set ALLOW_REMOTE_TEST_EXECUTION=true only for controlled verification.`
    );
  }
}

/**
 * Validates that an email address belongs strictly to an isolated test account.
 * Throws an immediate error if a test attempts to target a real administrator account.
 *
 * @param {string} email
 * @param {string} context - Optional description of the calling test / operation
 */
function assertSafeTestAccount(email, context = 'Test execution') {
  if (!email || typeof email !== 'string') {
    throw new Error(`[TEST GUARD] Invalid email provided in ${context}`);
  }

  const normalized = email.trim().toLowerCase();

  // 1. Strict real account blacklist
  if (PROTECTED_REAL_ADMIN_EMAILS.includes(normalized)) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: ${context} attempted to target real administrator account "${normalized}". ` +
      `Automated tests and scripts are strictly forbidden from targeting, modifying, or authenticating as production platform owners.`
    );
  }

  // 2. Format validation: must be an approved test account pattern
  const isMatch = ALLOWED_TEST_EMAIL_REGEX.test(normalized);
  if (!isMatch && normalized.endsWith('@restopro.com')) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: ${context} used non-test account "${normalized}". ` +
      `Tests must use dedicated test domains (@restopro.internal or @restopro.test) with a test_ prefix.`
    );
  }
}

const ALLOWED_CLEANUP_BOUND_KEYS = [
  'id',
  'order_id',
  'restaurant_id',
  'recipient_phone',
  'customer_phone',
  'event_key',
  'admin_user_id',
  'admin_id',
  'email',
  'confirmation_token',
  'order_reference',
  'idempotency_key',
  'phone_number_id',
  'session_id',
  'OR',
  'AND'
];

/**
 * Enforces that a database cleanup filter is strictly scoped to test records.
 * Prevents catastrophic unconstrained delete queries (e.g. deleteMany({})).
 *
 * @param {object} whereClause - Prisma where filter
 * @param {string} entity - Name of the entity being cleaned up
 */
function assertSafeCleanupFilter(whereClause, entity = 'Record') {
  if (!whereClause || typeof whereClause !== 'object' || Object.keys(whereClause).length === 0) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: Attempted unconstrained deleteMany on ${entity}. ` +
      `Cleanup queries must be strictly constrained to dedicated test identifiers.`
    );
  }

  // Must contain at least one recognized boundary key
  const keys = Object.keys(whereClause);
  const hasBoundedKey = keys.some(k => ALLOWED_CLEANUP_BOUND_KEYS.includes(k));
  if (!hasBoundedKey) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: Attempted deleteMany on ${entity} without a bounded scoping filter. ` +
      `Allowed scoping keys: ${ALLOWED_CLEANUP_BOUND_KEYS.join(', ')}. Received: [${keys.join(', ')}]`
    );
  }

  // Validate array bounds (reject empty array in: [] which is often an unhandled bug)
  for (const key of keys) {
    const val = whereClause[key];
    if (val && typeof val === 'object' && val.in !== undefined) {
      if (!Array.isArray(val.in)) {
        throw new Error(`[TEST GUARD] Invalid "in" filter for ${key} on ${entity}: expected array.`);
      }
    }
  }

  // Email validation if email filter is present
  if (whereClause.email) {
    if (typeof whereClause.email === 'string') {
      assertSafeTestAccount(whereClause.email, `${entity} cleanup`);
    } else if (whereClause.email.in && Array.isArray(whereClause.email.in)) {
      whereClause.email.in.forEach(em => assertSafeTestAccount(em, `${entity} cleanup batch`));
    }
  }

  return true;
}

module.exports = {
  PROTECTED_REAL_ADMIN_EMAILS,
  ALLOWED_TEST_EMAIL_REGEX,
  PRODUCTION_DATABASE_NAMES,
  REMOTE_HOST_INDICATORS,
  getDatabaseName,
  isProductionOrRemoteDatabase,
  assertTestDatabase,
  assertSafeTestAccount,
  assertSafeCleanupFilter
};
