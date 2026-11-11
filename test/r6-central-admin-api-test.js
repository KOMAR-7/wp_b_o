/**
 * RESTOPRO — R6.6.2 Super Admin Central WhatsApp Management API Test Suite
 *
 * Verifies:
 * 1. Super Admin authentication & role authorization (401 for unauthenticated, 403 for non-Super Admin)
 * 2. GET /api/admin/central-account (safe sanitization, empty handling, environment fallback)
 * 3. POST /api/admin/central-account (validation, AES-256-GCM encryption, single active enforcement, deactivatePrevious)
 * 4. PATCH /api/admin/central-account (token rotation without leaking old token, partial updates)
 * 5. POST /api/admin/central-account/test-connection (connectivity testing, error handling, token redaction)
 * 6. GET /api/admin/central-account/templates (individual template visibility)
 * 7. PATCH /api/admin/central-account/templates/:templateName (independent status updates)
 * 8. AuditLog creation for central account operations
 */
require('./load-test-env');
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const app = require('../src/app');
const prisma = require('../src/config/database');
const { hashPassword } = require('../src/utils/password');
const { assertSafeTestAccount, assertSafeCleanupFilter } = require('../src/utils/test-guard');
const { decryptToken } = require('../src/utils/crypto');

const TEST_PORT = 4991;
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

