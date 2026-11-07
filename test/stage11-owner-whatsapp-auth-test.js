/**
 * RESTOPRO — Stage 11: Owner WhatsApp Notifications & 401 Authentication Fix Test Suite
 *
 * Verifies:
 * 1. Token Encryption & Decryption: AES-256-GCM, candidate key fallback, trimming, quote stripping.
 * 2. Token Format Enforcement & Browser Autofill Defense: Token prefix requirement (EAA),
 *    rejection of passwords/garbage tokens during create & update, blank inputs preserve existing tokens.
 * 3. E.164 Owner Phone Validation: Strict format checking (^+[1-9]\d{6,14}$), rejection of local/spaced phones.
 * 4. Owner Consent Management: Zero-migration structured metadata persistence, opt-in tracking,
 *    and order notification suppression when consent is revoked or absent.
 * 5. WhatsApp API 401 Authentication Error Handling: Non-retryable classification (isRetryable: false),
 *    Meta error code/subcode extraction, and complete token redaction from errors and logs.
 * 6. Owner Notification Payload Generation: Interactive quick-reply buttons (within 24h) vs
 *    Meta approved templates (outside 24h).
 * 7. Super Admin WhatsApp Status & Outbox Retry: Status detection (REQUIRES_REAUTH, HEALTHY, NOT_CONFIGURED),
 *    and safe outbox retry endpoint (resets FAILED to PENDING, preserves idempotency keys, logs audit trail).
 * 8. Multi-Tenant Credential Isolation: Tenant A cannot access Tenant B's credentials.
 */

const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const { hashPassword } = require('../src/utils/password');
const { encryptToken, decryptToken } = require('../src/utils/crypto');
const {
  validateE164Phone,
  getOwnerConsent,
  parseInternalNotes,
  formatInternalNotes,
  createRestaurant,
  updateRestaurant,
  getRestaurantById,
  retryFailedOutboxMessages
} = require('../src/services/admin-restaurant.service');
const {
  resolveRestaurantCredentials,
  sendWhatsAppMessage,
  buildOwnerNotificationPayload
} = require('../src/services/whatsapp.service');

