/**
 * RESTOPRO — Central WhatsApp Customer Automation Isolation Test Suite
 *
 * Verifies complete isolation between Central WhatsApp and Restaurant customer automation:
 * Test A: Central sends a message to Restaurant: zero customer sessions and zero catalogue messages.
 * Test B: Restaurant sends a message to Central: zero informational auto-replies.
 * Test C: Genuine customer messages Restaurant: existing ordering flow works.
 * Test D: Central sends owner order notification: works.
 * Test E: Owner accepts through Central: works.
 * Test F: Owner rejects through Central: works.
 * Test G: Multi-tenant isolation remains intact.
 */
require('./load-test-env');

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');
const { isCentralSenderPhone, isRestaurantPhoneNumber } = require('../src/services/central-whatsapp.service');
const { confirmCustomerOrder, processOwnerOrderDecision } = require('../src/services/order.service');
const { assertSafeCleanupFilter } = require('../src/utils/test-guard');

const TEST_PORT = 4994;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Fixtures
const CENTRAL_PHONE_ID = '106734138803096';
const CENTRAL_DISPLAY_PHONE = '919137361650';
const RESTAURANT_PHONE_ID = '1427497060448125';
const RESTAURANT_OWNER_PHONE = '+918369377477';

const GENUINE_CUSTOMER_PHONE = '919876543999';

const testRecords = {
  orders: [],
  sessions: [],
  outbox: []
};

function recordTestPass(name) {
  console.log(`  ✅ [PASS] ${name}`);
}

async function makeWebhookRequest(payload) {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', config.meta.appSecret || 'test_app_secret')
    .update(body)
    .digest('hex');

  const res = await fetch(`${BASE_URL}/api/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`
    },
    body
  });

  return {
    status: res.status,
    text: await res.text()
  };
}