async function runTestSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — R6.6.2 SUPER ADMIN CENTRAL API TEST SUITE     ');
  console.log('============================================================\n');

  // Start HTTP Test Server
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`[TEST SERVER] Listening on http://127.0.0.1:${TEST_PORT}`);
      resolve();
    });
  });

  const createdAdminIds = [];
  const createdCentralAccountIds = [];
  let previouslyActiveAccount = null;

  const testPhoneIdA = '999888777333';
  const testPhoneIdB = '999888777444';
  const testWabaId = 'waba_admin_api_test_001';
  const testTokenValid = 'EAA_TEST_MOCK_VALID_CENTRAL_TOKEN_SECRET_XYZ_99999';
  const testTokenRotated = 'EAA_TEST_MOCK_VALID_ROTATED_TOKEN_SECRET_XYZ_88888';

  try {
    // Teardown pre-existing fixtures
    assertSafeCleanupFilter({ phone_number_id: { in: [testPhoneIdA, testPhoneIdB] } }, 'CentralWhatsAppAccount');
    await prisma.centralWhatsAppAccount.deleteMany({
      where: { phone_number_id: { in: [testPhoneIdA, testPhoneIdB] } }
    });

    // -------------------------------------------------------------
    // SETUP: Provision Test Super Admin and Staff Admin
    // -------------------------------------------------------------
    const superAdminEmail = `super_admin_${Date.now()}@restopro.internal`;
    const staffAdminEmail = `staff_admin_${Date.now()}@restopro.internal`;
    assertSafeTestAccount(superAdminEmail, 'Central Admin Test Suite Setup');
    assertSafeTestAccount(staffAdminEmail, 'Central Admin Test Suite Setup');
    const password = `CentralApiTestSecret_${crypto.randomBytes(8).toString('hex')}!`;
    const passwordHash = await hashPassword(password);

    const superAdmin = await prisma.adminUser.create({
      data: {
        name: 'Super Admin Test',
        email: superAdminEmail,
        password_hash: passwordHash,
        role: 'SUPER_ADMIN',
        is_active: true
      }
    });
    createdAdminIds.push(superAdmin.id);

    const staffAdmin = await prisma.adminUser.create({
      data: {
        name: 'Staff User Test',
        email: staffAdminEmail,
        password_hash: passwordHash,
        role: 'SUPPORT',
        is_active: true
      }
    });
    createdAdminIds.push(staffAdmin.id);

    // Authenticate Super Admin
    const superLogin = await httpRequest({
      method: 'POST',
      path: '/api/admin/auth/login',
      body: { email: superAdminEmail, password }
    });
    assert(superLogin.statusCode === 200, 'Super Admin login succeeded');
    const superToken = superLogin.body.token;
    const superHeaders = {
      Authorization: `Bearer ${superToken}`,
      'X-Requested-With': 'XMLHttpRequest'
    };

    // Provision session for non-super admin (SUPPORT role)
    const staffToken = crypto.randomBytes(32).toString('hex');
    const staffTokenHash = crypto.createHash('sha256').update(staffToken).digest('hex');
    await prisma.adminSession.create({
      data: {
        admin_id: staffAdmin.id,
        session_token_hash: staffTokenHash,
        expires_at: new Date(Date.now() + 3600000)
      }
    });
    const staffHeaders = {
      Authorization: `Bearer ${staffToken}`,
      'X-Requested-With': 'XMLHttpRequest'
    };

    // -------------------------------------------------------------
    // TEST GROUP 1: Authentication & Authorization Guards
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: Authentication & Authorization Guards ---');

    // 1.1 Unauthenticated access denied
    const unauthGet = await httpRequest({
      method: 'GET',
      path: '/api/admin/central-account'
    });
    assert(unauthGet.statusCode === 401, 'Unauthenticated GET /api/admin/central-account returns HTTP 401');

    const unauthPost = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account',
      body: { phoneNumberId: testPhoneIdA, wabaId: testWabaId, accessToken: testTokenValid }
    });
    assert(unauthPost.statusCode === 401, 'Unauthenticated POST /api/admin/central-account returns HTTP 401');

    // 1.2 Non-Super-Admin (Restaurant staff / SUPPORT) access strictly denied with 403 Forbidden
    const staffGet = await httpRequest({
      method: 'GET',
      path: '/api/admin/central-account',
      headers: staffHeaders
    });
    assert(staffGet.statusCode === 403, 'Non-Super-Admin GET /api/admin/central-account returns HTTP 403 Forbidden');
    assert(staffGet.body.error.includes('Super Admin privileges required'), 'Error message specifies Super Admin required');

    const staffPost = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account',
      headers: staffHeaders,
      body: { phoneNumberId: testPhoneIdA, wabaId: testWabaId, accessToken: testTokenValid }
    });
    assert(staffPost.statusCode === 403, 'Non-Super-Admin POST /api/admin/central-account returns HTTP 403 Forbidden');

    const staffTemplates = await httpRequest({
      method: 'GET',
      path: '/api/admin/central-account/templates',
      headers: staffHeaders
    });
    assert(staffTemplates.statusCode === 403, 'Non-Super-Admin GET /api/admin/central-account/templates returns HTTP 403');

    // -------------------------------------------------------------
    // TEST GROUP 2: Empty / Missing Configuration Handling
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Empty / Missing Configuration Handling ---');

    // Safely capture and deactivate currently active DB account for baseline test
    previouslyActiveAccount = await prisma.centralWhatsAppAccount.findFirst({ where: { is_active: true } });
    if (previouslyActiveAccount) {
      await prisma.centralWhatsAppAccount.update({
        where: { id: previouslyActiveAccount.id },
        data: { is_active: false }
      });
    }

    const emptyGet = await httpRequest({
      method: 'GET',
      path: '/api/admin/central-account',
      headers: superHeaders
    });
    assert(emptyGet.statusCode === 200, 'GET /api/admin/central-account with no active account returns HTTP 200');
    assert(emptyGet.body.success === true, 'Response reports success: true');
    // If environment has CENTRAL_PHONE_NUMBER_ID, reports ENVIRONMENT, otherwise NONE
    assert(typeof emptyGet.body.configured === 'boolean', 'configured boolean is returned');

    // -------------------------------------------------------------
    // TEST GROUP 3: Onboarding & Validation (POST /api/admin/central-account)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Onboarding & Validation ---');

    // 3.1 Missing required fields
    const missingPhone = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account',
      headers: superHeaders,
      body: { wabaId: testWabaId, accessToken: testTokenValid }
    });
    assert(missingPhone.statusCode === 400, 'Missing phoneNumberId returns HTTP 400');

    const missingToken = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account',
      headers: superHeaders,
      body: { phoneNumberId: testPhoneIdA, wabaId: testWabaId }
    });
    assert(missingToken.statusCode === 400, 'Missing accessToken returns HTTP 400');

    // 3.2 Invalid token format (must start with EAA)
    const invalidTokenPrefix = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account',
      headers: superHeaders,
      body: { phoneNumberId: testPhoneIdA, wabaId: testWabaId, accessToken: 'INVALID_TOKEN_WITHOUT_EAA' }
    });
    assert(invalidTokenPrefix.statusCode === 400, 'Token without EAA prefix returns HTTP 400');
    assert(invalidTokenPrefix.body.code === 'INVALID_TOKEN_PREFIX', 'Returns INVALID_TOKEN_PREFIX code');

    // 3.3 Valid creation
    const createRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account',
      headers: superHeaders,
      body: {
        phoneNumberId: testPhoneIdA,
        wabaId: testWabaId,
        accessToken: testTokenValid,
        displayPhoneNumber: '+91 93720 15523',
        isActive: true
      }
    });
    assert(createRes.statusCode === 201, 'Valid creation returns HTTP 201 Created');
    assert(createRes.body.success === true, 'Response success is true');
    const accountA = createRes.body.account;
    assert(accountA && accountA.id, 'Account UUID returned');
    assert(accountA.phone_number_id === testPhoneIdA, 'Phone Number ID matches input');
    assert(accountA.waba_id === testWabaId, 'WABA ID matches input');
    assert(accountA.display_phone_number === '+91 93720 15523', 'displayPhoneNumber matches input');
    assert(accountA.has_token === true, 'has_token is true');
    assert(accountA.access_token_encrypted === undefined, 'Raw ciphertext is strictly stripped');
    assert(accountA.accessToken === undefined, 'Plaintext token is never returned');
    createdCentralAccountIds.push(accountA.id);

    // Verify token encrypted in database with AES-256-GCM
    const rawAccountA = await prisma.centralWhatsAppAccount.findUnique({
      where: { id: accountA.id }
    });
    assert(rawAccountA.access_token_encrypted.startsWith('enc:v1:'), 'Token stored encrypted with enc:v1: prefix in PostgreSQL');
    assert(decryptToken(rawAccountA.access_token_encrypted) === testTokenValid, 'Encrypted token decrypts to original plaintext');

    // 3.4 Second active account without deactivatePrevious returns 409
    const secondActiveRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account',
      headers: superHeaders,
      body: {
        phoneNumberId: testPhoneIdB,
        wabaId: testWabaId,
        accessToken: testTokenValid,
        isActive: true
      }
    });
    assert(secondActiveRes.statusCode === 409, 'Second active account without deactivatePrevious returns HTTP 409');
    assert(secondActiveRes.body.code === 'SINGLE_ACTIVE_ACCOUNT_EXISTS', 'Returns SINGLE_ACTIVE_ACCOUNT_EXISTS code');

    // 3.5 Second active account with deactivatePrevious: true succeeds and deactivates first
    const replaceRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account',
      headers: superHeaders,
      body: {
        phoneNumberId: testPhoneIdB,
        wabaId: testWabaId,
        accessToken: testTokenValid,
        displayPhoneNumber: '+91 99999 00000',
        isActive: true,
        deactivatePrevious: true
      }
    });
    assert(replaceRes.statusCode === 201, 'Creation with deactivatePrevious: true succeeds (HTTP 201)');
    const accountB = replaceRes.body.account;
    createdCentralAccountIds.push(accountB.id);

    const oldAccountCheck = await prisma.centralWhatsAppAccount.findUnique({ where: { id: accountA.id } });
    const newAccountCheck = await prisma.centralWhatsAppAccount.findUnique({ where: { id: accountB.id } });
    assert(oldAccountCheck.is_active === false, 'Previous active account was deactivated');
    assert(newAccountCheck.is_active === true, 'New account is active');

    // -------------------------------------------------------------
    // TEST GROUP 4: Token Rotation & Partial Updates (PATCH /api/admin/central-account)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Token Rotation & Partial Updates ---');

    // 4.1 Update display phone number only
    const updateDisplayRes = await httpRequest({
      method: 'PATCH',
      path: '/api/admin/central-account',
      headers: superHeaders,
      body: {
        displayPhoneNumber: '+91 88888 77777'
      }
    });
    assert(updateDisplayRes.statusCode === 200, 'PATCH displayPhoneNumber returns HTTP 200');
    assert(updateDisplayRes.body.account.display_phone_number === '+91 88888 77777', 'displayPhoneNumber updated');

    // 4.2 Token Rotation
    const rotateTokenRes = await httpRequest({
      method: 'PATCH',
      path: '/api/admin/central-account',
      headers: superHeaders,
      body: {
        accessToken: testTokenRotated
      }
    });
    assert(rotateTokenRes.statusCode === 200, 'PATCH accessToken (Token Rotation) returns HTTP 200');
    assert(rotateTokenRes.body.account.has_token === true, 'Response confirms has_token: true');
    assert(rotateTokenRes.body.account.accessToken === undefined, 'Rotated token is not exposed in response');
    assert(rotateTokenRes.body.account.access_token_encrypted === undefined, 'Ciphertext is not exposed in response');

    // Verify database stored rotated token decrypted matches testTokenRotated
    const dbRotated = await prisma.centralWhatsAppAccount.findUnique({ where: { id: accountB.id } });
    assert(decryptToken(dbRotated.access_token_encrypted) === testTokenRotated, 'Database stored newly encrypted rotated token');

    // -------------------------------------------------------------
    // TEST GROUP 5: Connection Testing (POST /api/admin/central-account/test-connection)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Connection Testing ---');

    // 5.1 Test connection with mock valid token
    const testConnRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account/test-connection',
      headers: superHeaders
    });
    assert(testConnRes.statusCode === 200, 'POST test-connection returns HTTP 200');
    assert(testConnRes.body.success === true, 'Connection test reports success: true');
    assert(testConnRes.body.status === 'CONNECTED', 'Connection status is CONNECTED');
    assert(testConnRes.body.verified === true, 'Token verified is true');
    assert(testConnRes.body.phoneNumberId === testPhoneIdB, 'Phone Number ID matches configured account');
    assert(testConnRes.body.accessToken === undefined, 'Access token is strictly redacted from response');

    // -------------------------------------------------------------
    // TEST GROUP 6: Template Status Management (GET & PATCH /templates)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Template Status Management ---');

    // 6.1 GET /templates
    const getTemplatesRes = await httpRequest({
      method: 'GET',
      path: '/api/admin/central-account/templates',
      headers: superHeaders
    });
    assert(getTemplatesRes.statusCode === 200, 'GET /templates returns HTTP 200');
    assert(Array.isArray(getTemplatesRes.body.templates), 'templates is an array');
    assert(getTemplatesRes.body.templates.length === 3, 'Returns exactly 3 templates');
    const alertTmpl = getTemplatesRes.body.templates.find(t => t.name === 'restopro_order_alert');
    assert(alertTmpl !== undefined, 'Contains restopro_order_alert');
    assert(alertTmpl.targetRole === 'OWNER', 'restopro_order_alert targetRole is OWNER');

    // 6.2 PATCH /templates/:templateName with invalid name returns 400
    const invalidTmplPatch = await httpRequest({
      method: 'PATCH',
      path: '/api/admin/central-account/templates/unsupported_template_name',
      headers: superHeaders,
      body: { status: 'APPROVED' }
    });
    assert(invalidTmplPatch.statusCode === 400, 'PATCH unsupported template name returns HTTP 400');
    assert(invalidTmplPatch.body.error.includes('Unsupported template'), 'Error specifies unsupported template');

    // 6.3 PATCH /templates/:templateName with invalid status returns 400
    const invalidStatusPatch = await httpRequest({
      method: 'PATCH',
      path: '/api/admin/central-account/templates/restopro_order_alert',
      headers: superHeaders,
      body: { status: 'INVALID_STATUS_STRING' }
    });
    assert(invalidStatusPatch.statusCode === 400, 'PATCH invalid status returns HTTP 400');

    // 6.4 PATCH /templates/:templateName to APPROVED
    const approveAlertPatch = await httpRequest({
      method: 'PATCH',
      path: '/api/admin/central-account/templates/restopro_order_alert',
      headers: superHeaders,
      body: {
        status: 'APPROVED',
        approvalSource: 'SUPER_ADMIN_MANUAL_VERIFIED'
      }
    });
    assert(approveAlertPatch.statusCode === 200, 'PATCH restopro_order_alert to APPROVED returns HTTP 200');
    assert(approveAlertPatch.body.template.isApproved === true, 'Template isApproved is true');
    assert(approveAlertPatch.body.template.status === 'APPROVED', 'Template status is APPROVED');
    assert(approveAlertPatch.body.template.approvalSource === 'SUPER_ADMIN_MANUAL_VERIFIED', 'approvalSource recorded');

    // 6.5 PATCH customer rejected template to REJECTED with reason
    const rejectCustTmplPatch = await httpRequest({
      method: 'PATCH',
      path: '/api/admin/central-account/templates/restopro_customer_order_rejected',
      headers: superHeaders,
      body: {
        status: 'REJECTED',
        failureReason: 'Variable 3 character limit exceeded'
      }
    });
    assert(rejectCustTmplPatch.statusCode === 200, 'PATCH restopro_customer_order_rejected returns HTTP 200');
    assert(rejectCustTmplPatch.body.template.isApproved === false, 'Template isApproved is false');
    assert(rejectCustTmplPatch.body.template.status === 'REJECTED', 'Template status is REJECTED');
    assert(rejectCustTmplPatch.body.template.failureReason === 'Variable 3 character limit exceeded', 'failureReason recorded');

    // Verify GET /templates reflects updated statuses
    const updatedTemplatesRes = await httpRequest({
      method: 'GET',
      path: '/api/admin/central-account/templates',
      headers: superHeaders
    });
    const checkAlert = updatedTemplatesRes.body.templates.find(t => t.name === 'restopro_order_alert');
    const checkCustReject = updatedTemplatesRes.body.templates.find(t => t.name === 'restopro_customer_order_rejected');
    const checkCustAccept = updatedTemplatesRes.body.templates.find(t => t.name === 'restopro_customer_order_accepted');
    assert(checkAlert.isApproved === true, 'restopro_order_alert is marked APPROVED');
    assert(checkCustReject.isApproved === false && checkCustReject.status === 'REJECTED', 'restopro_customer_order_rejected is marked REJECTED');
    assert(checkCustAccept.isApproved === false, 'restopro_customer_order_accepted remains UNCONFIGURED');

    // 6.7 Security Invariant: Manual PATCH attempting to claim META_VERIFIED is safely downgraded
    const forgeMetaAttempt = await httpRequest({
      method: 'PATCH',
      path: '/api/admin/central-account/templates/restopro_customer_order_accepted',
      headers: superHeaders,
      body: {
        status: 'APPROVED',
        approvalSource: 'META_VERIFIED'
      }
    });
    assert(forgeMetaAttempt.statusCode === 200, 'Forged META_VERIFIED attempt accepted safely');
    assert(forgeMetaAttempt.body.template.approvalSource === 'SUPER_ADMIN_MANUAL_VERIFIED', 'Forged META_VERIFIED downgraded to SUPER_ADMIN_MANUAL_VERIFIED');

    // 6.8 Extended Statuses: NOT_SUBMITTED and UNKNOWN are accepted as valid unapproved statuses
    const notSubmittedPatch = await httpRequest({
      method: 'PATCH',
      path: '/api/admin/central-account/templates/restopro_customer_order_accepted',
      headers: superHeaders,
      body: {
        status: 'NOT_SUBMITTED',
        failureReason: 'Template not yet drafted in Meta Business Manager'
      }
    });
    assert(notSubmittedPatch.statusCode === 200, 'PATCH NOT_SUBMITTED returns HTTP 200');
    assert(notSubmittedPatch.body.template.status === 'NOT_SUBMITTED', 'Status recorded as NOT_SUBMITTED');
    assert(notSubmittedPatch.body.template.isApproved === false, 'NOT_SUBMITTED isApproved is false');

    // 6.9 Direct Meta Verification Endpoint: POST /api/admin/central-account/templates/verify-meta
    const metaVerifyRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/central-account/templates/verify-meta',
      headers: superHeaders
    });
    assert(metaVerifyRes.statusCode === 200, 'POST /templates/verify-meta returns HTTP 200');
    assert(metaVerifyRes.body.success === true, 'Response reports success: true');
    assert(Array.isArray(metaVerifyRes.body.templates), 'Returns templates array');
    assert(metaVerifyRes.body.templates.length === 3, 'Verifies all 3 supported templates');
    const metaAlert = metaVerifyRes.body.templates.find(t => t.name === 'restopro_order_alert');
    assert(metaAlert && metaAlert.approvalSource === 'META_VERIFIED', 'Direct verification legitimately records META_VERIFIED');

    // -------------------------------------------------------------
    // TEST GROUP 7: Audit Logging
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Audit Logging ---');

    const auditLogs = await prisma.auditLog.findMany({
      where: { admin_user_id: superAdmin.id },
      orderBy: { created_at: 'desc' }
    });

    const actions = auditLogs.map(l => l.action);
    assert(actions.includes('CENTRAL_WHATSAPP_ACCOUNT_CREATED'), 'Audit log recorded CENTRAL_WHATSAPP_ACCOUNT_CREATED');
    assert(actions.includes('CENTRAL_WHATSAPP_ACCOUNT_UPDATED'), 'Audit log recorded CENTRAL_WHATSAPP_ACCOUNT_UPDATED');
    assert(actions.includes('CENTRAL_TEMPLATE_STATUS_UPDATED'), 'Audit log recorded CENTRAL_TEMPLATE_STATUS_UPDATED');

  } catch (err) {
    console.error('❌ Unhandled test error:', err);
    failed++;
  } finally {
    // Teardown
    console.log('\n--- Cleaning up test artifacts ---');
    try {
      if (createdCentralAccountIds.length > 0) {
        assertSafeCleanupFilter({ id: { in: createdCentralAccountIds } }, 'CentralWhatsAppAccount');
        await prisma.centralWhatsAppAccount.deleteMany({
          where: { id: { in: createdCentralAccountIds } }
        });
      }
      if (createdAdminIds.length > 0) {
        assertSafeCleanupFilter({ admin_id: { in: createdAdminIds } }, 'AdminSession');
        await prisma.adminSession.deleteMany({ where: { admin_id: { in: createdAdminIds } } });
        assertSafeCleanupFilter({ admin_user_id: { in: createdAdminIds } }, 'AuditLog');
        await prisma.auditLog.deleteMany({ where: { admin_user_id: { in: createdAdminIds } } });
        assertSafeCleanupFilter({ id: { in: createdAdminIds } }, 'AdminUser');
        await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminIds } } });
      }
      if (previouslyActiveAccount) {
        await prisma.centralWhatsAppAccount.update({
          where: { id: previouslyActiveAccount.id },
          data: { is_active: true }
        }).catch(() => {});
      }
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await prisma.$disconnect();
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr.message);
    }

    console.log('\n============================================================');
    console.log(`   SUPER ADMIN CENTRAL API TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('============================================================\n');

    if (failed > 0) process.exit(1);
  }
}

runTestSuite();
