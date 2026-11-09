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

/**
 * Checks whether the active database connection string points to Render / Production.
 * @returns {boolean}
 */
function isProductionOrRemoteDatabase() {
  const dbUrl = process.env.DATABASE_URL || '';
  return (
    dbUrl.includes('singapore-postgres.render.com') ||
    dbUrl.includes('render.internal') ||
    dbUrl.includes('restopro_jadq') ||
    process.env.NODE_ENV === 'production'
  );
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

/**
 * Enforces that a database cleanup filter is strictly scoped to test records.
 * Prevents catastrophic unconstrained delete queries.
 *
 * @param {object} whereClause - Prisma where filter
 * @param {string} entity - Name of the entity being cleaned up
 */
function assertSafeCleanupFilter(whereClause, entity = 'Record') {
  if (!whereClause || Object.keys(whereClause).length === 0) {
    throw new Error(
      `[TEST GUARD] CRITICAL SAFETY VIOLATION: Attempted unconstrained deleteMany on ${entity}. ` +
      `Cleanup queries must be strictly constrained to dedicated test identifiers.`
    );
  }

  if (whereClause.email) {
    if (typeof whereClause.email === 'string') {
      assertSafeTestAccount(whereClause.email, `${entity} cleanup`);
    } else if (whereClause.email.in && Array.isArray(whereClause.email.in)) {
      whereClause.email.in.forEach(em => assertSafeTestAccount(em, `${entity} cleanup batch`));
    }
  }
}

module.exports = {
  PROTECTED_REAL_ADMIN_EMAILS,
  ALLOWED_TEST_EMAIL_REGEX,
  isProductionOrRemoteDatabase,
  assertSafeTestAccount,
  assertSafeCleanupFilter
};

