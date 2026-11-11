require('./load-test-env');
process.env.NODE_ENV = 'test';
process.env.NOTIFICATION_ROUTING_MODE = 'CENTRAL';
process.env.OWNER_TEMPLATE_APPROVED = 'true';
process.env.CENTRAL_TEMPLATE_APPROVED = 'true';

const http = require('http');
const crypto = require('crypto');
const prisma = require('../src/config/database');
const app = require('../src/app');
const config = require('../src/config/env');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');
const { assertSafeCleanupFilter } = require('../src/utils/test-guard');
const { createCentralAccount, setCentralSenderForTesting } = require('../src/services/central-whatsapp.service');
const { isCentralPhoneNumberId, resolveTenantByPhoneNumberId } = require('../src/services/tenant.service');
const { handleIncomingEvent } = require('../src/controllers/webhook.controller');

const TEST_PORT = 4991;
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

async function runTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — R6.6 CENTRAL WEBHOOK ROUTING TEST SUITE        ');
  console.log('   (TC-04, TC-05, TC-09, TC-11, TC-12, TC-13, TC-16)        ');
  console.log('============================================================\n');

  // Track created entities for cleanup
  const createdCentralAccountIds = [];
  const createdRestaurantIds = [];
  const createdOrderIds = [];
  const createdOutboxIds = [];
  const createdWebhookEventIds = [];

  const centralPhoneId = '999888001111';
  const restAPhoneId = '111222333444';
  const restBPhoneId = '111222333555';
  const ownerAPhone = '919876543211';
  const ownerBPhone = '919876543222';
  const unknownSenderPhone = '919999999999';
  const createdWebhookEventKeys = [];
  let previouslyActiveAccount = null;

  try {
    // Start local HTTP server
    await new Promise((resolve) => {
      serverInstance = app.listen(TEST_PORT, () => {
        resolve();
      });
    });

    // Clean up any stale central accounts with test centralPhoneId
    assertSafeCleanupFilter({ phone_number_id: { in: [centralPhoneId, '999888001112'] } }, 'CentralWhatsAppAccount');
    await prisma.centralWhatsAppAccount.deleteMany({
      where: { phone_number_id: { in: [centralPhoneId, '999888001112'] } }
    });
    previouslyActiveAccount = await prisma.centralWhatsAppAccount.findFirst({ where: { is_active: true } });
    if (previouslyActiveAccount) {
      await prisma.centralWhatsAppAccount.update({
        where: { id: previouslyActiveAccount.id },
        data: { is_active: false }
      });
    }

    // 1. Seed Active Central Account (XYZ)
    const centralAccount = await createCentralAccount({
      phoneNumberId: centralPhoneId,
      wabaId: 'waba_central_001',
      accessToken: 'EAAB_test_mock_central_access_token_xyz',
      displayPhoneNumber: '+91 99988 80011',
      isActive: true,
      templates: {
        restopro_order_alert: { isApproved: true, status: 'APPROVED', approvalSource: 'TEST' },
        restopro_customer_order_accepted: { isApproved: true, status: 'APPROVED', approvalSource: 'TEST' },
        restopro_customer_order_rejected: { isApproved: true, status: 'APPROVED', approvalSource: 'TEST' }
      }
    });
    createdCentralAccountIds.push(centralAccount.id);

    // 2. Seed Restaurant A and Restaurant B
    const restA = await prisma.restaurant.create({
      data: {
        name: 'The Royal Biryani (Restaurant A)',
        address: '101 MG Road, Mumbai',
        phone_number_id: restAPhoneId,
        waba_id: 'waba_rest_a',
        owner_phone: `+${ownerAPhone}`,
        access_token_encrypted: 'mock_token_a',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: JSON.stringify({
          ownerConsent: { optedIn: true, templateApproved: true }
        })
      }
    });
    createdRestaurantIds.push(restA.id);

    const restB = await prisma.restaurant.create({
      data: {
        name: 'Pizza Palace (Restaurant B)',
        address: '202 Park Street, Mumbai',
        phone_number_id: restBPhoneId,
        waba_id: 'waba_rest_b',
        owner_phone: `+${ownerBPhone}`,
        access_token_encrypted: 'mock_token_b',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: JSON.stringify({
          ownerConsent: { optedIn: true, templateApproved: true }
        })
      }
    });
    createdRestaurantIds.push(restB.id);

    // 3. Seed Order A for Restaurant A
    const orderA = await prisma.order.create({
      data: {
        restaurant_id: restA.id,
        order_reference: 'RP-261108-WKA1',
        customer_phone: '919811112222',
        customer_name: 'Customer Alice',
        order_type: 'DELIVERY',
        address_snapshot: 'Flat 4A, Marine Drive, Mumbai',
        items: [
          { productRetailerId: 'ITEM_1', productName: 'Hyderabadi Biryani', quantity: 2, unitPrice: 350, lineTotal: 700 }
        ],
        total_amount: 700,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderA.id);

    // 4. Seed Order B for Restaurant B
    const orderB = await prisma.order.create({
      data: {
        restaurant_id: restB.id,
        order_reference: 'RP-261108-WKB2',
        customer_phone: '919822223333',
        customer_name: 'Customer Bob',
        order_type: 'TAKEAWAY',
        items: [
          { productRetailerId: 'ITEM_2', productName: 'Farmhouse Pizza', quantity: 1, unitPrice: 450, lineTotal: 450 }
        ],
        total_amount: 450,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderB.id);

    console.log('--- TEST GROUP 1: Central Webhook Detection & Tenant Isolation ---');
    const isCentral = await isCentralPhoneNumberId(centralPhoneId);
    assert(isCentral === true, 'isCentralPhoneNumberId correctly detects Central Number XYZ');

    const isRestCentral = await isCentralPhoneNumberId(restAPhoneId);
    assert(isRestCentral === false, 'isCentralPhoneNumberId correctly returns false for Restaurant ABC');

    const tenantForCentral = await resolveTenantByPhoneNumberId(centralPhoneId);
    assert(tenantForCentral === null, 'resolveTenantByPhoneNumberId returns null for Central Number XYZ (not a restaurant tenant)');

    console.log('\n--- TEST GROUP 2: TC-04 — Restaurant A Owner Accepts Through Central XYZ ---');
    const acceptPayloadA = generateSignedOwnerCallback({ orderId: orderA.id, action: 'ACCEPT' });
    const webhookAId = `wamid_tc04_${Date.now()}`;
    createdWebhookEventKeys.push(webhookAId);
    const webhookBodyA = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry_1',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '+91 99988 80011',
              phone_number_id: centralPhoneId
            },
            contacts: [{ profile: { name: 'Owner A' }, wa_id: ownerAPhone }],
            messages: [{
              from: ownerAPhone,
              id: webhookAId,
              timestamp: `${Math.floor(Date.now() / 1000)}`,
              type: 'interactive',
              interactive: {
                type: 'button_reply',
                button_reply: {
                  id: acceptPayloadA,
                  title: '✅ Accept Order'
                }
              }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    const sigA = computeSignature(webhookBodyA);
    const resA = await makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sigA
      },
      body: webhookBodyA
    });

    assert(resA.statusCode === 200, `TC-04 HTTP response is 200 (Got ${resA.statusCode})`);
    assert(resA.body === 'EVENT_RECEIVED', 'Response body confirms EVENT_RECEIVED');

    // Verify Order A updated to ACCEPTED
    const updatedOrderA = await prisma.order.findUnique({ where: { id: orderA.id } });
    assert(updatedOrderA.status === 'ACCEPTED', 'Order A transitioned to ACCEPTED atomically');
    assert(updatedOrderA.decision_at !== null, 'Order A has decision_at timestamp populated');

    // Verify Customer decision outbox message created with sender_channel = CENTRAL
    const outboxA = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `customer_decision_${orderA.id}_accept`
      }
    });
    assert(outboxA !== null, 'Customer decision outbox message created');
    assert(outboxA.sender_channel === 'CENTRAL', 'Outbox sender_channel is CENTRAL in CENTRAL routing mode');
    assert(outboxA.payload.type === 'template', 'Customer notification payload uses Meta template format');
    assert(outboxA.payload.template?.name === 'restopro_customer_order_accepted', 'Template name is restopro_customer_order_accepted');
    if (outboxA) createdOutboxIds.push(outboxA.id);

    console.log('\n--- TEST GROUP 3: TC-05 — Restaurant B Owner Rejects Through Central XYZ ---');
    const rejectPayloadB = generateSignedOwnerCallback({ orderId: orderB.id, action: 'REJECT' });
    const webhookBId = `wamid_tc05_${Date.now()}`;
    createdWebhookEventKeys.push(webhookBId);
    const webhookBodyB = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry_2',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '+91 99988 80011',
              phone_number_id: centralPhoneId
            },
            contacts: [{ profile: { name: 'Owner B' }, wa_id: ownerBPhone }],
            messages: [{
              from: ownerBPhone,
              id: webhookBId,
              timestamp: `${Math.floor(Date.now() / 1000)}`,
              type: 'interactive',
              interactive: {
                type: 'button_reply',
                button_reply: {
                  id: rejectPayloadB,
                  title: '❌ Reject Order'
                }
              }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    const sigB = computeSignature(webhookBodyB);
    const resB = await makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sigB
      },
      body: webhookBodyB
    });

    assert(resB.statusCode === 200, `TC-05 HTTP response is 200 (Got ${resB.statusCode})`);
    const updatedOrderB = await prisma.order.findUnique({ where: { id: orderB.id } });
    assert(updatedOrderB.status === 'REJECTED', 'Order B transitioned to REJECTED atomically');

    const outboxB = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restB.id,
        idempotency_key: `customer_decision_${orderB.id}_reject`
      }
    });
    assert(outboxB !== null, 'Customer rejection outbox message created');
    assert(outboxB.sender_channel === 'CENTRAL', 'Outbox sender_channel is CENTRAL');
    assert(outboxB.payload.template?.name === 'restopro_customer_order_rejected', 'Template name is restopro_customer_order_rejected');
    if (outboxB) createdOutboxIds.push(outboxB.id);

    console.log('\n--- TEST GROUP 4: TC-09 — Duplicate Webhook Delivery Idempotency ---');
    // Resend exact same webhook for Order A
    const resADup = await makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sigA
      },
      body: webhookBodyA
    });
    assert(resADup.statusCode === 200, 'Duplicate delivery returns HTTP 200 safely');
    const outboxACount = await prisma.outboxMessage.count({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `customer_decision_${orderA.id}_accept`
      }
    });
    assert(outboxACount === 1, 'Zero duplicate outbox messages created on redelivery');

    console.log('\n--- TEST GROUP 5: TC-11 — Tampered & Expired Callback Signatures ---');
    // Seed Order C for tampering test
    const orderC = await prisma.order.create({
      data: {
        restaurant_id: restA.id,
        order_reference: 'RP-261108-WKC3',
        customer_phone: '919833334444',
        order_type: 'TAKEAWAY',
        items: [{ productRetailerId: 'ITEM_1', productName: 'Biryani', quantity: 1, unitPrice: 350, lineTotal: 350 }],
        total_amount: 350,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderC.id);

    // Tamper the signature by altering hex chars
    const validCallbackC = generateSignedOwnerCallback({ orderId: orderC.id, action: 'ACCEPT' });
    const tamperedCallbackC = validCallbackC.slice(0, -6) + 'abcdef';

    const webhookTamperedId = `wamid_tc11_tampered_${Date.now()}`;
    createdWebhookEventKeys.push(webhookTamperedId);
    const webhookBodyTampered = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry_3',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+91 99988 80011', phone_number_id: centralPhoneId },
            messages: [{
              from: ownerAPhone,
              id: webhookTamperedId,
              timestamp: `${Math.floor(Date.now() / 1000)}`,
              type: 'interactive',
              interactive: {
                type: 'button_reply',
                button_reply: { id: tamperedCallbackC, title: '✅ Accept' }
              }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    const resTampered = await makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': computeSignature(webhookBodyTampered)
      },
      body: webhookBodyTampered
    });
    assert(resTampered.statusCode === 200, 'Webhook returns 200 to acknowledge receipt');

    const orderCAfterTampered = await prisma.order.findUnique({ where: { id: orderC.id } });
    assert(orderCAfterTampered.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order C remains PENDING: tampered signature rejected');

    // Expired signature
    const expiredCallbackC = generateSignedOwnerCallback({ orderId: orderC.id, action: 'ACCEPT', ttlSeconds: -100 });
    const webhookExpiredId = `wamid_tc11_expired_${Date.now()}`;
    createdWebhookEventKeys.push(webhookExpiredId);
    const webhookBodyExpired = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry_4',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+91 99988 80011', phone_number_id: centralPhoneId },
            messages: [{
              from: ownerAPhone,
              id: webhookExpiredId,
              timestamp: `${Math.floor(Date.now() / 1000)}`,
              type: 'interactive',
              interactive: {
                type: 'button_reply',
                button_reply: { id: expiredCallbackC, title: '✅ Accept' }
              }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    await makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': computeSignature(webhookBodyExpired)
      },
      body: webhookBodyExpired
    });
    const orderCAfterExpired = await prisma.order.findUnique({ where: { id: orderC.id } });
    assert(orderCAfterExpired.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order C remains PENDING: expired signature rejected');

    console.log('\n--- TEST GROUP 6: TC-12 — Unknown Sender Authorization Rejection ---');
    // Unknown phone sends valid callback for Order C
    const webhookUnknownId = `wamid_tc12_unknown_${Date.now()}`;
    createdWebhookEventKeys.push(webhookUnknownId);
    const webhookBodyUnknown = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry_5',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+91 99988 80011', phone_number_id: centralPhoneId },
            messages: [{
              from: unknownSenderPhone,
              id: webhookUnknownId,
              timestamp: `${Math.floor(Date.now() / 1000)}`,
              type: 'interactive',
              interactive: {
                type: 'button_reply',
                button_reply: { id: validCallbackC, title: '✅ Accept' }
              }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    await makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': computeSignature(webhookBodyUnknown)
      },
      body: webhookBodyUnknown
    });

    const orderCAfterUnknown = await prisma.order.findUnique({ where: { id: orderC.id } });
    assert(orderCAfterUnknown.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order C remains PENDING: unknown sender phone rejected');

    console.log('\n--- TEST GROUP 7: TC-13 — Central and Restaurant Webhook Separation ---');
    let centralInfoReplyCaptured = null;
    setCentralSenderForTesting(async (params) => {
      centralInfoReplyCaptured = params;
      return { success: true, metaMessageId: 'wamid_info_reply_mock' };
    });

    // Send unknown free-form text message to Central Number XYZ
    const webhookTextCentralId = `wamid_tc13_text_central_${Date.now()}`;
    createdWebhookEventKeys.push(webhookTextCentralId);
    const webhookBodyTextCentral = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry_6',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+91 99988 80011', phone_number_id: centralPhoneId },
            messages: [{
              from: '919876500000',
              id: webhookTextCentralId,
              timestamp: `${Math.floor(Date.now() / 1000)}`,
              type: 'text',
              text: { body: 'Hello, what restaurants do you have?' }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    await makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': computeSignature(webhookBodyTextCentral)
      },
      body: webhookBodyTextCentral
    });

    // Verify session was NOT created for Central Number XYZ
    const centralSession = await prisma.conversationSession.findFirst({
      where: { customer_phone: '919876500000' }
    });
    assert(centralSession === null, 'Central incoming message NEVER created a restaurant conversation session');
    assert(centralInfoReplyCaptured !== null, 'Central informational auto-reply triggered for text to XYZ');
    assert(centralInfoReplyCaptured?.phoneNumberId === centralPhoneId, 'Informational reply uses Central Phone Number ID');
    assert(centralInfoReplyCaptured?.payload?.text?.body.includes('automated dispatch notification line'), 'Informational message clearly advises customer');

    // Clean up test hook
    setCentralSenderForTesting(null);

    console.log('\n--- TEST GROUP 8: TC-16 — Central Status Receipt Delivery Failure Tracking ---');
    const failedStatusId = `wamid_tc16_status_${Date.now()}`;
    createdWebhookEventKeys.push(`status:${failedStatusId}:failed`);
    const webhookStatusBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry_7',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+91 99988 80011', phone_number_id: centralPhoneId },
            statuses: [{
              id: failedStatusId,
              status: 'failed',
              timestamp: `${Math.floor(Date.now() / 1000)}`,
              recipient_id: ownerAPhone,
              errors: [{
                code: 131026,
                title: 'Message undeliverable',
                message: 'Receiver is incapable of receiving this message',
                error_data: { details: 'Meta 24h window constraint' }
              }]
            }]
          },
          field: 'messages'
        }]
      }]
    });

    const resStatus = await makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': computeSignature(webhookStatusBody)
      },
      body: webhookStatusBody
    });
    assert(resStatus.statusCode === 200, 'Status webhook receipt returned HTTP 200');

    // Verify webhook event record in database
    const statusEventRecord = await prisma.webhookEvent.findUnique({
      where: { event_key: `status:${failedStatusId}:failed` }
    });
    assert(statusEventRecord !== null, 'Status failure webhook event persisted to database');
    assert(statusEventRecord.payload_summary?.isCentral === true, 'Event marked as isCentral: true');
    assert(statusEventRecord.payload_summary?.errors[0]?.code === 131026, 'Sanitized Meta error code 131026 captured');

  } catch (err) {
    console.error('Unexpected error in R6.6 Central Webhook test:', err);
    failed++;
  } finally {
    // Teardown HTTP server
    if (serverInstance) {
      await new Promise(r => serverInstance.close(r));
    }

    console.log('\n--- Cleaning up R6.6 Webhook test artifacts ---');
    if (createdOutboxIds.length > 0) {
      assertSafeCleanupFilter({ id: { in: createdOutboxIds } }, 'OutboxMessage');
      await prisma.outboxMessage.deleteMany({ where: { id: { in: createdOutboxIds } } });
    }
    if (createdOrderIds.length > 0) {
      assertSafeCleanupFilter({ order_id: { in: createdOrderIds } }, 'OrderNotification');
      await prisma.orderNotification.deleteMany({ where: { order_id: { in: createdOrderIds } } });
      assertSafeCleanupFilter({ id: { in: createdOrderIds } }, 'Order');
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdRestaurantIds.length > 0) {
      assertSafeCleanupFilter({ id: { in: createdRestaurantIds } }, 'Restaurant');
      await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } });
    }
    if (createdCentralAccountIds.length > 0) {
      assertSafeCleanupFilter({ id: { in: createdCentralAccountIds } }, 'CentralWhatsAppAccount');
      await prisma.centralWhatsAppAccount.deleteMany({ where: { id: { in: createdCentralAccountIds } } });
    }
    if (createdWebhookEventKeys.length > 0) {
      assertSafeCleanupFilter({ event_key: { in: createdWebhookEventKeys } }, 'WebhookEvent');
      await prisma.webhookEvent.deleteMany({ where: { event_key: { in: createdWebhookEventKeys } } });
    }
    if (previouslyActiveAccount) {
      await prisma.centralWhatsAppAccount.update({
        where: { id: previouslyActiveAccount.id },
        data: { is_active: true }
      }).catch(() => {});
    }

    console.log(`\n============================================================`);
    console.log(`   R6.6 CENTRAL WEBHOOK RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`============================================================\n`);

    if (failed > 0) process.exit(1);
  }
}

runTests();

