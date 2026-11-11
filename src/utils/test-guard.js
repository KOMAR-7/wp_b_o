/**
 * RESTOPRO — Test Safety Guard & Database Isolation Utility
 *
 * Enforces strict isolation boundaries during automated test execution:
 * 1. Blocks tests from mutating, authenticating as, or deleting real administrator accounts.
 * 2. Enforces dedicated test domain formats (@restopro.internal or @restopro.test) with approved prefixes.
 * 3. Prevents destructive queries (unconstrained deleteMany, status-only deletion) from touching production records.
 * 4. Detects remote/production database connections and enforces local test-scoped safeguards.
 */

const PROTECTED_REAL_ADMIN_EMAILS = [
  'devomar@restopro.com',
  'madi@restopro.com',
  'admin@restopro.com'
];

// Approved test accounts must use @restopro.internal or @restopro.test with approved test prefixes
const ALLOWED_TEST_EMAIL_REGEX = /^(test_|chrome_test_|staff_test_|staff_admin_|super_admin_|controlled_admin_|staging_test_|viewer_|inactive_admin_|full_admin_|nonexistent_admin|r\d+_admin_|super_admin_r\d+_|stage\d+_admin_)[a-zA-Z0-9_-]*@restopro\.(internal|test)$/i;

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

const PROTECTED_PRODUCTION_PHONES = [
  '919137361650',
  '+919137361650',
  '106734138803096', // Central phone number ID
  '1427497060448125', // RestPro phone number ID
  '918369377477',
  '+918369377477'
];

const APPROVED_TEST_EVENT_PREFIXES = [
  'evt_stage7_',
  'wamid.AUDIT_',
  'test_',
  'evt_test_'
];

const APPROVED_TEST_PHONES = [
  '919876543210',
  '+919876543210',
  '919876500077',
  '+919876500077',
  '919876500078',
  '+919876500078',
  '919876500099',
  '+919876500099',
  '919855000001',
  '919866000001',
  '919877000001',
  '919844000001',
  '919844000002',
  '919611000001',
  '919622000002',
  '919633000003',
  '919811000001',
  '919822999902',
  '919833999903',
  '111111111111111',
  '222222222222222',
  '999888777000',
  '111333555777',
  '111333555888'
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
 * Extracts the database hostname from DATABASE_URL.
 * @param {string} dbUrl
 * @returns {string}
 */
function getDatabaseHost(dbUrl = process.env.DATABASE_URL || '') {
  if (!dbUrl) return 'unknown';
  try {
    const parsed = new URL(dbUrl);
    return (parsed.hostname || '').toLowerCase();
  } catch {
    const match = dbUrl.match(/@([^:/]+)/);
    return match ? match[1].toLowerCase() : 'unknown';
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

  for (const indicator of REMOTE_HOST_INDICATORS) {
    if (dbUrl.includes(indicator)) {
      return true;
    }
  }

  const dbName = getDatabaseName(dbUrl).toLowerCase();
  for (const prodName of PRODUCTION_DATABASE_NAMES) {
    if (dbName === prodName || dbUrl.includes(`/${prodName}`) || dbUrl.includes(`dbname=${prodName}`)) {
      return true;
    }
  }

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
    if (!dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')) {
      return true;
    }
  }

  return false;
}

/**
 * Asserts that the current database connection is safe for test execution.
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
      `Automated tests and scripts are strictly forbidden from mutating production databases.`
    );
  }
}

/**
 * Strict whitelist guard: rejects every database except the dedicated local "restopro_test" database.
 * @param {string} context - Description of the test or operation
 */
function assertTestDatabaseWhitelist(context = 'Test execution') {
  if (process.env.ALLOW_REMOTE_TEST_EXECUTION === 'true') {
    console.warn(
      `[TEST GUARD WARNING] Executing test with explicit ALLOW_REMOTE_TEST_EXECUTION=true: ${context}`
    );
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: ${context} attempted while NODE_ENV=production. ` +
      `Automated tests are strictly forbidden from running in production mode.`
    );
  }

  const dbUrl = process.env.DATABASE_URL || '';
  const dbName = getDatabaseName(dbUrl).toLowerCase();
  const dbHost = getDatabaseHost(dbUrl).toLowerCase();

  const isLocalHost =
    dbHost === 'localhost' ||
    dbHost === '127.0.0.1' ||
    dbHost === '0.0.0.0' ||
    dbHost === 'host.docker.internal' ||
    dbHost === 'postgres' ||
    dbHost === '';

  if (!isLocalHost || dbName !== 'restopro_test') {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: ${context} rejected database "${dbName}" on host "${dbHost}". ` +
      `The test loader rejects every database except the dedicated local "restopro_test" database.`
    );
  }
}

