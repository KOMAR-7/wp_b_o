/**
 * RESTOPRO — Phase A Focused Safety & Verification Suite
 *
 * Verifies Phase A Requirements:
 * 1. Meta WhatsApp Error 132018 Fix & Positional Parameter Sanitization:
 *    - Multiple order items formatted without newlines/tabs
 *    - Multi-line customer addresses collapsed safely to single-line
 *    - Tabs and >= 4 consecutive spaces collapsed
 *    - Empty or missing parameter values receive safe fallbacks
 *    - All 6 template positional parameters strictly single-line, trimmed, and <= 1024 chars
 *
 * 2. Fail-Closed Database Initialization Guard:
 *    - Test mode with correct database (local "restopro_test") passes
 *    - Test mode with production database ("restopro_whatsapp_only") fails closed
 *    - Test mode with remote database ("singapore-postgres.render.com" / "restopro_jadq") fails closed
 *    - Test mode with remote host even if named "restopro_test" fails closed
 *    - Normal production startup continues to allow production database
 *    - Subprocess execution verification proving fail-closed database guard behavior
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

// Set in-memory approved test database connection string before importing database client
// (Guarantees isolation without mutating .env on disk)
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://whatsapp_only_test_user:test_pass@127.0.0.1:5432/restopro_test';
process.env.OWNER_CALLBACK_SECRET = process.env.OWNER_CALLBACK_SECRET || 'test_callback_secret_32_bytes_long_value_123';

// 1. Import sanitization & template building from whatsapp.service
const {
  sanitizeTemplateParam,
  buildOwnerNotificationPayload
} = require('../src/services/whatsapp.service');

// 2. Import database safety guard functions
const {
  isTestExecution,
  parseDatabaseTarget,
  enforceDatabaseSafety
} = require('../src/config/database');

console.log('============================================================');
console.log('   RESTOPRO — PHASE A FOCUSED SAFETY VERIFICATION SUITE     ');
console.log('============================================================\n');

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(`     Error: ${err.message}\n`);
    failed++;
  }
}

// =========================================================================
// PART 1: META WHATSAPP TEMPLATE PARAMETER SANITIZATION (ERROR 132018)
// =========================================================================
console.log('--- PART 1: Meta WhatsApp Template Parameter Sanitization ---');

runTest('Test 1: Multiple order items are formatted on a single line without newlines or tabs', () => {
  const items = [
    { quantity: 2, productName: 'Chicken Biryani' },
    { quantity: 1, productName: 'Butter Naan' },
    { quantity: 3, productName: 'Gulab Jamun' }
  ];

  const payload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: {
      id: 'ord-test-multi-item',
      order_reference: 'OR-9901',
      total_amount: 540,
      customer_name: 'Rahul Sharma',
      customer_phone: '919876543210',
      order_type: 'DELIVERY',
      address_snapshot: 'Flat 101, Galaxy Heights, Mumbai',
      items
    },
    useTemplate: true,
    templateName: 'restopro_order_alert'
  });

  const bodyComponent = payload.template.components.find(c => c.type === 'body');
  assert.ok(bodyComponent, 'Template body component must exist');
  
  const itemParam = bodyComponent.parameters[4]; // {{5}} is formatted items
  assert.ok(itemParam, 'Parameter {{5}} (items) must exist');
  assert.strictEqual(itemParam.type, 'text');
  
  // Verify it contains all items joined with comma-space
  assert.strictEqual(itemParam.text, '2x Chicken Biryani, 1x Butter Naan, 3x Gulab Jamun');
  // Strict Meta Error 132018 checks:
  assert.strictEqual(/[\r\n\t]/.test(itemParam.text), false, 'Parameter must not contain \\r, \\n, or \\t');
  assert.strictEqual(/[ ]{4,}/.test(itemParam.text), false, 'Parameter must not have 4+ consecutive spaces');
});

runTest('Test 2: Multi-line customer addresses are safely sanitized to single-line', () => {
  const multiLineAddress = 'Flat 402, Building 7,\nPalm Grove Residency,\r\nNear Hiranandani Metro,\nPowai, Mumbai - 400076';

  const payload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: {
      id: 'ord-test-address',
      order_reference: 'OR-9902',
      total_amount: 320,
      customer_name: 'Pooja Mehta',
      customer_phone: '919822334455',
      order_type: 'DELIVERY',
      address_snapshot: multiLineAddress,
      items: [{ quantity: 1, productName: 'Veg Thali' }]
    },
    useTemplate: true
  });

  const bodyComponent = payload.template.components.find(c => c.type === 'body');
  const addressParam = bodyComponent.parameters[3]; // {{4}} is delivery address

  assert.ok(addressParam, 'Parameter {{4}} (address) must exist');
  assert.strictEqual(/[\r\n\t]/.test(addressParam.text), false, 'Address must not contain newlines or tabs');
  assert.strictEqual(
    addressParam.text,
    'Flat 402, Building 7, Palm Grove Residency, Near Hiranandani Metro, Powai, Mumbai - 400076'
  );
});

runTest('Test 3: Tabs and excessive spaces (>= 4 consecutive spaces) are collapsed cleanly', () => {
  const dirtyInput = 'VIP\tCustomer     with    excessive     spaces';
  const sanitized = sanitizeTemplateParam(dirtyInput, 'Default');

  assert.strictEqual(/[\r\n\t]/.test(sanitized), false, 'Must strip tabs');
  assert.strictEqual(/[ ]{4,}/.test(sanitized), false, 'Must collapse 4+ consecutive spaces');
  // Should preserve meaningful content without consecutive 4+ spaces
  assert.ok(sanitized.includes('VIP Customer'));
  assert.ok(sanitized.includes('excessive'));
});

runTest('Test 4: Empty, null, undefined, or whitespace-only parameter values use safe fallbacks', () => {
  assert.strictEqual(sanitizeTemplateParam(null, 'Customer'), 'Customer');
  assert.strictEqual(sanitizeTemplateParam(undefined, 'N/A'), 'N/A');
  assert.strictEqual(sanitizeTemplateParam('', 'Fallback'), 'Fallback');
  assert.strictEqual(sanitizeTemplateParam('     ', 'Fallback'), 'Fallback');
  assert.strictEqual(sanitizeTemplateParam('\t\r\n', 'Safe Value'), 'Safe Value');

  // Verify full payload with empty order fields
  const payload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: {
      id: 'ord-empty',
      order_reference: 'OR-0000',
      customer_name: '   ',
      customer_phone: null,
      order_type: 'DELIVERY',
      address_snapshot: '',
      items: []
    },
    useTemplate: true
  });

  const params = payload.template.components.find(c => c.type === 'body').parameters;
  assert.strictEqual(params[0].text, 'Customer'); // {{1}} customerName fallback
  assert.strictEqual(params[1].text, 'N/A');      // {{2}} customerPhone fallback
  assert.strictEqual(params[2].text, 'Delivery'); // {{3}} orderType fallback
  assert.strictEqual(params[3].text, 'Address not provided'); // {{4}} deliveryAddress fallback
  assert.strictEqual(params[4].text, '1x Order Items');       // {{5}} items fallback
  assert.ok(params[5].text.includes('₹0'), '{{6}} total fallback');
});

runTest('Test 5: All 6 positional parameters are strictly single-line, trimmed, and <= 1024 characters', () => {
  const longName = 'A'.repeat(1200);
  const longAddress = 'B'.repeat(1500);

  const payload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: {
      id: 'ord-long',
      order_reference: 'OR-LONG',
      customer_name: longName,
      customer_phone: '919876543210',
      order_type: 'DELIVERY',
      address_snapshot: longAddress,
      items: [
        { quantity: 10, productName: 'Special Thali\nWith Dessert\tIncluded    Extra Large' }
      ],
      total_amount: 1500
    },
    useTemplate: true
  });

  const bodyComponent = payload.template.components.find(c => c.type === 'body');
  assert.strictEqual(bodyComponent.parameters.length, 6, 'Must have exactly 6 parameters');

  for (let i = 0; i < bodyComponent.parameters.length; i++) {
    const param = bodyComponent.parameters[i];
    assert.strictEqual(param.type, 'text', `Parameter {{${i + 1}}} must have type: text`);
    assert.ok(param.text.length > 0, `Parameter {{${i + 1}}} must not be empty`);
    assert.ok(param.text.length <= 1024, `Parameter {{${i + 1}}} must not exceed 1024 chars (actual: ${param.text.length})`);
    assert.strictEqual(/[\r\n\t]/.test(param.text), false, `Parameter {{${i + 1}}} must not have newlines or tabs`);
    assert.strictEqual(/[ ]{4,}/.test(param.text), false, `Parameter {{${i + 1}}} must not have 4+ consecutive spaces`);
  }
});

// =========================================================================
// PART 2: DATABASE INITIALIZATION SAFETY GUARD & FAIL-CLOSED ISOLATION
// =========================================================================
console.log('\n--- PART 2: Database Initialization Safety Guard & Isolation ---');

runTest('Test 6: Test mode with correct database (local "restopro_test") passes the safety guard', () => {
  const validLocalTestUrls = [
    'postgresql://whatsapp_only_test_user:test_pass@127.0.0.1:5432/restopro_test?schema=public',
    'postgresql://postgres:secret@localhost:5432/restopro_test',
    'postgresql://user:pass@host.docker.internal:5432/restopro_test'
  ];

  for (const dbUrl of validLocalTestUrls) {
    const passed = enforceDatabaseSafety('Test 6 Execution', {
      dbUrl,
      isTestOverride: true
    });
    assert.strictEqual(passed, true, `Should permit valid local test database: ${dbUrl}`);
  }
});

runTest('Test 7a: Test mode fails closed when targeting production database name ("restopro_whatsapp_only")', () => {
  const prodLocalUrl = 'postgresql://whatsapp_only_user:secret_prod_pass@127.0.0.1:5432/restopro_whatsapp_only?schema=public';

  assert.throws(
    () => {
      enforceDatabaseSafety('Production Target Test', {
        dbUrl: prodLocalUrl,
        isTestOverride: true
      });
    },
    /\[DATABASE SAFETY VIOLATION\].*rejected database "restopro_whatsapp_only"/i,
    'Must reject production database name "restopro_whatsapp_only" during test execution'
  );
});

runTest('Test 7b: Test mode fails closed when targeting remote cloud database (Render "restopro_jadq")', () => {
  const remoteUrl = 'postgresql://restopro_jadq_user:secret@dpg-dbmch3mi0phs73dl030g-a.singapore-postgres.render.com:5432/restopro_jadq';

  assert.throws(
    () => {
      enforceDatabaseSafety('Remote Render Test', {
        dbUrl: remoteUrl,
        isTestOverride: true
      });
    },
    /\[DATABASE SAFETY VIOLATION\].*rejected database "restopro_jadq"/i,
    'Must reject remote Render database during test execution'
  );
});

runTest('Test 7c: Test mode fails closed when targeting remote host even if database is named "restopro_test"', () => {
  const remoteTestDbUrl = 'postgresql://admin:pass@aws-singapore.rds.amazonaws.com:5432/restopro_test';

  assert.throws(
    () => {
      enforceDatabaseSafety('Remote Host Test', {
        dbUrl: remoteTestDbUrl,
        isTestOverride: true
      });
    },
    /\[DATABASE SAFETY VIOLATION\].*rejected database "restopro_test" on host "aws-singapore.rds.amazonaws.com"/i,
    'Must reject non-local host even if database name matches "restopro_test"'
  );
});

runTest('Test 7d: Test mode fails closed when DATABASE_URL is missing or blank', () => {
  assert.throws(
    () => {
      enforceDatabaseSafety('Missing DB URL Test', {
        dbUrl: '',
        isTestOverride: true
      });
    },
    /\[DATABASE SAFETY VIOLATION\].*DATABASE_URL is not set or empty/i,
    'Must fail closed when DATABASE_URL is empty'
  );
});

runTest('Test 8: Normal production startup continues to allow production database without test constraints', () => {
  const prodUrl = 'postgresql://whatsapp_only_user:prod_pass@127.0.0.1:5432/restopro_whatsapp_only?schema=public';

  // When isTestOverride is false (e.g. server.js running in production)
  const allowed = enforceDatabaseSafety('Production Server Startup', {
    dbUrl: prodUrl,
    isTestOverride: false
  });

  assert.strictEqual(allowed, true, 'Production startup must be permitted without throwing');
});

// =========================================================================
// PART 3: SUBPROCESS PROOF OF PRISMA GUARD FAIL-CLOSED BEHAVIOR
// =========================================================================
console.log('\n--- PART 3: Subprocess Proof of Fail-Closed Guard Behavior ---');

runTest('Test 9a: Subprocess test requiring config/database with production DB fails closed with code 1', () => {
  const childScript = `
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://whatsapp_only_user:secret@127.0.0.1:5432/restopro_whatsapp_only';
    try {
      require('./src/config/database');
      process.exit(0);
    } catch (err) {
      if (err.message.includes('[DATABASE SAFETY VIOLATION]')) {
        console.error('PROVED_FAIL_CLOSED_VIOLATION:', err.message);
        process.exit(42);
      }
      process.exit(1);
    }
  `;

  const result = spawnSync('node', ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });

  assert.strictEqual(result.status, 42, `Subprocess must exit with error status 42 (got ${result.status}). Output: ${result.stderr}`);
  assert.ok(
    result.stderr.includes('PROVED_FAIL_CLOSED_VIOLATION'),
    'Subprocess must report DATABASE SAFETY VIOLATION'
  );
});

runTest('Test 9b: Subprocess test requiring config/database with remote Render DB fails closed with code 1', () => {
  const childScript = `
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://user:secret@dpg-dbmch3mi0phs73dl030g-a.singapore-postgres.render.com:5432/restopro_jadq';
    try {
      require('./src/config/database');
      process.exit(0);
    } catch (err) {
      if (err.message.includes('[DATABASE SAFETY VIOLATION]')) {
        console.error('PROVED_FAIL_CLOSED_REMOTE_VIOLATION:', err.message);
        process.exit(43);
      }
      process.exit(1);
    }
  `;

  const result = spawnSync('node', ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });

  assert.strictEqual(result.status, 43, `Subprocess must exit with error status 43 (got ${result.status}). Output: ${result.stderr}`);
  assert.ok(
    result.stderr.includes('PROVED_FAIL_CLOSED_REMOTE_VIOLATION'),
    'Subprocess must report DATABASE SAFETY VIOLATION for remote Render DB'
  );
});

runTest('Test 9c: Subprocess test requiring config/database with approved test DB succeeds', () => {
  const childScript = `
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://whatsapp_only_test_user:test_pass@127.0.0.1:5432/restopro_test';
    const prisma = require('./src/config/database');
    if (prisma && typeof prisma.isTestExecution === 'function') {
      console.log('APPROVED_TEST_DB_INITIALIZED_SUCCESSFULLY');
      process.exit(0);
    }
    process.exit(1);
  `;

  const result = spawnSync('node', ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });

  assert.strictEqual(result.status, 0, `Subprocess must exit with code 0. Error: ${result.stderr}`);
  assert.ok(
    result.stdout.includes('APPROVED_TEST_DB_INITIALIZED_SUCCESSFULLY'),
    'Subprocess must initialize approved test database without throwing'
  );
});

runTest('Test 9d: Subprocess production startup with production DB succeeds without interference', () => {
  const childScript = `
    delete process.env.RESTOPRO_TEST_MODE;
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://whatsapp_only_user:prod_pass@127.0.0.1:5432/restopro_whatsapp_only';
    const prisma = require('./src/config/database');
    if (prisma && typeof prisma.isTestExecution === 'function') {
      console.log('PRODUCTION_DB_INITIALIZED_SUCCESSFULLY');
      process.exit(0);
    }
    process.exit(1);
  `;

  const childEnv = { ...process.env };
  delete childEnv.RESTOPRO_TEST_MODE;
  childEnv.NODE_ENV = 'production';
  childEnv.npm_lifecycle_event = 'start';

  const result = spawnSync('node', ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: childEnv
  });

  assert.strictEqual(result.status, 0, `Subprocess must exit with code 0. Error: ${result.stderr}`);
  assert.ok(
    result.stdout.includes('PRODUCTION_DB_INITIALIZED_SUCCESSFULLY'),
    'Production startup must succeed without interference from test guard'
  );
});

// =========================================================================
// SUMMARY
// =========================================================================
console.log('\n============================================================');
console.log(`PHASE A TEST RESULTS: Passed: ${passed} | Failed: ${failed}`);
console.log('============================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 ALL PHASE A SAFETY & UNIT TESTS PASSED SUCCESSFULLY!\n');
  process.exit(0);
}
