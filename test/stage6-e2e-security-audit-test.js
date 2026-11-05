/**
 * RESTOPRO — Stage 6: End-to-End Integration, Security & Multi-Tenant Audit Test Suite
 *
 * Comprehensive end-to-end audit verifying:
 * 1. Multi-Tenant Architecture & Isolation (ST6-01 through ST6-07)
 * 2. Security Threat Vectors (HMAC, timing attacks, SQL injection, button tampering, tokens, headers, oversized payloads)
 * 3. Complete 12-Step Customer Journey (Greeting -> Cart -> Pin -> Room -> Consent -> Delivery -> Confirm -> Owner Notify -> Accept -> Customer Notify -> Outbox Dispatch)
 * 4. Reliability, Concurrency & Failure Recovery (Double webhooks, race conditions, worker lease fencing, timeouts, rollbacks)
 * 5. Operational & Production Health Verification
 */
const crypto = require('crypto');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const {
  claimPendingOutboxMessages,
  updateOutboxResult,
  dispatchPendingOutboxMessages
} = require('../src/services/outbox.service');
const {
  processOwnerOrderDecision,
  parseOwnerAction,
  confirmCustomerOrder
} = require('../src/services/order.service');
const {
  handleIncomingMessage,
  processIncomingCart
} = require('../src/services/conversation.service');
const {
  findCustomerSavedAddresses
} = require('../src/services/address.service');
const {
  resolveTenantByPhoneNumberId
} = require('../src/services/tenant.service');

const TEST_PORT = 3997;
let serverInstance;

// Tenant A Configuration (Seeded)
const TENANT_A_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_A_PHONE_ID = '111111111111111';
const TENANT_A_OWNER_PHONE = '+919876543210';

// Tenant B Configuration (Seeded)
const TENANT_B_ID = 'b0000000-0000-0000-0000-000000000002';
const TENANT_B_PHONE_ID = '222222222222222';
const TENANT_B_OWNER_PHONE = '+919811122233';

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

/**
 * Sends a raw signed HTTP POST request to the local webhook endpoint.
 */
function sendSignedWebhook(payload, {
  secret = config.meta.appSecret,
  headers = {},
  rawBodyString = null
} = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = rawBodyString !== null ? rawBodyString : JSON.stringify(payload);
    const bodyBuffer = Buffer.from(bodyStr, 'utf8');

    let signatureHeader = '';
    if (secret) {
      const hmac = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');
      signatureHeader = `sha256=${hmac}`;
    }

    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuffer.length,
      ...(signatureHeader ? { 'x-hub-signature-256': signatureHeader } : {}),
      ...headers
    };

    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/webhook',
      method: 'POST',
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          rawBody: data
        });
      });
    });

    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

/**
 * Sends a raw GET request to the local server.
 */
function sendGetRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          rawBody: data
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Helper to build standard incoming Meta webhook payload wrapper.
 */