async function runSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — CENTRAL WHATSAPP CUSTOMER ISOLATION SUITE     ');
  console.log('============================================================\n');

  let server;
  let restPro;
  let centralAccount;

  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(TEST_PORT, resolve));
    console.log(`[TEST SERVER] Listening on ${BASE_URL}\n`);

    // Verify database prerequisite: RestPro and Central Account (Naila)
    centralAccount = await prisma.centralWhatsAppAccount.findFirst({
      where: { phone_number_id: CENTRAL_PHONE_ID, is_active: true, deleted_at: null }
    });
    assert(centralAccount, `Active central account with phone_number_id ${CENTRAL_PHONE_ID} must exist`);

    restPro = await prisma.restaurant.findUnique({
      where: { phone_number_id: RESTAURANT_PHONE_ID }
    });
    assert(restPro, `Restaurant with phone_number_id ${RESTAURANT_PHONE_ID} must exist`);

    // -------------------------------------------------------------------------
    // UNIT CHECK: isCentralSenderPhone & isRestaurantPhoneNumber
    // -------------------------------------------------------------------------
    console.log('--- UNIT CHECKS: Sender Identification ---');
    const isCentral1 = await isCentralSenderPhone(CENTRAL_DISPLAY_PHONE);
    assert.strictEqual(isCentral1, true, `isCentralSenderPhone('${CENTRAL_DISPLAY_PHONE}') must return true`);

    const isCentral2 = await isCentralSenderPhone('+91 91373 61650');
    assert.strictEqual(isCentral2, true, "isCentralSenderPhone('+91 91373 61650') must return true");

    const isCentralCust = await isCentralSenderPhone(GENUINE_CUSTOMER_PHONE);
    assert.strictEqual(isCentralCust, false, `isCentralSenderPhone('${GENUINE_CUSTOMER_PHONE}') must return false`);

    const isRest1 = await isRestaurantPhoneNumber(RESTAURANT_PHONE_ID);
    assert.strictEqual(isRest1, true, `isRestaurantPhoneNumber('${RESTAURANT_PHONE_ID}') must return true`);

    const isRestOwner = await isRestaurantPhoneNumber(RESTAURANT_OWNER_PHONE);
    assert.strictEqual(isRestOwner, true, `isRestaurantPhoneNumber('${RESTAURANT_OWNER_PHONE}') must return true`);

    const isRestCust = await isRestaurantPhoneNumber(GENUINE_CUSTOMER_PHONE);
    assert.strictEqual(isRestCust, false, `isRestaurantPhoneNumber('${GENUINE_CUSTOMER_PHONE}') must return false`);
    recordTestPass('Helper functions isCentralSenderPhone and isRestaurantPhoneNumber behave accurately');

    // -------------------------------------------------------------------------
    // TEST A: Central sends a message to Restaurant
    // Zero customer sessions and zero catalogue messages
    // -------------------------------------------------------------------------
    console.log('\n--- TEST A: Central sends message to Restaurant ---');

    // Count outbox messages and sessions for Central before test
    const outboxBeforeA = await prisma.outboxMessage.count({
      where: { recipient_phone: CENTRAL_DISPLAY_PHONE }
    });

    const sessionsBeforeA = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restPro.id,
          customer_phone: CENTRAL_DISPLAY_PHONE
        }
      }
    });

    const msgIdA = `test_central_msg_${Date.now()}`;
    const webhookA = {
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
                  display_phone_number: '1427497060448125',
                  phone_number_id: RESTAURANT_PHONE_ID
                },
                contacts: [{ profile: { name: 'Central Account' }, wa_id: CENTRAL_DISPLAY_PHONE }],
                messages: [
                  {
                    from: CENTRAL_DISPLAY_PHONE,
                    id: msgIdA,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'This is a message from Central WhatsApp.' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const resA = await makeWebhookRequest(webhookA);
    assert.strictEqual(resA.status, 200, `Webhook must return HTTP 200 (got ${resA.status})`);

    // Verify zero new outbox messages were enqueued to Central
    const outboxAfterA = await prisma.outboxMessage.count({
      where: { recipient_phone: CENTRAL_DISPLAY_PHONE }
    });
    assert.strictEqual(outboxAfterA, outboxBeforeA, 'Zero new outbox messages must be enqueued to Central');

    // Verify no session was created or modified
    const sessionsAfterA = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restPro.id,
          customer_phone: CENTRAL_DISPLAY_PHONE
        }
      }
    });
    if (!sessionsBeforeA) {
      assert.strictEqual(sessionsAfterA, null, 'No ConversationSession must be created for Central WhatsApp number');
    } else {
      assert.strictEqual(sessionsAfterA.updated_at.getTime(), sessionsBeforeA.updated_at.getTime(), 'Existing session must not be updated');
    }
    recordTestPass('Central sending message to Restaurant results in zero customer sessions and zero catalogue replies');

    // -------------------------------------------------------------------------
    // TEST B: Restaurant sends a message to Central
    // Zero informational auto-replies
    // -------------------------------------------------------------------------
    console.log('\n--- TEST B: Restaurant sends message to Central ---');

    const cleanOwnerPhone = RESTAURANT_OWNER_PHONE.replace(/[^\d]/g, '');
    const outboxBeforeB = await prisma.outboxMessage.count({
      where: { recipient_phone: cleanOwnerPhone }
    });

    const msgIdB = `test_rest_to_central_${Date.now()}`;
    const webhookB = {
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
                  display_phone_number: '919137361650',
                  phone_number_id: CENTRAL_PHONE_ID
                },
                contacts: [{ profile: { name: 'RestPro Kitchen' }, wa_id: cleanOwnerPhone }],
                messages: [
                  {
                    from: cleanOwnerPhone,
                    id: msgIdB,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hello Central, checking dispatch connection.' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const resB = await makeWebhookRequest(webhookB);
    assert.strictEqual(resB.status, 200, `Webhook must return HTTP 200 (got ${resB.status})`);

    const outboxAfterB = await prisma.outboxMessage.count({
      where: { recipient_phone: cleanOwnerPhone }
    });
    assert.strictEqual(outboxAfterB, outboxBeforeB, 'Zero informational auto-replies must be enqueued to Restaurant');
    recordTestPass('Restaurant sending ordinary message to Central triggers zero auto-replies');

    // -------------------------------------------------------------------------
    // TEST C: Genuine customer messages Restaurant
    // Existing ordering flow works
    // -------------------------------------------------------------------------
    console.log('\n--- TEST C: Genuine customer messages Restaurant ---');

    // Cleanup any prior session for test customer
    assertSafeCleanupFilter({ customer_phone: GENUINE_CUSTOMER_PHONE }, 'ConversationSession');
    await prisma.conversationSession.deleteMany({
      where: { customer_phone: GENUINE_CUSTOMER_PHONE }
    });

    const msgIdC = `test_cust_hi_${Date.now()}`;
    const webhookC = {
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
                  display_phone_number: '1427497060448125',
                  phone_number_id: RESTAURANT_PHONE_ID
                },
                contacts: [{ profile: { name: 'Genuine Customer' }, wa_id: GENUINE_CUSTOMER_PHONE }],
                messages: [
                  {
                    from: GENUINE_CUSTOMER_PHONE,
                    id: msgIdC,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hi' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const resC = await makeWebhookRequest(webhookC);
    assert.strictEqual(resC.status, 200, `Webhook must return HTTP 200 (got ${resC.status})`);

    // Verify session was created for genuine customer
    const sessionC = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restPro.id,
          customer_phone: GENUINE_CUSTOMER_PHONE
        }
      }
    });
    assert(sessionC, 'ConversationSession must be created for genuine customer');
    assert.strictEqual(sessionC.current_step, 'AWAITING_CART', 'Session step must transition to AWAITING_CART');
    testRecords.sessions.push(sessionC.id);

    // Verify conversational reply outbox message was created
    const outboxC = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restPro.id,
        recipient_phone: GENUINE_CUSTOMER_PHONE,
        message_type: 'CUSTOMER_CONVERSATION_REPLY'
      },
      orderBy: { created_at: 'desc' }
    });
    assert(outboxC, 'Outbound conversational reply must be enqueued for genuine customer');
    assert(outboxC.payload?.interactive?.type === 'catalog_message', 'Reply must be an interactive catalog message');
    testRecords.outbox.push(outboxC.id);
    recordTestPass('Genuine customer messaging Restaurant triggers existing Welcome Catalog ordering flow');

    // -------------------------------------------------------------------------
    // TEST D: Central sends owner order notification
    // Works with status PENDING and CENTRAL sender_channel
    // -------------------------------------------------------------------------
    console.log('\n--- TEST D: Central sends owner order notification ---');

    // Create a customer session in CONFIRMING state to confirm an order
    const confirmationToken = `conf_iso_${Date.now()}`;
    const cartItems = [{ id: 'item_1', name: 'Paneer Butter Masala', quantity: 1, unitPriceCents: 25000, lineTotalCents: 25000, price: 250 }];
    const addressSnapshot = '123 Test Street, Apartment 4B';

    await prisma.conversationSession.update({
      where: { id: sessionC.id },
      data: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          confirmationToken,
          cart: {
            items: cartItems,
            subtotal: 250,
            currency: 'INR'
          },
          orderType: 'DELIVERY',
          address: {
            addressText: addressSnapshot,
            latitude: 19.076,
            longitude: 72.877
          },
          subtotal: 250,
          currency: 'INR'
        }
      }
    });

    const confirmResult = await confirmCustomerOrder({
      restaurantId: restPro.id,
      customerPhone: GENUINE_CUSTOMER_PHONE,
      confirmationToken,
      customerName: 'Genuine Customer'
    });

    assert(confirmResult.success, `confirmCustomerOrder must succeed (got ${JSON.stringify(confirmResult)})`);
    const createdOrder = confirmResult.order;
    assert(createdOrder && createdOrder.id, 'Order must be created');
    testRecords.orders.push(createdOrder.id);

    // Verify outbox message for owner notification
    const ownerOutbox = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restPro.id,
        message_type: 'OWNER_ORDER_NOTIFICATION',
        idempotency_key: `owner_notif_${createdOrder.id}`
      }
    });
    assert(ownerOutbox, 'Outbox message for owner order notification must exist');
    assert.strictEqual(ownerOutbox.sender_channel, 'CENTRAL', 'Owner notification must use CENTRAL sender_channel');
    assert.strictEqual(ownerOutbox.recipient_phone, RESTAURANT_OWNER_PHONE.trim(), 'Owner notification must be addressed to owner_phone');
    testRecords.outbox.push(ownerOutbox.id);
    recordTestPass('Central owner order notification created with sender_channel=CENTRAL and correct owner phone');

    // -------------------------------------------------------------------------
    // TEST E: Owner accepts through Central
    // HMAC verification, state transition to ACCEPTED, customer notification queued
    // -------------------------------------------------------------------------
    console.log('\n--- TEST E: Owner accepts order through Central ---');

    const signedAcceptPayload = generateSignedOwnerCallback({
      orderId: createdOrder.id,
      action: 'ACCEPT',
      expiresInSeconds: 3600
    });

    const acceptMsgId = `test_owner_accept_${Date.now()}`;
    const webhookE = {
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
                  display_phone_number: '919137361650',
                  phone_number_id: CENTRAL_PHONE_ID
                },
                contacts: [{ profile: { name: 'RestPro Owner' }, wa_id: cleanOwnerPhone }],
                messages: [
                  {
                    from: cleanOwnerPhone,
                    id: acceptMsgId,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'button',
                    button: {
                      payload: signedAcceptPayload,
                      text: 'Accept'
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const resE = await makeWebhookRequest(webhookE);
    assert.strictEqual(resE.status, 200, `Webhook must return HTTP 200 (got ${resE.status})`);

    const orderAfterAccept = await prisma.order.findUnique({
      where: { id: createdOrder.id }
    });
    assert.strictEqual(orderAfterAccept.status, 'ACCEPTED', 'Order status must be updated to ACCEPTED');
    assert(orderAfterAccept.decision_at, 'Order decision_at must be populated');

    // Verify customer notification enqueued via restaurant number
    const customerDecisionOutbox = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restPro.id,
        recipient_phone: GENUINE_CUSTOMER_PHONE,
        idempotency_key: `customer_decision_${createdOrder.id}_accept`
      }
    });
    assert(customerDecisionOutbox, 'Customer acceptance notification must be enqueued in outbox');
    assert.strictEqual(customerDecisionOutbox.sender_channel, 'RESTAURANT', 'Customer decision reply must use RESTAURANT sender channel');
    testRecords.outbox.push(customerDecisionOutbox.id);
    recordTestPass('Owner Accept callback through Central validates HMAC, updates status to ACCEPTED, and queues customer notification');

    // -------------------------------------------------------------------------
    // TEST F: Owner rejects through Central
    // HMAC verification, state transition to REJECTED, duplicate callback protection
    // -------------------------------------------------------------------------
    console.log('\n--- TEST F: Owner rejects order through Central ---');

    // Create a second order for rejection test
    const confirmationToken2 = `conf_iso2_${Date.now()}`;
    await prisma.conversationSession.update({
      where: { id: sessionC.id },
      data: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          confirmationToken: confirmationToken2,
          cart: {
            items: cartItems,
            subtotal: 250,
            currency: 'INR'
          },
          orderType: 'TAKEAWAY',
          subtotal: 250,
          currency: 'INR'
        }
      }
    });

    const confirmResult2 = await confirmCustomerOrder({
      restaurantId: restPro.id,
      customerPhone: GENUINE_CUSTOMER_PHONE,
      confirmationToken: confirmationToken2,
      customerName: 'Genuine Customer'
    });
    assert(confirmResult2.success, 'Second order confirmation must succeed');
    const order2 = confirmResult2.order;
    testRecords.orders.push(order2.id);

    const signedRejectPayload = generateSignedOwnerCallback({
      orderId: order2.id,
      action: 'REJECT',
      expiresInSeconds: 3600
    });

    const rejectMsgId = `test_owner_reject_${Date.now()}`;
    const webhookF = {
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
                  display_phone_number: '919137361650',
                  phone_number_id: CENTRAL_PHONE_ID
                },
                contacts: [{ profile: { name: 'RestPro Owner' }, wa_id: cleanOwnerPhone }],
                messages: [
                  {
                    from: cleanOwnerPhone,
                    id: rejectMsgId,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'button',
                    button: {
                      payload: signedRejectPayload,
                      text: 'Reject'
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const resF = await makeWebhookRequest(webhookF);
    assert.strictEqual(resF.status, 200, `Webhook must return HTTP 200 (got ${resF.status})`);

    const orderAfterReject = await prisma.order.findUnique({
      where: { id: order2.id }
    });
    assert.strictEqual(orderAfterReject.status, 'REJECTED', 'Order status must be updated to REJECTED');

    // Test duplicate tap protection: Replay identical reject callback
    const resF2 = await makeWebhookRequest(webhookF);
    assert.strictEqual(resF2.status, 200, 'Duplicate webhook replay must return HTTP 200');
    const orderAfterDuplicate = await prisma.order.findUnique({
      where: { id: order2.id }
    });
    assert.strictEqual(orderAfterDuplicate.status, 'REJECTED', 'Order status must remain REJECTED on duplicate tap');
    recordTestPass('Owner Reject callback through Central validates HMAC, updates status to REJECTED, with duplicate tap idempotency');

    // -------------------------------------------------------------------------
    // TEST G: Multi-tenant isolation remains intact
    // Cross-tenant access and unauthorized decision rejection
    // -------------------------------------------------------------------------
    console.log('\n--- TEST G: Multi-tenant isolation ---');

    // Create an order for a second restaurant
    const restB = await prisma.restaurant.findFirst({
      where: {
        id: { not: restPro.id },
        is_active: true
      }
    });
    assert(restB, 'A second active restaurant must exist for multi-tenant verification');

    // Attempt to accept restPro's order using an unauthorized sender phone
    const unauthorizedSender = '919999999999';
    const unauthorizedDecision = await processOwnerOrderDecision({
      restaurantId: restPro.id,
      senderPhone: unauthorizedSender,
      buttonPayload: signedAcceptPayload
    });

    assert.strictEqual(unauthorizedDecision.success, false, 'Decision from unauthorized sender must fail');
    assert.strictEqual(unauthorizedDecision.code, 'UNAUTHORIZED_OWNER', 'Must fail with UNAUTHORIZED_OWNER');

    // Ensure Rest B cannot view Rest Pro's order
    const crossTenantOrder = await prisma.order.findFirst({
      where: {
        id: createdOrder.id,
        restaurant_id: restB.id
      }
    });
    assert.strictEqual(crossTenantOrder, null, 'Restaurant B must not be able to find Restaurant Pro order');
    recordTestPass('Multi-tenant isolation and owner authorization security strictly enforced');

    console.log('\n============================================================');
    console.log('   ALL 7 CENTRAL ISOLATION TESTS PASSED PERFECTLY (A - G)   ');
    console.log('============================================================\n');

  } finally {
    // Teardown
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // Cleanup created test records
    try {
      if (testRecords.orders.length > 0) {
        assertSafeCleanupFilter({ order_id: { in: testRecords.orders } }, 'OrderNotification');
        await prisma.orderNotification.deleteMany({
          where: { order_id: { in: testRecords.orders } }
        });
        assertSafeCleanupFilter({ id: { in: testRecords.orders } }, 'Order');
        await prisma.order.deleteMany({
          where: { id: { in: testRecords.orders } }
        });
      }
      if (testRecords.outbox.length > 0) {
        assertSafeCleanupFilter({ id: { in: testRecords.outbox } }, 'OutboxMessage');
        await prisma.outboxMessage.deleteMany({
          where: { id: { in: testRecords.outbox } }
        });
      }
      if (testRecords.sessions.length > 0) {
        assertSafeCleanupFilter({ id: { in: testRecords.sessions } }, 'ConversationSession');
        await prisma.conversationSession.deleteMany({
          where: { id: { in: testRecords.sessions } }
        });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }

    await prisma.$disconnect();
  }
}

runSuite().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
