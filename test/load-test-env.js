/**
 * RESTOPRO — Test Environment Loader & Isolation Harness
 *
 * Automatically preloaded via `node -r ./test/load-test-env.js` to ensure:
 * 1. Safe environment variable loading from `.env.test` ONLY (never defaults to `.env`).
 * 2. Strict database identity enforcement (must be restopro_test on 127.0.0.1/localhost with whatsapp_only_test_user).
 * 3. Fail-closed prevention against accidental production or remote database mutations.
 * 4. Isolation of test signing secrets (OWNER_CALLBACK_SECRET).
 * 5. Deterministic test mode configuration prior to module loading.
 */

const path = require('path');
const dotenv = require('dotenv');

// 1. Force load `.env.test` strictly
const testEnvPath = path.resolve(process.cwd(), '.env.test');
const result = dotenv.config({
  path: testEnvPath,
  override: true
});

if (result.error) {
  throw new Error(`[TEST SAFETY] Cannot load .env.test from "${testEnvPath}": ${result.error.message}`);
}

// 2. Validate mandatory DATABASE_URL
const rawDbUrl = (process.env.DATABASE_URL || '').trim();
if (!rawDbUrl) {
  throw new Error('[TEST SAFETY] DATABASE_URL is mandatory and cannot be empty during test execution.');
}

let url;
try {
  url = new URL(rawDbUrl);
} catch (err) {
  throw new Error(`[TEST SAFETY] Invalid DATABASE_URL format: ${err.message}`);
}

// 3. Strict identity validation: must be restopro_test, whatsapp_only_test_user, local host
const dbPath = (url.pathname || '').replace(/^\//, '').split('?')[0];
const dbUser = decodeURIComponent(url.username || '');
const dbHost = (url.hostname || '').toLowerCase();

const isLocalHost = dbHost === '127.0.0.1' || dbHost === 'localhost' || dbHost === 'host.docker.internal' || dbHost === 'postgres';

if (dbPath !== 'restopro_test') {
  throw new Error(
    `[TEST SAFETY] Refusing to run: database "${dbPath}" is not the dedicated test database ("restopro_test"). Production access blocked.`
  );
}

if (dbUser !== 'whatsapp_only_test_user') {
  throw new Error(
    `[TEST SAFETY] Refusing to run: database user "${dbUser}" is not the dedicated test user ("whatsapp_only_test_user"). Production access blocked.`
  );
}

if (!isLocalHost) {
  throw new Error(
    `[TEST SAFETY] Refusing to run: database host "${dbHost}" is not local. Remote database access blocked.`
  );
}

// 4. Force test environment flags
process.env.NODE_ENV = 'test';
process.env.RESTOPRO_TEST_MODE = 'true';
process.env.NOTIFICATION_ROUTING_MODE = process.env.NOTIFICATION_ROUTING_MODE || 'LEGACY';

// 5. Test callback signing secret isolation (prevents inheriting production secrets)
process.env.OWNER_CALLBACK_SECRET = process.env.OWNER_CALLBACK_SECRET || 'restopro_test_only_callback_signing_secret_2026';

// 6. Pre-register test tenant catalogue items for seeded test tenants in test mode
const { registerTenantCatalog } = require('../src/services/catalog.service');
registerTenantCatalog('a0000000-0000-0000-0000-000000000001', {
  'SKU_BIRYANI_SPL': { name: 'Special Chicken Biryani', price: 240.00 },
  'SKU_COKE_CAN': { name: 'Coke Can (330ml)', price: 60.00 },
  'SKU_PIZZA_PEPPERONI': { name: 'Pepperoni Pizza', price: 320.00 },
  'SKU_GARLIC_BREAD': { name: 'Garlic Bread', price: 110.00 },
  'SKU_BURGER': { name: 'Classic Chicken Burger', price: 120.00 },
  'SKU_PASTA': { name: 'Penne Arrabbiata', price: 300.00 },
  'SKU_ROLL': { name: 'Kathi Roll', price: 150.00 },
  'SKU_WRAP': { name: 'Chicken Wrap', price: 180.00 },
  'SKU_PIZZA_X': { name: 'Farmhouse Pizza (Large)', price: 300.00 },
  'SKU_PIZZA_LARGE': { name: 'Farmhouse Pizza (Large)', price: 450.00 },
  'SKU_PIZZA': { name: 'Veggie Pizza', price: 350.00 },
  'SKU_PANEER_TIKKA': { name: 'Paneer Tikka', price: 180.00 },
  'SKU_PANEER': { name: 'Paneer Butter Masala', price: 220.00 },
  'SKU_ROTI': { name: 'Tandoori Roti', price: 25.00 },
  'SKU_ITEM_1': { name: 'Test Item 1', price: 150.00 },
  'SKU_ITEM_2': { name: 'Test Item 2', price: 75.00 },
  'S1': { name: 'Test Item S1', price: 10.00 },
  'S2': { name: 'Test Item S2', price: 20.00 },
  'S3': { name: 'Test Item S3', price: 30.00 },
  'SKU_1': { name: 'Paneer Butter Masala', price: 150.00 },
  'SKU_2': { name: 'Butter Naan', price: 200.00 }
});
registerTenantCatalog('b0000000-0000-0000-0000-000000000002', {
  'SKU_BURGER': { name: 'Ocean Breeze Burger', price: 120.00 },
  'SKU_PIZZA': { name: 'Ocean Breeze Seafood Pizza', price: 350.00 },
  'SKU_GARLIC_BREAD': { name: 'Garlic Bread', price: 110.00 },
  'SKU_1': { name: 'Ocean Fish & Chips', price: 150.00 },
  'SKU_2': { name: 'Iced Lemon Tea', price: 200.00 }
});

console.log('[TEST SAFETY] Dedicated test database and environment verified successfully.');

module.exports = {
  dbPath,
  dbUser,
  dbHost
};
