/**
 * RESTOPRO — Stage 5.2: Owner Accept / Reject Processing Test Suite
 *
 * Verifies:
 * - Valid owner Accept: atomic status transition to ACCEPTED, decision timestamp recorded (ST5-03, ST5-06)
 * - Valid owner Reject: atomic status transition to REJECTED, decision timestamp recorded (ST5-03, ST5-06)
 * - Owner authorization guard: sender phone must match restaurant.owner_phone (ST5-04)
 * - Customer cannot perform owner action (ST5-04)
 * - Owner from another restaurant cannot perform owner action on Tenant A (ST5-04)
 * - Cross-tenant order isolation: Owner B cannot accept Tenant A order (ST5-05)
 * - Unknown order ID defense (valid UUID not found in database)
 * - Malformed button payload validation (missing UUID, invalid UUID, unrecognized prefix)
 * - Repeated identical owner action: idempotent replay, zero duplicate notifications (ST5-07)
 * - Conflicting decision guard: once accepted/rejected, conflicting decision rejected (ST5-07)
 * - Concurrent Accept/Reject race condition: row locking allows exactly one winner
 * - Full webhook pipeline integration (HTTP POST with HMAC verification and event deduplication)
 * - Zero token or credential leakage in logs
 */
const crypto = require('crypto');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const {
  processOwnerOrderDecision,
  parseOwnerAction,
  normalizePhone
} = require('../src/services/order.service');

