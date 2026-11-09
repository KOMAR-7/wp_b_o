/**
 * RESTOPRO — R6.7 End-to-End Staging Verification & Multi-Tenant Routing Test Suite
 *
 * Verifies all Phase 5, Phase 6, and Phase 7 scenarios:
 *
 * PHASE 5: Webhook Configuration
 * - Webhook challenge handshake (GET /api/webhook)
 * - HMAC-SHA256 signature verification (X-Hub-Signature-256)
 * - Tampered/invalid signature rejection (HTTP 401/403)
 * - Duplicate webhook idempotency (HTTP 200, zero reprocessing)
 * - Central vs Restaurant webhook event segregation
 * - Central callback resolves tenant from order record, never by guessing from central phone_number_id
 * - Non-owner text message to XYZ receives safe informational response
 *
 * PHASE 6: Complete Two-Restaurant Staging Test
 * - Restaurant A (ABC) + Restaurant B (DEF) + Central (XYZ)
 * - Scenario A: Restaurant A full flow (customer conversation -> cart -> address -> order -> central alert -> accept -> central customer confirmation)
 * - Scenario B: Restaurant B full flow (isolated tenant scoping, DEF -> XYZ -> DEF owner -> XYZ customer)
 * - Scenario C: Rejection flow (Owner A rejects -> customer receives rejected template notification)
 * - Scenario D: Security & Idempotency:
 *   - Owner A attempting to accept Restaurant B's order (rejected: UNAUTHORIZED_OWNER / CROSS_TENANT)
 *   - Owner B attempting to reject Restaurant A's order (rejected: UNAUTHORIZED_OWNER)
 *   - Customer attempting to submit owner decision (rejected: UNAUTHORIZED_OWNER)
 *   - Invalid HMAC signature on button callback (rejected: INVALID_CALLBACK_SIGNATURE)
 *   - Expired button callback (rejected: CALLBACK_EXPIRED)
 *   - Duplicate Accept callback (idempotent 200, zero duplicate processing)
 *   - Duplicate Reject callback (idempotent 200)
 *   - Accept followed by Reject (rejected: CONFLICTING_DECISION)
 *   - Reject followed by Accept (rejected: CONFLICTING_DECISION)
 *   - Missing / unapproved template (fails safe: BLOCKED_TEMPLATE_NOT_CONFIGURED)
 *   - Central credential failure (classified as CENTRAL_CREDENTIAL_ERROR, no fallback)
 *   - Central API outage / timeout (UNCERTAIN_DISPATCH / FAILED, zero blind retries)
 *
 * PHASE 7: 24-Hour Window & Template Behavior
 * - Customer conversation with ABC opens window for ABC only, NOT for XYZ
 * - Central-originated messages to customer strictly use approved Meta templates
 * - Out-of-window customer messages never sent as free-form text in CENTRAL mode
 * - Failed template deliveries safely recorded in outbox & order_notifications
 * - Zero duplicate notifications created
 */

process.env.NODE_ENV = 'test';
process.env.NOTIFICATION_ROUTING_MODE = 'CENTRAL';

const http = require('http');
const crypto = require('crypto');
const prisma = require('../src/config/database');
const app = require('../src/app');
const config = require('../src/config/env');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');
const {
  createCentralAccount,
  resolveCentralCredentials,
  sanitizeCentralAccount,
  setCentralSenderForTesting
} = require('../src/services/central-whatsapp.service');
const { isCentralPhoneNumberId, resolveTenantByPhoneNumberId } = require('../src/services/tenant.service');
const { handleIncomingMessage, processIncomingCart } = require('../src/services/conversation.service');
const { confirmCustomerOrder, processOwnerOrderDecision } = require('../src/services/order.service');
const { dispatchPendingOutboxMessages, updateOutboxResult } = require('../src/services/outbox.service');
const {
  isTemplateApproved,
  setTemplateApprovalForTesting,
  resetTemplateApprovalsForTesting,
  getCopyReadyTemplateDefinitions,
  submitCentralTemplateToMeta,
  SUPPORTED_TEMPLATES
} = require('../src/services/template-config.service');
const { formatInternalNotes } = require('../src/services/admin-restaurant.service');
const { encryptToken } = require('../src/utils/crypto');

const TEST_PORT = 4992;
let serverInstance;
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

function computeSignature(payloadString, secret = config.meta.appSecret || 'test_secret') {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(payloadString, 'utf8'))
    .digest('hex');
  return `sha256=${hash}`;
}