function buildMetaWebhookPayload({
  phoneNumberId,
  senderPhone,
  messageId,
  messageType = 'text',
  messageObj = {}
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550269999',
                phone_number_id: phoneNumberId
              },
              contacts: [
                {
                  profile: { name: 'Audit Test User' },
                  wa_id: senderPhone
                }
              ],
              messages: [
                {
                  from: senderPhone,
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: messageType,
                  ...messageObj
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

async function cleanupTestData() {
  await prisma.outboxMessage.deleteMany({
    where: {
      OR: [
        { recipient_phone: { startsWith: '9196' } },
        { recipient_phone: { startsWith: '9197' } },
        { recipient_phone: { startsWith: '9198' } },
        { recipient_phone: { startsWith: '9199' } }
      ]
    }
  });

  await prisma.orderNotification.deleteMany({
    where: {
      OR: [
        { recipient_phone: { startsWith: '9196' } },
        { recipient_phone: { startsWith: '9197' } },
        { recipient_phone: { startsWith: '9198' } },
        { recipient_phone: { startsWith: '9199' } }
      ]
    }
  });

  await prisma.order.deleteMany({
    where: {
      OR: [
        { customer_phone: { startsWith: '9196' } },
        { customer_phone: { startsWith: '9197' } },
        { customer_phone: { startsWith: '9198' } },
        { customer_phone: { startsWith: '9199' } }
      ]
    }
  });

  await prisma.conversationSession.deleteMany({
    where: {
      OR: [
        { customer_phone: { startsWith: '9196' } },
        { customer_phone: { startsWith: '9197' } },
        { customer_phone: { startsWith: '9198' } },
        { customer_phone: { startsWith: '9199' } }
      ]
    }
  });

  await prisma.savedAddress.deleteMany({
    where: {
      OR: [
        { customer_phone: { startsWith: '9196' } },
        { customer_phone: { startsWith: '9197' } },
        { customer_phone: { startsWith: '9198' } },
        { customer_phone: { startsWith: '9199' } }
      ]
    }
  });

  await prisma.webhookEvent.deleteMany({
    where: {
      event_key: { startsWith: 'wamid.AUDIT_' }
    }
  });
}

// =========================================================================
// RUNNER
// =========================================================================

async function runAuditSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 6: END-TO-END AUDIT & SECURITY TEST     ');
  console.log('============================================================\n');

  // Start HTTP Server
  serverInstance = app.listen(TEST_PORT);
  await new Promise(resolve => serverInstance.on('listening', resolve));
  await cleanupTestData();

  try {
    // ---------------------------------------------------------------------
    // TEST GROUP 1: Multi-Tenant Architecture & Isolation (ST6-01 to ST6-07)
    // ---------------------------------------------------------------------
    console.log('--- TEST GROUP 1: Multi-Tenant Architecture & Isolation (ST6-01 to ST6-07) ---');

    // ST6-01: Seed & verify Tenant A and Tenant B
    const tenantA = await prisma.restaurant.findUnique({ where: { phone_number_id: TENANT_A_PHONE_ID } });
    const tenantB = await prisma.restaurant.findUnique({ where: { phone_number_id: TENANT_B_PHONE_ID } });

    assert(tenantA !== null && tenantA.is_active === true, 'ST6-01: Tenant A is seeded and active');
    assert(tenantB !== null && tenantB.is_active === true, 'ST6-01: Tenant B is seeded and active');
    assert(tenantA.id !== tenantB.id, 'ST6-01: Tenant A and B have distinct UUID primary keys');
    assert(tenantA.phone_number_id !== tenantB.phone_number_id, 'ST6-01: Tenant A and B have distinct phone_number_ids');
    assert(tenantA.owner_phone !== tenantB.owner_phone, 'ST6-01: Tenant A and B have distinct owner phones');

    // ST6-02: Concurrent Customer Orders for Tenant A and Tenant B
    const customerPhoneA = '919611000001';
    const customerPhoneB = '919622000002';
    const tokenA = `conf_${crypto.randomUUID()}`;
    const tokenB = `conf_${crypto.randomUUID()}`;

    // Seed active sessions in AWAITING_CONFIRMATION
    await prisma.conversationSession.create({
      data: {
        restaurant_id: TENANT_A_ID,
        customer_phone: customerPhoneA,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 3600000),
        state: {
          cart: {
            subtotal: 500,
            currency: 'INR',
            items: [{ productRetailerId: 'SKU_TENANT_A', productName: 'Biryani A', quantity: 2, unitPrice: 250 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: tokenA
        }
      }
    });

    await prisma.conversationSession.create({
      data: {
        restaurant_id: TENANT_B_ID,
        customer_phone: customerPhoneB,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 3600000),
        state: {
          cart: {
            subtotal: 350,
            currency: 'INR',
            items: [{ productRetailerId: 'SKU_TENANT_B', productName: 'Fish Curry B', quantity: 1, unitPrice: 350 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: tokenB
        }
      }
    });

    // Execute concurrent confirmations
    const [resOrderA, resOrderB] = await Promise.all([
      confirmCustomerOrder({
        restaurantId: TENANT_A_ID,
        customerPhone: customerPhoneA,
        confirmationToken: tokenA
      }),
      confirmCustomerOrder({
        restaurantId: TENANT_B_ID,
        customerPhone: customerPhoneB,
        confirmationToken: tokenB
      })
    ]);

    assert(resOrderA.success === true, 'ST6-02: Tenant A order confirmation succeeded');
    assert(resOrderB.success === true, 'ST6-02: Tenant B order confirmation succeeded');
    assert(resOrderA.order.restaurant_id === TENANT_A_ID, 'ST6-02: Order A strictly scoped to Tenant A');
    assert(resOrderB.order.restaurant_id === TENANT_B_ID, 'ST6-02: Order B strictly scoped to Tenant B');
    assert(resOrderA.order.id !== resOrderB.order.id, 'ST6-02: Orders have distinct UUIDs');

    // ST6-03: Customer Session Isolation Across Tenants (Same customer, both restaurants)
    const dualCustomer = '919633000003';
    const cartPayloadA = {
      catalog_id: 'CAT_A',
      product_items: [{ product_retailer_id: 'SKU_1', quantity: 1, item_price: 150, currency: 'INR' }]
    };
    const cartPayloadB = {
      catalog_id: 'CAT_B',
      product_items: [{ product_retailer_id: 'SKU_2', quantity: 2, item_price: 200, currency: 'INR' }]
    };

    const sessionResA = await processIncomingCart(TENANT_A_ID, dualCustomer, cartPayloadA);
    const sessionResB = await processIncomingCart(TENANT_B_ID, dualCustomer, cartPayloadB);

    assert(sessionResA.success === true, 'ST6-03: Cart accepted at Tenant A');
    assert(sessionResB.success === true, 'ST6-03: Cart accepted at Tenant B');
    assert(sessionResA.session.restaurant_id === TENANT_A_ID, 'ST6-03: Session A belongs to Tenant A');
    assert(sessionResB.session.restaurant_id === TENANT_B_ID, 'ST6-03: Session B belongs to Tenant B');
    assert(sessionResA.session.id !== sessionResB.session.id, 'ST6-03: Dual customer maintains two distinct session IDs');
    assert(sessionResA.session.state.cart.subtotal === 150, 'ST6-03: Session A cart subtotal preserved (150)');
    assert(sessionResB.session.state.cart.subtotal === 400, 'ST6-03: Session B cart subtotal preserved (400)');

    // ST6-04: Saved Address Isolation Across Tenants
    await prisma.savedAddress.create({
      data: {
        restaurant_id: TENANT_A_ID,
        customer_phone: dualCustomer,
        address: '42 Orchid Lane, Tenant A Complex, City A',
        label: 'Home'
      }
    });

    const addressesAtA = await findCustomerSavedAddresses(TENANT_A_ID, dualCustomer);
    const addressesAtB = await findCustomerSavedAddresses(TENANT_B_ID, dualCustomer);

    assert(addressesAtA.length === 1, 'ST6-04: Address found for Customer at Tenant A');
    assert(addressesAtB.length === 0, 'ST6-04: Zero addresses returned for Customer at Tenant B (Zero Leakage)');

    // ST6-05: Owner Notification Routing Across Tenants
    const outboxA = await prisma.outboxMessage.findFirst({
      where: { restaurant_id: TENANT_A_ID, message_type: 'OWNER_ORDER_NOTIFICATION' }
    });
    const outboxB = await prisma.outboxMessage.findFirst({
      where: { restaurant_id: TENANT_B_ID, message_type: 'OWNER_ORDER_NOTIFICATION' }
    });

    assert(outboxA !== null && outboxA.recipient_phone.includes('9876543210'), 'ST6-05: Tenant A order notified Owner A (+919876543210)');
    assert(outboxB !== null && outboxB.recipient_phone.includes('9811122233'), 'ST6-05: Tenant B order notified Owner B (+919811122233)');

    // ST6-06: Cross-Tenant Attack Scenarios
    // Attack 1: Owner A attempts to accept Tenant B's order via Tenant A endpoint
    const attack1 = await processOwnerOrderDecision({
      restaurantId: TENANT_A_ID,
      senderPhone: TENANT_A_OWNER_PHONE,
      orderId: resOrderB.order.id,
      decision: 'ACCEPT'
    });
    assert(attack1.success === false, 'ST6-06: Cross-tenant modification rejected');
    assert(attack1.code === 'CROSS_TENANT_VIOLATION', 'ST6-06: Error code is CROSS_TENANT_VIOLATION');

    // Attack 2: Owner A attempts to accept Tenant B's order via Tenant B endpoint
    const attack2 = await processOwnerOrderDecision({
      restaurantId: TENANT_B_ID,
      senderPhone: TENANT_A_OWNER_PHONE,
      orderId: resOrderB.order.id,
      decision: 'ACCEPT'
    });
    assert(attack2.success === false, 'ST6-06: Impersonating owner at Tenant B rejected');
    assert(attack2.code === 'UNAUTHORIZED_OWNER', 'ST6-06: Error code is UNAUTHORIZED_OWNER');

    // Verify Order B remained untouched
    const freshOrderB = await prisma.order.findUnique({ where: { id: resOrderB.order.id } });
    assert(freshOrderB.status === 'PENDING_RESTAURANT_CONFIRMATION', 'ST6-06: Order B status intact (PENDING_RESTAURANT_CONFIRMATION)');

    // ST6-07: Soft-Disabled Tenant Behavior (is_active = false)
    await prisma.restaurant.update({
      where: { id: TENANT_B_ID },
      data: { is_active: false }
    });

    const disabledLookup = await resolveTenantByPhoneNumberId(TENANT_B_PHONE_ID);
    assert(disabledLookup === null, 'ST6-07: Inactive restaurant returns null from tenant resolver');

    // Send webhook message to disabled tenant
    const disabledWebhook = buildMetaWebhookPayload({
      phoneNumberId: TENANT_B_PHONE_ID,
      senderPhone: '919699999999',
      messageId: `wamid.AUDIT_DISABLED_${Date.now()}`,
      messageType: 'text',
      messageObj: { text: { body: 'Hello' } }
    });

    const disabledRes = await sendSignedWebhook(disabledWebhook);
    assert(disabledRes.statusCode === 200, 'ST6-07: Disabled tenant webhook returns HTTP 200 (prevents Meta retry storm)');

    // Restore Tenant B to active
    await prisma.restaurant.update({
      where: { id: TENANT_B_ID },
      data: { is_active: true }
    });
    const restoredLookup = await resolveTenantByPhoneNumberId(TENANT_B_PHONE_ID);
    assert(restoredLookup !== null && restoredLookup.is_active === true, 'ST6-07: Tenant B successfully restored to active');


    // ---------------------------------------------------------------------
    // TEST GROUP 2: Security & Threat Vector Auditing
    // ---------------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Security & Threat Vector Auditing ---');

    // 1. Webhook HMAC Verification
    const dummyPayload = { object: 'whatsapp_business_account', entry: [] };
    const validHmacRes = await sendSignedWebhook(dummyPayload);
    assert(validHmacRes.statusCode === 200, 'HMAC: Valid signature accepted with HTTP 200');

    const forgedHmacRes = await sendSignedWebhook(dummyPayload, { secret: 'forged_fake_secret_123' });
    assert(forgedHmacRes.statusCode === 403, 'HMAC: Forged signature rejected with HTTP 403 Forbidden');

    const missingSigRes = await sendSignedWebhook(dummyPayload, { secret: null });
    assert(missingSigRes.statusCode === 401, 'HMAC: Missing signature header rejected with HTTP 401 Unauthorized');

    // 2. GET Verification Challenge
    const validGet = await sendGetRequest(`/api/webhook?hub.mode=subscribe&hub.verify_token=${config.meta.verifyToken}&hub.challenge=test_challenge_12345`);
    assert(validGet.statusCode === 200, 'GET Challenge: Valid verify token returns HTTP 200');
    assert(validGet.rawBody === 'test_challenge_12345', 'GET Challenge: Echoes exact challenge');

    const invalidGet = await sendGetRequest('/api/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=12345');
    assert(invalidGet.statusCode === 403, 'GET Challenge: Invalid token rejected with HTTP 403 Forbidden');

    // 3. Malformed JSON
    const malformedJsonRes = await sendSignedWebhook(null, { rawBodyString: '{"broken_json": [true,' });
    assert(malformedJsonRes.statusCode === 400, 'Malformed JSON: Rejected with HTTP 400 Bad Request');
    assert(malformedJsonRes.body.error === 'Malformed JSON payload', 'Malformed JSON: Clean error message returned');

    // 4. Oversized Payload (>1MB)
    const hugeString = 'x'.repeat(1024 * 1024 + 100); // 1MB + 100 bytes
    const oversizedPayload = { object: 'whatsapp_business_account', data: hugeString };
    const oversizedRes = await sendSignedWebhook(oversizedPayload);
    assert(oversizedRes.statusCode === 413, 'Oversized Payload: Rejected with HTTP 413 Payload Too Large');
    assert(oversizedRes.body.error.includes('1MB'), 'Oversized Payload: Explicit 1MB boundary error reported');

    // 5. SQL Injection Protection
    const sqlInjectionAttempts = [
      "'; DROP TABLE orders; --",
      "1' OR '1'='1",
      "UNION SELECT username, password FROM users --",
      "{\"admin\": true}"
    ];

    for (const sqlPayload of sqlInjectionAttempts) {
      const parsedBtn = parseOwnerAction(`OWNER_ACCEPT:${sqlPayload}`);
      assert(parsedBtn.isValid === false, `SQL Injection Defense: Button parser rejected injection "${sqlPayload}"`);
    }

    // 6. Interactive Button Tampering
    const tamperedButtonResult = await processOwnerOrderDecision({
      restaurantId: TENANT_A_ID,
      senderPhone: TENANT_A_OWNER_PHONE,
      buttonPayload: 'OWNER_MAYBE:12345'
    });
    assert(tamperedButtonResult.success === false, 'Tampered Button: Unrecognized action OWNER_MAYBE rejected');
    assert(tamperedButtonResult.code === 'UNRECOGNIZED_OWNER_ACTION', 'Tampered Button: Error code UNRECOGNIZED_OWNER_ACTION');

    // 7. Owner Identity Spoofing
    const customerSpoof = await processOwnerOrderDecision({
      restaurantId: TENANT_A_ID,
      senderPhone: '919999888877', // Not owner phone
      orderId: resOrderA.order.id,
      decision: 'ACCEPT'
    });
    assert(customerSpoof.success === false, 'Owner Spoof: Non-owner phone rejected');
    assert(customerSpoof.code === 'UNAUTHORIZED_OWNER', 'Owner Spoof: Error code UNAUTHORIZED_OWNER');

    // 8. Sensitive Data & Token Redaction in Responses & Headers
    assert(validHmacRes.headers['x-powered-by'] === undefined, 'Security Header: X-Powered-By is disabled');
    assert(validHmacRes.headers['x-content-type-options'] === 'nosniff', 'Security Header: X-Content-Type-Options: nosniff present');
    assert(validHmacRes.headers['x-frame-options'] === 'DENY', 'Security Header: X-Frame-Options: DENY present');
    assert(validHmacRes.headers['referrer-policy'] === 'no-referrer', 'Security Header: Referrer-Policy: no-referrer present');


    // ---------------------------------------------------------------------
    // TEST GROUP 3: Complete 12-Step End-to-End Workflow Test
    // ---------------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Complete 12-Step End-to-End Workflow Test ---');

    const e2eCustomer = '919711223344';

    // Step 1: Customer sends "Hi"
    const step1Payload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: e2eCustomer,
      messageId: `wamid.AUDIT_STEP1_${Date.now()}`,
      messageType: 'text',
      messageObj: { text: { body: 'Hi' } }
    });
    const step1Res = await sendSignedWebhook(step1Payload);
    assert(step1Res.statusCode === 200, 'Step 1: Customer "Hi" webhook accepted with HTTP 200');

    // Step 2: Catalogue prompt generated & session created in AWAITING_CART
    const step2Session = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TENANT_A_ID,
          customer_phone: e2eCustomer
        }
      }
    });
    assert(step2Session !== null, 'Step 2: Conversation session created in PostgreSQL');
    assert(step2Session.current_step === 'AWAITING_CART', 'Step 2: Session step advanced from IDLE to AWAITING_CART');

    // Step 3: Customer submits catalogue cart
    const step3Payload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: e2eCustomer,
      messageId: `wamid.AUDIT_STEP3_${Date.now()}`,
      messageType: 'order',
      messageObj: {
        order: {
          catalog_id: 'CATALOG_001',
          text: 'Less spicy please',
          product_items: [
            { product_retailer_id: 'SKU_PANEER', quantity: 2, item_price: 220, currency: 'INR' },
            { product_retailer_id: 'SKU_ROTI', quantity: 4, item_price: 25, currency: 'INR' }
          ]
        }
      }
    });
    const step3Res = await sendSignedWebhook(step3Payload);
    assert(step3Res.statusCode === 200, 'Step 3: Catalogue cart webhook accepted with HTTP 200');

    const step3Session = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TENANT_A_ID,
          customer_phone: e2eCustomer
        }
      }
    });
    assert(step3Session.current_step === 'AWAITING_ADDRESS_INPUT', 'Step 3: Session advanced to AWAITING_ADDRESS_INPUT');
    assert(step3Session.state.cart.subtotal === 540, 'Step 3: Cart subtotal correctly calculated (2*220 + 4*25 = 540.00)');
    const activeToken = step3Session.state.confirmationToken;
    assert(typeof activeToken === 'string' && activeToken.startsWith('conf_'), 'Step 3: Fresh confirmation token generated');

    // Step 4 & 5: Location Pin (preserving 0.0 lat/lng), Building & Room Number Collection
    const step4Payload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: e2eCustomer,
      messageId: `wamid.AUDIT_STEP4_${Date.now()}`,
      messageType: 'location',
      messageObj: {
        location: {
          latitude: 12.9352,
          longitude: 77.6245,
          name: 'Koramangala 4th Block',
          address: 'Koramangala, Bengaluru, Karnataka 560034'
        }
      }
    });
    await sendSignedWebhook(step4Payload);

    const step4Session = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TENANT_A_ID,
          customer_phone: e2eCustomer
        }
      }
    });
    assert(step4Session.current_step === 'AWAITING_BUILDING_NAME', 'Step 4: Location pin accepted; session at AWAITING_BUILDING_NAME');

    // Provide building name
    const step4BuildingPayload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: e2eCustomer,
      messageId: `wamid.AUDIT_STEP4B_${Date.now()}`,
      messageType: 'text',
      messageObj: { text: { body: 'Silver Oak Apartments' } }
    });
    await sendSignedWebhook(step4BuildingPayload);

    const step4BSession = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TENANT_A_ID,
          customer_phone: e2eCustomer
        }
      }
    });
    assert(step4BSession.current_step === 'AWAITING_ROOM_NUMBER', 'Step 4: Building recorded; session at AWAITING_ROOM_NUMBER');

    // Provide room number
    const step4RoomPayload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: e2eCustomer,
      messageId: `wamid.AUDIT_STEP4R_${Date.now()}`,
      messageType: 'text',
      messageObj: { text: { body: 'Flat 302, 3rd Floor' } }
    });
    await sendSignedWebhook(step4RoomPayload);

    const step4RSession = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TENANT_A_ID,
          customer_phone: e2eCustomer
        }
      }
    });
    assert(step4RSession.current_step === 'AWAITING_SAVE_CONSENT', 'Step 4: Room recorded; session at AWAITING_SAVE_CONSENT');

    // Consent to save address
    const step4ConsentPayload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: e2eCustomer,
      messageId: `wamid.AUDIT_STEP4C_${Date.now()}`,
      messageType: 'button',
      messageObj: { button: { payload: 'BTN_CONSENT_YES', text: 'Yes, Save' } }
    });
    await sendSignedWebhook(step4ConsentPayload);

    const savedAddr = await prisma.savedAddress.findFirst({
      where: { restaurant_id: TENANT_A_ID, customer_phone: e2eCustomer }
    });
    assert(savedAddr !== null, 'Step 5: Address durably saved to saved_addresses');
    assert(savedAddr.address.includes('Silver Oak Apartments'), 'Step 5: Saved address contains building name');

    // Step 6: Choose Delivery
    const step6Session = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TENANT_A_ID,
          customer_phone: e2eCustomer
        }
      }
    });
    assert(step6Session.current_step === 'AWAITING_ORDER_TYPE', 'Step 6: Session reached AWAITING_ORDER_TYPE');

    const step6Payload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: e2eCustomer,
      messageId: `wamid.AUDIT_STEP6_${Date.now()}`,
      messageType: 'button',
      messageObj: { button: { payload: 'BTN_ORDER_DELIVERY', text: '🚚 Delivery' } }
    });
    await sendSignedWebhook(step6Payload);

    const step7Session = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TENANT_A_ID,
          customer_phone: e2eCustomer
        }
      }
    });
    assert(step7Session.current_step === 'AWAITING_CONFIRMATION', 'Step 7: Session reached AWAITING_CONFIRMATION');
    assert(step7Session.state.orderType === 'DELIVERY', 'Step 7: Fulfilment recorded as DELIVERY');

    // Step 7: Customer Confirms Order
    const e2eToken = step7Session.state.confirmationToken;
    const step7ConfirmPayload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: e2eCustomer,
      messageId: `wamid.AUDIT_STEP7_${Date.now()}`,
      messageType: 'button',
      messageObj: { button: { payload: `BTN_CONFIRM_ORDER:${e2eToken}`, text: 'Confirm Order' } }
    });
    await sendSignedWebhook(step7ConfirmPayload);

    // Step 8: Order & Owner Outbox Record Created Atomically
    const confirmedOrder = await prisma.order.findUnique({
      where: { confirmation_token: e2eToken }
    });
    assert(confirmedOrder !== null, 'Step 8: Order record created in PostgreSQL');
    assert(confirmedOrder.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Step 8: Initial order status is PENDING_RESTAURANT_CONFIRMATION');
    assert(Number(confirmedOrder.total_amount) === 540, 'Step 8: Order total is 540.00');

    const ownerOutbox = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: TENANT_A_ID,
        message_type: 'OWNER_ORDER_NOTIFICATION',
        idempotency_key: `owner_notif_${confirmedOrder.id}`
      }
    });
    assert(ownerOutbox !== null, 'Step 8: Owner notification outbox record created atomically');
    assert(ownerOutbox.status === 'PENDING', 'Step 8: Initial owner outbox status is PENDING');

    // Session reset to IDLE
    const postConfirmSession = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TENANT_A_ID,
          customer_phone: e2eCustomer
        }
      }
    });
    assert(postConfirmSession.current_step === 'IDLE', 'Step 8: Customer session reset to IDLE after confirmation');

    // Step 9: Outbox Worker Claims & Dispatches Owner Alert (Mocked HTTP)
    const mockSenderOwner = async (msg) => {
      return {
        success: true,
        metaMessageId: `wamid.HB_OWNER_${Date.now()}`
      };
    };

    const ownerDispatchRes = await dispatchPendingOutboxMessages({
      batchSize: 10,
      customSender: mockSenderOwner
    });
    assert(ownerDispatchRes.succeededCount >= 1, 'Step 9: Owner notification successfully dispatched by outbox worker');

    const dispatchedOwnerOutbox = await prisma.outboxMessage.findUnique({
      where: { id: ownerOutbox.id }
    });
    assert(dispatchedOwnerOutbox.status === 'ACCEPTED', 'Step 9: Owner outbox status transitioned to ACCEPTED');
    assert(dispatchedOwnerOutbox.payload.meta_message_id !== undefined, 'Step 9: meta_message_id persisted in payload');

    // Step 10: Owner Taps Accept Button via Webhook
    const step10Payload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: TENANT_A_OWNER_PHONE,
      messageId: `wamid.AUDIT_STEP10_${Date.now()}`,
      messageType: 'interactive',
      messageObj: {
        interactive: {
          type: 'button_reply',
          button_reply: {
            id: `OWNER_ACCEPT:${confirmedOrder.id}`,
            title: '✅ Accept Order'
          }
        }
      }
    });
    const step10Res = await sendSignedWebhook(step10Payload);
    assert(step10Res.statusCode === 200, 'Step 10: Owner accept webhook returned HTTP 200');

    const acceptedOrder = await prisma.order.findUnique({
      where: { id: confirmedOrder.id }
    });
    assert(acceptedOrder.status === 'ACCEPTED', 'Step 10: Order status transitioned to ACCEPTED');
    assert(acceptedOrder.decision_at !== null, 'Step 10: decision_at timestamp persisted');

    // Step 11: Customer Notification Outbox Record Created Atomically
    const customerOutbox = await prisma.outboxMessage.findUnique({
      where: { idempotency_key: `customer_decision_${confirmedOrder.id}_accept` }
    });
    assert(customerOutbox !== null, 'Step 11: Customer decision outbox record created atomically');
    assert(customerOutbox.recipient_phone === e2eCustomer, 'Step 11: Recipient is ordering customer phone');
    assert(customerOutbox.status === 'PENDING', 'Step 11: Customer outbox initial status is PENDING');

    // Step 12: Outbox Worker Claims & Dispatches Customer Notification
    const mockSenderCustomer = async (msg) => {
      return {
        success: true,
        metaMessageId: `wamid.HB_CUST_${Date.now()}`
      };
    };

    const customerDispatchRes = await dispatchPendingOutboxMessages({
      batchSize: 10,
      customSender: mockSenderCustomer
    });

    const dispatchedCustomerOutbox = await prisma.outboxMessage.findUnique({
      where: { id: customerOutbox.id }
    });
    assert(customerDispatchRes.succeededCount >= 1, 'Step 12: Customer notification dispatched by outbox worker');
    assert(dispatchedCustomerOutbox.status === 'ACCEPTED', 'Step 12: Customer outbox status transitioned to ACCEPTED');
    assert(dispatchedCustomerOutbox.payload.meta_message_id !== undefined, 'Step 12: meta_message_id recorded in payload');


    // ---------------------------------------------------------------------
    // TEST GROUP 4: Reliability, Concurrency & Failure Recovery Auditing
    // ---------------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Reliability, Concurrency & Failure Recovery Auditing ---');

    // 1. Duplicate Webhook Deliveries (Idempotent Webhook Deduplication)
    const dupeEventKey = `wamid.AUDIT_DUPE_${Date.now()}`;
    const dupePayload = buildMetaWebhookPayload({
      phoneNumberId: TENANT_A_PHONE_ID,
      senderPhone: '919811999901',
      messageId: dupeEventKey,
      messageType: 'text',
      messageObj: { text: { body: 'Hello' } }
    });

    const firstDelivery = await sendSignedWebhook(dupePayload);
    const secondDelivery = await sendSignedWebhook(dupePayload);

    assert(firstDelivery.statusCode === 200, 'Reliability: First webhook delivery returns HTTP 200');
    assert(secondDelivery.statusCode === 200, 'Reliability: Retried webhook delivery returns HTTP 200');

    const eventCount = await prisma.webhookEvent.count({
      where: { event_key: dupeEventKey }
    });
    assert(eventCount === 1, 'Reliability: Exactly 1 row persisted in webhook_events (Zero duplicate records)');

    // 2. Concurrent Customer Confirmations (Idempotency Guard)
    const raceCustomer = '919822999902';
    const raceToken = `conf_${crypto.randomUUID()}`;

    await prisma.conversationSession.create({
      data: {
        restaurant_id: TENANT_A_ID,
        customer_phone: raceCustomer,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 3600000),
        state: {
          cart: {
            subtotal: 200,
            currency: 'INR',
            items: [{ productRetailerId: 'SKU_SNACK', productName: 'Samosa', quantity: 4, unitPrice: 50 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: raceToken
        }
      }
    });

    const [conf1, conf2] = await Promise.all([
      confirmCustomerOrder({ restaurantId: TENANT_A_ID, customerPhone: raceCustomer, confirmationToken: raceToken }),
      confirmCustomerOrder({ restaurantId: TENANT_A_ID, customerPhone: raceCustomer, confirmationToken: raceToken })
    ]);

    assert(conf1.success === true && conf2.success === true, 'Reliability: Both concurrent confirmations returned success');
    const duplicateFlags = [conf1.isDuplicate, conf2.isDuplicate].filter(Boolean);
    assert(duplicateFlags.length === 1, 'Reliability: Exactly one confirmation was first; the second was marked isDuplicate');

    const ordersWithToken = await prisma.order.count({ where: { confirmation_token: raceToken } });
    assert(ordersWithToken === 1, 'Reliability: Exactly 1 order created in database (Zero duplicate orders)');

    // 3. Concurrent Conflicting Owner Decisions (Accept vs Reject)
    const conflictCustomer = '919833999903';
    const conflictToken = `conf_${crypto.randomUUID()}`;

    await prisma.conversationSession.create({
      data: {
        restaurant_id: TENANT_A_ID,
        customer_phone: conflictCustomer,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 3600000),
        state: {
          cart: {
            subtotal: 300,
            currency: 'INR',
            items: [{ productRetailerId: 'SKU_ROLL', productName: 'Paneer Roll', quantity: 2, unitPrice: 150 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: conflictToken
        }
      }
    });

    const conflictOrderRes = await confirmCustomerOrder({
      restaurantId: TENANT_A_ID,
      customerPhone: conflictCustomer,
      confirmationToken: conflictToken
    });

    const [decA, decB] = await Promise.all([
      processOwnerOrderDecision({ restaurantId: TENANT_A_ID, senderPhone: TENANT_A_OWNER_PHONE, orderId: conflictOrderRes.order.id, decision: 'ACCEPT' }),
      processOwnerOrderDecision({ restaurantId: TENANT_A_ID, senderPhone: TENANT_A_OWNER_PHONE, orderId: conflictOrderRes.order.id, decision: 'REJECT' })
    ]);

    const successes = [decA.success, decB.success].filter(Boolean);
    const conflicts = [decA.code, decB.code].filter(c => c === 'CONFLICTING_DECISION');
    assert(successes.length === 1, 'Reliability: Exactly one owner decision succeeded under concurrent race');
    assert(conflicts.length === 1, 'Reliability: Competing decision rejected with CONFLICTING_DECISION');

    // 4. Concurrent Outbox Workers (FOR UPDATE SKIP LOCKED)
    // Seed two pending outbox messages
    await prisma.outboxMessage.create({
      data: {
        restaurant_id: TENANT_A_ID,
        recipient_phone: '919844000001',
        message_type: 'TEST_CONCURRENT',
        payload: { text: 'Worker A test' },
        idempotency_key: `concurrent_msg_1_${Date.now()}`,
        status: 'PENDING'
      }
    });
    await prisma.outboxMessage.create({
      data: {
        restaurant_id: TENANT_A_ID,
        recipient_phone: '919844000002',
        message_type: 'TEST_CONCURRENT',
        payload: { text: 'Worker B test' },
        idempotency_key: `concurrent_msg_2_${Date.now()}`,
        status: 'PENDING'
      }
    });

    const [claimedWorkerA, claimedWorkerB] = await Promise.all([
      prisma.$transaction(tx => claimPendingOutboxMessages(tx, { limit: 1, workerId: 'worker_alpha' })),
      prisma.$transaction(tx => claimPendingOutboxMessages(tx, { limit: 1, workerId: 'worker_beta' }))
    ]);

    assert(claimedWorkerA.length === 1 && claimedWorkerB.length === 1, 'Reliability: Both workers claimed 1 message');
    assert(claimedWorkerA[0].id !== claimedWorkerB[0].id, 'Reliability: Workers claimed completely distinct messages (Zero double-claiming)');

    // Clean up test outbox before crash recovery test to isolate message queue
    await prisma.outboxMessage.deleteMany({ where: { status: 'PENDING' } });

    // 5. Worker Crash & Lease Expiration Recovery
    // Simulate expired lease on message
    const expiredLeaseMsg = await prisma.outboxMessage.create({
      data: {
        restaurant_id: TENANT_A_ID,
        recipient_phone: '919855000001',
        message_type: 'TEST_CRASH',
        payload: {
          text: 'Crash recovery test',
          lease: {
            claimed_by: 'dead_worker_pid_9999',
            lease_token: 'dead-lease-token-1111',
            lease_expires_at: new Date(Date.now() - 60000).toISOString() // Expired 1 min ago
          }
        },
        idempotency_key: `crash_msg_${Date.now()}`,
        status: 'PENDING',
        attempts: 1
      }
    });

    const recoveryClaim = await prisma.$transaction(tx =>
      claimPendingOutboxMessages(tx, { limit: 1, workerId: 'recovery_worker' })
    );

    assert(recoveryClaim.some(m => m.id === expiredLeaseMsg.id), 'Reliability: Fresh worker successfully reclaimed expired lease message');

    // 6. Stale Worker Fencing (FENCED_OUT)
    const staleUpdate = await updateOutboxResult({
      id: expiredLeaseMsg.id,
      leaseToken: 'dead-lease-token-1111', // Stale token
      dispatchResult: { success: true, metaMessageId: 'stale_id' },
      attempts: 2
    });

    assert(staleUpdate.updated === false, 'Reliability: Stale worker update rejected');
    assert(staleUpdate.reason === 'FENCED_OUT', 'Reliability: Reason is FENCED_OUT');

    // Clean up test outbox before timeout test to isolate message queue
    await prisma.outboxMessage.deleteMany({ where: { status: 'PENDING' } });

    // 7. Meta API Timeout & UNCERTAIN_DISPATCH
    const timeoutMsg = await prisma.outboxMessage.create({
      data: {
        restaurant_id: TENANT_A_ID,
        recipient_phone: '919866000001',
        message_type: 'TEST_TIMEOUT',
        payload: { text: 'Timeout test' },
        idempotency_key: `timeout_msg_${Date.now()}`,
        status: 'PENDING'
      }
    });

    const claimedTimeout = await prisma.$transaction(tx =>
      claimPendingOutboxMessages(tx, { limit: 1, workerId: 'timeout_worker' })
    );
    const targetTimeoutMsg = claimedTimeout.find(m => m.id === timeoutMsg.id);

    const timeoutResult = await updateOutboxResult({
      id: targetTimeoutMsg.id,
      leaseToken: targetTimeoutMsg.leaseToken,
      dispatchResult: { success: false, isTimeout: true, error: 'Request timed out after 10000ms' },
      attempts: targetTimeoutMsg.attempts
    });

    assert(timeoutResult.status === 'UNCERTAIN_DISPATCH', 'Reliability: Timeout marked as UNCERTAIN_DISPATCH (Zero blind retries)');

    // Clean up test outbox before failure test
    await prisma.outboxMessage.deleteMany({ where: { status: 'PENDING' } });

    // 8. Meta Non-Retryable 4xx Error
    const failMsg = await prisma.outboxMessage.create({
      data: {
        restaurant_id: TENANT_A_ID,
        recipient_phone: '919877000001',
        message_type: 'TEST_FAIL',
        payload: { text: 'Fail test' },
        idempotency_key: `fail_msg_${Date.now()}`,
        status: 'PENDING'
      }
    });

    const claimedFail = await prisma.$transaction(tx =>
      claimPendingOutboxMessages(tx, { limit: 1, workerId: 'fail_worker' })
    );
    const targetFailMsg = claimedFail.find(m => m.id === failMsg.id);

    const failResult = await updateOutboxResult({
      id: targetFailMsg.id,
      leaseToken: targetFailMsg.leaseToken,
      dispatchResult: { success: false, isTimeout: false, isRetryable: false, error: 'Recipient phone number is invalid' },
      attempts: targetFailMsg.attempts
    });

    assert(failResult.status === 'FAILED', 'Reliability: Non-retryable error transitioned status to FAILED');


    // ---------------------------------------------------------------------
    // TEST GROUP 5: Operational & Production Health Checks
    // ---------------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Operational & Production Health Checks ---');

    const healthRes = await sendGetRequest('/health');
    assert(healthRes.statusCode === 200, 'Operational: GET /health returns HTTP 200');
    assert(healthRes.body.status === 'ok', 'Operational: Health status reports "ok"');
    assert(healthRes.body.service === 'RESTOPRO-WhatsApp-Backend', 'Operational: Correct service identifier');

    const rootRes = await sendGetRequest('/');
    assert(rootRes.statusCode === 200, 'Operational: GET / returns HTTP 200');
    assert(rootRes.body.status === 'operational', 'Operational: Root status reports "operational"');

    const notFoundRes = await sendGetRequest('/api/unknown-endpoint');
    assert(notFoundRes.statusCode === 404, 'Operational: Unknown route returns HTTP 404');

  } catch (err) {
    console.error('Fatal error during Stage 6 test suite execution:', err);
    failedTests++;
  } finally {
    console.log('\n--- Cleaning up Stage 6 audit test artifacts ---');
    await cleanupTestData();

    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 6 AUDIT RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAuditSuite();
