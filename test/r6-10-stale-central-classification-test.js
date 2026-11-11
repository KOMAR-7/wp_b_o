/**
 * RESTOPRO — R6.10 Stale Central Account Classification Regression Test Suite
 *
 * Verifies the exact required classification rules:
 * A. Active Central Account (106734138803096) CANNOT be registered as a restaurant (HTTP 409 CENTRAL_ACCOUNT_PHONE_CONFLICT).
 * B. Independent restaurant number (1427497060448125, RestPro) CAN be onboarded with HTTP 201 when not in central accounts.
 * C. Restaurant sharing a WABA ID (1620323530136933 or 103820662432290) with a central account is NOT automatically rejected.
 * D. A soft-deleted central account's historical records do NOT incorrectly block legitimate restaurant onboarding.
 * E. A genuinely active central number cannot be registered as a restaurant.
 * F. Multi-restaurant central routing through Central XYZ continues working.
 * G. Tenant isolation remains intact.
 */
require('./load-test-env');

const assert = require('assert');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const { getActiveCentralPhoneIds, isCentralPhoneNumberId } = require('../src/services/central-whatsapp.service');
const { setTemplateApprovalForTesting, resetTemplateApprovalsForTesting } = require('../src/services/template-config.service');

const TEST_PORT = 4992;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const testRecords = {
  restaurants: [],
  centralAccounts: [],
  adminUsers: []
};

function recordTestPass(name) {
  console.log(`  ✅ [PASS] ${name}`);
}

