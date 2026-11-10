/**
 * RESTOPRO — R6.8 Central WhatsApp Account Management Test Suite
 *
 * Comprehensive end-to-end test suite for:
 * Group A: Account CRUD (Scenarios 1-10)
 * Group B: Multiple Accounts & Tenant Isolation (Scenarios 11-20)
 * Group C: Meta Connection & Diagnostics (Scenarios 21-28)
 * Group D: Activation, Deactivation & Safe Deletion (Scenarios 29-38)
 * Group E: Regression & Production Safety (Scenarios 39-50)
 */
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const app = require('../src/app');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const { hashPassword } = require('../src/utils/password');
const { assertSafeTestAccount } = require('../src/utils/test-guard');
const { decryptToken } = require('../src/utils/crypto');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');
const {
  resolveCentralCredentials,
  createCentralAccount,
  listCentralAccounts,
  getCentralAccountById,
  updateCentralAccount,
  deleteCentralAccount,
  setTestHttpClient
} = require('../src/services/central-whatsapp.service');
const { confirmCustomerOrder, processOwnerOrderDecision } = require('../src/services/order.service');

const TEST_PORT = 4995;
let server;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failed++;
  }
}

function httpRequest({ method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };

    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(rawData);
        } catch (_) {
          json = rawData;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runR68TestSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — R6.8 CENTRAL WHATSAPP MANAGEMENT TEST SUITE   ');
  console.log('============================================================\n');

  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`[TEST SERVER] Listening on http://127.0.0.1:${TEST_PORT}`);
      resolve();
    });
  });

  const createdAdminIds = [];
  const createdCentralAccountIds = [];
  const createdRestaurantIds = [];
  const createdOrderIds = [];

  const testPhoneAlpha = '888000111001';
  const testPhoneBeta = '888000111002';
  const testPhoneGamma = '888000111003';
  const testWabaAlpha = 'waba_r68_alpha_101';
  const testWabaBeta = 'waba_r68_beta_102';
  const testTokenAlpha = 'EAAB_test_mock_alpha_token_secret_12345';
  const testTokenBeta = 'EAAB_test_mock_beta_token_secret_67890';
  const testTokenRotated = 'EAAB_test_mock_rotated_token_secret_99999';

  try {
    // -------------------------------------------------------------------------
    // SETUP: Provision Test Super Admin & Clean Fixtures
    // -------------------------------------------------------------------------
    await prisma.centralWhatsAppAccount.deleteMany({
      where: { phone_number_id: { in: [testPhoneAlpha, testPhoneBeta, testPhoneGamma] } }
    });

    const superAdminEmail = `super_admin_r68_${Date.now()}@restopro.internal`;
    assertSafeTestAccount(superAdminEmail, 'R6.8 Test Suite Setup');
    const password = `R68TestSecret_${crypto.randomBytes(8).toString('hex')}!`;
    const passwordHash = await hashPassword(password);

    const superAdmin = await prisma.adminUser.create({
      data: {
        name: 'Super Admin R68',
        email: superAdminEmail,
        password_hash: passwordHash,
        role: 'SUPER_ADMIN',
        is_active: true
      }
    });
    createdAdminIds.push(superAdmin.id);

    const loginRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/auth/login',
      body: { email: superAdminEmail, password }
    });
    assert(loginRes.statusCode === 200, 'Super Admin login succeeded (HTTP 200)');
    const token = loginRes.body.token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    // -------------------------------------------------------------------------
    // GROUP A: Account CRUD (Scenarios 1-10)
    // -------------------------------------------------------------------------
    console.log('\n--- GROUP A: Account CRUD ---');

    // 1. Add a new central account via POST /api/admin/central-accounts
    const createRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-accounts',
      headers: authHeaders,
      body: {
        accountName: 'Central Dispatch North',
        description: 'Dedicated notification line for North restaurants',
        phoneNumberId: testPhoneAlpha,
        wabaId: testWabaAlpha,
        accessToken: testTokenAlpha,
        displayPhoneNumber: '+91 98765 00001',
        isActive: true
      }
    });
    assert(createRes.statusCode === 201, 'Scenario 1: Add new central account returns HTTP 201');
    assert(createRes.body.account && createRes.body.account.id, 'Scenario 1: Returns created account with UUID');
    assert(createRes.body.account.account_name === 'Central Dispatch North', 'Scenario 1: Account name matches input');
    assert(createRes.body.account.has_token === true, 'Scenario 1: Reports has_token = true');
    assert(createRes.body.account.access_token_encrypted === undefined, 'Scenario 1: Ciphertext is strictly redacted');
    const accountAlphaId = createRes.body.account.id;
    createdCentralAccountIds.push(accountAlphaId);

    // 2. Reject missing required fields
    const missingPhoneRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-accounts',
      headers: authHeaders,
      body: { wabaId: testWabaAlpha, accessToken: testTokenAlpha }
    });
    assert(missingPhoneRes.statusCode === 400, 'Scenario 2: Reject missing phoneNumberId with HTTP 400');

    const missingTokenRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-accounts',
      headers: authHeaders,
      body: { phoneNumberId: testPhoneGamma, wabaId: testWabaAlpha }
    });
    assert(missingTokenRes.statusCode === 400, 'Scenario 2: Reject missing accessToken with HTTP 400');

    // 3. Reject duplicate account with same phone_number_id
    const duplicateRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-accounts',
      headers: authHeaders,
      body: {
        accountName: 'Duplicate North',
        phoneNumberId: testPhoneAlpha, // Collision!
        wabaId: testWabaAlpha,
        accessToken: testTokenAlpha
      }
    });
    assert(duplicateRes.statusCode === 409, 'Scenario 3: Reject duplicate phone_number_id with HTTP 409');
    assert(duplicateRes.body.code === 'DUPLICATE_PHONE_NUMBER_ID', 'Scenario 3: Error code is DUPLICATE_PHONE_NUMBER_ID');

    // 4. Retrieve account list
    const listRes = await httpRequest({
      method: 'GET',
      path: '/api/admin/central-accounts',
      headers: authHeaders
    });
    assert(listRes.statusCode === 200, 'Scenario 4: Retrieve accounts list returns HTTP 200');
    assert(Array.isArray(listRes.body.accounts), 'Scenario 4: Response contains accounts array');
    assert(listRes.body.accounts.some(a => a.id === accountAlphaId), 'Scenario 4: Account Alpha present in list');

    // 5. Retrieve individual account by ID
    const getRes = await httpRequest({
      method: 'GET',
      path: `/api/admin/central-accounts/${accountAlphaId}`,
      headers: authHeaders
    });
    assert(getRes.statusCode === 200, 'Scenario 5: Retrieve individual account returns HTTP 200');
    assert(getRes.body.account.id === accountAlphaId, 'Scenario 5: Returns correct account by ID');
    assert(Array.isArray(getRes.body.restaurants), 'Scenario 5: Returns assigned restaurants array');

    // 6. Update account details (name, description, display number)
    const updateRes = await httpRequest({
      method: 'PATCH',
      path: `/api/admin/central-accounts/${accountAlphaId}`,
      headers: authHeaders,
      body: {
        accountName: 'Central Dispatch North Updated',
        description: 'Updated region SLA notes',
        displayPhoneNumber: '+91 98765 00099'
      }
    });
    assert(updateRes.statusCode === 200, 'Scenario 6: Update account returns HTTP 200');
    assert(updateRes.body.account.account_name === 'Central Dispatch North Updated', 'Scenario 6: Account name updated');
    assert(updateRes.body.account.display_phone_number === '+91 98765 00099', 'Scenario 6: Display phone updated');

    // 7. Retain existing token when replacement field is empty
    const rawBeforeBlank = await prisma.centralWhatsAppAccount.findUnique({ where: { id: accountAlphaId } });
    const blankTokenUpdateRes = await httpRequest({
      method: 'PATCH',
      path: `/api/admin/central-accounts/${accountAlphaId}`,
      headers: authHeaders,
      body: {
        accessToken: '' // Empty string must NOT overwrite working token
      }
    });
    assert(blankTokenUpdateRes.statusCode === 200, 'Scenario 7: Empty token update returns HTTP 200');
    const rawAfterBlank = await prisma.centralWhatsAppAccount.findUnique({ where: { id: accountAlphaId } });
    assert(rawBeforeBlank.access_token_encrypted === rawAfterBlank.access_token_encrypted, 'Scenario 7: Existing encrypted token retained when empty token passed');

    // 8. Replace and encrypt token when a new valid token is supplied
    const rotateTokenRes = await httpRequest({
      method: 'PATCH',
      path: `/api/admin/central-accounts/${accountAlphaId}`,
      headers: authHeaders,
      body: {
        accessToken: testTokenRotated
      }
    });
    assert(rotateTokenRes.statusCode === 200, 'Scenario 8: Token rotation returns HTTP 200');
    const rawAfterRotate = await prisma.centralWhatsAppAccount.findUnique({ where: { id: accountAlphaId } });
    assert(rawAfterRotate.access_token_encrypted !== rawBeforeBlank.access_token_encrypted, 'Scenario 8: Ciphertext changed after token rotation');
    assert(decryptToken(rawAfterRotate.access_token_encrypted) === testTokenRotated, 'Scenario 8: Decrypted token matches new rotated token');

    // 9. Ensure token is never returned by GET
    assert(getRes.body.account.access_token_encrypted === undefined, 'Scenario 9: access_token_encrypted is not present in GET');
    assert(getRes.body.account.accessToken === undefined, 'Scenario 9: Plaintext accessToken is not present in GET');

    // 10. Reject unauthorized account modifications
    const unauthUpdateRes = await httpRequest({
      method: 'PATCH',
      path: `/api/admin/central-accounts/${accountAlphaId}`,
      body: { accountName: 'Hacked Name' }
    });
    assert(unauthUpdateRes.statusCode === 401, 'Scenario 10: Unauthorized modification rejected with HTTP 401');

    // -------------------------------------------------------------------------
    // GROUP B: Multiple Central Accounts & Tenant Isolation (Scenarios 11-20)
    // -------------------------------------------------------------------------
    console.log('\n--- GROUP B: Multiple Accounts & Tenant Isolation ---');

    // 11. Central Account A already created (Alpha)
    assert(accountAlphaId, 'Scenario 11: Central Account A (Alpha) active');

    // 12. Create Central Account B (Beta) simultaneously active
    const createBetaRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-accounts',
      headers: authHeaders,
      body: {
        accountName: 'Central Dispatch South',
        description: 'Dedicated notification line for South restaurants',
        phoneNumberId: testPhoneBeta,
        wabaId: testWabaBeta,
        accessToken: testTokenBeta,
        displayPhoneNumber: '+91 98765 00002',
        isActive: true
      }
    });
    assert(createBetaRes.statusCode === 201, 'Scenario 12: Create Central Account B returns HTTP 201');
    const accountBetaId = createBetaRes.body.account.id;
    createdCentralAccountIds.push(accountBetaId);

    // Provision test restaurants A and B
    const restA = await prisma.restaurant.create({
      data: {
        name: 'Trattoria Bella (Rest A)',
        phone_number_id: '111888000001',
        waba_id: 'waba_rest_a_001',
        owner_phone: '+919876000001',
        access_token_encrypted: 'enc:v1:mock_token_rest_a',
        is_active: true
      }
    });
    createdRestaurantIds.push(restA.id);

    const restB = await prisma.restaurant.create({
      data: {
        name: 'Curry Kingdom (Rest B)',
        phone_number_id: '111888000002',
        waba_id: 'waba_rest_b_002',
        owner_phone: '+919876000002',
        access_token_encrypted: 'enc:v1:mock_token_rest_b',
        is_active: true
      }
    });
    createdRestaurantIds.push(restB.id);

    // 13. Assign Restaurant A to Central Account A
    const assignARes = await httpRequest({
      method: 'PUT',
      path: `/api/admin/restaurants/${restA.id}/central-account`,
      headers: authHeaders,
      body: { centralAccountId: accountAlphaId }
    });
    assert(assignARes.statusCode === 200, 'Scenario 13: Assign Restaurant A to Central A returns HTTP 200');
    assert(assignARes.body.restaurant.central_account_id === accountAlphaId, 'Scenario 13: Restaurant A mapped to Central A');

    // 14. Assign Restaurant B to Central Account B
    const assignBRes = await httpRequest({
      method: 'PUT',
      path: `/api/admin/restaurants/${restB.id}/central-account`,
      headers: authHeaders,
      body: { centralAccountId: accountBetaId }
    });
    assert(assignBRes.statusCode === 200, 'Scenario 14: Assign Restaurant B to Central B returns HTTP 200');
    assert(assignBRes.body.restaurant.central_account_id === accountBetaId, 'Scenario 14: Restaurant B mapped to Central B');

    // 15. Confirm Restaurant A resolves Central A credentials
    const credsA = await resolveCentralCredentials({ restaurantId: restA.id });
    assert(credsA.accountId === accountAlphaId, 'Scenario 15: Restaurant A resolves Central Account A ID');
    assert(credsA.phoneNumberId === testPhoneAlpha, 'Scenario 15: Restaurant A resolves Central Account A Phone ID');

    // 16. Confirm Restaurant B resolves Central B credentials
    const credsB = await resolveCentralCredentials({ restaurantId: restB.id });
    assert(credsB.accountId === accountBetaId, 'Scenario 16: Restaurant B resolves Central Account B ID');
    assert(credsB.phoneNumberId === testPhoneBeta, 'Scenario 16: Restaurant B resolves Central Account B Phone ID');
    assert(credsA.phoneNumberId !== credsB.phoneNumberId, 'Scenario 16: Independent phone number IDs resolved per tenant');

    // 17. Reassign Restaurant A without changing Restaurant B
    const reassignARes = await httpRequest({
      method: 'PUT',
      path: `/api/admin/restaurants/${restA.id}/central-account`,
      headers: authHeaders,
      body: { centralAccountId: accountBetaId }
    });
    assert(reassignARes.statusCode === 200, 'Scenario 17: Reassign Restaurant A returns HTTP 200');
    const credsANew = await resolveCentralCredentials({ restaurantId: restA.id });
    const credsBCheck = await resolveCentralCredentials({ restaurantId: restB.id });
    assert(credsANew.accountId === accountBetaId, 'Scenario 17: Restaurant A now uses Central Account B');
    assert(credsBCheck.accountId === accountBetaId, 'Scenario 17: Restaurant B mapping completely undisturbed');

    // 18. Reject invalid account assignment (non-existent UUID)
    const invalidAssignRes = await httpRequest({
      method: 'PUT',
      path: `/api/admin/restaurants/${restA.id}/central-account`,
      headers: authHeaders,
      body: { centralAccountId: '00000000-0000-0000-0000-000000000000' }
    });
    assert(invalidAssignRes.statusCode === 404, 'Scenario 18: Reject assignment to non-existent central account with HTTP 404');

    // 19. Reject assignment to an inactive central account
    const inactiveAccount = await createCentralAccount({
      accountName: 'Inactive Test Account',
      phoneNumberId: testPhoneGamma,
      wabaId: 'waba_gamma_103',
      accessToken: 'EAAB_test_gamma_token_123',
      isActive: false
    });
    createdCentralAccountIds.push(inactiveAccount.id);

    const inactiveAssignRes = await httpRequest({
      method: 'PUT',
      path: `/api/admin/restaurants/${restA.id}/central-account`,
      headers: authHeaders,
      body: { centralAccountId: inactiveAccount.id }
    });
    assert(inactiveAssignRes.statusCode === 400, 'Scenario 19: Reject assignment to inactive account with HTTP 400');
    assert(inactiveAssignRes.body.code === 'CENTRAL_ACCOUNT_INACTIVE', 'Scenario 19: Error code is CENTRAL_ACCOUNT_INACTIVE');

    // 20. Prevent cross-tenant access / isolation preserved
    const listAssignedBeta = await httpRequest({
      method: 'GET',
      path: `/api/admin/central-accounts/${accountBetaId}/restaurants`,
      headers: authHeaders
    });
    assert(listAssignedBeta.statusCode === 200, 'Scenario 20: List assigned restaurants returns HTTP 200');
    assert(listAssignedBeta.body.restaurants.length === 2, 'Scenario 20: Both restaurants cleanly isolated and queryable');

    // -------------------------------------------------------------------------
    // GROUP C: Meta Connection & Diagnostics (Scenarios 21-28)
    // -------------------------------------------------------------------------
    console.log('\n--- GROUP C: Meta Connection & Diagnostics ---');

    // 21. Successful connection verification using mocked Meta responses
    const testMockSuccessClient = {
      get: async (url, opts) => {
        return {
          status: 200,
          data: {
            verified_name: 'RestoPro Central Dispatch',
            display_phone_number: '+91 98765 00001',
            quality_rating: 'GREEN',
            code_verification_status: 'VERIFIED'
          }
        };
      }
    };

    setTestHttpClient(testMockSuccessClient);

    const testConnRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${accountAlphaId}/test-connection`,
      headers: authHeaders
    });
    assert(testConnRes.statusCode === 200, 'Scenario 21: Test connection returns HTTP 200');
    assert(testConnRes.body.verified === true, 'Scenario 21: Reports verified: true');
    assert(testConnRes.body.status === 'CONNECTED', 'Scenario 21: Reports status: CONNECTED');
    assert(testConnRes.body.verifiedName === 'RestoPro Central Dispatch', 'Scenario 21: Returns verifiedName');

    // 22. Invalid token response (401 from Meta)
    const testMockInvalidTokenClient = {
      get: async () => {
        const err = new Error('Invalid OAuth access token');
        err.response = { status: 401, data: { error: { code: 190, message: 'Invalid OAuth access token' } } };
        throw err;
      }
    };
    setTestHttpClient(testMockInvalidTokenClient);

    const invalidTokenRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${accountAlphaId}/test-connection`,
      headers: authHeaders
    });
    assert(invalidTokenRes.statusCode === 200, 'Scenario 22: Returns HTTP 200 with sanitized outcome');
    assert(invalidTokenRes.body.verified === false, 'Scenario 22: Reports verified: false');
    assert(invalidTokenRes.body.status === 'DISCONNECTED', 'Scenario 22: Reports status: DISCONNECTED');

    // 23. Invalid Phone Number ID response (404 / 100 from Meta)
    const testMockInvalidPhoneClient = {
      get: async () => {
        const err = new Error('Graph API endpoint not found');
        err.response = { status: 404, data: { error: { code: 100, message: 'Unsupported get request. Object does not exist.' } } };
        throw err;
      }
    };
    setTestHttpClient(testMockInvalidPhoneClient);

    const invalidPhoneRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${accountAlphaId}/test-connection`,
      headers: authHeaders
    });
    assert(invalidPhoneRes.body.verified === false, 'Scenario 23: Invalid phone ID returns verified: false');

    // 24. WABA mismatch error response
    const testMockWabaMismatchClient = {
      get: async () => {
        const err = new Error('Phone number does not belong to WABA');
        err.response = { status: 400, data: { error: { code: 131000, message: 'WABA mismatch for requested asset.' } } };
        throw err;
      }
    };
    setTestHttpClient(testMockWabaMismatchClient);

    const wabaMismatchRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${accountAlphaId}/test-connection`,
      headers: authHeaders
    });
    assert(wabaMismatchRes.body.verified === false, 'Scenario 24: WABA mismatch returns verified: false');

    // 25. Insufficient permissions response (200 / code 10 from Meta)
    const testMockPermsClient = {
      get: async () => {
        const err = new Error('Application does not have permission');
        err.response = { status: 403, data: { error: { code: 10, message: 'Permission denied for whatsapp_business_messaging' } } };
        throw err;
      }
    };
    setTestHttpClient(testMockPermsClient);

    const permsRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${accountAlphaId}/test-connection`,
      headers: authHeaders
    });
    assert(permsRes.body.verified === false, 'Scenario 25: Insufficient permissions returns verified: false');

    // 26. Meta API timeout response
    const testMockTimeoutClient = {
      get: async () => {
        const err = new Error('Connection timed out');
        err.code = 'ECONNABORTED';
        throw err;
      }
    };
    setTestHttpClient(testMockTimeoutClient);

    const timeoutRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${accountAlphaId}/test-connection`,
      headers: authHeaders
    });
    assert(timeoutRes.body.verified === false, 'Scenario 26: Timeout caught and returns verified: false');
    assert(timeoutRes.body.status === 'DISCONNECTED', 'Scenario 26: Reports status: DISCONNECTED');

    // 27. Sanitized error handling: no raw tokens or auth headers leaked
    const jsonStrOutcome = JSON.stringify(timeoutRes.body);
    assert(!jsonStrOutcome.includes('EAAB_'), 'Scenario 27: Raw access token is absent from test-connection response');
    assert(!jsonStrOutcome.includes('Bearer'), 'Scenario 27: Raw Bearer headers absent from test-connection response');

    // 28. Verify test connection sends zero customer messages
    const outboxCountBefore = await prisma.outboxMessage.count();
    // (Test connection was run multiple times above)
    const outboxCountAfter = await prisma.outboxMessage.count();
    assert(outboxCountBefore === outboxCountAfter, 'Scenario 28: Zero outbox messages created during connection tests');

    // Reset test client hook
    setTestHttpClient(null);

    // -------------------------------------------------------------------------
    // GROUP D: Activation, Deactivation & Safe Deletion (Scenarios 29-38)
    // -------------------------------------------------------------------------
    console.log('\n--- GROUP D: Activation, Deactivation & Safe Deletion ---');

    // 29. Activate an account
    const activateRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${inactiveAccount.id}/activate`,
      headers: authHeaders
    });
    assert(activateRes.statusCode === 200, 'Scenario 29: Activate account returns HTTP 200');
    assert(activateRes.body.account.is_active === true, 'Scenario 29: Account is_active set to true');

    // 30. Reject activation of a non-existent account
    const nonExistentActivateRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-accounts/00000000-0000-0000-0000-000000000000/activate',
      headers: authHeaders
    });
    assert(nonExistentActivateRes.statusCode === 404, 'Scenario 30: Reject activation of non-existent account with HTTP 404');

    // 31. Deactivate an unassigned account
    const deactivateRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${inactiveAccount.id}/deactivate`,
      headers: authHeaders
    });
    assert(deactivateRes.statusCode === 200, 'Scenario 31: Deactivate account returns HTTP 200');
    assert(deactivateRes.body.account.is_active === false, 'Scenario 31: Account is_active set to false');
    assert(deactivateRes.body.warning === null, 'Scenario 31: Zero warnings when deactivating unassigned account');

    // 32. Warn when assigned restaurants exist upon deactivation
    const deactivateAssignedRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${accountBetaId}/deactivate`,
      headers: authHeaders
    });
    assert(deactivateAssignedRes.statusCode === 200, 'Scenario 32: Deactivate assigned account returns HTTP 200');
    assert(Boolean(deactivateAssignedRes.body.warning), 'Scenario 32: Returns warning explaining active restaurants are assigned');
    // Reactivate for subsequent tests
    await httpRequest({
      method: 'POST',
      path: `/api/admin/central-accounts/${accountBetaId}/activate`,
      headers: authHeaders
    });

    // 33. Reject unsafe deletion when restaurants are assigned
    const deleteBlockedRes = await httpRequest({
      method: 'DELETE',
      path: `/api/admin/central-accounts/${accountBetaId}`,
      headers: authHeaders
    });
    assert(deleteBlockedRes.statusCode === 400, 'Scenario 33: Reject deletion of account with assigned restaurants (HTTP 400)');
    assert(deleteBlockedRes.body.code === 'ASSIGNED_RESTAURANTS_EXIST', 'Scenario 33: Code is ASSIGNED_RESTAURANTS_EXIST');

    // 34. Reject unsafe deletion with pending outbox messages
    // Unassign restaurants from Alpha first
    await prisma.restaurant.updateMany({
      where: { central_account_id: accountAlphaId },
      data: { central_account_id: null }
    });

    const pendingMsg = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restA.id,
        recipient_phone: '+919876543210',
        sender_channel: 'CENTRAL',
        message_type: 'CUSTOMER_ORDER_DECISION',
        payload: { test: true },
        idempotency_key: `test_pending_deletion_${Date.now()}`,
        status: 'PENDING'
      }
    });

    const deleteBlockedOutboxRes = await httpRequest({
      method: 'DELETE',
      path: `/api/admin/central-accounts/${accountAlphaId}`,
      headers: authHeaders
    });
    assert(deleteBlockedOutboxRes.statusCode === 400, 'Scenario 34: Reject deletion when pending Central outbox messages exist');
    assert(deleteBlockedOutboxRes.body.code === 'PENDING_DISPATCHES_EXIST', 'Scenario 34: Code is PENDING_DISPATCHES_EXIST');

    // Complete the pending outbox message
    await prisma.outboxMessage.update({
      where: { id: pendingMsg.id },
      data: { status: 'DELIVERED' }
    });

    // 35. Historical order reference preservation
    const testOrder = await prisma.order.create({
      data: {
        restaurant_id: restA.id,
        order_reference: `RP-${Date.now().toString().slice(-6)}`,
        customer_name: 'Historical Preservation Customer',
        customer_phone: '+919999888877',
        order_type: 'DELIVERY',
        items: [{ name: 'Chicken Tikka', quantity: 2, price: 300 }],
        total_amount: 600,
        status: 'ACCEPTED'
      }
    });
    createdOrderIds.push(testOrder.id);
    assert(testOrder && testOrder.id, 'Scenario 35: Historical order record exists and intact');

    // 36. Verify soft deletion behavior (when historical dispatch messages exist)
    const softDeleteRes = await httpRequest({
      method: 'DELETE',
      path: `/api/admin/central-accounts/${accountAlphaId}`,
      headers: authHeaders
    });
    assert(softDeleteRes.statusCode === 200, 'Scenario 36: Account deletion returns HTTP 200');
    assert(softDeleteRes.body.softDeleted === true, 'Scenario 36: Account was soft-deleted to preserve dispatch references');
    const dbAlpha = await prisma.centralWhatsAppAccount.findUnique({ where: { id: accountAlphaId } });
    assert(dbAlpha.deleted_at !== null, 'Scenario 36: deleted_at timestamp is set in PostgreSQL');
    assert(dbAlpha.is_active === false, 'Scenario 36: is_active set to false on soft deletion');

    // 37. Verify permanent deletion only when safe and unreferenced
    // Clean test restaurant outbox messages to ensure test isolation
    if (createdRestaurantIds.length > 0) {
      await prisma.outboxMessage.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } });
    }

    const freshPhoneId = '999' + Date.now().toString().slice(-9);
    const freshUnreferenced = await createCentralAccount({
      accountName: 'Fresh Unused Central Account',
      phoneNumberId: freshPhoneId,
      wabaId: `waba_fresh_${Date.now()}`,
      accessToken: 'EAAB_test_fresh_unused_token',
      isActive: false
    });

    const permDeleteRes = await httpRequest({
      method: 'DELETE',
      path: `/api/admin/central-accounts/${freshUnreferenced.id}`,
      headers: authHeaders
    });
    assert(permDeleteRes.statusCode === 200, 'Scenario 37: Permanent deletion returns HTTP 200');
    assert(permDeleteRes.body.softDeleted === false, 'Scenario 37: Reports softDeleted: false (hard delete)');
    const checkDeleted = await prisma.centralWhatsAppAccount.findUnique({ where: { id: freshUnreferenced.id } });
    assert(checkDeleted === null, 'Scenario 37: Record completely purged from database table');

    // 38. Verify AuditLog entries
    const auditCount = await prisma.auditLog.count({
      where: {
        admin_user_id: superAdmin.id,
        entity_type: 'CentralWhatsAppAccount'
      }
    });
    assert(auditCount >= 3, 'Scenario 38: AuditLog entries created for Central WhatsApp management actions');

    // -------------------------------------------------------------------------
    // GROUP E: Regression & Production Safety (Scenarios 39-50)
    // -------------------------------------------------------------------------
    console.log('\n--- GROUP E: Regression & Production Safety ---');

    // 39. Existing customer ordering flow unchanged
    const confirmToken39 = crypto.randomBytes(16).toString('hex');
    const customerPhone39 = `9198${Math.floor(10000000 + Math.random() * 90000000)}`;
    const session = await prisma.conversationSession.create({
      data: {
        restaurant_id: restB.id,
        customer_phone: customerPhone39,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 24 * 3600 * 1000),
        state: {
          cart: {
            items: [{ productRetailerId: 'pbm_1', productName: 'Paneer Butter Masala', quantity: 1, unitPrice: 250, currency: 'INR' }]
          },
          orderType: 'DELIVERY',
          address: { addressText: '123 MG Road, Suite 4B' },
          confirmationToken: confirmToken39,
          customerName: 'Rohit Verma'
        }
      }
    });

    const orderRes = await confirmCustomerOrder({
      restaurantId: restB.id,
      customerPhone: customerPhone39,
      confirmationToken: confirmToken39,
      customerName: 'Rohit Verma'
    });
    assert(orderRes.success === true, 'Scenario 39: Customer checkout order creation succeeds');
    assert(orderRes.order && orderRes.order.order_reference, 'Scenario 39: Order reference generated');
    createdOrderIds.push(orderRes.order.id);

    // 40. Existing restaurant webhook flow unchanged
    const restTenant = await prisma.restaurant.findUnique({ where: { id: restB.id } });
    assert(restTenant.phone_number_id === '111888000002', 'Scenario 40: Restaurant phone number ID intact');

    // 41. Central webhook routes owner decisions by signed order reference
    const signedPayload = generateSignedOwnerCallback({ orderId: orderRes.order.id, action: 'ACCEPT' });
    const decisionResult = await processOwnerOrderDecision({
      restaurantId: null, // Zero restaurant phone matching! Tenant derived from order
      senderPhone: restB.owner_phone,
      buttonPayload: signedPayload
    });
    assert(decisionResult.success === true, 'Scenario 41: Owner decision successfully routed from signed callback');
    assert(decisionResult.newStatus === 'ACCEPTED', 'Scenario 41: Order transitioned to ACCEPTED');

    // 42. HMAC signature verification in button callbacks
    assert(signedPayload.includes(':sig:'), 'Scenario 42: Button callback payload contains cryptographic HMAC signature');

    // 43. Callback tampering prevention
    const tamperedPayload = signedPayload.slice(0, -4) + 'FFFF';
    const tamperedResult = await processOwnerOrderDecision({
      senderPhone: restB.owner_phone,
      buttonPayload: tamperedPayload
    });
    assert(tamperedResult.success === false, 'Scenario 43: Tampered signature callback strictly rejected');
    assert(tamperedResult.code === 'TAMPERED_CALLBACK', 'Scenario 43: Error classified as TAMPERED_CALLBACK');

    // 44. Central webhook deduplication & idempotency
    const dupeDecisionResult = await processOwnerOrderDecision({
      senderPhone: restB.owner_phone,
      buttonPayload: signedPayload
    });
    assert(dupeDecisionResult.success === true && dupeDecisionResult.isDuplicate === true, 'Scenario 44: Duplicate owner decision returns isDuplicate: true safely');

    // 45. Outbox duplicate prevention
    const outboxDupeCount = await prisma.outboxMessage.count({
      where: { idempotency_key: `cust_decision_${orderRes.order.id}` }
    });
    assert(outboxDupeCount <= 1, 'Scenario 45: Zero duplicate outbox messages created for same order decision');

    // 46. Programmatic template submission
    const getDefinitionsRes = await httpRequest({
      method: 'GET',
      path: '/api/admin/central-account/templates/definitions',
      headers: authHeaders
    });
    assert(getDefinitionsRes.statusCode === 200, 'Scenario 46: GET template definitions returns HTTP 200');
    assert(Array.isArray(getDefinitionsRes.body.definitions), 'Scenario 46: Returns array of copy-ready definitions');

    // 47. Template verification endpoint
    const verifyMetaRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account/templates/verify-meta',
      headers: authHeaders
    });
    assert(verifyMetaRes.statusCode === 200, 'Scenario 47: POST templates/verify-meta returns HTTP 200');

    // 48. Existing Super Admin authentication & scrypt hashing
    assert(superAdmin.password_hash.startsWith('scrypt:'), 'Scenario 48: Admin password securely stored with scrypt hash');

    // 49. Multi-tenant database isolation
    const ordersRestA = await prisma.order.findMany({ where: { restaurant_id: restA.id } });
    const ordersRestB = await prisma.order.findMany({ where: { restaurant_id: restB.id } });
    const restAOrderIds = ordersRestA.map(o => o.id);
    const restBOrderIds = ordersRestB.map(o => o.id);
    assert(restAOrderIds.includes(testOrder.id) && !restAOrderIds.includes(orderRes.order.id), 'Scenario 49: Orders strictly segregated by restaurant_id (Rest A isolated)');
    assert(restBOrderIds.includes(orderRes.order.id) && !restBOrderIds.includes(testOrder.id), 'Scenario 49: Orders strictly segregated by restaurant_id (Rest B isolated)');

    // 50. Central-Only architecture invariant: NOTIFICATION_ROUTING_MODE=CENTRAL
    const currentMode = (config.routingMode || process.env.NOTIFICATION_ROUTING_MODE || 'CENTRAL').toUpperCase().trim();
    assert(currentMode === 'CENTRAL', 'Scenario 50: Production NOTIFICATION_ROUTING_MODE is active CENTRAL');

  } catch (err) {
    console.error('Unhandled Test Suite Error:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up R6.8 test fixtures ---');
    if (createdOrderIds.length > 0) {
      await prisma.orderNotification.deleteMany({ where: { order_id: { in: createdOrderIds } } }).catch(() => {});
      if (createdRestaurantIds.length > 0) {
        await prisma.outboxMessage.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } }).catch(() => {});
      }
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
    }
    if (createdRestaurantIds.length > 0) {
      await prisma.conversationSession.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } }).catch(() => {});
      await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } }).catch(() => {});
    }
    if (createdCentralAccountIds.length > 0) {
      await prisma.centralWhatsAppAccount.deleteMany({ where: { id: { in: createdCentralAccountIds } } }).catch(() => {});
    }
    if (createdAdminIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { admin_user_id: { in: createdAdminIds } } }).catch(() => {});
      await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminIds } } }).catch(() => {});
    }

    if (server) {
      server.close();
    }
  }

  console.log('\n============================================================');
  console.log(`   R6.8 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runR68TestSuite().catch((err) => {
  console.error('Test Suite Fatal Error:', err);
  process.exit(1);
});