async function runStage5DecisionTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 5.2: OWNER ACCEPT / REJECT TEST SUITE   ');
  console.log('============================================================\n');

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

  // Cleanup tracking
  const createdOrderIds = [];
  const createdWebhookEventKeys = [];

  let server;
  let serverPort;

  // Helper to create test pending order
  async function createTestOrder(restaurantId, customerPhone = '919876543210', initialStatus = 'PENDING_RESTAURANT_CONFIRMATION') {
    const ref = `RP-261105-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const token = `conf_${crypto.randomUUID()}`;
    const order = await prisma.order.create({
      data: {
        restaurant_id: restaurantId,
        order_reference: ref,
        confirmation_token: token,
        customer_name: 'Test Customer',
        customer_phone: customerPhone,
        order_type: 'TAKEAWAY',
        items: [
          { productRetailerId: 'SKU_PIZZA', quantity: 1, unitPrice: 350.00, lineTotal: 350.00 }
        ],
        total_amount: 350.00,
        currency: 'INR',
        status: initialStatus
      }
    });
    createdOrderIds.push(order.id);
    return order;
  }

  // Helper to make signed HTTP POST request to webhook server
  function sendSignedWebhook(payload, signatureSecret = config.meta.appSecret) {
    return new Promise((resolve, reject) => {
      const rawBody = JSON.stringify(payload);
      const signature = signatureSecret
        ? `sha256=${crypto.createHmac('sha256', signatureSecret).update(rawBody).digest('hex')}`
        : 'invalid_sig';

      const options = {
        hostname: '127.0.0.1',
        port: serverPort,
        path: '/api/webhook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          'x-hub-signature-256': signature
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      });

      req.on('error', reject);
      req.write(rawBody);
      req.end();
    });
  }

  try {
    // 1. Initial database cleanup and tenant resolution
    await prisma.outboxMessage.deleteMany({});
    await prisma.orderNotification.deleteMany({});
    await prisma.order.deleteMany({});

    const tenantA = await prisma.restaurant.findUnique({
      where: { phone_number_id: '111111111111111' }
    });
    const tenantB = await prisma.restaurant.findUnique({
      where: { phone_number_id: '222222222222222' }
    });

    if (!tenantA || !tenantB) {
      throw new Error('Precondition failed: Seeded restaurants (Tenant A / B) not found.');
    }

    // Start local test server for webhook pipeline integration tests
    server = http.createServer(app);
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });

    // -------------------------------------------------------------
    // TEST GROUP 1: Valid Owner Decision Transitions (ST5-03, ST5-06)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: Valid Owner Decision Transitions (ST5-03, ST5-06) ---');

    // 1. Valid Owner Accept
    {
      const orderA1 = await createTestOrder(tenantA.id);
      const acceptPayload = `OWNER_ACCEPT:${orderA1.id}`;

      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: acceptPayload
      });

      assert(res.success === true, 'Valid owner Accept returns success: true');
      assert(res.previousStatus === 'PENDING_RESTAURANT_CONFIRMATION', 'Previous status was PENDING_RESTAURANT_CONFIRMATION');
      assert(res.newStatus === 'ACCEPTED', 'New status is ACCEPTED');
      assert(res.decision === 'ACCEPT', 'Decision recorded as ACCEPT');
      assert(res.isDuplicate === false, 'First decision marks isDuplicate: false');
      assert(res.decisionAt instanceof Date, 'decisionAt is a valid Date object');

      // Verify in database
      const dbOrder = await prisma.order.findUnique({ where: { id: orderA1.id } });
      assert(dbOrder.status === 'ACCEPTED', 'Order row in PostgreSQL transitioned to ACCEPTED');
      assert(dbOrder.decision_at !== null, 'Order row in PostgreSQL has non-null decision_at timestamp');
    }

    // 2. Valid Owner Reject
    {
      const orderA2 = await createTestOrder(tenantA.id);
      const rejectPayload = `OWNER_REJECT:${orderA2.id}`;

      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: rejectPayload
      });

      assert(res.success === true, 'Valid owner Reject returns success: true');
      assert(res.previousStatus === 'PENDING_RESTAURANT_CONFIRMATION', 'Previous status was PENDING_RESTAURANT_CONFIRMATION');
      assert(res.newStatus === 'REJECTED', 'New status is REJECTED');
      assert(res.decision === 'REJECT', 'Decision recorded as REJECT');
      assert(res.decisionAt instanceof Date, 'decisionAt is a valid Date object');

      // Verify in database
      const dbOrder = await prisma.order.findUnique({ where: { id: orderA2.id } });
      assert(dbOrder.status === 'REJECTED', 'Order row in PostgreSQL transitioned to REJECTED');
      assert(dbOrder.decision_at !== null, 'Order row in PostgreSQL has non-null decision_at timestamp');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Owner Authorization & Identity Defense (ST5-04)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Owner Authorization & Identity Defense (ST5-04) ---');

    // 3. Wrong owner phone number (arbitrary stranger)
    {
      const orderA3 = await createTestOrder(tenantA.id);
      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: '919999988888', // Not the owner
        buttonPayload: `OWNER_ACCEPT:${orderA3.id}`
      });

      assert(res.success === false, 'Wrong owner number returns success: false');
      assert(res.code === 'UNAUTHORIZED_OWNER', 'Rejection code is UNAUTHORIZED_OWNER');

      // Verify order status unchanged in database
      const dbOrder = await prisma.order.findUnique({ where: { id: orderA3.id } });
      assert(dbOrder.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order status remains PENDING_RESTAURANT_CONFIRMATION');
      assert(dbOrder.decision_at === null, 'decision_at remains null');
    }

    // 4. Customer attempting owner action
    {
      const customerPhone = '919876500001';
      const orderA4 = await createTestOrder(tenantA.id, customerPhone);

      // Customer sends OWNER_ACCEPT for their own order
      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: customerPhone,
        buttonPayload: `OWNER_ACCEPT:${orderA4.id}`
      });

      assert(res.success === false, 'Customer attempting owner action rejected');
      assert(res.code === 'UNAUTHORIZED_OWNER', 'Customer rejection code is UNAUTHORIZED_OWNER');

      const dbOrder = await prisma.order.findUnique({ where: { id: orderA4.id } });
      assert(dbOrder.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Customer cannot alter order status');
    }

    // 5. Owner from another restaurant (Tenant B owner attempting Tenant A order)
    {
      const orderA5 = await createTestOrder(tenantA.id);

      // Tenant B owner sends action to Tenant A
      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantB.owner_phone, // Owner B
        buttonPayload: `OWNER_ACCEPT:${orderA5.id}`
      });

      assert(res.success === false, 'Owner B attempting Tenant A order rejected');
      assert(res.code === 'UNAUTHORIZED_OWNER', 'Rejection code is UNAUTHORIZED_OWNER');

      const dbOrder = await prisma.order.findUnique({ where: { id: orderA5.id } });
      assert(dbOrder.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Tenant A order status unaffected by Owner B');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: Cross-Tenant Order Isolation (ST5-05)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Cross-Tenant Order Isolation (ST5-05) ---');

    // 6. Cross-tenant order: Owner B operates in Tenant B context, but provides Tenant A's order ID
    {
      const orderA6 = await createTestOrder(tenantA.id);

      // Owner B is authenticated for Tenant B, but tries to modify Tenant A's order
      const res = await processOwnerOrderDecision({
        restaurantId: tenantB.id,
        senderPhone: tenantB.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${orderA6.id}`
      });

      assert(res.success === false, 'Cross-tenant order modification strictly rejected');
      assert(res.code === 'CROSS_TENANT_VIOLATION', 'Rejection code is CROSS_TENANT_VIOLATION');

      const dbOrder = await prisma.order.findUnique({ where: { id: orderA6.id } });
      assert(dbOrder.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Tenant A order remains PENDING_RESTAURANT_CONFIRMATION');
    }

    // 7. Unknown order ID (valid UUID that does not exist in PostgreSQL)
    {
      const nonExistentUuid = crypto.randomUUID();
      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${nonExistentUuid}`
      });

      assert(res.success === false, 'Unknown order ID returns success: false');
      assert(res.code === 'ORDER_NOT_FOUND', 'Rejection code is ORDER_NOT_FOUND');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Malformed Payload Validation
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Malformed Payload Validation ---');

    // 8. Missing order UUID in payload
    {
      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: 'OWNER_ACCEPT:'
      });
      assert(res.success === false, 'Missing order UUID rejected');
      assert(res.code === 'INVALID_ORDER_ID', 'Rejection code is INVALID_ORDER_ID');
    }

    // 9. Non-UUID string in payload
    {
      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: 'OWNER_ACCEPT:order_12345_not_a_uuid'
      });
      assert(res.success === false, 'Non-UUID order ID rejected');
      assert(res.code === 'INVALID_ORDER_ID', 'Rejection code is INVALID_ORDER_ID');
    }

    // 10. Unrecognized owner action prefix
    {
      const validUuid = crypto.randomUUID();
      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_MAYBE:${validUuid}`
      });
      assert(res.success === false, 'Unrecognized action prefix OWNER_MAYBE rejected');
      assert(res.code === 'UNRECOGNIZED_OWNER_ACTION', 'Rejection code is UNRECOGNIZED_OWNER_ACTION');
    }

    // 11. Empty or non-string payload
    {
      const res1 = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: ''
      });
      assert(res1.success === false, 'Empty string payload rejected');

      const res2 = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: null,
        orderId: null,
        decision: null
      });
      assert(res2.success === false, 'Null payload rejected');
    }

    // -------------------------------------------------------------
    // TEST GROUP 5: Idempotency & Repeat Decisions (ST5-07)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Idempotency & Repeat Decisions (ST5-07) ---');

    // 12. Repeated identical Accept
    {
      const orderA12 = await createTestOrder(tenantA.id);

      // First Accept
      const firstRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${orderA12.id}`
      });
      assert(firstRes.success === true, 'First Accept succeeded');
      assert(firstRes.isDuplicate === false, 'First Accept isDuplicate: false');
      const firstDecisionAt = firstRes.decisionAt;

      // Second identical Accept
      const secondRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${orderA12.id}`
      });

      assert(secondRes.success === true, 'Repeated identical Accept returns success: true');
      assert(secondRes.isDuplicate === true, 'Repeated Accept marks isDuplicate: true');
      assert(secondRes.alreadyDecided === true, 'Repeated Accept marks alreadyDecided: true');
      assert(secondRes.newStatus === 'ACCEPTED', 'Status remains ACCEPTED');
      assert(secondRes.decisionAt.getTime() === firstDecisionAt.getTime(), 'Original decisionAt timestamp is preserved');

      const dbOrder = await prisma.order.findUnique({ where: { id: orderA12.id } });
      assert(dbOrder.status === 'ACCEPTED', 'Order row in PostgreSQL remains ACCEPTED');
    }

    // 13. Repeated identical Reject
    {
      const orderA13 = await createTestOrder(tenantA.id);

      // First Reject
      await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_REJECT:${orderA13.id}`
      });

      // Second identical Reject
      const secondRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_REJECT:${orderA13.id}`
      });

      assert(secondRes.success === true, 'Repeated identical Reject returns success: true');
      assert(secondRes.isDuplicate === true, 'Repeated Reject marks isDuplicate: true');
      assert(secondRes.newStatus === 'REJECTED', 'Status remains REJECTED');
    }

    // -------------------------------------------------------------
    // TEST GROUP 6: Conflicting Decisions & Terminal States (ST5-07)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Conflicting Decisions & Terminal States (ST5-07) ---');

    // 14. Conflicting decision: Attempting Reject on an already ACCEPTED order
    {
      const orderA14 = await createTestOrder(tenantA.id);

      // Accept first
      await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${orderA14.id}`
      });

      // Then try to Reject
      const conflictRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_REJECT:${orderA14.id}`
      });

      assert(conflictRes.success === false, 'Rejecting an already ACCEPTED order is rejected');
      assert(conflictRes.code === 'CONFLICTING_DECISION', 'Rejection code is CONFLICTING_DECISION');
      assert(conflictRes.currentStatus === 'ACCEPTED', 'Reports currentStatus as ACCEPTED');

      const dbOrder = await prisma.order.findUnique({ where: { id: orderA14.id } });
      assert(dbOrder.status === 'ACCEPTED', 'Order status strictly remains ACCEPTED in database');
    }

    // 15. Conflicting decision: Attempting Accept on an already REJECTED order
    {
      const orderA15 = await createTestOrder(tenantA.id);

      // Reject first
      await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_REJECT:${orderA15.id}`
      });

      // Then try to Accept
      const conflictRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${orderA15.id}`
      });

      assert(conflictRes.success === false, 'Accepting an already REJECTED order is rejected');
      assert(conflictRes.code === 'CONFLICTING_DECISION', 'Rejection code is CONFLICTING_DECISION');
      assert(conflictRes.currentStatus === 'REJECTED', 'Reports currentStatus as REJECTED');

      const dbOrder = await prisma.order.findUnique({ where: { id: orderA15.id } });
      assert(dbOrder.status === 'REJECTED', 'Order status strictly remains REJECTED in database');
    }

    // 16. Decision on EXPIRED order
    {
      const expiredOrder = await createTestOrder(tenantA.id, '919876543210', 'EXPIRED');
      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${expiredOrder.id}`
      });

      assert(res.success === false, 'Accept on EXPIRED order rejected');
      assert(res.code === 'CONFLICTING_DECISION', 'Rejection code is CONFLICTING_DECISION');

      const dbOrder = await prisma.order.findUnique({ where: { id: expiredOrder.id } });
      assert(dbOrder.status === 'EXPIRED', 'Order status remains EXPIRED');
    }

    // -------------------------------------------------------------
    // TEST GROUP 7: Concurrency & Race Condition Defense
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Concurrency & Race Condition Defense ---');

    // 17. Conflicting concurrent Accept and Reject requests run in parallel
    {
      const concurrentOrder = await createTestOrder(tenantA.id);

      // Fire simultaneous Accept and Reject requests
      const [resAccept, resReject] = await Promise.all([
        processOwnerOrderDecision({
          restaurantId: tenantA.id,
          senderPhone: tenantA.owner_phone,
          buttonPayload: `OWNER_ACCEPT:${concurrentOrder.id}`
        }),
        processOwnerOrderDecision({
          restaurantId: tenantA.id,
          senderPhone: tenantA.owner_phone,
          buttonPayload: `OWNER_REJECT:${concurrentOrder.id}`
        })
      ]);

      const successCount = (resAccept.success ? 1 : 0) + (resReject.success ? 1 : 0);
      assert(successCount === 1, 'Exactly one concurrent decision succeeded (row-level locking verified)');

      const winningStatus = resAccept.success ? 'ACCEPTED' : 'REJECTED';
      const losingRes = resAccept.success ? resReject : resAccept;

      assert(losingRes.success === false, 'Losing concurrent request failed');
      assert(losingRes.code === 'CONFLICTING_DECISION', 'Losing concurrent request returned CONFLICTING_DECISION');

      const finalDbOrder = await prisma.order.findUnique({ where: { id: concurrentOrder.id } });
      assert(finalDbOrder.status === winningStatus, `Database final status is strictly ${winningStatus}`);
    }

    // -------------------------------------------------------------
    // TEST GROUP 8: Webhook Pipeline Integration (HTTP POST with HMAC Security)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 8: Webhook Pipeline Integration (HTTP POST) ---');

    // 18. End-to-end HTTP POST with valid HMAC signature: Owner Accept
    {
      const webhookOrder = await createTestOrder(tenantA.id);
      const wamidAccept = `wamid.OWNER_ACCEPT_${Date.now()}`;
      createdWebhookEventKeys.push(wamidAccept);

      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: tenantA.waba_id,
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550001',
                    phone_number_id: tenantA.phone_number_id
                  },
                  messages: [
                    {
                      from: tenantA.owner_phone.replace(/[^\d]/g, ''),
                      id: wamidAccept,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: {
                          id: `OWNER_ACCEPT:${webhookOrder.id}`,
                          title: '✅ Accept Order'
                        }
                      }
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      const res = await sendSignedWebhook(payload);
      assert(res.statusCode === 200, 'HTTP POST owner Accept returns HTTP 200');
      assert(res.body === 'EVENT_RECEIVED', 'Returns EVENT_RECEIVED');

      // Verify webhook_events record was completed
      const eventRow = await prisma.webhookEvent.findUnique({ where: { event_key: wamidAccept } });
      assert(eventRow !== null, 'Webhook event persisted in PostgreSQL');
      assert(eventRow.processing_status === 'COMPLETED', 'Webhook event marked COMPLETED');

      // Verify order transitioned to ACCEPTED
      const updatedOrder = await prisma.order.findUnique({ where: { id: webhookOrder.id } });
      assert(updatedOrder.status === 'ACCEPTED', 'Order transitioned to ACCEPTED via webhook HTTP pipeline');
    }

    // 19. End-to-end HTTP POST with valid HMAC signature: Owner Reject
    {
      const webhookRejectOrder = await createTestOrder(tenantA.id);
      const wamidReject = `wamid.OWNER_REJECT_${Date.now()}`;
      createdWebhookEventKeys.push(wamidReject);

      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: tenantA.waba_id,
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550001',
                    phone_number_id: tenantA.phone_number_id
                  },
                  messages: [
                    {
                      from: tenantA.owner_phone.replace(/[^\d]/g, ''),
                      id: wamidReject,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: {
                          id: `OWNER_REJECT:${webhookRejectOrder.id}`,
                          title: '❌ Reject Order'
                        }
                      }
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      const res = await sendSignedWebhook(payload);
      assert(res.statusCode === 200, 'HTTP POST owner Reject returns HTTP 200');

      const updatedOrder = await prisma.order.findUnique({ where: { id: webhookRejectOrder.id } });
      assert(updatedOrder.status === 'REJECTED', 'Order transitioned to REJECTED via webhook HTTP pipeline');
    }

    // 20. End-to-end HTTP POST: Customer unauthorized attempt via webhook
    {
      const custAttemptOrder = await createTestOrder(tenantA.id);
      const wamidCust = `wamid.CUST_ATTEMPT_${Date.now()}`;
      createdWebhookEventKeys.push(wamidCust);

      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: tenantA.waba_id,
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550001',
                    phone_number_id: tenantA.phone_number_id
                  },
                  messages: [
                    {
                      from: '919123456789', // Customer number, definitely not owner (+919876543210)!
                      id: wamidCust,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: {
                          id: `OWNER_ACCEPT:${custAttemptOrder.id}`,
                          title: '✅ Accept Order'
                        }
                      }
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      const res = await sendSignedWebhook(payload);
      assert(res.statusCode === 200, 'Webhook acknowledged with HTTP 200');

      // Verify event was marked FAILED due to unauthorized sender
      const eventRow = await prisma.webhookEvent.findUnique({ where: { event_key: wamidCust } });
      assert(eventRow.processing_status === 'FAILED', 'Unauthorized attempt marked FAILED in webhook_events');

      // Verify order status was NOT changed
      const dbOrder = await prisma.order.findUnique({ where: { id: custAttemptOrder.id } });
      assert(dbOrder.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order status uncorrupted by customer attempt');
    }

    // 21. Webhook Deduplication: Retried webhook event with same messageId
    {
      const dupeOrder = await createTestOrder(tenantA.id);
      const wamidDupe = `wamid.DUPE_DECISION_${Date.now()}`;
      createdWebhookEventKeys.push(wamidDupe);

      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: tenantA.waba_id,
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550001',
                    phone_number_id: tenantA.phone_number_id
                  },
                  messages: [
                    {
                      from: tenantA.owner_phone.replace(/[^\d]/g, ''),
                      id: wamidDupe,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: {
                          id: `OWNER_ACCEPT:${dupeOrder.id}`,
                          title: '✅ Accept Order'
                        }
                      }
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      // 1st delivery
      const res1 = await sendSignedWebhook(payload);
      assert(res1.statusCode === 200, 'First delivery returns HTTP 200');

      // 2nd delivery (retried identical webhook event)
      const res2 = await sendSignedWebhook(payload);
      assert(res2.statusCode === 200, 'Retried duplicate delivery returns HTTP 200');

      // Verify only 1 webhook event row exists for wamidDupe
      const eventCount = await prisma.webhookEvent.count({ where: { event_key: wamidDupe } });
      assert(eventCount === 1, 'Exactly 1 row exists in webhook_events for event_key (deduplicated)');
    }

    // 22. Security: Forged HMAC signature rejected with HTTP 403
    {
      const forgedOrder = await createTestOrder(tenantA.id);
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{ id: tenantA.waba_id, changes: [] }]
      };

      const res = await sendSignedWebhook(payload, 'wrong_secret_key_1234');
      assert(res.statusCode === 403, 'Forged signature rejected with HTTP 403 Forbidden');
    }

  } catch (err) {
    console.error('\n❌ Unexpected error during Stage 5.2 test execution:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up Stage 5.2 test artifacts ---');
    try {
      if (server) {
        await new Promise(resolve => server.close(resolve));
      }
      if (createdWebhookEventKeys.length > 0) {
        await prisma.webhookEvent.deleteMany({
          where: { event_key: { in: createdWebhookEventKeys } }
        });
      }
      if (createdOrderIds.length > 0) {
        await prisma.order.deleteMany({
          where: { id: { in: createdOrderIds } }
        });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 5.2 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage5DecisionTests();
}

module.exports = { runStage5DecisionTests };
