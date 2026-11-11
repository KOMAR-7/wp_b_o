/**
 * RESTOPRO — Unit Test Suite for Test Safety Guard & Cleanup Filter Validation
 */

const assert = require('assert');
const {
  assertSafeTestAccount,
  assertSafeCleanupFilter,
  PROTECTED_REAL_ADMIN_EMAILS
} = require('../src/utils/test-guard');

console.log('============================================================');
console.log('   RESTOPRO — TEST GUARD & CLEANUP FILTER UNIT TESTS        ');
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
// PART 1: TEST ACCOUNT EMAIL VALIDATION
// =========================================================================
console.log('--- PART 1: Test Account Email Validation ---');

runTest('TG-01: Approved test account naming patterns on @restopro.internal pass', () => {
  const validEmails = [
    'test_admin_12345@restopro.internal',
    'chrome_test_user@restopro.internal',
    'staff_test_manager@restopro.internal',
    'staff_admin_456@restopro.internal',
    'super_admin_999@restopro.internal',
    'controlled_admin_1@restopro.internal',
    'staging_test_runner@restopro.internal',
    'viewer_observer@restopro.internal',
    'inactive_admin_789@restopro.internal',
    'full_admin_suite@restopro.internal',
    'nonexistent_admin@restopro.internal',
    'r610_admin_173132@restopro.internal',
    'r69_admin_998877@restopro.internal',
    'super_admin_r68_1234@restopro.internal',
    'stage11_admin_5544@restopro.internal'
  ];

  for (const email of validEmails) {
    assert.strictEqual(assertSafeTestAccount(email, 'Valid Internal Test'), true);
  }
});

runTest('TG-02: Approved test account naming patterns on @restopro.test pass', () => {
  const validEmails = [
    'test_runner@restopro.test',
    'super_admin_ci@restopro.test',
    'viewer_audit@restopro.test'
  ];

  for (const email of validEmails) {
    assert.strictEqual(assertSafeTestAccount(email, 'Valid Test Domain'), true);
  }
});

runTest('TG-03: Real administrator emails are strictly rejected', () => {
  for (const admin of PROTECTED_REAL_ADMIN_EMAILS) {
    assert.throws(
      () => assertSafeTestAccount(admin, 'Real Admin Check'),
      /CRITICAL SAFETY VIOLATION.*real administrator account/i,
      `Must reject real admin email ${admin}`
    );
  }
});

runTest('TG-04: Non-test accounts on @restopro.com are strictly rejected', () => {
  const invalidProdEmails = [
    'test@restopro.com',
    'john.doe@restopro.com',
    'finance@restopro.com',
    'support@restopro.com'
  ];

  for (const email of invalidProdEmails) {
    assert.throws(
      () => assertSafeTestAccount(email, 'Prod Domain Check'),
      /CRITICAL SAFETY VIOLATION.*production domain "@restopro\.com"/i,
      `Must reject production restopro.com address ${email}`
    );
  }
});

runTest('TG-05: Non-whitelisted external domains are strictly rejected', () => {
  const externalEmails = [
    'attacker@gmail.com',
    'test_admin@yahoo.com',
    'hacker@malicious.io',
    'dev@company.org'
  ];

  for (const email of externalEmails) {
    assert.throws(
      () => assertSafeTestAccount(email, 'External Domain Check'),
      /CRITICAL SAFETY VIOLATION.*used unapproved email/i,
      `Must reject external domain email ${email}`
    );
  }
});

runTest('TG-06: Unapproved prefix on @restopro.internal is strictly rejected', () => {
  const badPrefixEmails = [
    'ceo@restopro.internal',
    'real_user@restopro.internal',
    'marketing_lead@restopro.internal'
  ];

  for (const email of badPrefixEmails) {
    assert.throws(
      () => assertSafeTestAccount(email, 'Bad Prefix Check'),
      /CRITICAL SAFETY VIOLATION.*used unapproved email/i,
      `Must reject unapproved prefix ${email}`
    );
  }
});

// =========================================================================
// PART 2: CLEANUP FILTER VALIDATION
// =========================================================================
console.log('\n--- PART 2: Cleanup Filter Validation ---');