/**
 * Validates that an email address belongs strictly to an isolated test account.
 * Throws an immediate error if a test attempts to target a real administrator account
 * or any non-whitelisted domain or pattern.
 *
 * @param {string} email
 * @param {string} context - Optional description of the calling test / operation
 */
function assertSafeTestAccount(email, context = 'Test execution') {
  if (!email || typeof email !== 'string') {
    throw new Error(`[TEST GUARD] Invalid email provided in ${context}`);
  }

  const normalized = email.trim().toLowerCase();

  // 1. Strict real administrator blacklist
  if (PROTECTED_REAL_ADMIN_EMAILS.includes(normalized)) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: ${context} attempted to target real administrator account "${normalized}". ` +
      `Automated tests and scripts are strictly forbidden from targeting, modifying, or authenticating as production platform owners.`
    );
  }

  // 2. Reject all production restopro.com addresses
  if (normalized.endsWith('@restopro.com')) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: ${context} used production domain "@restopro.com" ("${normalized}"). ` +
      `Tests must use dedicated test domains (@restopro.internal or @restopro.test) with an approved test prefix.`
    );
  }

  // 3. Strict whitelist enforcement: only approved test domains and naming patterns allowed
  if (!ALLOWED_TEST_EMAIL_REGEX.test(normalized)) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: ${context} used unapproved email "${normalized}". ` +
      `Only approved test accounts on @restopro.internal or @restopro.test with approved test prefixes are permitted.`
    );
  }

  return true;
}

const ALLOWED_CLEANUP_BOUND_KEYS = [
  'id',
  'order_id',
  'restaurant_id',
  'recipient_phone',
  'customer_phone',
  'phone_number_id',
  'event_key',
  'admin_user_id',
  'admin_id',
  'email',
  'confirmation_token',
  'order_reference',
  'idempotency_key',
  'session_id'
];

/**
 * Enforces that a database cleanup filter is strictly scoped to test records.
 * Prevents catastrophic unconstrained delete queries (e.g. deleteMany({}))
 * and broad status-only or production-wide cleanup.
 *
 * @param {object} whereClause - Prisma where filter
 * @param {string} entity - Name of the entity being cleaned up
 */
function assertSafeCleanupFilter(whereClause, entity = 'Record') {
  if (!whereClause || typeof whereClause !== 'object' || Array.isArray(whereClause)) {
    throw new Error(`[TEST GUARD] CRITICAL SAFETY VIOLATION: Invalid cleanup filter for ${entity}. Expected an object.`);
  }

  const keys = Object.keys(whereClause);
  if (keys.length === 0) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: Attempted unconstrained deleteMany on ${entity} with empty filter {}. ` +
      `Cleanup queries must be strictly constrained to dedicated test identifiers.`
    );
  }

  // Block status-only or broad metadata-only deletions
  const disallowStatusOnly = keys.every(k => ['status', 'is_active', 'created_at', 'updated_at', 'type'].includes(k));
  if (disallowStatusOnly) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: Attempted status-only cleanup on ${entity} ([${keys.join(', ')}]). ` +
      `Cleanup must be strictly constrained to specific test-created IDs or test identifiers.`
    );
  }

  // Must contain at least one recognized boundary key
  const hasBoundedKey = keys.some(k => ALLOWED_CLEANUP_BOUND_KEYS.includes(k) || k === 'OR' || k === 'AND');
  if (!hasBoundedKey) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: Attempted deleteMany on ${entity} without a recognized boundary key. ` +
      `Allowed scoping keys: ${ALLOWED_CLEANUP_BOUND_KEYS.join(', ')}. Received: [${keys.join(', ')}]`
    );
  }

  // Validate array bounds and values for all provided keys
  for (const key of keys) {
    const val = whereClause[key];

    // Check "in" filter: must be non-empty array of valid strings
    if (val && typeof val === 'object' && val.in !== undefined) {
      if (!Array.isArray(val.in)) {
        throw new Error(`[TEST GUARD] Invalid "in" filter for ${key} on ${entity}: expected array.`);
      }
      if (val.in.length === 0) {
        throw new Error(`[TEST GUARD] CRITICAL SAFETY VIOLATION: Empty "in: []" filter for ${key} on ${entity}.`);
      }
      if (val.in.some(item => typeof item !== 'string' || !item.trim())) {
        throw new Error(`[TEST GUARD] CRITICAL SAFETY VIOLATION: "in" filter for ${key} on ${entity} contains invalid non-string or empty elements.`);
      }

      // Check phone numbers inside "in"
      if (['recipient_phone', 'customer_phone', 'phone_number_id'].includes(key)) {
        for (const phone of val.in) {
          const cleanPhone = phone.replace(/[^\d]/g, '');
          if (PROTECTED_PRODUCTION_PHONES.includes(cleanPhone) || PROTECTED_PRODUCTION_PHONES.includes(phone)) {
            throw new Error(`[TEST GUARD] CRITICAL SAFETY VIOLATION: Attempted cleanup targeting protected production phone "${phone}".`);
          }
        }
      }
    }

    // Check direct phone number filters
    if (['recipient_phone', 'customer_phone', 'phone_number_id'].includes(key) && typeof val === 'string') {
      const cleanPhone = val.replace(/[^\d]/g, '');
      if (PROTECTED_PRODUCTION_PHONES.includes(cleanPhone) || PROTECTED_PRODUCTION_PHONES.includes(val)) {
        throw new Error(`[TEST GUARD] CRITICAL SAFETY VIOLATION: Attempted cleanup targeting protected production phone "${val}".`);
      }
    }

    // Check event_key startsWith filters
    if (key === 'event_key' && val && typeof val === 'object' && val.startsWith !== undefined) {
      const prefix = val.startsWith;
      const isApprovedPrefix = APPROVED_TEST_EVENT_PREFIXES.some(appPrefix => prefix.startsWith(appPrefix) || prefix === appPrefix);
      if (!isApprovedPrefix) {
        throw new Error(
          `[TEST GUARD] CRITICAL SAFETY VIOLATION: Unapproved event_key prefix "${prefix}" on ${entity}. ` +
          `Allowed prefixes: ${APPROVED_TEST_EVENT_PREFIXES.join(', ')}`
        );
      }
    }

    // Email validation if email filter is present
    if (key === 'email') {
      if (typeof val === 'string') {
        assertSafeTestAccount(val, `${entity} cleanup`);
      } else if (val && val.in && Array.isArray(val.in)) {
        val.in.forEach(em => assertSafeTestAccount(em, `${entity} cleanup batch`));
      }
    }
  }

  return true;
}

module.exports = {
  PROTECTED_REAL_ADMIN_EMAILS,
  ALLOWED_TEST_EMAIL_REGEX,
  PRODUCTION_DATABASE_NAMES,
  REMOTE_HOST_INDICATORS,
  PROTECTED_PRODUCTION_PHONES,
  APPROVED_TEST_EVENT_PREFIXES,
  APPROVED_TEST_PHONES,
  ALLOWED_CLEANUP_BOUND_KEYS,
  getDatabaseName,
  getDatabaseHost,
  isProductionOrRemoteDatabase,
  assertTestDatabase,
  assertTestDatabaseWhitelist,
  assertSafeTestAccount,
  assertSafeCleanupFilter
};