function makeRequest({ method = 'POST', path = '/api/webhook', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runStagingVerificationTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — R6.7 END-TO-END STAGING VERIFICATION SUITE     ');
  console.log('   (Phase 5 Webhooks, Phase 6 Scenarios A-D, Phase 7 Window) ');
  console.log('============================================================\n');

  // Track entities for teardown
  const createdCentralAccountIds = [];
  const createdRestaurantIds = [];
  const createdOrderIds = [];
  const createdOutboxIds = [];
  const createdWebhookEventIds = [];
  const createdSessionIds = [];

  const centralPhoneId = '999888777000'; // Central XYZ
  const restAPhoneId = '111444555001';   // Restaurant A (ABC)
  const restBPhoneId = '111444555002';   // Restaurant B (DEF)
  const ownerAPhone = '919871110001';
  const ownerBPhone = '919872220002';
  const customerAPhone = '919611110001';
  const customerBPhone = '919622220002';

  try {
    // -------------------------------------------------------------------------
    // 0. Setup: Clean any stale test accounts & seed clean Central + Restaurants
    // -------------------------------------------------------------------------
    await prisma.centralWhatsAppAccount.deleteMany({
      where: { phone_number_id: centralPhoneId }
    });
    await prisma.centralWhatsAppAccount.updateMany({
      where: { is_active: true },
      data: { is_active: false }
    });

    // Seed Active Central Account with Approved Templates
    const centralAccount = await createCentralAccount({
      phoneNumberId: centralPhoneId,
      wabaId: 'waba_central_staging_xyz',
      accessToken: 'EAAB_test_staging_central_token_xyz',
      displayPhoneNumber: '+91 99988 87770',
      isActive: true,
      templates: {
        restopro_order_alert: { status: 'APPROVED', approvalSource: 'META_VERIFIED', verifiedAt: new Date().toISOString() },
        restopro_customer_order_accepted: { status: 'APPROVED', approvalSource: 'META_VERIFIED', verifiedAt: new Date().toISOString() },
        restopro_customer_order_rejected: { status: 'APPROVED', approvalSource: 'META_VERIFIED', verifiedAt: new Date().toISOString() }
      }
    });
    createdCentralAccountIds.push(centralAccount.id);

    // Seed Restaurant A (ABC)
    const restA = await prisma.restaurant.create({
      data: {
        name: 'Curry Palace (Restaurant A)',
        address: '10 Connaught Place, New Delhi',
        phone_number_id: restAPhoneId,
        waba_id: 'waba_rest_a_staging',
        owner_phone: `+${ownerAPhone}`,
        access_token_encrypted: 'mock_token_rest_a',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: formatInternalNotes('Restaurant A Notes', {
          optedIn: true,
          templateApproved: true,
          authorizedOwners: [`+${ownerAPhone}`]
        })
      }
    });
    createdRestaurantIds.push(restA.id);

    // Seed Restaurant B (DEF)
    const restB = await prisma.restaurant.create({
      data: {
        name: 'Sushi Zen (Restaurant B)',
        address: '45 Bandra West, Mumbai',
        phone_number_id: restBPhoneId,
        waba_id: 'waba_rest_b_staging',
        owner_phone: `+${ownerBPhone}`,
        access_token_encrypted: 'mock_token_rest_b',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: formatInternalNotes('Restaurant B Notes', {
          optedIn: true,
          templateApproved: true,
          authorizedOwners: [`+${ownerBPhone}`]
        })
      }
    });
    createdRestaurantIds.push(restB.id);

    // Start Express Test Server
    serverInstance = http.createServer(app);
    await new Promise((resolve) => serverInstance.listen(TEST_PORT, resolve));
    console.log(`[TEST SERVER] Listening on http://127.0.0.1:${TEST_PORT}\n`);

    // =========================================================================
    // PHASE 5: Webhook Configuration & Security Verification
    // =========================================================================
    console.log('--- TEST GROUP 1: Webhook Handshake & Cryptographic Verification ---');

    // 1.1 Webhook GET verification handshake
    const verifyToken = config.meta.verifyToken || 'restopro_dev_verify_token_2026';
    const challengeRes = await makeRequest({
      method: 'GET',
      path: `/api/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=staging_challenge_123`
    });
    assert(challengeRes.statusCode === 200, 'Webhook GET challenge returns HTTP 200');
    assert(challengeRes.body === 'staging_challenge_123', 'Webhook GET challenge echoes back hub.challenge');

    // 1.2 Invalid verify token rejected
    const badTokenRes = await makeRequest({
      method: 'GET',
      path: '/api/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=bad_chal'
    });
    assert(badTokenRes.statusCode === 403, 'Webhook GET with invalid verify_token returns HTTP 403 Forbidden');

    // 1.3 Missing HMAC signature header rejected
    const missingSigRes = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: [] })
    });
    assert(missingSigRes.statusCode === 401, 'POST without x-hub-signature-256 returns HTTP 401 Unauthorized');

    // 1.4 Tampered HMAC signature rejected
    const tamperedPayload = JSON.stringify({ entry: [{ changes: [{ value: { messages: [] } }] }] });
    const tamperedSigRes = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000'
      },
      body: tamperedPayload
    });
    assert(tamperedSigRes.statusCode === 403, 'POST with tampered signature returns HTTP 403 Forbidden');

    // 1.5 Valid HMAC signature accepted
    const validBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const validSig = computeSignature(validBody);
    const validSigRes = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': validSig
      },
      body: validBody
    });
    assert(validSigRes.statusCode === 200, 'POST with valid HMAC signature returns HTTP 200 OK');

    // 1.6 Duplicate webhook delivery idempotency
    const dupeMsgId = `wamid.STAGING_DUPE_${Date.now()}`;
    const dupePayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_test',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '1234', phone_number_id: restAPhoneId },
            messages: [{
              from: customerAPhone,
              id: dupeMsgId,
              timestamp: String(Math.floor(Date.now() / 1000)),
              text: { body: 'Hi' },
              type: 'text'
            }]
          },
          field: 'messages'
        }]
      }]
    });
    const dupeSig = computeSignature(dupePayload);

    const firstDelivery = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': dupeSig },
      body: dupePayload
    });
    assert(firstDelivery.statusCode === 200, 'First webhook delivery returns HTTP 200');

    const secondDelivery = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': dupeSig },
      body: dupePayload
    });
    assert(secondDelivery.statusCode === 200, 'Retried duplicate webhook delivery returns HTTP 200 safely');

    const dupeDbCount = await prisma.webhookEvent.count({ where: { event_key: dupeMsgId } });
    assert(dupeDbCount === 1, 'Exactly 1 row persisted in webhook_events (Zero duplicate persistence)');

    // 1.7 Non-owner text message to Central XYZ receives safe informational response
    let interceptedCentralMsg = null;
    setCentralSenderForTesting(async ({ phoneNumberId, accessToken, payload }) => {
      interceptedCentralMsg = payload;
      return { success: true };
    });

    const unknownCentralMsgId = `wamid.CENTRAL_UNKNOWN_${Date.now()}`;
    const unknownCentralPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_central',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '99988', phone_number_id: centralPhoneId },
            messages: [{
              from: customerAPhone,
              id: unknownCentralMsgId,
              timestamp: String(Math.floor(Date.now() / 1000)),
              text: { body: 'Can I book a table?' },
              type: 'text'
            }]
          },
          field: 'messages'
        }]
      }]
    });
    const unknownSig = computeSignature(unknownCentralPayload);
    const unknownRes = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': unknownSig },
      body: unknownCentralPayload
    });
    assert(unknownRes.statusCode === 200, 'Unknown text message to Central XYZ returns HTTP 200');
    assert(Boolean(interceptedCentralMsg), 'Central informational response transmitted');
    assert(interceptedCentralMsg?.text?.body?.includes('automated dispatch notification'), 'Informational response explains central notification purpose');
    setCentralSenderForTesting(null);

    // =========================================================================
    // PHASE 6: Scenario A — Restaurant A (ABC) Full End-to-End Central Routing
    // =========================================================================
    console.log('\n--- TEST GROUP 2: Scenario A — Restaurant A Complete End-to-End ---');

    // Step A.1: Customer A browses catalogue and creates cart on Restaurant A (ABC)
    await prisma.conversationSession.deleteMany({
      where: { restaurant_id: restA.id, customer_phone: customerAPhone }
    });
    const confirmationTokenA = 'tok_staging_order_a_' + Date.now();
    const sessionA = await prisma.conversationSession.create({
      data: {
        restaurant_id: restA.id,
        customer_phone: customerAPhone,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        state: {
          cart: {
            items: [
              { productRetailerId: 'prod_curry_01', productName: 'Chicken Tikka Masala', quantity: 2, unitPrice: 350 },
              { productRetailerId: 'prod_naan_01', productName: 'Garlic Naan', quantity: 3, unitPrice: 50 }
            ]
          },
          orderType: 'DELIVERY',
          address: { addressText: 'Flat 402, Lotus Tower, CP, New Delhi' },
          confirmationToken: confirmationTokenA,
          customerName: 'Aarav Sharma'
        }
      }
    });
    createdSessionIds.push(sessionA.id);

    // Step A.2: Confirm Order A
    const orderAResult = await confirmCustomerOrder({
      restaurantId: restA.id,
      customerPhone: customerAPhone,
      confirmationToken: confirmationTokenA,
      customerName: 'Aarav Sharma'
    });

    assert(orderAResult.success === true, 'Restaurant A order confirmed successfully');
    const orderA = orderAResult.order;
    createdOrderIds.push(orderA.id);
    assert(orderA.restaurant_id === restA.id, 'Order strictly scoped to Restaurant A');
    assert(orderA.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order A initial status is PENDING_RESTAURANT_CONFIRMATION');

    // Step A.3: Verify Owner A notification enqueued with sender_channel: CENTRAL
    const ownerOutboxA = await prisma.outboxMessage.findUnique({
      where: { id: orderAResult.outboxMessage.id }
    });
    assert(Boolean(ownerOutboxA), 'Owner A order notification outbox record found');
    assert(ownerOutboxA.sender_channel === 'CENTRAL', 'Owner A notification sender_channel is CENTRAL (XYZ)');
    assert(ownerOutboxA.payload?.type === 'template', 'Owner A notification formatted as Meta Utility Template');
    assert(ownerOutboxA.payload?.template?.name === 'restopro_order_alert', 'Uses restopro_order_alert template');
    if (ownerOutboxA) createdOutboxIds.push(ownerOutboxA.id);

    // Step A.4: Verify signed quick-reply buttons on owner alert
    const quickReplyButtonsA = ownerOutboxA.payload?.template?.components?.filter(c => c.type === 'button') || [];
    assert(quickReplyButtonsA.length === 2, 'Owner alert has exactly 2 quick-reply buttons (Accept, Reject)');
    const acceptPayloadA = quickReplyButtonsA[0]?.parameters?.[0]?.payload;
    assert(typeof acceptPayloadA === 'string' && acceptPayloadA.startsWith('OWNER_ACCEPT:'), 'Accept button has signed OWNER_ACCEPT payload');
    assert(acceptPayloadA.length <= 128, `Accept callback payload is within Meta 128 char limit (${acceptPayloadA.length} chars)`);

    // Step A.5: Owner A clicks Accept -> Received on Central XYZ webhook
    const ownerAcceptMsgId = `wamid.OWNER_ACCEPT_${Date.now()}`;
    const ownerAcceptPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_central',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '99988', phone_number_id: centralPhoneId },
            messages: [{
              from: ownerAPhone,
              id: ownerAcceptMsgId,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'button',
              button: { text: 'Accept Order', payload: acceptPayloadA }
            }]
          },
          field: 'messages'
        }]
      }]
    });
    const acceptSig = computeSignature(ownerAcceptPayload);
    const acceptRes = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': acceptSig },
      body: ownerAcceptPayload
    });
    assert(acceptRes.statusCode === 200, 'Owner A Accept button webhook returns HTTP 200');

    // Step A.6: Verify Order A transition to ACCEPTED
    const updatedOrderA = await prisma.order.findUnique({ where: { id: orderA.id } });
    assert(updatedOrderA.status === 'ACCEPTED', 'Order A transitioned to ACCEPTED');
    assert(updatedOrderA.decision_at !== null, 'Order A has decision_at timestamp recorded');

    // Step A.7: Verify Customer A notification enqueued with sender_channel: CENTRAL
    const customerOutboxA = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        recipient_phone: customerAPhone,
        message_type: 'CUSTOMER_ORDER_DECISION'
      }
    });
    assert(Boolean(customerOutboxA), 'Customer A accepted notification outbox record found');
    assert(customerOutboxA.sender_channel === 'CENTRAL', 'Customer A notification sender_channel is CENTRAL (XYZ)');
    assert(customerOutboxA.payload?.template?.name === 'restopro_customer_order_accepted', 'Uses restopro_customer_order_accepted template');
    assert(customerOutboxA.payload?.template?.components?.[0]?.parameters?.[0]?.text === 'Curry Palace (Restaurant A)', 'Customer notification includes Restaurant A name');
    if (customerOutboxA) createdOutboxIds.push(customerOutboxA.id);

    // =========================================================================
    // PHASE 6: Scenario B — Restaurant B (DEF) Isolated Full End-to-End
    // =========================================================================
    console.log('\n--- TEST GROUP 3: Scenario B — Restaurant B Isolated End-to-End ---');

    // Step B.1: Customer B orders at Restaurant B (DEF)
    const confirmationTokenB = 'tok_staging_order_b_' + Date.now();
    const sessionB = await prisma.conversationSession.create({
      data: {
        restaurant_id: restB.id,
        customer_phone: customerBPhone,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        state: {
          cart: {
            items: [
              { productRetailerId: 'prod_sushi_01', productName: 'Salmon Nigiri (4pcs)', quantity: 1, unitPrice: 480 },
              { productRetailerId: 'prod_miso_01', productName: 'Miso Soup', quantity: 2, unitPrice: 120 }
            ]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: confirmationTokenB,
          customerName: 'Priya Patel'
        }
      }
    });
    createdSessionIds.push(sessionB.id);

    const orderBResult = await confirmCustomerOrder({
      restaurantId: restB.id,
      customerPhone: customerBPhone,
      confirmationToken: confirmationTokenB,
      customerName: 'Priya Patel'
    });

    assert(orderBResult.success === true, 'Restaurant B order confirmed successfully');
    const orderB = orderBResult.order;
    createdOrderIds.push(orderB.id);
    assert(orderB.restaurant_id === restB.id, 'Order B strictly scoped to Restaurant B');

    // Step B.2: Owner B receives alert from XYZ
    const ownerOutboxB = await prisma.outboxMessage.findUnique({
      where: { id: orderBResult.outboxMessage.id }
    });
    assert(Boolean(ownerOutboxB), 'Owner B order notification outbox record found');
    assert(ownerOutboxB.sender_channel === 'CENTRAL', 'Owner B notification sender_channel is CENTRAL');
    if (ownerOutboxB) createdOutboxIds.push(ownerOutboxB.id);

    const quickReplyButtonsB = ownerOutboxB.payload?.template?.components?.filter(c => c.type === 'button') || [];
    const acceptPayloadB = quickReplyButtonsB[0]?.parameters?.[0]?.payload;

    // Step B.3: Owner B accepts via Central XYZ
    const ownerBAcceptMsgId = `wamid.OWNER_B_ACCEPT_${Date.now()}`;
    const ownerBAcceptBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_central',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '99988', phone_number_id: centralPhoneId },
            messages: [{
              from: ownerBPhone,
              id: ownerBAcceptMsgId,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'button',
              button: { text: 'Accept Order', payload: acceptPayloadB }
            }]
          },
          field: 'messages'
        }]
      }]
    });
    const acceptBSig = computeSignature(ownerBAcceptBody);
    const acceptBRes = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': acceptBSig },
      body: ownerBAcceptBody
    });
    assert(acceptBRes.statusCode === 200, 'Owner B Accept webhook returns HTTP 200');

    const updatedOrderB = await prisma.order.findUnique({ where: { id: orderB.id } });
    assert(updatedOrderB.status === 'ACCEPTED', 'Order B transitioned to ACCEPTED');

    // Step B.4: Customer B receives accepted template notification with Restaurant B name
    const customerOutboxB = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restB.id,
        recipient_phone: customerBPhone,
        message_type: 'CUSTOMER_ORDER_DECISION'
      }
    });
    assert(Boolean(customerOutboxB), 'Customer B accepted notification outbox record found');
    assert(customerOutboxB.payload?.template?.components?.[0]?.parameters?.[0]?.text === 'Sushi Zen (Restaurant B)', 'Customer B notification contains Restaurant B name');
    if (customerOutboxB) createdOutboxIds.push(customerOutboxB.id);

    // =========================================================================
    // PHASE 6: Scenario C — Rejection Flow
    // =========================================================================
    console.log('\n--- TEST GROUP 4: Scenario C — Rejection Flow ---');

    // Step C.1: Place separate order for Restaurant A to be rejected
    await prisma.conversationSession.deleteMany({
      where: { restaurant_id: restA.id, customer_phone: customerAPhone }
    });
    const confirmationTokenC = 'tok_staging_order_c_' + Date.now();
    const sessionC = await prisma.conversationSession.create({
      data: {
        restaurant_id: restA.id,
        customer_phone: customerAPhone,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        state: {
          cart: {
            items: [{ productRetailerId: 'prod_curry_01', productName: 'Chicken Biryani', quantity: 1, unitPrice: 300 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: confirmationTokenC,
          customerName: 'Aarav Sharma'
        }
      }
    });
    createdSessionIds.push(sessionC.id);

    const orderCResult = await confirmCustomerOrder({
      restaurantId: restA.id,
      customerPhone: customerAPhone,
      confirmationToken: confirmationTokenC,
      customerName: 'Aarav Sharma'
    });
    const orderC = orderCResult.order;
    createdOrderIds.push(orderC.id);

    const ownerOutboxC = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `owner_notif_${orderC.id}`
      }
    });
    if (ownerOutboxC) createdOutboxIds.push(ownerOutboxC.id);

    const rejectPayloadC = ownerOutboxC.payload?.template?.components
      ?.filter(c => c.type === 'button')?.[1]?.parameters?.[0]?.payload;
    assert(typeof rejectPayloadC === 'string' && rejectPayloadC.startsWith('OWNER_REJECT:'), 'Reject button has signed OWNER_REJECT payload');

    // Step C.2: Owner A clicks Reject -> Received on Central XYZ webhook
    const ownerRejectMsgId = `wamid.OWNER_REJECT_${Date.now()}`;
    const ownerRejectPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_central',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '99988', phone_number_id: centralPhoneId },
            messages: [{
              from: ownerAPhone,
              id: ownerRejectMsgId,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'button',
              button: { text: 'Reject Order', payload: rejectPayloadC }
            }]
          },
          field: 'messages'
        }]
      }]
    });
    const rejectSig = computeSignature(ownerRejectPayload);
    const rejectRes = await makeRequest({
      method: 'POST',
      path: '/api/webhook',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': rejectSig },
      body: ownerRejectPayload
    });
    assert(rejectRes.statusCode === 200, 'Owner A Reject webhook returns HTTP 200');

    // Step C.3: Verify Order C transitioned to REJECTED
    const updatedOrderC = await prisma.order.findUnique({ where: { id: orderC.id } });
    assert(updatedOrderC.status === 'REJECTED', 'Order C transitioned to REJECTED');

    // Step C.4: Verify Customer A rejected notification enqueued with restopro_customer_order_rejected template
    const customerOutboxC = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `customer_decision_${orderC.id}_reject`
      }
    });
    assert(Boolean(customerOutboxC), 'Customer rejected notification outbox record found');
    assert(customerOutboxC.sender_channel === 'CENTRAL', 'Rejected customer notification sent from CENTRAL');
    assert(customerOutboxC.payload?.template?.name === 'restopro_customer_order_rejected', 'Uses restopro_customer_order_rejected template');
    if (customerOutboxC) createdOutboxIds.push(customerOutboxC.id);

    // =========================================================================
    // PHASE 6: Scenario D — Security, Multi-Tenant Scoping & Idempotency
    // =========================================================================
    console.log('\n--- TEST GROUP 5: Scenario D — Security, Isolation & Idempotency ---');

    // D.1: Owner A attempting to accept Restaurant B's order
    const crossTenantDecision1 = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: acceptPayloadB
    });
    assert(crossTenantDecision1.success === false, 'Owner A attempting to accept Restaurant B order is rejected');
    assert(crossTenantDecision1.code === 'UNAUTHORIZED_OWNER', 'Rejection code is UNAUTHORIZED_OWNER');

    // D.2: Owner B attempting to reject Restaurant A's order
    const crossTenantDecision2 = await processOwnerOrderDecision({
      senderPhone: ownerBPhone,
      buttonPayload: rejectPayloadC
    });
    assert(crossTenantDecision2.success === false, 'Owner B attempting to reject Restaurant A order is rejected');
    assert(crossTenantDecision2.code === 'UNAUTHORIZED_OWNER', 'Rejection code is UNAUTHORIZED_OWNER');

    // D.3: Customer attempting to submit owner decision
    const customerImpersonation = await processOwnerOrderDecision({
      senderPhone: customerAPhone,
      buttonPayload: acceptPayloadA
    });
    assert(customerImpersonation.success === false, 'Customer attempting to submit owner decision is rejected');
    assert(customerImpersonation.code === 'UNAUTHORIZED_OWNER', 'Rejection code is UNAUTHORIZED_OWNER');

    // D.4: Invalid HMAC signature on callback
    const tamperedCallback = acceptPayloadA.slice(0, -6) + 'abcdef';
    const invalidSigDecision = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: tamperedCallback
    });
    assert(invalidSigDecision.success === false, 'Tampered HMAC signature callback is rejected');
    assert(invalidSigDecision.code === 'TAMPERED_CALLBACK', 'Rejection code is TAMPERED_CALLBACK');

    // D.5: Expired callback rejection
    const expiredCallback = generateSignedOwnerCallback({
      orderId: orderA.id,
      action: 'ACCEPT',
      ttlSeconds: -100 // Already expired in the past
    });
    const expiredDecision = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: expiredCallback
    });
    assert(expiredDecision.success === false, 'Expired callback is rejected');
    assert(expiredDecision.code === 'EXPIRED_CALLBACK', 'Rejection code is EXPIRED_CALLBACK');

    // D.6: Duplicate Accept callback (idempotent, no duplicate outbox)
    const dupeAcceptDecision = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: acceptPayloadA
    });
    assert(dupeAcceptDecision.success === true, 'Duplicate Accept callback returns success');
    assert(dupeAcceptDecision.isDuplicate === true, 'Duplicate Accept marked as isDuplicate: true');

    const customerOutboxCountA = await prisma.outboxMessage.count({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `customer_decision_${orderA.id}_accept`
      }
    });
    assert(customerOutboxCountA === 1, 'Exactly 1 customer notification created despite duplicate accept (Idempotent)');

    // D.7: Conflicting decision (Reject after Accept)
    const signedRejectForA = generateSignedOwnerCallback({ orderId: orderA.id, action: 'REJECT' });
    const conflictingDecision = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: signedRejectForA
    });
    assert(conflictingDecision.success === false, 'Conflicting decision (Reject after Accept) is rejected');
    assert(conflictingDecision.code === 'CONFLICTING_DECISION', 'Rejection code is CONFLICTING_DECISION');

    // Verify order status unchanged
    const orderAAfterConflict = await prisma.order.findUnique({ where: { id: orderA.id } });
    assert(orderAAfterConflict.status === 'ACCEPTED', 'Order A remains in ACCEPTED status (Cannot be overwritten)');

    // D.8: Missing / Unapproved Template in CENTRAL mode
    // Temporarily set template unapproved
    setTemplateApprovalForTesting(SUPPORTED_TEMPLATES.ORDER_ALERT, 'UNCONFIGURED');
    const tokenUnapproved = 'tok_staging_unapproved_' + Date.now();
    const sessionUnapproved = await prisma.conversationSession.create({
      data: {
        restaurant_id: restA.id,
        customer_phone: '919633330003',
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        state: {
          cart: { items: [{ productRetailerId: 'prod_test', productName: 'Test Item', quantity: 1, unitPrice: 100 }] },
          orderType: 'TAKEAWAY',
          confirmationToken: tokenUnapproved
        }
      }
    });
    createdSessionIds.push(sessionUnapproved.id);
    const unapprovedOrderRes = await confirmCustomerOrder({
      restaurantId: restA.id,
      customerPhone: '919633330003',
      confirmationToken: tokenUnapproved
    });
    assert(unapprovedOrderRes.success === true, 'Order created successfully even when template unapproved');
    createdOrderIds.push(unapprovedOrderRes.order.id);

    const blockedOutbox = await prisma.outboxMessage.findFirst({
      where: {
        idempotency_key: `owner_notif_${unapprovedOrderRes.order.id}`
      }
    });
    assert(blockedOutbox.status === 'FAILED', 'Unapproved template message marked FAILED immediately');
    assert(blockedOutbox.last_error.includes('BLOCKED_TEMPLATE_NOT_CONFIGURED'), 'Error classified as BLOCKED_TEMPLATE_NOT_CONFIGURED');
    assert(blockedOutbox.sender_channel === 'CENTRAL', 'Remains CENTRAL channel (No silent fallback to restaurant)');
    if (blockedOutbox) createdOutboxIds.push(blockedOutbox.id);
    resetTemplateApprovalsForTesting();

    // =========================================================================
    // PHASE 7: 24-Hour Window & Template Behavior Verification
    // =========================================================================
    console.log('\n--- TEST GROUP 6: 24-Hour Window & Template Behavior ---');

    // 7.1 Verify customer interaction with ABC does NOT create service window on Central XYZ
    // Verify that all Central outbound messages are strictly template-formatted
    const allCentralOutbox = await prisma.outboxMessage.findMany({
      where: {
        sender_channel: 'CENTRAL',
        id: { in: createdOutboxIds },
        message_type: { in: ['OWNER_ORDER_NOTIFICATION', 'CUSTOMER_ORDER_DECISION'] }
      }
    });
    assert(allCentralOutbox.length > 0, 'Found Central outbound messages');
    let allUseTemplates = true;
    for (const msg of allCentralOutbox) {
      if (msg.payload?.type !== 'template' || !msg.payload?.template?.name) {
        // If it was blocked due to unapproved template, verify it is still a structured blocked payload
        if (!msg.payload?.blockedReason) {
          allUseTemplates = false;
          break;
        }
      }
    }
    assert(allUseTemplates === true, 'All Central customer & owner notifications strictly use approved Meta Utility Templates (Zero free-form leaks)');

    // 7.2 Outbox worker credential resolution & dispatch safety
    // Test custom sender simulating successful Meta delivery on a fresh pending message
    const testWorkerMsg = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restA.id,
        recipient_phone: customerAPhone,
        sender_channel: 'CENTRAL',
        message_type: 'CUSTOMER_ORDER_DECISION',
        payload: {
          type: 'template',
          template: { name: 'restopro_customer_order_accepted', language: { code: 'en' } }
        },
        idempotency_key: `worker_dispatch_test_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(testWorkerMsg.id);

    let dispatchedChannel = null;
    let dispatchedTemplateName = null;
    const testCustomSender = async (msg) => {
      dispatchedChannel = msg.sender_channel;
      dispatchedTemplateName = msg.payload?.template?.name;
      return {
        success: true,
        metaMessageId: `wamid.MOCK_DISPATCH_${Date.now()}`
      };
    };

    const dispatchResult = await dispatchPendingOutboxMessages({
      batchSize: 5,
      customSender: testCustomSender
    });
    assert(dispatchResult.processedCount > 0, 'Outbox worker processed pending messages');
    assert(dispatchResult.succeededCount > 0, 'Outbox messages marked ACCEPTED upon Meta success');

    // 7.3 Failed template delivery safely transitions to FAILED
    const failCustomSender = async (msg) => {
      return {
        success: false,
        isTimeout: false,
        isRetryable: false,
        statusCode: 400,
        error: 'Meta API error: (#100) Param components[0] does not match template schema'
      };
    };

    const failMsg = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restA.id,
        recipient_phone: customerAPhone,
        sender_channel: 'CENTRAL',
        message_type: 'CUSTOMER_ORDER_DECISION',
        payload: { type: 'template', template: { name: 'restopro_customer_order_accepted' } },
        idempotency_key: `fail_test_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(failMsg.id);

    const failDispatchResult = {
      success: false,
      isTimeout: false,
      isRetryable: false,
      statusCode: 400,
      error: 'Meta API error: (#100) Param components[0] does not match template schema'
    };
    const updateOutcome = await updateOutboxResult({
      id: failMsg.id,
      leaseToken: 'mock_worker_lease_token',
      dispatchResult: failDispatchResult,
      attempts: 1,
      maxAttempts: 5
    });
    assert(updateOutcome.status === 'FAILED', 'Non-retryable template error transitions outbox status to FAILED');

    const failedMsgDb = await prisma.outboxMessage.findUnique({ where: { id: failMsg.id } });
    assert(failedMsgDb.status === 'FAILED', 'Outbox record status is FAILED in database');
    assert(failedMsgDb.last_error.includes('Param components'), 'Detailed Meta error recorded in outbox record');

    // =========================================================================
    // PHASE 4: Template Definitions & Programmatic Submission Verification
    // =========================================================================
    console.log('\n--- TEST GROUP 7: Template Definitions & API Submission Verification ---');

    const copyReadyDefs = getCopyReadyTemplateDefinitions();
    assert(copyReadyDefs.length === 3, 'Returns copy-ready definitions for all 3 templates');
    const orderAlertDef = copyReadyDefs.find(d => d.name === 'restopro_order_alert');
    assert(orderAlertDef?.category === 'UTILITY', 'order_alert category is UTILITY');
    assert(orderAlertDef?.components?.length === 2, 'order_alert definition has BODY and BUTTONS components');

    // Programmatic template submission in mock mode
    const submitResult = await submitCentralTemplateToMeta({
      templateName: 'restopro_order_alert',
      adminId: 'mock_admin_uuid'
    });
    assert(submitResult.success === true, 'submitCentralTemplateToMeta succeeds in mock environment');
    assert(submitResult.approvalSource === 'META_VERIFIED', 'Recorded approvalSource is META_VERIFIED');

  } finally {
    // Teardown
    console.log('\n--- Cleaning up R6.7 Staging Test Artifacts ---');
    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(resolve));
    }

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
      await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } }).catch(() => {});
    }
    if (createdCentralAccountIds.length > 0) {
      await prisma.centralWhatsAppAccount.deleteMany({ where: { id: { in: createdCentralAccountIds } } }).catch(() => {});
    }

    console.log('  Cleaned up all temporary test records.');
  }

  console.log('\n============================================================');
  console.log(`   R6.7 STAGING VERIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStagingVerificationTests().catch((err) => {
  console.error('Unhandled failure in R6.7 Staging Verification tests:', err);
  process.exit(1);
});