runTest('TG-07: Valid ID-scoped cleanup filters pass', () => {
  assert.strictEqual(assertSafeCleanupFilter({ id: { in: ['ord-1', 'ord-2'] } }, 'Order'), true);
  assert.strictEqual(assertSafeCleanupFilter({ id: 'ord-single' }, 'Order'), true);
  assert.strictEqual(assertSafeCleanupFilter({ order_id: { in: ['ord-1'] } }, 'OrderNotification'), true);
  assert.strictEqual(assertSafeCleanupFilter({ restaurant_id: { in: ['rest-1'] } }, 'OutboxMessage'), true);
  assert.strictEqual(assertSafeCleanupFilter({ admin_id: { in: ['admin-1'] } }, 'AdminSession'), true);
  assert.strictEqual(assertSafeCleanupFilter({ admin_user_id: { in: ['admin-1'] } }, 'AuditLog'), true);
  assert.strictEqual(assertSafeCleanupFilter({ session_id: { in: ['sess-1'] } }, 'Session'), true);
});

runTest('TG-08: Valid event-key and phone cleanup filters pass', () => {
  assert.strictEqual(assertSafeCleanupFilter({ event_key: { in: ['evt_1', 'evt_2'] } }, 'WebhookEvent'), true);
  assert.strictEqual(assertSafeCleanupFilter({ event_key: { startsWith: 'evt_stage7_' } }, 'WebhookEvent'), true);
  assert.strictEqual(assertSafeCleanupFilter({ event_key: { startsWith: 'wamid.AUDIT_' } }, 'WebhookEvent'), true);
  assert.strictEqual(assertSafeCleanupFilter({ recipient_phone: { in: ['919876543210', '919876500077'] } }, 'OutboxMessage'), true);
  assert.strictEqual(assertSafeCleanupFilter({ customer_phone: '919876500077' }, 'Order'), true);
});

runTest('TG-09: Empty filters and invalid types fail closed', () => {
  assert.throws(
    () => assertSafeCleanupFilter({}, 'Record'),
    /empty filter/i,
    'Must reject empty filter {}'
  );
  assert.throws(
    () => assertSafeCleanupFilter(null, 'Record'),
    /Invalid cleanup filter/i,
    'Must reject null filter'
  );
  assert.throws(
    () => assertSafeCleanupFilter([], 'Record'),
    /Invalid cleanup filter/i,
    'Must reject array filter'
  );
});

runTest('TG-10: Status-only deletion is strictly blocked', () => {
  assert.throws(
    () => assertSafeCleanupFilter({ status: 'PENDING' }, 'OutboxMessage'),
    /Attempted status-only cleanup/i,
    'Must reject status-only deletion'
  );
  assert.throws(
    () => assertSafeCleanupFilter({ status: 'DELIVERED', is_active: false }, 'Record'),
    /Attempted status-only cleanup/i,
    'Must reject combined metadata-only deletion'
  );
});

runTest('TG-11: Empty array in "in: []" filter fails closed', () => {
  assert.throws(
    () => assertSafeCleanupFilter({ id: { in: [] } }, 'Order'),
    /Empty "in: \[\]" filter/i,
    'Must reject empty array in "in" filter'
  );
});

runTest('TG-12: Target targeting protected production phone numbers fails closed', () => {
  assert.throws(
    () => assertSafeCleanupFilter({ recipient_phone: '919137361650' }, 'OutboxMessage'),
    /targeting protected production phone/i,
    'Must reject Central WhatsApp phone deletion'
  );
  assert.throws(
    () => assertSafeCleanupFilter({ phone_number_id: '106734138803096' }, 'CentralAccount'),
    /targeting protected production phone/i,
    'Must reject Central phone number ID deletion'
  );
});

runTest('TG-13: Unapproved broad event_key prefix fails closed', () => {
  assert.throws(
    () => assertSafeCleanupFilter({ event_key: { startsWith: 'wamid.' } }, 'WebhookEvent'),
    /Unapproved event_key prefix/i,
    'Must reject broad wamid. prefix'
  );
  assert.throws(
    () => assertSafeCleanupFilter({ event_key: { startsWith: 'evt_' } }, 'WebhookEvent'),
    /Unapproved event_key prefix/i,
    'Must reject broad evt_ prefix'
  );
});

console.log('\n============================================================');
console.log(`TEST GUARD UNIT RESULTS: Passed: ${passed} | Failed: ${failed}`);
console.log('============================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 ALL TEST GUARD UNIT TESTS PASSED SUCCESSFULLY!\n');
  process.exit(0);
}
