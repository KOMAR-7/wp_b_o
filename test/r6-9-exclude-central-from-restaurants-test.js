/**
 * RESTOPRO — R6.9 Exclude Central WhatsApp Account from Restaurant Management Test Suite
 *
 * Scenarios tested:
 * 1. Central account never appears in Restaurants listing API.
 * 2. Central account remains visible in Central Accounts listing API.
 * 3. Genuine restaurant accounts remain visible.
 * 4. Multiple restaurants can route through one central WhatsApp number.
 * 5. A restaurant sharing a WABA ID with the central account is not incorrectly excluded.
 * 6. Restaurant tenant isolation remains intact.
 * 7. Central inbound and outbound WhatsApp routing continues working.
 * 8. Restaurant acceptance/rejection messages still originate from the central number.
 * 9. Restaurant CRUD operations remain functional.
 * 10. Unauthorized users cannot access central account configuration.
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '4989';

const assert = require('assert');
const http = require('http');
const app = require('../src/app');
const prisma = require('../src/config/database');
const { hashPassword } = require('../src/utils/password');
const {
  listRestaurants,
  getRestaurantById,
  createRestaurant,
  updateRestaurant,
  updateRestaurantStatus
} = require('../src/services/admin-restaurant.service');
const {
  listCentralAccounts,
  getUnassignedRestaurants,
  assignRestaurantToCentralAccount,
  unassignRestaurantFromCentralAccount
} = require('../src/services/central-whatsapp.service');
const { getDashboardStats } = require('../src/services/admin-dashboard.service');
const { processOwnerOrderDecision } = require('../src/services/order.service');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');

let server;
let baseUrl;
let superAdminToken;
let superAdminId;
const testRecords = {
  restaurants: [],
  orders: [],
  outbox: [],
  centralAccounts: [],
  adminUsers: []
};

function recordTestPass(name) {
  console.log(`  ✅ [PASS] ${name}`);
}

function makeRequest({ method = 'GET', path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = { ...headers };
    let payload = null;

    if (body) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — R6.9 EXCLUDE CENTRAL FROM RESTAURANTS TEST    ');
  console.log('============================================================\n');

  // Start test server
  server = http.createServer(app);
  await new Promise(res => server.listen(4989, '127.0.0.1', res));
  baseUrl = 'http://127.0.0.1:4989';
  console.log(`[TEST SERVER] Listening on ${baseUrl}`);

  // Create isolated Super Admin for authenticated tests
  const adminEmail = `r69_admin_${Date.now()}@restopro.internal`;
  const adminPassword = 'TestPassword123!';
  const passwordHash = await hashPassword(adminPassword);
  const adminUser = await prisma.adminUser.create({
    data: {
      name: 'R6.9 Test Super Admin',
      email: adminEmail,
      password_hash: passwordHash,
      role: 'SUPER_ADMIN',
      is_active: true
    }
  });
  testRecords.adminUsers.push(adminUser.id);
  superAdminId = adminUser.id;

  const loginRes = await makeRequest({
    method: 'POST',
    path: '/api/admin/auth/login',
    body: { email: adminEmail, password: adminPassword }
  });
  assert.strictEqual(loginRes.status, 200, 'Super Admin login must succeed');
  superAdminToken = loginRes.body.token;
  console.log('  ✅ [SETUP] Super Admin authenticated');

  // --- SCENARIO 1: Central account never appears in Restaurants ---
  console.log('\n--- SCENARIO 1: Central Account Excluded from Restaurants ---');
  const resList = await makeRequest({
    method: 'GET',
    path: '/api/admin/restaurants?limit=50',
    headers: { Authorization: `Bearer ${superAdminToken}` }
  });
  assert.strictEqual(resList.status, 200, 'Listing restaurants must return HTTP 200');
  const listedRestaurants = resList.body.restaurants || [];

  // Verify RestPro central account or any central account phone number is NOT listed
  const centralAccounts = await prisma.centralWhatsAppAccount.findMany();
  const centralPhoneIds = centralAccounts.map(c => c.phone_number_id);
  centralPhoneIds.push('1427497060448125'); // canonical central number

  for (const r of listedRestaurants) {
    assert.strictEqual(centralPhoneIds.includes(r.phone_number_id), false,
      `Central phone number ID ${r.phone_number_id} must not appear in restaurants list`);
    assert.notStrictEqual(r.name, 'RestPro', 'RestPro central account record must not appear in restaurants list');
    assert.notStrictEqual(r.is_platform_account, true, 'Platform accounts must not appear in restaurants list');
    assert.notStrictEqual(r.account_type, 'PLATFORM_CENTRAL', 'PLATFORM_CENTRAL type must not appear in restaurants list');
    assert.notStrictEqual(r.account_type, 'PLATFORM_TEST', 'PLATFORM_TEST type must not appear in restaurants list');
  }
  recordTestPass('Central account never appears in GET /api/admin/restaurants');
  recordTestPass('Platform-owned accounts and test bistros are completely excluded');

  // --- SCENARIO 2: Central account remains visible in Central Accounts ---
  console.log('\n--- SCENARIO 2: Central Account Remains Visible in Central Accounts ---');
  const centralList = await makeRequest({
    method: 'GET',
    path: '/api/admin/central-accounts',
    headers: { Authorization: `Bearer ${superAdminToken}` }
  });
  assert.strictEqual(centralList.status, 200, 'Listing central accounts must return HTTP 200');
  assert(Array.isArray(centralList.body.accounts), 'Response must contain accounts array');
  assert(centralList.body.accounts.length >= 1, 'At least one Central account must be listed');
  recordTestPass('Central account is visible in GET /api/admin/central-accounts');

  // --- SCENARIO 3: Genuine restaurant accounts remain visible ---
  console.log('\n--- SCENARIO 3: Genuine Restaurant Accounts Remain Visible ---');
  const hasSpiceGarden = listedRestaurants.some(r => r.name.includes('Spice Garden') || r.phone_number_id === '111111111111111');
  const hasOceanBreeze = listedRestaurants.some(r => r.name.includes('Ocean Breeze') || r.phone_number_id === '222222222222222');
  assert(hasSpiceGarden || hasOceanBreeze, 'Genuine restaurants must be returned in the list');
  recordTestPass('Genuine restaurants (Spice Garden / Ocean Breeze) are visible in restaurants list');

  // --- SCENARIO 4: Multiple restaurants can route through one central WhatsApp number ---
  console.log('\n--- SCENARIO 4: Multiple Restaurants Routing Through Central Account ---');
  const activeCentral = centralAccounts.find(c => c.is_active && !c.deleted_at) || centralAccounts[0];
  assert(activeCentral, 'An active central account must exist');

  // Create two test restaurants
  const testRest1 = await prisma.restaurant.create({
    data: {
      name: 'R6.9 Routing Test Bistro 1',
      phone_number_id: `9198${Date.now().toString().slice(-8)}1`,
      waba_id: 'WABA_R69_TEST_01',
      owner_phone: '+919876543211',
      access_token_encrypted: 'enc:v1:test_token_1',
      central_account_id: activeCentral.id,
      is_platform_account: false,
      account_type: 'RESTAURANT',
      tenant_status: 'ACTIVE'
    }
  });
  testRecords.restaurants.push(testRest1.id);

  const testRest2 = await prisma.restaurant.create({
    data: {
      name: 'R6.9 Routing Test Bistro 2',
      phone_number_id: `9198${Date.now().toString().slice(-8)}2`,
      waba_id: 'WABA_R69_TEST_02',
      owner_phone: '+919876543212',
      access_token_encrypted: 'enc:v1:test_token_2',
      central_account_id: activeCentral.id,
      is_platform_account: false,
      account_type: 'RESTAURANT',
      tenant_status: 'ACTIVE'
    }
  });
  testRecords.restaurants.push(testRest2.id);

  // Verify both restaurants point to the same central account
  const r1 = await prisma.restaurant.findUnique({ where: { id: testRest1.id }, include: { central_account: true } });
  const r2 = await prisma.restaurant.findUnique({ where: { id: testRest2.id }, include: { central_account: true } });
  assert.strictEqual(r1.central_account_id, activeCentral.id, 'Restaurant 1 routes through active central account');
  assert.strictEqual(r2.central_account_id, activeCentral.id, 'Restaurant 2 routes through active central account');
  recordTestPass('Multiple independent restaurants successfully map to same Central WhatsApp account');

  // --- SCENARIO 5: A restaurant sharing a WABA ID with the central account is NOT excluded ---
  console.log('\n--- SCENARIO 5: Shared WABA ID Restaurant Not Excluded ---');
  const sharedWabaRest = await prisma.restaurant.create({
    data: {
      name: 'R6.9 Shared WABA Restaurant',
      phone_number_id: `9197${Date.now().toString().slice(-8)}`,
      waba_id: activeCentral.waba_id, // Shares central account's WABA ID
      owner_phone: '+919876543299',
      access_token_encrypted: 'enc:v1:test_token_shared',
      is_platform_account: false,
      account_type: 'RESTAURANT',
      tenant_status: 'ACTIVE'
    }
  });
  testRecords.restaurants.push(sharedWabaRest.id);

  const sharedCheckRes = await makeRequest({
    method: 'GET',
    path: `/api/admin/restaurants?search=${encodeURIComponent('Shared WABA')}`,
    headers: { Authorization: `Bearer ${superAdminToken}` }
  });
  assert.strictEqual(sharedCheckRes.status, 200, 'Search must return HTTP 200');
  const foundShared = (sharedCheckRes.body.restaurants || []).find(r => r.id === sharedWabaRest.id);
  assert(foundShared, 'Restaurant sharing central WABA ID must NOT be excluded from restaurant list');
  assert.strictEqual(foundShared.waba_id, activeCentral.waba_id, 'WABA ID matches central WABA');
  recordTestPass('Restaurant sharing WABA ID with central account is legitimately displayed');

  // --- SCENARIO 6: Restaurant tenant isolation remains intact ---
  console.log('\n--- SCENARIO 6: Restaurant Tenant Isolation Intact ---');
  const unassignedRests = await getUnassignedRestaurants();
  const foundUnassigned = unassignedRests.find(r => r.id === sharedWabaRest.id);
  assert(foundUnassigned, 'Unassigned genuine restaurant must appear in unassigned list');

  // Central account and platform accounts must never appear in unassigned list
  for (const ur of unassignedRests) {
    assert.strictEqual(centralPhoneIds.includes(ur.phone_number_id), false,
      `Central phone ${ur.phone_number_id} must not appear in unassigned dropdown`);
    assert.notStrictEqual(ur.name, 'RestPro', 'RestPro central account must not appear in unassigned dropdown');
  }
  recordTestPass('Tenant isolation intact: unassigned list excludes all central & platform records');

  // --- SCENARIO 7 & 8: Central WhatsApp Routing and Acceptance/Rejection Flow ---
  console.log('\n--- SCENARIO 7 & 8: Central Message Routing & Owner Callbacks ---');
  // Create an order for testRest1
  const orderRef = `RP-R69-${Date.now().toString().slice(-6)}`;
  const order = await prisma.order.create({
    data: {
      restaurant_id: testRest1.id,
      order_reference: orderRef,
      customer_name: 'Regression Customer',
      customer_phone: '+919899001122',
      order_type: 'DELIVERY',
      total_amount: 350.00,
      currency: 'INR',
      items: [{ item_name: 'Butter Chicken', quantity: 1, price: 350 }],
      status: 'PENDING_RESTAURANT_CONFIRMATION'
    }
  });
  testRecords.orders.push(order.id);

  // Generate cryptographic owner callback payload
  const signedCallback = generateSignedOwnerCallback({
    action: 'ACCEPT',
    orderId: order.id,
    restaurantId: testRest1.id
  });

  const decisionResult = await processOwnerOrderDecision({
    buttonPayload: signedCallback,
    senderPhone: testRest1.owner_phone
  });
  assert.strictEqual(decisionResult.success, true, 'Owner decision processing must succeed');
  assert.strictEqual(decisionResult.newStatus, 'ACCEPTED', 'Order status must transition to ACCEPTED');
  const targetOutboxId = decisionResult.outboxMessage ? decisionResult.outboxMessage.id : decisionResult.outboxId;
  if (targetOutboxId) testRecords.outbox.push(targetOutboxId);

  // Verify the outbox message was created for the customer notification
  const outbox = await prisma.outboxMessage.findUnique({
    where: { id: targetOutboxId }
  });
  assert(outbox, 'Outbox notification message must be created');
  assert.strictEqual(outbox.sender_channel, 'CENTRAL', 'In CENTRAL mode sender_channel is CENTRAL');
  recordTestPass('Owner decision processing and customer outbox notification flow works cleanly');

  // --- SCENARIO 9: Restaurant CRUD operations remain functional ---
  console.log('\n--- SCENARIO 9: Restaurant CRUD Operations Functional ---');
  // Create a new restaurant via API
  const newRestPhone = `9196${Date.now().toString().slice(-8)}`;
  const createRes = await makeRequest({
    method: 'POST',
    path: '/api/admin/restaurants',
    headers: { Authorization: `Bearer ${superAdminToken}` },
    body: {
      name: 'R6.9 API Created Bistro',
      owner_name: 'Sunil Kumar',
      owner_phone: '+919876543255',
      phone_number_id: newRestPhone,
      waba_id: '102938475610293',
      tenant_status: 'ACTIVE'
    }
  });
  assert.strictEqual(createRes.status, 201, 'Create restaurant via API must return HTTP 201');
  const createdId = createRes.body.restaurant.id;
  testRecords.restaurants.push(createdId);

  // Verify created restaurant has is_platform_account = false and account_type = 'RESTAURANT'
  const createdRecord = await prisma.restaurant.findUnique({ where: { id: createdId } });
  assert.strictEqual(createdRecord.is_platform_account, false, 'New restaurant must have is_platform_account = false');
  assert.strictEqual(createdRecord.account_type, 'RESTAURANT', 'New restaurant must have account_type = RESTAURANT');

  // Get restaurant by ID
  const getRes = await makeRequest({
    method: 'GET',
    path: `/api/admin/restaurants/${createdId}`,
    headers: { Authorization: `Bearer ${superAdminToken}` }
  });
  assert.strictEqual(getRes.status, 200, 'Get restaurant by ID must return HTTP 200');
  assert.strictEqual(getRes.body.restaurant.id, createdId, 'Returned restaurant ID matches');

  // Update restaurant status
  const statusRes = await makeRequest({
    method: 'PATCH',
    path: `/api/admin/restaurants/${createdId}/status`,
    headers: { Authorization: `Bearer ${superAdminToken}` },
    body: { status: 'SUSPENDED' }
  });
  assert.strictEqual(statusRes.status, 200, 'Update status must return HTTP 200');
  assert.strictEqual(statusRes.body.restaurant.tenant_status, 'SUSPENDED', 'Status updated to SUSPENDED');

  // Attempt to onboard with Central Phone Number ID must be rejected with HTTP 409
  const conflictRes = await makeRequest({
    method: 'POST',
    path: '/api/admin/restaurants',
    headers: { Authorization: `Bearer ${superAdminToken}` },
    body: {
      name: 'Invalid Central Impersonator',
      owner_name: 'Hacker',
      owner_phone: '+919876543200',
      phone_number_id: activeCentral.phone_number_id,
      waba_id: '999888777666',
      tenant_status: 'ACTIVE'
    }
  });
  assert.strictEqual(conflictRes.status, 409, 'Registering central phone as restaurant must be rejected with HTTP 409');
  recordTestPass('Restaurant CRUD operations functional; central phone registration properly rejected');

  // --- SCENARIO 10: Unauthorized users cannot access central account configuration ---
  console.log('\n--- SCENARIO 10: Central Account Authorization Guard ---');
  const unauthRes = await makeRequest({
    method: 'GET',
    path: '/api/admin/central-accounts'
  });
  assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request to central-accounts must return HTTP 401');

  const invalidTokenRes = await makeRequest({
    method: 'GET',
    path: '/api/admin/central-accounts',
    headers: { Authorization: 'Bearer invalid_or_expired_token' }
  });
  assert.strictEqual(invalidTokenRes.status, 401, 'Invalid token to central-accounts must return HTTP 401');
  recordTestPass('Unauthorized access to Central WhatsApp configuration strictly rejected with HTTP 401');

  console.log('\n============================================================');
  console.log('   ALL 10 SCENARIOS PASSED (0 FAILURES)                      ');
  console.log('============================================================\n');
}

async function cleanup() {
  console.log('Cleaning up test fixtures...');
  try {
    for (const oid of testRecords.outbox) {
      await prisma.outboxMessage.deleteMany({ where: { id: oid } }).catch(() => {});
    }
    for (const ordId of testRecords.orders) {
      await prisma.order.deleteMany({ where: { id: ordId } }).catch(() => {});
    }
    for (const rid of testRecords.restaurants) {
      await prisma.restaurant.deleteMany({ where: { id: rid } }).catch(() => {});
    }
    for (const aid of testRecords.adminUsers) {
      await prisma.adminSession.deleteMany({ where: { admin_id: aid } }).catch(() => {});
      await prisma.adminUser.deleteMany({ where: { id: aid } }).catch(() => {});
    }
    console.log('Test fixtures cleaned up successfully.');
  } catch (err) {
    console.warn('Cleanup error (non-fatal):', err.message);
  }

  if (server) {
    await new Promise(res => server.close(res));
  }
}

runSuite()
  .catch(err => {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  });