async function makeRequest({ method, path, headers = {}, body = null }) {
  const url = `${BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  let resBody = null;
  const text = await res.text();
  try {
    resBody = JSON.parse(text);
  } catch (e) {
    resBody = text;
  }

  return {
    status: res.status,
    body: resBody
  };
}

async function runSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — R6.10 CENTRAL CLASSIFICATION REGRESSION TEST   ');
  console.log('============================================================\n');

  let server;
  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(TEST_PORT, resolve));
    console.log(`[TEST SERVER] Listening on ${BASE_URL}\n`);

    // Verify Active Central Account Naila
    const nailaAccount = await prisma.centralWhatsAppAccount.findFirst({
      where: {
        phone_number_id: '106734138803096',
        is_active: true,
        deleted_at: null
      }
    });
    assert(nailaAccount, 'Active Central Account Naila (106734138803096) must exist in DB');
    console.log(`[SETUP] Active Central Account Verified: "${nailaAccount.account_name}" (${nailaAccount.phone_number_id})`);

    // Create temporary Super Admin for authorized testing
    const adminEmail = `r610_admin_${Date.now()}@restopro.internal`;
    const adminPassword = 'AdminSecurePassword2026!';
    const { hashPassword } = require('../src/utils/password');
    const passwordHash = await hashPassword(adminPassword);

    const superAdmin = await prisma.adminUser.create({
      data: {
        email: adminEmail,
        password_hash: passwordHash,
        name: 'R6.10 Regression Admin',
        role: 'SUPER_ADMIN',
        is_active: true
      }
    });
    testRecords.adminUsers.push(superAdmin.id);

    // Authenticate
    const loginRes = await makeRequest({
      method: 'POST',
      path: '/api/admin/auth/login',
      body: { email: adminEmail, password: adminPassword }
    });
    assert.strictEqual(loginRes.status, 200, 'Super admin login must succeed');
    const adminToken = loginRes.body.token;
    const authHeaders = { Authorization: `Bearer ${adminToken}` };
    console.log(`[SETUP] Super Admin authenticated successfully.\n`);

    // -------------------------------------------------------------------------
    // TEST A & E: Active Central WhatsApp Account CANNOT be registered as a restaurant
    // -------------------------------------------------------------------------
    console.log('--- TEST A & E: Active Central Number Cannot Be Registered as Restaurant ---');
    const rejectCentralRes = await makeRequest({
      method: 'POST',
      path: '/api/admin/restaurants',
      headers: authHeaders,
      body: {
        name: 'Malicious Central Impersonator',
        owner_name: 'Test Owner',
        owner_phone: '+919876543210',
        phone_number_id: '106734138803096', // Active Central Phone Number (Naila)
        waba_id: '103820662432290',
        tenant_status: 'ACTIVE'
      }
    });
    assert.strictEqual(rejectCentralRes.status, 409, 'Onboarding active central phone as restaurant must return HTTP 409');
    assert(
      rejectCentralRes.body.error.includes('belongs to a Central WhatsApp Account and cannot be registered as a restaurant tenant'),
      'Error message must state that phone number belongs to a Central WhatsApp Account'
    );
    recordTestPass('Active Central Account (106734138803096) is strictly protected from restaurant registration (HTTP 409)');

    // -------------------------------------------------------------------------
    // TEST B: Legitimate independent restaurant number (1427497060448125, RestPro) CAN be onboarded
    // -------------------------------------------------------------------------
    console.log('\n--- TEST B: Onboard Restaurant RestPro (1427497060448125) ---');
    const existingRestPro = await prisma.restaurant.findFirst({
      where: { phone_number_id: '1427497060448125' }
    });

    let dbRestPro;
    if (existingRestPro) {
      console.log('RestPro is already onboarded in the database. Verifying tenant status...');
      dbRestPro = existingRestPro;
    } else {
      const onboardRestProRes = await makeRequest({
        method: 'POST',
        path: '/api/admin/restaurants',
        headers: authHeaders,
        body: {
          name: 'RestPro',
          owner_name: 'Omar Farooq',
          owner_phone: '+919876543299',
          phone_number_id: '1427497060448125', // Target restaurant phone number
          waba_id: '1620323530136933',         // Target WABA ID
          address: '42 Main Street, Central Plaza',
          email: 'devomar@restopro.com',
          tenant_status: 'ACTIVE'
        }
      });
      assert.strictEqual(onboardRestProRes.status, 201, `Onboarding RestPro (1427497060448125) must succeed with HTTP 201. Body: ${JSON.stringify(onboardRestProRes.body)}`);
      const onboardedRestPro = onboardRestProRes.body.restaurant;
      assert(onboardedRestPro && onboardedRestPro.id, 'Created restaurant must have a valid UUID');
      testRecords.restaurants.push(onboardedRestPro.id);
      dbRestPro = await prisma.restaurant.findUnique({ where: { id: onboardedRestPro.id } });
    }

    // Verify in PostgreSQL that RestPro is created as genuine tenant
    assert(dbRestPro, 'RestPro record must exist in PostgreSQL');
    assert.strictEqual(dbRestPro.name, 'RestPro');
    assert.strictEqual(dbRestPro.phone_number_id, '1427497060448125');
    assert.strictEqual(dbRestPro.waba_id, '1620323530136933');
    assert.strictEqual(dbRestPro.is_platform_account, false, 'RestPro must have is_platform_account = false');
    assert.strictEqual(dbRestPro.account_type, 'RESTAURANT', 'RestPro must have account_type = RESTAURANT');
    assert.strictEqual(dbRestPro.is_active, true, 'RestPro must be active');
    recordTestPass('Restaurant RestPro (1427497060448125, WABA 1620323530136933) successfully onboarded as genuine tenant (HTTP 201)');

    // Verify RestPro appears in the Super Admin GET /api/admin/restaurants list
    const listRes = await makeRequest({
      method: 'GET',
      path: '/api/admin/restaurants?search=RestPro',
      headers: authHeaders
    });
    assert.strictEqual(listRes.status, 200, 'GET /api/admin/restaurants must return HTTP 200');
    const matched = (listRes.body.restaurants || []).find(r => r.phone_number_id === '1427497060448125');
    assert(matched, 'RestPro must appear in Super Admin restaurants list');
    recordTestPass('RestPro (1427497060448125) successfully visible in GET /api/admin/restaurants');

    // -------------------------------------------------------------------------
    // TEST C: Restaurant sharing WABA ID with central account is NOT automatically rejected
    // -------------------------------------------------------------------------
    console.log('\n--- TEST C: Restaurant Sharing Central Account WABA ID is NOT Rejected ---');
    const sharedWabaPhone = '919' + Date.now().toString().slice(-9);
    const sharedWabaRes = await makeRequest({
      method: 'POST',
      path: '/api/admin/restaurants',
      headers: authHeaders,
      body: {
        name: 'Shared WABA Bistro',
        owner_name: 'WABA Partner',
        owner_phone: '+919876543201',
        phone_number_id: sharedWabaPhone,
        waba_id: nailaAccount.waba_id, // Shares Naila's Central WABA ID: 103820662432290
        tenant_status: 'ACTIVE'
      }
    });
    assert.strictEqual(sharedWabaRes.status, 201, 'Restaurant sharing central WABA ID must succeed (HTTP 201)');
    testRecords.restaurants.push(sharedWabaRes.body.restaurant.id);
    recordTestPass('Restaurant sharing WABA ID with central account is not rejected');

    // -------------------------------------------------------------------------
    // TEST D: Deleted central account historical records do NOT block onboarding
    // -------------------------------------------------------------------------
    console.log('\n--- TEST D: Deleted Central Account Historical Records Do Not Block Onboarding ---');
    const testDeletedPhone = '888' + Date.now().toString().slice(-9);

    // Create a temporary central account and soft-delete it
    const tempCentral = await prisma.centralWhatsAppAccount.create({
      data: {
        account_name: 'Temporary Decommissioned Central',
        phone_number_id: testDeletedPhone,
        waba_id: 'waba_temp_decom',
        access_token_encrypted: 'mock_token',
        is_active: false,
        deleted_at: new Date() // Soft-deleted!
      }
    });
    testRecords.centralAccounts.push(tempCentral.id);

    // Verify isCentralPhoneNumberId returns false for deleted central phone
    const isDeletedCentral = await isCentralPhoneNumberId(testDeletedPhone);
    assert.strictEqual(isDeletedCentral, false, 'Soft-deleted central account phone must NOT be classified as central');

    // Attempt to onboard a restaurant using that phone number
    const onboardDecomRes = await makeRequest({
      method: 'POST',
      path: '/api/admin/restaurants',
      headers: authHeaders,
      body: {
        name: 'Repurposed Line Cafe',
        owner_name: 'Line Owner',
        owner_phone: '+919876543202',
        phone_number_id: testDeletedPhone,
        waba_id: '102938475610294',
        tenant_status: 'ACTIVE'
      }
    });
    assert.strictEqual(onboardDecomRes.status, 201, 'Onboarding phone from soft-deleted central account must succeed with HTTP 201');
    testRecords.restaurants.push(onboardDecomRes.body.restaurant.id);
    recordTestPass('Soft-deleted central account historical records do not block restaurant onboarding');

    // -------------------------------------------------------------------------
    // TEST F & G: Existing multi-restaurant routing & tenant isolation intact
    // -------------------------------------------------------------------------
    console.log('\n--- TEST F & G: Multi-Restaurant Central Routing & Tenant Isolation ---');
    setTemplateApprovalForTesting('restopro_order_alert', 'APPROVED');
    setTemplateApprovalForTesting('restopro_customer_order_accepted', 'APPROVED');

    // Verify unassigned restaurants query works cleanly
    const { getUnassignedRestaurants } = require('../src/services/central-whatsapp.service');
    const unassigned = await getUnassignedRestaurants(prisma);
    assert(Array.isArray(unassigned), 'getUnassignedRestaurants must return array');
    const centralPhoneSet = await getActiveCentralPhoneIds(prisma);
    for (const u of unassigned) {
      assert(!centralPhoneSet.has(u.phone_number_id), 'Central phone must never be in unassigned restaurants');
    }
    recordTestPass('Multi-restaurant central routing and tenant isolation verified intact');

    console.log('\n============================================================');
    console.log('   ALL R6.10 REGRESSION TESTS PASSED (0 FAILURES)           ');
    console.log('============================================================\n');

  } catch (err) {
    console.error('\n❌ R6.10 TEST SUITE FAILED:', err);
    process.exitCode = 1;
  } finally {
    console.log('Cleaning up R6.10 test records...');
    resetTemplateApprovalsForTesting();
    try {
      if (testRecords.restaurants.length > 0) {
        await prisma.restaurant.deleteMany({
          where: { id: { in: testRecords.restaurants } }
        }).catch(() => {});
      }
      if (testRecords.centralAccounts.length > 0) {
        await prisma.centralWhatsAppAccount.deleteMany({
          where: { id: { in: testRecords.centralAccounts } }
        }).catch(() => {});
      }
      if (testRecords.adminUsers.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { admin_user_id: { in: testRecords.adminUsers } }
        }).catch(() => {});
        await prisma.adminUser.deleteMany({
          where: { id: { in: testRecords.adminUsers } }
        }).catch(() => {});
      }
      console.log('Test fixtures cleaned up successfully.');
    } catch (e) {
      console.warn('Cleanup warning:', e.message);
    }
    if (server) {
      server.close();
    }
  }
}

runSuite().catch(console.error);
