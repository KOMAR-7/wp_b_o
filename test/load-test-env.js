/**
 * RESTOPRO — Test Environment Loader & Isolation Harness
 *
 * Automatically included or required by automated test suites to ensure:
 * 1. Safe environment variable loading (.env.test prioritized over .env).
 * 2. Fail-closed prevention against accidental production or remote database mutations.
 * 3. Centralized export of test isolation guards and safety checkers.
 */

const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

const testEnvPath = path.resolve(process.cwd(), '.env.test');
const defaultEnvPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(testEnvPath)) {
  dotenv.config({ path: testEnvPath, override: true });
} else if (fs.existsSync(defaultEnvPath)) {
  dotenv.config({ path: defaultEnvPath });
}

// Force NODE_ENV to 'test' if unset or development
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
  process.env.NODE_ENV = 'test';
}

const {
  PROTECTED_REAL_ADMIN_EMAILS,
  ALLOWED_TEST_EMAIL_REGEX,
  isProductionOrRemoteDatabase,
  assertTestDatabase,
  assertTestDatabaseWhitelist,
  assertSafeTestAccount,
  assertSafeCleanupFilter,
  getDatabaseName,
  getDatabaseHost
} = require('../src/utils/test-guard');

// Enforce strict test database whitelist on initialization (restopro_test only)
assertTestDatabaseWhitelist('Test Environment Loader');

module.exports = {
  PROTECTED_REAL_ADMIN_EMAILS,
  ALLOWED_TEST_EMAIL_REGEX,
  isProductionOrRemoteDatabase,
  assertTestDatabase,
  assertTestDatabaseWhitelist,
  assertSafeTestAccount,
  assertSafeCleanupFilter,
  getDatabaseName,
  getDatabaseHost
};

