process.env.NODE_ENV = 'test';

/**
 * RESTOPRO — Stage 11 & Stage 11.1 Security & Reliability Hardening Test Suite
 *
 * Comprehensive integration test suite executing actual application functions:
 * F-01 + F-07: Owner WhatsApp Notifications & 24h Messaging Window Logic (Interactive vs Meta Utility Template)
 * F-02: Encryption Key Hardening (Mandatory ENCRYPTION_KEY, legacy key decryption warning, missing key error)
 * F-03: Real Meta Token Verification (GET /{phone_number_id}, 401/403 rejection, token redaction, blank token preservation)
 * F-04: Explicit Owner Consent (Checkbox verification, revocation tracking, internal_notes metadata isolation, order suppression)
 * F-05: Safe Outbox Retry (Eligibility classification: skips stale sessions, finalized orders, permanent 131026 errors)
 * F-06: Actual Function Integration Coverage (Mocked axios 401 in sendWhatsAppMessage, confirmCustomerOrder with consent/revoked)
 * F-08: Signed Owner Callback IDs (HMAC-SHA256, constant-time verification, tampering, expiration, replay idempotency, cross-tenant defense)
 */
require('./load-test-env');

const http = require('http');
const prisma = require('../src/config/database');
const app = require('../src/app');
const { hashPassword } = require('../src/utils/password');
const { assertSafeTestAccount } = require('../src/utils/test-guard');
const { encryptToken, decryptToken, getPrimaryEncryptionKey } = require('../src/utils/crypto');
const { generateSignedOwnerCallback, verifySignedOwnerCallback } = require('../src/utils/callback-signer');
const {
  validateE164Phone,
  getOwnerConsent,
  parseInternalNotes,
  formatInternalNotes,
  createRestaurant,
  updateRestaurant,
  getRestaurantById,
  retryFailedOutboxMessages,
  sanitizeRestaurant
} = require('../src/services/admin-restaurant.service');
const {
  resolveRestaurantCredentials,
  sendWhatsAppMessage,
  buildOwnerNotificationPayload,
  verifyMetaWhatsAppToken
} = require('../src/services/whatsapp.service');
const {
  confirmCustomerOrder,
  processOwnerOrderDecision,
  parseOwnerAction,
  isOwnerMessagingWindowActive
} = require('../src/services/order.service');

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
  console.log('   RESTOPRO — STAGE 11.1 SECURITY & RELIABILITY TEST SUITE  ');
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
  const createdSessionIds = [];

  try {
    // -------------------------------------------------------------
    // SETUP: Provision Test Super Admin
    // -------------------------------------------------------------
    const adminEmail = `stage11_admin_${Date.now()}@restopro.internal`;
    assertSafeTestAccount(adminEmail, 'Stage 11 Admin Setup');
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
    // TEST GROUP 1: F-02 Encryption Key Hardening
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: F-02 Encryption Key Hardening ---');

    const sampleToken = 'EAABtestingValidToken1234567890abcdefghijklmnopqrstuvwxyz';
    const encrypted = encryptToken(sampleToken);
    assert(typeof encrypted === 'string' && encrypted.startsWith('enc:v1:'), 'encryptToken generates enc:v1:<iv>:<tag>:<cipher>');

    const decrypted = decryptToken(encrypted);
    assert(decrypted === sampleToken, 'decryptToken successfully decrypts with primary ENCRYPTION_KEY');

    // Test missing ENCRYPTION_KEY throws on new encryption
    const savedKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    let missingKeyThrows = false;
    try {
      encryptToken(sampleToken);
    } catch (err) {
      missingKeyThrows = true;
      assert(err.message.includes('ENCRYPTION_KEY environment variable is required'), 'encryptToken strictly requires ENCRYPTION_KEY');
    }
    assert(missingKeyThrows, 'encryptToken throws immediately when ENCRYPTION_KEY is unset');

    // Restore key
    process.env.ENCRYPTION_KEY = savedKey;

    // Test corrupted ciphertext fails cleanly
    let decryptionFailed = false;
    try {
      decryptToken('enc:v1:0123456789abcdef01234567:0123456789abcdef0123456789abcdef:0123456789abcdef');
    } catch (_) {
      decryptionFailed = true;
    }
    assert(decryptionFailed, 'decryptToken throws error on corrupted / invalid ciphertext');

    // -------------------------------------------------------------
    // TEST GROUP 2: F-03 Real Meta Token Verification
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: F-03 Real Meta Token Verification ---');

    // 2.1 Mocked HTTP client simulating Meta Graph API 401 Unauthorized
    const mock401HttpClient = {
      get: async (url, options) => {
        const err = new Error('Request failed with status code 401');
        err.response = {
          status: 401,
          data: {
            error: {
              message: 'Invalid OAuth access token - Cannot parse access token',
              type: 'OAuthException',
              code: 190,
              error_subcode: 463
            }
          }
        };
        throw err;
      },
      post: async (url, data, options) => {
        const err = new Error('Request failed with status code 401');
        err.response = {
          status: 401,
          data: {
            error: {
              message: 'Authentication Error',
              type: 'OAuthException',
              code: 190,
              error_subcode: 463
            }
          }
        };
        throw err;
      }
    };

    const verify401Res = await verifyMetaWhatsAppToken({
      phoneNumberId: '104829104829104',
      accessToken: 'EAABinvalidOrExpiredToken123',
      httpClient: mock401HttpClient
    });
    assert(verify401Res.valid === false, 'verifyMetaWhatsAppToken returns valid: false on 401 response');
    assert(verify401Res.statusCode === 401, 'Captures statusCode: 401');
    assert(verify401Res.errorCode === 190, 'Captures Meta error code 190');

    // 2.2 Mocked HTTP client simulating Meta Graph API 403 Forbidden (Insufficient permissions)
    const mock403HttpClient = {
      get: async () => {
        const err = new Error('Request failed with status code 403');
        err.response = {
          status: 403,
          data: {
            error: {
              message: 'Permissions error: access to this phone number is not allowed',
              type: 'OAuthException',
              code: 200
            }
          }
        };
        throw err;
      }
    };

    const verify403Res = await verifyMetaWhatsAppToken({
      phoneNumberId: '104829104829104',
      accessToken: 'EAABwrongPermissionToken123',
      httpClient: mock403HttpClient
    });
    assert(verify403Res.valid === false, 'verifyMetaWhatsAppToken returns valid: false on 403 response');
    assert(verify403Res.errorCode === 200, 'Captures Meta permission error code 200');

    // 2.3 Mocked HTTP client simulating Meta Graph API 200 Success
    const mock200HttpClient = {
      get: async (url) => ({
        status: 200,
        data: {
          id: '104829104829104',
          verified_name: 'Spice Bistro Official',
          display_phone_number: '+91 98765 43210',
          quality_rating: 'GREEN'
        }
      })
    };

    const verify200Res = await verifyMetaWhatsAppToken({
      phoneNumberId: '104829104829104',
      accessToken: 'EAABvalidMetaTokenOfficial',
      httpClient: mock200HttpClient
    });
    assert(verify200Res.valid === true, 'verifyMetaWhatsAppToken returns valid: true on 200 response');
    assert(verify200Res.verifiedName === 'Spice Bistro Official', 'Returns verified commercial name from Meta');

    // 2.4 createRestaurant rejects invalid token using mock client
    let createRejected = false;
    try {
      await createRestaurant({
        name: 'Invalid Token Bistro',
        phone_number_id: `998877${Date.now().toString().slice(-8)}`,
        waba_id: `887766${Date.now().toString().slice(-8)}`,
        owner_phone: '+919876543210',
        access_token: 'EAABrejectedToken'
      }, testAdmin.id, { httpClient: mock401HttpClient });
    } catch (err) {
      createRejected = true;
      assert(err.message.includes('token verification failed'), 'createRestaurant throws when token verification fails');
    }
    assert(createRejected, 'createRestaurant rejects invalid token verified against Meta API');

    // 2.5 Onboard restaurant with valid token using mock client
    const goodPhoneId = `112233${Date.now().toString().slice(-8)}`;
    const goodWabaId = `223344${Date.now().toString().slice(-8)}`;
    const initialToken = 'EAABvalidMetaAccessTokenForRestaurant101010101010';

    const goodRes = await createRestaurant({
      name: 'Spice Valley',
      phone_number_id: goodPhoneId,
      waba_id: goodWabaId,
      owner_phone: '+919876543210',
      owner_name: 'Rajesh Kumar',
      access_token: initialToken,
      owner_consent_verified: true
    }, testAdmin.id, { httpClient: mock200HttpClient });
    assert(goodRes.id !== undefined, 'createRestaurant succeeds with verified token');
    const goodRestaurantId = goodRes.id;
    createdRestaurantIds.push(goodRestaurantId);

    // 2.6 updateRestaurant with blank token preserves existing valid encrypted token
    const updatedWithBlank = await updateRestaurant(goodRestaurantId, {
      name: 'Spice Valley Renamed',
      access_token: '   '
    }, testAdmin.id, { httpClient: mock401HttpClient }); // even if mock fails, it should not be called on blank
    assert(updatedWithBlank.name === 'Spice Valley Renamed', 'updateRestaurant succeeded');
    const credsPreserved = await resolveRestaurantCredentials(goodRestaurantId);
    assert(credsPreserved.accessToken === initialToken, 'Existing encrypted token preserved intact when input is blank');

    // -------------------------------------------------------------
    // TEST GROUP 3: F-04 Explicit Owner Consent
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: F-04 Explicit Owner Consent ---');

    // 3.1 Onboarding without explicit consent defaults to optedIn: false
    const noConsentPhoneId = `334455${Date.now().toString().slice(-8)}`;
    const noConsentWabaId = `445566${Date.now().toString().slice(-8)}`;
    const noConsentRes = await createRestaurant({
      name: 'No Consent Cafe',
      phone_number_id: noConsentPhoneId,
      waba_id: noConsentWabaId,
      owner_phone: '+919876543211',
      access_token: 'mock_token'
    }, testAdmin.id);
    createdRestaurantIds.push(noConsentRes.id);

    const noConsentRecord = await prisma.restaurant.findUnique({ where: { id: noConsentRes.id } });
    const noConsentStatus = getOwnerConsent(noConsentRecord);
    assert(noConsentStatus.optedIn === false, 'Default owner consent is optedIn: false when checkbox unselected');
    assert(noConsentStatus.source === 'NOT_CONFIGURED', 'Default consent source is NOT_CONFIGURED');

    // 3.2 Super Admin explicitly grants consent
    await updateRestaurant(noConsentRes.id, {
      owner_consent_verified: true
    }, testAdmin.id);
    const grantedRecord = await prisma.restaurant.findUnique({ where: { id: noConsentRes.id } });
    const grantedConsent = getOwnerConsent(grantedRecord);
    assert(grantedConsent.optedIn === true, 'Consent successfully granted via owner_consent_verified: true');
    assert(grantedConsent.revoked === false, 'Revoked flag is false');
    assert(grantedConsent.source === 'SUPER_ADMIN_MANUAL_VERIFIED', 'Consent source recorded as SUPER_ADMIN_MANUAL_VERIFIED');

    // 3.3 Super Admin revokes consent
    await updateRestaurant(noConsentRes.id, {
      owner_consent_verified: false,
      revokedReason: 'Owner requested SMS only'
    }, testAdmin.id);
    const revokedRecord = await prisma.restaurant.findUnique({ where: { id: noConsentRes.id } });
    const revokedConsent = getOwnerConsent(revokedRecord);
    assert(revokedConsent.optedIn === false, 'Consent revoked via owner_consent_verified: false');
    assert(revokedConsent.revoked === true, 'Revoked flag set to true');

    // 3.4 Sanitization strips metadata tag from internal_notes
    const noteWithTag = formatInternalNotes('Ordinary notes for delivery', revokedConsent);
    await prisma.restaurant.update({
      where: { id: noConsentRes.id },
      data: { internal_notes: noteWithTag }
    });
    const sanitizedView = sanitizeRestaurant(await prisma.restaurant.findUnique({ where: { id: noConsentRes.id } }));
    assert(sanitizedView.internal_notes === 'Ordinary notes for delivery', 'sanitizeRestaurant strips <!--RESTOPRO_METADATA--> tags');

    // 3.5 Ordinary note edits do not erase consent metadata
    await updateRestaurant(noConsentRes.id, {
      internal_notes: 'Updated ordinary notes without metadata tag'
    }, testAdmin.id);
    const preservedConsentRecord = await prisma.restaurant.findUnique({ where: { id: noConsentRes.id } });
    const preservedConsent = getOwnerConsent(preservedConsentRecord);
    assert(preservedConsent.revoked === true, 'Consent metadata preserved intact across plain text internal_notes update');

    // -------------------------------------------------------------
    // TEST GROUP 4: F-01 & F-07 Owner WhatsApp Notifications & 24h Window
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: F-01 & F-07 Owner Order Alerts & 24h Window ---');

    // 4.1 Confirm customer order with consent granted & active window -> enqueues OWNER_ORDER_NOTIFICATION
    const testCustPhone1 = `919811${Math.floor(100000 + Math.random() * 900000)}`;
    const sessionToken1 = `conf_token_1_${Date.now()}`;
    const custSession1 = await prisma.conversationSession.create({
      data: {
        restaurant_id: goodRestaurantId,
        customer_phone: testCustPhone1,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          orderType: 'DELIVERY',
          address: { addressText: '123 Test Street' },
          confirmationToken: sessionToken1,
          cart: {
            items: [
              { productRetailerId: 'ITEM_1', productName: 'Biryani', quantity: 2, item_price: 250, currency: 'INR' }
            ],
            subtotal: 500,
            currency: 'INR'
          }
        },
        expires_at: new Date(Date.now() + 3600 * 1000)
      }
    });
    createdSessionIds.push(custSession1.id);

    const confirmResult = await confirmCustomerOrder({
      restaurantId: goodRestaurantId,
      customerPhone: testCustPhone1,
      confirmationToken: sessionToken1,
      customerName: 'Aarav Patel'
    });
    assert(confirmResult.success === true, 'confirmCustomerOrder succeeds');
    assert(confirmResult.order !== undefined, 'Order created in database');
    createdOrderIds.push(confirmResult.order.id);

    const ownerOutboxMsg = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: goodRestaurantId,
        message_type: 'OWNER_ORDER_NOTIFICATION',
        idempotency_key: `owner_notif_${confirmResult.order.id}`
      }
    });
    assert(ownerOutboxMsg !== null, 'OWNER_ORDER_NOTIFICATION outbox message created for consented restaurant');
    assert(ownerOutboxMsg.status === 'PENDING', 'Outbox status is PENDING');
    assert(ownerOutboxMsg.payload?.type === 'interactive', 'Dispatches session interactive button message when window is open');
    if (ownerOutboxMsg) createdOutboxIds.push(ownerOutboxMsg.id);

    // 4.2 Confirm customer order when consent is revoked -> zero outbox messages created
    const testCustPhone2 = `919812${Math.floor(100000 + Math.random() * 900000)}`;
    const revokedSessionToken = `conf_token_rev_${Date.now()}`;
    const revokedCustSession = await prisma.conversationSession.create({
      data: {
        restaurant_id: noConsentRes.id,
        customer_phone: testCustPhone2,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          orderType: 'TAKEAWAY',
          confirmationToken: revokedSessionToken,
          cart: {
            items: [{ productRetailerId: 'ITEM_2', productName: 'Tea', quantity: 1, item_price: 50, currency: 'INR' }],
            subtotal: 50,
            currency: 'INR'
          }
        },
        expires_at: new Date(Date.now() + 3600 * 1000)
      }
    });
    createdSessionIds.push(revokedCustSession.id);

    const revokedConfirmResult = await confirmCustomerOrder({
      restaurantId: noConsentRes.id,
      customerPhone: testCustPhone2,
      confirmationToken: revokedSessionToken
    });
    assert(revokedConfirmResult.success === true, 'Order created successfully even when owner consent revoked');
    createdOrderIds.push(revokedConfirmResult.order.id);

    const suppressedOutboxMsg = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: noConsentRes.id,
        message_type: 'OWNER_ORDER_NOTIFICATION',
        idempotency_key: `owner_notif_${revokedConfirmResult.order.id}`
      }
    });
    assert(suppressedOutboxMsg === null, 'Zero outbox messages created when owner consent is revoked or absent');

    // 4.3 Outside 24h window without approved template -> marks as BLOCKED_TEMPLATE_NOT_CONFIGURED
    process.env.TEST_FORCE_WINDOW_CLOSED = 'true';
    delete process.env.OWNER_TEMPLATE_APPROVED;

    const testCustPhone3 = `919813${Math.floor(100000 + Math.random() * 900000)}`;
    const blockedSessionToken = `conf_token_blocked_${Date.now()}`;
    const blockedCustSession = await prisma.conversationSession.create({
      data: {
        restaurant_id: goodRestaurantId,
        customer_phone: testCustPhone3,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          orderType: 'TAKEAWAY',
          confirmationToken: blockedSessionToken,
          cart: {
            items: [{ productRetailerId: 'ITEM_3', productName: 'Dosa', quantity: 1, item_price: 120, currency: 'INR' }],
            subtotal: 120,
            currency: 'INR'
          }
        },
        expires_at: new Date(Date.now() + 3600 * 1000)
      }
    });
    createdSessionIds.push(blockedCustSession.id);

    const blockedConfirmResult = await confirmCustomerOrder({
      restaurantId: goodRestaurantId,
      customerPhone: testCustPhone3,
      confirmationToken: blockedSessionToken
    });
    createdOrderIds.push(blockedConfirmResult.order.id);

    const blockedOutboxMsg = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: goodRestaurantId,
        idempotency_key: `owner_notif_${blockedConfirmResult.order.id}`
      }
    });
    assert(blockedOutboxMsg !== null, 'Outbox message record created');
    assert(blockedOutboxMsg.status === 'FAILED', 'Status is marked FAILED when template is unapproved and window closed');
    assert(blockedOutboxMsg.last_error.includes('BLOCKED_TEMPLATE_NOT_CONFIGURED'), 'last_error clearly specifies BLOCKED_TEMPLATE_NOT_CONFIGURED');
    if (blockedOutboxMsg) createdOutboxIds.push(blockedOutboxMsg.id);

    // 4.4 Outside 24h window with approved template -> dispatches Meta Utility Template (restopro_order_alert)
    process.env.OWNER_TEMPLATE_APPROVED = 'true';

    const testCustPhone4 = `919814${Math.floor(100000 + Math.random() * 900000)}`;
    const templateSessionToken = `conf_token_tmpl_${Date.now()}`;
    const templateCustSession = await prisma.conversationSession.create({
      data: {
        restaurant_id: goodRestaurantId,
        customer_phone: testCustPhone4,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          orderType: 'TAKEAWAY',
          confirmationToken: templateSessionToken,
          cart: {
            items: [{ productRetailerId: 'ITEM_4', productName: 'Idli', quantity: 2, item_price: 60, currency: 'INR' }],
            subtotal: 120,
            currency: 'INR'
          }
        },
        expires_at: new Date(Date.now() + 3600 * 1000)
      }
    });
    createdSessionIds.push(templateCustSession.id);

    const templateConfirmResult = await confirmCustomerOrder({
      restaurantId: goodRestaurantId,
      customerPhone: testCustPhone4,
      confirmationToken: templateSessionToken
    });
    createdOrderIds.push(templateConfirmResult.order.id);

    const templateOutboxMsg = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: goodRestaurantId,
        idempotency_key: `owner_notif_${templateConfirmResult.order.id}`
      }
    });
    assert(templateOutboxMsg !== null, 'Template outbox message created');
    assert(templateOutboxMsg.status === 'PENDING', 'Template outbox status is PENDING');
    assert(templateOutboxMsg.payload?.type === 'template', 'Dispatches template payload when window is closed and template is approved');
    assert(templateOutboxMsg.payload?.template?.name === 'restopro_order_alert', 'Uses approved Meta Utility Template name: restopro_order_alert');
    if (templateOutboxMsg) createdOutboxIds.push(templateOutboxMsg.id);

    // Clean up window env flags
    delete process.env.TEST_FORCE_WINDOW_CLOSED;
    delete process.env.OWNER_TEMPLATE_APPROVED;

    // -------------------------------------------------------------
    // TEST GROUP 5: F-06 Actual sendWhatsAppMessage() with Mocked 401
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: F-06 sendWhatsAppMessage() with Mocked 401 ---');

    const result401 = await sendWhatsAppMessage({
      phoneNumberId: goodPhoneId,
      accessToken: 'EAABfakeExpiredToken401Test',
      recipientPhone: '+919876543210',
      payload: { text: { body: 'Hello' } },
      httpClient: mock401HttpClient
    });
    assert(result401.success === false, 'sendWhatsAppMessage returns success: false on 401');
    assert(result401.statusCode === 401, 'Captures statusCode: 401');
    assert(result401.isRetryable === false, '401 is classified as isRetryable: false (non-retryable terminal auth failure)');
    assert(result401.isAuthError === true, 'Flagged as isAuthError: true');

    // -------------------------------------------------------------
    // TEST GROUP 6: F-05 Safe Outbox Retry Classification
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: F-05 Safe Outbox Retry Classification ---');

    // 6.1 Create eligible 401 message (order still PENDING_RESTAURANT_CONFIRMATION)
    const orderForRetry = await prisma.order.create({
      data: {
        restaurant_id: goodRestaurantId,
        order_reference: `RP-${Date.now().toString().slice(-6)}-RETR`,
        customer_phone: '919815000001',
        customer_name: 'Retry Customer',
        order_type: 'TAKEAWAY',
        items: [{ id: 'item1', name: 'Coffee', price: 100, quantity: 1 }],
        total_amount: 100,
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderForRetry.id);

    const eligibleOutbox = await prisma.outboxMessage.create({
      data: {
        restaurant_id: goodRestaurantId,
        recipient_phone: '+919876543210',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        payload: { text: 'Owner alert' },
        idempotency_key: `owner_notif_${orderForRetry.id}`,
        status: 'FAILED',
        attempts: 1,
        last_error: 'WhatsApp API 401 Unauthorized: Authentication Error (code: 190)'
      }
    });
    createdOutboxIds.push(eligibleOutbox.id);

    // 6.2 Ineligible: Owner alert for already finalized order (status ACCEPTED)
    const finalizedOrder = await prisma.order.create({
      data: {
        restaurant_id: goodRestaurantId,
        order_reference: `RP-${Date.now().toString().slice(-6)}-FIN`,
        customer_phone: '919815000002',
        customer_name: 'Finalized Customer',
        order_type: 'TAKEAWAY',
        items: [{ id: 'item1', name: 'Tea', price: 50, quantity: 1 }],
        total_amount: 50,
        status: 'ACCEPTED'
      }
    });
    createdOrderIds.push(finalizedOrder.id);

    const finalizedOutbox = await prisma.outboxMessage.create({
      data: {
        restaurant_id: goodRestaurantId,
        recipient_phone: '+919876543210',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        payload: { text: 'Finalized alert' },
        idempotency_key: `owner_notif_${finalizedOrder.id}`,
        status: 'FAILED',
        attempts: 1,
        last_error: 'Connection timeout'
      }
    });
    createdOutboxIds.push(finalizedOutbox.id);

    // 6.3 Create ineligible permanent recipient error (code 131026)
    const permanentRecipientOutbox = await prisma.outboxMessage.create({
      data: {
        restaurant_id: goodRestaurantId,
        recipient_phone: '+919999999999',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { text: 'Customer prompt' },
        idempotency_key: `perm_error_${Date.now()}`,
        status: 'FAILED',
        attempts: 1,
        last_error: 'Meta WhatsApp Error 131026: Receiver is not on WhatsApp'
      }
    });
    createdOutboxIds.push(permanentRecipientOutbox.id);

    // 6.4 Create ineligible stale customer session reply (expired session)
    const staleCustSession = await prisma.conversationSession.create({
      data: {
        restaurant_id: goodRestaurantId,
        customer_phone: '919000000001',
        current_step: 'IDLE',
        expires_at: new Date(Date.now() - 3600 * 1000) // Expired 1 hour ago
      }
    });
    createdSessionIds.push(staleCustSession.id);

    const staleReplyOutbox = await prisma.outboxMessage.create({
      data: {
        restaurant_id: goodRestaurantId,
        recipient_phone: '919000000001',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { text: 'Stale reprompt' },
        idempotency_key: `stale_reply_${Date.now()}`,
        status: 'FAILED',
        attempts: 1,
        last_error: 'Connection timeout'
      }
    });
    createdOutboxIds.push(staleReplyOutbox.id);

    // Execute retryFailedOutboxMessages
    const retryResult = await retryFailedOutboxMessages(goodRestaurantId, testAdmin.id);
    assert(retryResult.success === true, 'retryFailedOutboxMessages executed successfully');
    assert(retryResult.retriedCount >= 1, 'Eligible messages were retried');
    assert(retryResult.skippedCount >= 3, 'Ineligible messages were skipped with reasons');

    const skippedReasons = retryResult.skippedDetails.map(d => d.reason);
    assert(skippedReasons.includes('PERMANENT_RECIPIENT_ERROR'), 'Skipped permanent recipient error 131026');
    assert(skippedReasons.includes('STALE_CONVERSATION_SESSION'), 'Skipped stale conversation session prompt');
    assert(skippedReasons.includes('ORDER_ALREADY_FINALIZED'), 'Skipped alert for finalized order');

    // Verify eligible message was reset to PENDING while ineligible remains FAILED
    const checkEligible = await prisma.outboxMessage.findUnique({ where: { id: eligibleOutbox.id } });
    assert(checkEligible.status === 'PENDING', 'Eligible 401 outbox message reset to PENDING');
    assert(checkEligible.attempts === 0, 'Eligible attempts reset to 0');
    assert(checkEligible.idempotency_key === eligibleOutbox.idempotency_key, 'Original idempotency_key strictly preserved');

    const checkPermanent = await prisma.outboxMessage.findUnique({ where: { id: permanentRecipientOutbox.id } });
    assert(checkPermanent.status === 'FAILED', 'Permanent recipient error remains in FAILED status');

    const checkStale = await prisma.outboxMessage.findUnique({ where: { id: staleReplyOutbox.id } });
    assert(checkStale.status === 'FAILED', 'Stale session prompt remains in FAILED status');

    // -------------------------------------------------------------
    // TEST GROUP 7: F-08 Signed Owner Callback IDs & Tamper Resistance
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: F-08 Signed Owner Callback IDs & Tamper Resistance ---');

    const testOrderId = confirmResult.order.id;

    // 7.1 Generate valid signed callback
    const signedAccept = generateSignedOwnerCallback({ orderId: testOrderId, action: 'ACCEPT' });
    const signedReject = generateSignedOwnerCallback({ orderId: testOrderId, action: 'REJECT' });
    assert(signedAccept.startsWith(`OWNER_ACCEPT:${testOrderId}:sig:v1:`), 'Signed Accept callback begins with OWNER_ACCEPT:<id>:sig:v1:');
    assert(signedReject.startsWith(`OWNER_REJECT:${testOrderId}:sig:v1:`), 'Signed Reject callback begins with OWNER_REJECT:<id>:sig:v1:');

    // 7.2 Verify valid signature
    const verifyValid = verifySignedOwnerCallback(signedAccept);
    assert(verifyValid.valid === true, 'Valid signed callback verifies successfully');
    assert(verifyValid.action === 'ACCEPT', 'Parsed action is ACCEPT');
    assert(verifyValid.orderId === testOrderId, 'Parsed orderId matches target order');
    assert(verifyValid.isLegacy === false, 'isLegacy is false');

    // 7.3 Tampered signature is rejected
    const tamperedPayload = signedAccept.slice(0, -4) + '0000';
    const verifyTampered = verifySignedOwnerCallback(tamperedPayload);
    assert(verifyTampered.valid === false, 'Tampered callback fails verification');
    assert(verifyTampered.code === 'TAMPERED_CALLBACK', 'Returns TAMPERED_CALLBACK code');

    // 7.4 Expired callback is rejected
    const expiredPayload = generateSignedOwnerCallback({ orderId: testOrderId, action: 'ACCEPT', ttlSeconds: -60 });
    const verifyExpired = verifySignedOwnerCallback(expiredPayload);
    assert(verifyExpired.valid === false, 'Expired callback fails verification');
    assert(verifyExpired.code === 'EXPIRED_CALLBACK', 'Returns EXPIRED_CALLBACK code');

    // 7.5 Legacy format is supported for backward compatibility
    const legacyPayload = `OWNER_ACCEPT:${testOrderId}`;
    const verifyLegacy = verifySignedOwnerCallback(legacyPayload);
    assert(verifyLegacy.valid === true, 'Legacy unsigned callback accepted for backward compatibility');
    assert(verifyLegacy.isLegacy === true, 'Legacy callback flagged with isLegacy: true');

    // 7.6 Unauthorized sender phone to processOwnerOrderDecision is rejected
    const unauthorizedDecision = await processOwnerOrderDecision({
      restaurantId: goodRestaurantId,
      senderPhone: '+919999999999', // Spoofed phone does not match owner_phone
      buttonPayload: signedAccept
    });
    assert(unauthorizedDecision.success === false, 'processOwnerOrderDecision rejects unauthorized sender phone');
    assert(unauthorizedDecision.code === 'UNAUTHORIZED_OWNER', 'Returns UNAUTHORIZED_OWNER error code');

    // 7.7 Authorized owner processes decision
    const authorizedDecision = await processOwnerOrderDecision({
      restaurantId: goodRestaurantId,
      senderPhone: '+919876543210', // Matches goodRestaurant owner_phone
      buttonPayload: signedAccept
    });
    assert(authorizedDecision.success === true, 'Authorized owner Accept decision succeeds');
    assert(authorizedDecision.newStatus === 'ACCEPTED', 'Order transitioned to ACCEPTED');
    if (authorizedDecision.outboxMessage) createdOutboxIds.push(authorizedDecision.outboxMessage.id);

    // 7.8 Replay idempotency: repeated decision returns isDuplicate: true without modifying state
    const replayDecision = await processOwnerOrderDecision({
      restaurantId: goodRestaurantId,
      senderPhone: '+919876543210',
      buttonPayload: signedAccept
    });
    assert(replayDecision.success === true, 'Replayed Accept decision succeeds idempotently');
    assert(replayDecision.isDuplicate === true, 'Returns isDuplicate: true');

    // 7.9 Cross-tenant defense: decision on another tenant's order is rejected
    const crossTenantDecision = await processOwnerOrderDecision({
      restaurantId: noConsentRes.id, // wrong restaurant
      senderPhone: '+919876543211',
      buttonPayload: signedAccept // belongs to goodRestaurantId
    });
    assert(crossTenantDecision.success === false, 'Cross-tenant owner decision is rejected');
    assert(crossTenantDecision.code === 'CROSS_TENANT_VIOLATION', 'Returns CROSS_TENANT_VIOLATION');

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
        await prisma.orderNotification.deleteMany({ where: { order_id: { in: createdOrderIds } } }).catch(() => {});
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
      }
      if (createdSessionIds.length > 0) {
        await prisma.conversationSession.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
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
  console.log(`   STAGE 11.1 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED (TOTAL: ${totalTests})`);
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