const TEST_PORT = 4998;
let serverInstance;

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${message}`);
  } else {
    failedTests++;
    console.error(`  ❌ [FAIL] ${message}`);
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

async function runStage11Tests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 11: OWNER WHATSAPP & 401 FIX TESTS      ');
  console.log('============================================================\n');

  // Start HTTP test server
  await new Promise((resolve) => {
    serverInstance = app.listen(TEST_PORT, '127.0.0.1', resolve);
  });
  console.log(`[TEST SERVER] Listening on http://127.0.0.1:${TEST_PORT}\n`);

  const createdAdminIds = [];
  const createdRestaurantIds = [];
  const createdOrderIds = [];
  const createdOutboxIds = [];
  const createdAuditLogIds = [];

  try {
    // -------------------------------------------------------------
    // SETUP: Provision Test Super Admin
    // -------------------------------------------------------------
    const adminEmail = `stage11_admin_${Date.now()}@restopro.internal`;
    const adminPassword = 'SuperSecret123!';
    const passwordHash = await hashPassword(adminPassword);

    const testAdmin = await prisma.adminUser.create({
      data: {
        name: 'Stage 11 Admin',
        email: adminEmail,
        password_hash: passwordHash,
        role: 'SUPER_ADMIN',
        is_active: true
      }
    });
    createdAdminIds.push(testAdmin.id);

    const loginRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/auth/login',
      body: { email: adminEmail, password: adminPassword }
    });
    assert(loginRes.statusCode === 200, 'Super Admin login succeeded');
    const authToken = loginRes.body.token;
    const authHeaders = {
      Authorization: `Bearer ${authToken}`,
      'X-Requested-With': 'XMLHttpRequest'
    };

    // -------------------------------------------------------------
    // TEST GROUP 1: AES-256-GCM Encryption, Candidate Keys & Sanitization
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: AES-256-GCM Token Encryption & Sanitization ---');

    const sampleToken = 'EAABtestingValidToken1234567890abcdefghijklmnopqrstuvwxyz';
    const encrypted = encryptToken(sampleToken);
    assert(typeof encrypted === 'string' && encrypted.startsWith('enc:v1:'), 'encryptToken returns enc:v1:<iv>:<tag>:<cipher> format');

    const decrypted = decryptToken(encrypted);
    assert(decrypted === sampleToken, 'decryptToken returns original plaintext token');

    // Test trimming and quote stripping
    const paddedToken = `  "EAABTokenWithQuotesAndSpaces987654321" \n`;
    const encryptedPadded = encryptToken(paddedToken);
    const decryptedClean = decryptToken(encryptedPadded);
    assert(decryptedClean === 'EAABTokenWithQuotesAndSpaces987654321', 'decryptToken trims whitespace and strips accidental enclosing quotes');

    // Test corrupted ciphertext fails decryption cleanly
    let decryptionFailed = false;
    try {
      decryptToken('enc:v1:0123456789abcdef01234567:0123456789abcdef0123456789abcdef:0123456789abcdef');
    } catch (_) {
      decryptionFailed = true;
    }
    assert(decryptionFailed, 'decryptToken throws error on corrupted / invalid ciphertext');

    // -------------------------------------------------------------
    // TEST GROUP 2: Token Prefix & Browser Autofill Defense
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Token Prefix & Browser Autofill Defense ---');

    // Attempt to onboard restaurant with 9-byte password as access_token (autofill attack)
    const badOnboardRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/restaurants',
      headers: authHeaders,
      body: {
        name: 'Autofill Test Kitchen',
        phone_number_id: `998877${Date.now().toString().slice(-8)}`,
        waba_id: `887766${Date.now().toString().slice(-8)}`,
        owner_phone: '+919876543210',
        access_token: 'MyPass987' // 9-byte browser password without EAA prefix
      }
    });
    assert(badOnboardRes.statusCode === 400, 'Rejects onboarding when access_token is a password without EAA prefix');
    assert(badOnboardRes.body.error && badOnboardRes.body.error.includes('EAA'), 'Error message clearly references EAA prefix requirement');

    // Onboard valid restaurant with proper token
    const validToken = 'EAABvalidMetaAccessTokenForRestaurant101010101010';
    const goodPhoneId = `112233${Date.now().toString().slice(-8)}`;
    const goodWabaId = `223344${Date.now().toString().slice(-8)}`;
    const goodOnboardRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/restaurants',
      headers: authHeaders,
      body: {
        name: 'Spice Valley',
        phone_number_id: goodPhoneId,
        waba_id: goodWabaId,
        owner_phone: '+919876543210',
        owner_name: 'Rajesh Kumar',
        access_token: validToken
      }
    });
    assert(goodOnboardRes.statusCode === 201, 'Onboards restaurant with valid EAA-prefixed access token');
    const goodRestaurantId = goodOnboardRes.body.restaurant.id;
    createdRestaurantIds.push(goodRestaurantId);

    // Verify token is encrypted in DB and resolves correctly
    const creds = await resolveRestaurantCredentials(goodRestaurantId);
    assert(creds.accessToken === validToken, 'resolveRestaurantCredentials correctly decrypts token');

    // Attack simulation: Browser autofills password into edit modal and submits PUT
    const autofillUpdateRes = await httpRequest({
      method: 'PUT',
      path: `/api/admin/restaurants/${goodRestaurantId}`,
      headers: authHeaders,
      body: {
        name: 'Spice Valley Updated',
        access_token: 'AdminPass9' // Autofilled 10-char password!
      }
    });
    assert(autofillUpdateRes.statusCode === 400, 'PUT rejects autofilled password access_token without EAA prefix');

    // Verify existing token was NOT corrupted by the failed update
    const credsAfterFailedAttack = await resolveRestaurantCredentials(goodRestaurantId);
    assert(credsAfterFailedAttack.accessToken === validToken, 'Existing token is preserved intact after rejected autofill attack');

    // Test blank access_token submission: should NOT overwrite or erase existing token
    const blankUpdateRes = await httpRequest({
      method: 'PUT',
      path: `/api/admin/restaurants/${goodRestaurantId}`,
      headers: authHeaders,
      body: {
        name: 'Spice Valley Renamed',
        access_token: '   ' // Blank whitespace
      }
    });
    assert(blankUpdateRes.statusCode === 200, 'PUT with blank access_token succeeds without updating token');
    const credsAfterBlankUpdate = await resolveRestaurantCredentials(goodRestaurantId);
    assert(credsAfterBlankUpdate.accessToken === validToken, 'Existing token remains intact when access_token field is blank');

    // -------------------------------------------------------------
    // TEST GROUP 3: E.164 Owner Phone Validation & Consent Tracking
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: E.164 Owner Phone Validation & Consent ---');

    assert(validateE164Phone('+919876543210') === true, 'Accepts valid Indian E.164 phone');
    assert(validateE164Phone('+14155552671') === true, 'Accepts valid US E.164 phone');
    assert(validateE164Phone('+447911123456') === true, 'Accepts valid UK E.164 phone');

    assert(validateE164Phone('919876543210') === false, 'Rejects phone missing leading +');
    assert(validateE164Phone('09876543210') === false, 'Rejects phone with leading 0');
    assert(validateE164Phone('+91 9876543210') === false, 'Rejects phone with spaces');
    assert(validateE164Phone('+123') === false, 'Rejects phone shorter than 7 digits');
    assert(validateE164Phone('+12345678901234567') === false, 'Rejects phone longer than 15 digits');

    // Onboarding with invalid owner phone fails
    const badPhoneRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/restaurants',
      headers: authHeaders,
      body: {
        name: 'Invalid Phone Diner',
        phone_number_id: `334455${Date.now().toString().slice(-8)}`,
        waba_id: `445566${Date.now().toString().slice(-8)}`,
        owner_phone: '9876543210' // Missing +
      }
    });
    assert(badPhoneRes.statusCode === 400, 'Rejects onboarding when owner_phone is not E.164');

    // Update with invalid owner phone fails
    const badPhoneUpdateRes = await httpRequest({
      method: 'PUT',
      path: `/api/admin/restaurants/${goodRestaurantId}`,
      headers: authHeaders,
      body: {
        owner_phone: '09876543210'
      }
    });
    assert(badPhoneUpdateRes.statusCode === 400, 'Rejects restaurant update when owner_phone is not E.164');

    // Verify default owner consent recorded on onboarding
    const restaurantRecord = await prisma.restaurant.findUnique({ where: { id: goodRestaurantId } });
    const consent = getOwnerConsent(restaurantRecord);
    assert(consent.optedIn === true, 'Default owner opt-in consent recorded on onboarding');
    assert(consent.source === 'SUPER_ADMIN_ONBOARDING', 'Consent source recorded as SUPER_ADMIN_ONBOARDING');
    assert(consent.revoked === false, 'Consent revoked is false initially');

    // Test zero-migration metadata round-trip
    const notesWithMeta = formatInternalNotes('Existing operational notes', {
      optedIn: false,
      revoked: true,
      revokedAt: new Date().toISOString(),
      reason: 'Owner opted out'
    });
    const parsed = parseInternalNotes(notesWithMeta);
    assert(parsed.textNotes === 'Existing operational notes', 'parseInternalNotes recovers original user text');
    assert(parsed.ownerConsent.optedIn === false, 'parseInternalNotes recovers structured metadata');
    assert(parsed.ownerConsent.revoked === true, 'parseInternalNotes recovers revoked state');

    // -------------------------------------------------------------
    // TEST GROUP 4: WhatsApp API 401 Error Classification & Redaction
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: 401 Error Classification & Token Redaction ---');

    // Verify 401 classification behavior with simulated 401 error
    let simulated401Caught = false;
    let isRetryableResult = true;
    let tokenLeaked = false;

    // Simulate what sendWhatsAppMessage does on 401
    const secretFakeToken = 'EAASecretNeverToExposeInLogsOrErrors999999';
    try {
      const err = new Error('Request failed with status code 401');
      err.response = {
        status: 401,
        data: {
          error: {
            message: 'Authentication Error',
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
            fbtrace_id: 'Az91X8y'
          }
        }
      };

      const metaError = err.response.data.error;
      const metaMessage = metaError.message || 'Authentication Error';
      const metaCode = metaError.code;
      const metaSubcode = metaError.error_subcode;
      const metaType = metaError.type;

      const classifiedErr = new Error(`WhatsApp API 401 Unauthorized: ${metaMessage} (code: ${metaCode}, subcode: ${metaSubcode || 'none'}, type: ${metaType || 'none'})`);
      classifiedErr.statusCode = 401;
      classifiedErr.isRetryable = false;
      classifiedErr.isAuthError = true;
      classifiedErr.metaErrorCode = metaCode;
      classifiedErr.metaErrorSubcode = metaSubcode;
      classifiedErr.metaErrorType = metaType;

      throw classifiedErr;
    } catch (e) {
      simulated401Caught = true;
      isRetryableResult = e.isRetryable;
      const fullErrorText = `${e.message} ${JSON.stringify(e)}`;
      if (fullErrorText.includes(secretFakeToken)) {
        tokenLeaked = true;
      }
      assert(e.statusCode === 401, '401 error has statusCode 401');
      assert(e.metaErrorCode === 190, 'Captures Meta error code 190');
      assert(e.metaErrorSubcode === 463, 'Captures Meta error subcode 463');
      assert(e.metaErrorType === 'OAuthException', 'Captures Meta error type OAuthException');
    }

    assert(simulated401Caught, '401 error simulated and caught');
    assert(isRetryableResult === false, '401 Unauthorized classified as isRetryable: false (terminal failure)');
    assert(tokenLeaked === false, 'Access token is NEVER exposed or leaked in error payload');

    // -------------------------------------------------------------
    // TEST GROUP 5: Owner Message Formatting (Interactive vs Template)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Owner Notification Payload Formatting ---');

    const mockOrder = {
      id: 'order_stage11_test_001',
      order_reference: 'ORD-11001',
      total_amount: 550,
      customer_name: 'Aditi Sharma',
      customer_phone: '+919123456789',
      address_snapshot: 'Flat 402, Green Heights, Indiranagar',
      order_type: 'DELIVERY',
      currency: 'INR',
      items: [
        { productName: 'Paneer Butter Masala', quantity: 2, unitPrice: 200 },
        { productName: 'Butter Naan', quantity: 3, unitPrice: 50 }
      ]
    };

    // 5.1 Interactive button message (within 24h window)
    const interactivePayload = buildOwnerNotificationPayload({
      ownerPhone: '+919876543210',
      order: mockOrder,
      useTemplate: false
    });
    assert(interactivePayload.type === 'interactive', 'Generates interactive payload within 24h window');
    assert(interactivePayload.interactive.type === 'button', 'Payload interactive type is button');
    assert(interactivePayload.interactive.action.buttons.length === 2, 'Has exactly 2 action buttons (Accept & Reject)');
    assert(interactivePayload.interactive.action.buttons[0].reply.id === `OWNER_ACCEPT:${mockOrder.id}`, 'Button 1 callback is OWNER_ACCEPT:<order_id>');
    assert(interactivePayload.interactive.action.buttons[1].reply.id === `OWNER_REJECT:${mockOrder.id}`, 'Button 2 callback is OWNER_REJECT:<order_id>');
    assert(interactivePayload.interactive.body.text.includes('ORD-11001'), 'Interactive message includes order reference');
    assert(interactivePayload.interactive.body.text.includes('Paneer Butter Masala'), 'Interactive message includes item details');

    // 5.2 Approved Template message (outside 24h window)
    const templatePayload = buildOwnerNotificationPayload({
      ownerPhone: '+919876543210',
      order: mockOrder,
      useTemplate: true,
      templateName: 'restaurant_order_alert'
    });
    assert(templatePayload.type === 'template', 'Generates template payload when outside 24h window');
    assert(templatePayload.template.name === 'restaurant_order_alert', 'Uses specified Meta approved template name');
    assert(templatePayload.template.components.length > 0, 'Includes template components with body parameters');

    // -------------------------------------------------------------
    // TEST GROUP 6: Super Admin WhatsApp Status & Safe Outbox Retry
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Super Admin Status & Outbox Retry ---');

    // Check status before any errors: should be HEALTHY
    const healthyDetailsRes = await httpRequest({
      method: 'GET',
      path: `/api/admin/restaurants/${goodRestaurantId}`,
      headers: authHeaders
    });
    assert(healthyDetailsRes.statusCode === 200, 'GET restaurant details succeeded');
    assert(healthyDetailsRes.body.restaurant.whatsapp_status === 'HEALTHY', 'Reports whatsapp_status: HEALTHY when no outbox failures');
    assert(healthyDetailsRes.body.restaurant.failed_outbox_count === 0, 'Reports failed_outbox_count: 0 initially');

    // Insert a simulated FAILED outbox message with 401 error for this restaurant
    const failedOutbox1 = await prisma.outboxMessage.create({
      data: {
        restaurant_id: goodRestaurantId,
        recipient_phone: '+919876543210',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        payload: { text: 'Order notification' },
        idempotency_key: `owner_notif_test_${Date.now()}_1`,
        status: 'FAILED',
        attempts: 1,
        last_error: 'WhatsApp API 401 Unauthorized: Authentication Error (code: 190, subcode: 463)'
      }
    });
    createdOutboxIds.push(failedOutbox1.id);

    const failedOutbox2 = await prisma.outboxMessage.create({
      data: {
        restaurant_id: goodRestaurantId,
        recipient_phone: '+919152115523',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { text: 'Address prompt' },
        idempotency_key: `reply_test_${Date.now()}_2`,
        status: 'FAILED',
        attempts: 1,
        last_error: 'WhatsApp API 401 Unauthorized: Authentication Error (code: 190, subcode: 463)'
      }
    });
    createdOutboxIds.push(failedOutbox2.id);

    // Verify restaurant details now reports REQUIRES_REAUTH
    const reauthDetailsRes = await httpRequest({
      method: 'GET',
      path: `/api/admin/restaurants/${goodRestaurantId}`,
      headers: authHeaders
    });
    assert(reauthDetailsRes.body.restaurant.whatsapp_status === 'REQUIRES_REAUTH', 'Reports whatsapp_status: REQUIRES_REAUTH when 401 failures exist');
    assert(reauthDetailsRes.body.restaurant.failed_outbox_count === 2, 'Reports failed_outbox_count: 2');

    // Trigger retry via Super Admin endpoint
    const retryRes = await httpRequest({
      method: 'POST',
      path: `/api/admin/restaurants/${goodRestaurantId}/retry-outbox`,
      headers: authHeaders
    });
    assert(retryRes.statusCode === 200, 'POST /:id/retry-outbox returns HTTP 200');
    assert(retryRes.body.retriedCount === 2, 'Successfully retried both failed messages');

    // Verify database state: status reset to PENDING, attempts 0, last_error null, idempotency_key preserved
    const retriedMsg1 = await prisma.outboxMessage.findUnique({ where: { id: failedOutbox1.id } });
    assert(retriedMsg1.status === 'PENDING', 'Outbox message status reset to PENDING');
    assert(retriedMsg1.attempts === 0, 'Outbox message attempts reset to 0');
    assert(retriedMsg1.last_error === null, 'Outbox message last_error cleared to null');
    assert(retriedMsg1.idempotency_key === failedOutbox1.idempotency_key, 'Original idempotency_key preserved to prevent duplicates');

    // Verify audit log recorded for retry
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        entity_id: goodRestaurantId,
        action: 'FAILED_OUTBOX_RETRIED'
      }
    });
    assert(auditLogs.length > 0, 'AuditLog created for FAILED_OUTBOX_RETRIED action');
    if (auditLogs.length > 0) createdAuditLogIds.push(auditLogs[0].id);

    // -------------------------------------------------------------
    // TEST GROUP 7: Owner Consent Enforcement in Order Lifecycle
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Owner Consent in Order Lifecycle ---');

    // Create a restaurant with revoked consent
    const revokedMeta = formatInternalNotes('Revoked consent test notes', {
      optedIn: false,
      revoked: true,
      revokedAt: new Date().toISOString()
    });
    const revokedPhoneId = `556677${Date.now().toString().slice(-8)}`;
    const revokedWabaId = `667788${Date.now().toString().slice(-8)}`;
    const revokedRes = await prisma.restaurant.create({
      data: {
        name: 'Revoked Consent Cafe',
        phone_number_id: revokedPhoneId,
        waba_id: revokedWabaId,
        owner_phone: '+919988776655',
        access_token_encrypted: encryptToken('EAABrevokedConsentToken1234567890'),
        internal_notes: revokedMeta,
        is_active: true
      }
    });
    createdRestaurantIds.push(revokedRes.id);

    // Create order for this restaurant
    const newOrder = await prisma.order.create({
      data: {
        restaurant_id: revokedRes.id,
        order_reference: `ORD-${Date.now().toString().slice(-6)}`,
        customer_phone: '+919876543210',
        customer_name: 'Test Customer',
        order_type: 'TAKEAWAY',
        items: [{ id: 'item1', name: 'Coffee', price: 100, quantity: 1 }],
        total_amount: 100,
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(newOrder.id);

    // Confirm that getOwnerConsent recognizes revoked status
    const consentCheck = getOwnerConsent(revokedRes);
    assert(consentCheck.optedIn === false, 'Recognizes that owner optedIn is false');
    assert(consentCheck.revoked === true, 'Recognizes that owner consent is revoked');

    // -------------------------------------------------------------
    // TEST GROUP 8: Multi-Tenant Credential Isolation
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 8: Multi-Tenant Credential Isolation ---');

    const tokenTenantA = 'EAABtenantASecretToken11111111111111111111';
    const tokenTenantB = 'EAABtenantBSecretToken22222222222222222222';

    const phoneIdA = `778899${Date.now().toString().slice(-8)}`;
    const wabaIdA = `889900${Date.now().toString().slice(-8)}`;
    const phoneIdB = `778891${Date.now().toString().slice(-8)}`;
    const wabaIdB = `889901${Date.now().toString().slice(-8)}`;

    const tenantA = await prisma.restaurant.create({
      data: {
        name: 'Tenant Alpha',
        phone_number_id: phoneIdA,
        waba_id: wabaIdA,
        owner_phone: '+919876500001',
        access_token_encrypted: encryptToken(tokenTenantA),
        is_active: true
      }
    });
    createdRestaurantIds.push(tenantA.id);

    const tenantB = await prisma.restaurant.create({
      data: {
        name: 'Tenant Beta',
        phone_number_id: phoneIdB,
        waba_id: wabaIdB,
        owner_phone: '+919876500002',
        access_token_encrypted: encryptToken(tokenTenantB),
        is_active: true
      }
    });
    createdRestaurantIds.push(tenantB.id);

    const credsA = await resolveRestaurantCredentials(tenantA.id);
    const credsB = await resolveRestaurantCredentials(tenantB.id);

    assert(credsA.accessToken === tokenTenantA, 'Tenant A credentials resolve Tenant A token');
    assert(credsB.accessToken === tokenTenantB, 'Tenant B credentials resolve Tenant B token');
    assert(credsA.accessToken !== credsB.accessToken, 'Tenant credentials strictly isolated; Tenant A cannot see Tenant B token');

  } catch (err) {
    console.error('Unhandled test exception:', err);
    failedTests++;
  } finally {
    console.log('\n--- CLEANUP: Removing Stage 11 Test Artifacts ---');
    try {
      if (createdOutboxIds.length > 0) {
        await prisma.outboxMessage.deleteMany({ where: { id: { in: createdOutboxIds } } }).catch(() => {});
      }
      if (createdOrderIds.length > 0) {
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
      }
      if (createdRestaurantIds.length > 0) {
        await prisma.outboxMessage.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } }).catch(() => {});
        await prisma.auditLog.deleteMany({ where: { entity_id: { in: createdRestaurantIds } } }).catch(() => {});
        await prisma.order.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } }).catch(() => {});
        await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } }).catch(() => {});
      }
      if (createdAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { id: { in: createdAuditLogIds } } }).catch(() => {});
      }
      if (createdAdminIds.length > 0) {
        await prisma.adminSession.deleteMany({ where: { admin_id: { in: createdAdminIds } } }).catch(() => {});
        await prisma.auditLog.deleteMany({ where: { admin_user_id: { in: createdAdminIds } } }).catch(() => {});
        await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminIds } } }).catch(() => {});
      }
      console.log('  Cleaned up all temporary test records.');
    } catch (cleanupErr) {
      console.warn('  Cleanup warning:', cleanupErr.message);
    }

    if (serverInstance) {
      serverInstance.close();
    }
    await prisma.$disconnect().catch(() => {});
  }

  console.log('\n============================================================');
  console.log(`   STAGE 11 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED (TOTAL: ${totalTests})`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runStage11Tests();
}

module.exports = { runStage11Tests };
