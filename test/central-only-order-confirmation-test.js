/**
 * RESTOPRO — Central-Only Order Confirmation Architecture End-to-End Test Suite
 *
 * Verifies the exact 4-phase central-only ordering and confirmation architecture:
 * Phase A: Customer PQR <-> Restaurant ABC (catalogue, cart, address, confirm).
 *          ABC sends initial pending acknowledgement to PQR.
 * Phase B: Order persisted in PostgreSQL. Central XYZ sends complete order summary
 *          with interactive Accept/Reject buttons to restaurant owner via Central WhatsApp.
 *          ABC never sends owner confirmation request.
 * Phase C: Owner clicks Accept/Reject on Central XYZ. Webhook verifies signed HMAC
 *          and sender authorization, updating order transactionally.
 * Phase D: Central XYZ sends final Accepted/Rejected notification to Customer PQR.
 *          ABC never sends final confirmation.
 * Multi-Tenant: Concurrent multi-restaurant routing through Central XYZ with strict cross-tenant rejection.
 * Legacy Removal: Restaurant ABC strictly rejects any direct owner decision callbacks.
 */

const assert = require('assert');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');
const { setTemplateApprovalForTesting, resetTemplateApprovalsForTesting } = require('../src/services/template-config.service');

const TEST_PORT = 4991;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Test fixtures tracking
const CUSTOMER_PQR = '919876611001';
const CUSTOMER_2 = '919876611002';
const CUSTOMER_3 = '919876611003';
const CUSTOMER_4 = '919876611004';
const CUSTOMER_5 = '919876611005';
const TEST_PHONES = [CUSTOMER_PQR, CUSTOMER_2, CUSTOMER_3, CUSTOMER_4, CUSTOMER_5];

const createdOrderIds = [];
const createdSessionIds = [];
const createdOutboxIds = [];

function recordTestPass(name) {
  console.log(`  ✅ [PASS] ${name}`);
}

async function makeWebhookRequest(payload) {
  const body = JSON.stringify(payload);
  const crypto = require('crypto');
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
  console.log('   RESTOPRO — CENTRAL-ONLY ORDER CONFIRMATION ARCHITECTURE  ');
  console.log('============================================================\n');

  let server;
  let restA, restB;
  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(TEST_PORT, resolve));
    console.log(`[TEST SERVER] Listening on ${BASE_URL}\n`);

    // Ensure environment is set to CENTRAL
    process.env.NOTIFICATION_ROUTING_MODE = 'CENTRAL';
    config.routingMode = 'CENTRAL';

    // Ensure templates are marked approved for E2E testing
    setTemplateApprovalForTesting('restopro_order_alert', 'APPROVED');
    setTemplateApprovalForTesting('restopro_customer_order_accepted', 'APPROVED');
    setTemplateApprovalForTesting('restopro_customer_order_rejected', 'APPROVED');

    // Verify Central WhatsApp Account (XYZ) exists
    const centralAccount = await prisma.centralWhatsAppAccount.findFirst({
      where: { is_active: true, deleted_at: null }
    });
    assert(centralAccount, 'Active Central WhatsApp account must exist in database');
    const XYZ_PHONE_ID = centralAccount.phone_number_id; // e.g. 106734138803096 (Naila)
    console.log(`[SETUP] Central WhatsApp Account XYZ: "${centralAccount.account_name}" (${XYZ_PHONE_ID})`);

    // Retrieve genuine test restaurants
    restA = await prisma.restaurant.findUnique({
      where: { id: 'a0000000-0000-0000-0000-000000000001' }
    });
    restB = await prisma.restaurant.findUnique({
      where: { id: 'b0000000-0000-0000-0000-000000000002' }
    });
    assert(restA && restB, 'Test restaurants A and B must exist');

    const ABC_PHONE_ID = restA.phone_number_id; // 111111111111111
    const DEF_PHONE_ID = restB.phone_number_id; // 222222222222222
    const OWNER_A_PHONE = restA.owner_phone;    // +919876543210
    const OWNER_B_PHONE = restB.owner_phone;    // +919811122233

    // Pre-test cleanup of test phones to ensure clean slate
    await prisma.outboxMessage.deleteMany({
      where: {
        restaurant_id: { in: [restA.id, restB.id] },
        recipient_phone: { in: TEST_PHONES }
      }
    }).catch(() => {});

    // -------------------------------------------------------------------------
    // TEST 1: COMPLETE END-TO-END ACCEPT FLOW
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Full Customer Order & Central Owner ACCEPT Flow ---');

    // Phase A: Customer PQR completes order on Restaurant ABC
    // Set up conversation session awaiting confirmation
    const confToken1 = 'test_conf_token_accept_' + Date.now();
    const session1 = await prisma.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restA.id,
          customer_phone: CUSTOMER_PQR
        }
      },
      update: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Madi',
          cart: {
            items: [{ productRetailerId: 'item_1', productName: 'Chicken Dum Biryani', quantity: 2, item_price: 250, currency: 'INR' }],
            subtotal: 500,
            currency: 'INR'
          },
          orderType: 'DELIVERY',
          address: { addressText: '42 Baker Street, Mumbai' },
          confirmationToken: confToken1
        },
        expires_at: new Date(Date.now() + 3600000)
      },
      create: {
        restaurant_id: restA.id,
        customer_phone: CUSTOMER_PQR,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Madi',
          cart: {
            items: [{ productRetailerId: 'item_1', productName: 'Chicken Dum Biryani', quantity: 2, item_price: 250, currency: 'INR' }],
            subtotal: 500,
            currency: 'INR'
          },
          orderType: 'DELIVERY',
          address: { addressText: '42 Baker Street, Mumbai' },
          confirmationToken: confToken1
        },
        expires_at: new Date(Date.now() + 3600000)
      }
    });
    createdSessionIds.push(session1.id);

    // Customer clicks Confirm Order button on Restaurant ABC
    const confirmWebhookA = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: restA.waba_id,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '919876543210',
                  phone_number_id: ABC_PHONE_ID
                },
                contacts: [{ profile: { name: 'Madi' }, wa_id: CUSTOMER_PQR }],
                messages: [
                  {
                    from: CUSTOMER_PQR,
                    id: `wamid_confirm_${Date.now()}`,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: {
                        id: `BTN_CONFIRM_ORDER:${confToken1}`,
                        title: 'Confirm Order'
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

    const webhookRes1 = await makeWebhookRequest(confirmWebhookA);
    assert.strictEqual(webhookRes1.status, 200, 'Webhook response must be HTTP 200');

    // 1. Verify: Order created in PostgreSQL with status PENDING_RESTAURANT_CONFIRMATION
    const order1 = await prisma.order.findFirst({
      where: {
        restaurant_id: restA.id,
        customer_phone: CUSTOMER_PQR
      },
      orderBy: { created_at: 'desc' }
    });
    assert(order1, 'Order must be created in PostgreSQL');
    createdOrderIds.push(order1.id);
    assert.strictEqual(order1.status, 'PENDING_RESTAURANT_CONFIRMATION', 'Order status must be PENDING_RESTAURANT_CONFIRMATION');
    recordTestPass('Order created in database with status PENDING_RESTAURANT_CONFIRMATION');

    // 2. Verify: Restaurant ABC sends initial pending acknowledgement to Customer PQR
    const customerAckOutbox = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        recipient_phone: CUSTOMER_PQR,
        sender_channel: 'RESTAURANT'
      },
      orderBy: { created_at: 'desc' }
    });
    assert(customerAckOutbox, 'Restaurant ABC must enqueue pending acknowledgement to Customer PQR');
    assert.strictEqual(customerAckOutbox.sender_channel, 'RESTAURANT', 'Initial acknowledgement MUST originate from Restaurant ABC');
    assert(customerAckOutbox.payload?.text?.body.includes('waiting for restaurant confirmation'),
      'Acknowledgement text must contain "waiting for restaurant confirmation"');
    recordTestPass('Restaurant ABC sends initial pending acknowledgement to customer PQR');

    // 3. Verify: Central XYZ sends complete order summary to Restaurant A Owner
    const ownerOutboxCentral = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `owner_notif_${order1.id}`,
        sender_channel: 'CENTRAL',
        message_type: 'OWNER_ORDER_NOTIFICATION'
      },
      orderBy: { created_at: 'desc' }
    });
    assert(ownerOutboxCentral, 'Central XYZ must enqueue owner order notification');
    assert.strictEqual(ownerOutboxCentral.sender_channel, 'CENTRAL', 'Owner order alert MUST originate from CENTRAL (XYZ)');
    assert(
      ownerOutboxCentral.recipient_phone === OWNER_A_PHONE ||
      ownerOutboxCentral.recipient_phone === OWNER_A_PHONE.replace(/[^\d]/g, ''),
      'Recipient phone must match restaurant owner phone'
    );
    
    // 4. Verify all required fields in Central payload
    const tmplComponents = ownerOutboxCentral.payload?.template?.components || [];
    const bodyComp = tmplComponents.find(c => c.type === 'body');
    assert(bodyComp && bodyComp.parameters.length >= 5, 'Template body must have at least 5 parameters');
    const paramTexts = bodyComp.parameters.map(p => p.text);
    assert(paramTexts.some(t => t.includes(restA.name)), 'Must contain restaurant name');
    assert(paramTexts.some(t => t.includes(order1.order_reference)), 'Must contain order reference ID');
    assert(paramTexts.some(t => t.includes('Chicken Dum Biryani')), 'Must contain ordered items & quantities');
    assert(paramTexts.some(t => t.includes('500.00')), 'Must contain total amount');
    assert(paramTexts.some(t => t.includes('Madi') && t.includes(CUSTOMER_PQR)), 'Must contain customer name & phone');
    assert(paramTexts.some(t => t.includes('42 Baker Street')), 'Must contain delivery address');

    // Verify Accept and Reject buttons exist with signed HMAC callbacks
    const btnComponents = tmplComponents.filter(c => c.type === 'button');
    assert.strictEqual(btnComponents.length, 2, 'Must have 2 interactive quick reply buttons');
    const acceptPayload = btnComponents[0].parameters[0].payload;
    const rejectPayload = btnComponents[1].parameters[0].payload;
    assert(acceptPayload.startsWith('OWNER_ACCEPT:'), 'Button 0 must be OWNER_ACCEPT');
    assert(rejectPayload.startsWith('OWNER_REJECT:'), 'Button 1 must be OWNER_REJECT');
    recordTestPass('Central XYZ payload contains complete order summary with Accept/Reject buttons');

    // 5. Verify: Restaurant ABC did NOT send an owner confirmation request
    const illegalOwnerOutboxABC = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        sender_channel: 'RESTAURANT',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        idempotency_key: `owner_notif_${order1.id}`
      }
    });
    assert.strictEqual(illegalOwnerOutboxABC, null, 'Restaurant ABC must NEVER send an owner confirmation request');
    recordTestPass('Restaurant ABC strictly prohibited from sending owner confirmation request');

    // Phase C: Owner clicks Accept in Central XYZ inbox
    console.log('\n--- Phase C & D: Owner Clicks ACCEPT in Central XYZ Inbox ---');
    const ownerAcceptWebhookXYZ = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: centralAccount.waba_id,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: centralAccount.display_phone_number || '919137361650',
                  phone_number_id: XYZ_PHONE_ID // Received on Central Number!
                },
                contacts: [{ profile: { name: 'Owner A' }, wa_id: OWNER_A_PHONE.replace(/[^\d]/g, '') }],
                messages: [
                  {
                    from: OWNER_A_PHONE.replace(/[^\d]/g, ''),
                    id: `wamid_owner_accept_${Date.now()}`,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: {
                        id: acceptPayload,
                        title: 'Accept'
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

    const webhookResAccept = await makeWebhookRequest(ownerAcceptWebhookXYZ);
    assert.strictEqual(webhookResAccept.status, 200, 'Central webhook response must be HTTP 200');

    // 6. Verify: Database order status becomes ACCEPTED
    const updatedOrder1 = await prisma.order.findUnique({
      where: { id: order1.id }
    });
    assert.strictEqual(updatedOrder1.status, 'ACCEPTED', 'Order status in PostgreSQL must transition to ACCEPTED');
    assert(updatedOrder1.decision_at !== null, 'decision_at must be populated');
    recordTestPass('Order status transitioned to ACCEPTED in PostgreSQL');

    // 7. Verify: Central XYZ sends final Accepted confirmation to Customer PQR
    const customerAcceptedOutbox = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        recipient_phone: CUSTOMER_PQR,
        sender_channel: 'CENTRAL',
        message_type: 'CUSTOMER_ORDER_DECISION'
      },
      orderBy: { created_at: 'desc' }
    });
    assert(customerAcceptedOutbox, 'Central XYZ must enqueue customer accepted notification');
    assert.strictEqual(customerAcceptedOutbox.sender_channel, 'CENTRAL', 'Final decision MUST originate from CENTRAL (XYZ)');
    assert.strictEqual(customerAcceptedOutbox.payload?.template?.name, 'restopro_customer_order_accepted',
      'Must use restopro_customer_order_accepted Meta template');
    recordTestPass('Central XYZ sends final Accepted notification to Customer PQR');

    // 8. Verify: Restaurant ABC did NOT send any final confirmation
    const illegalCustomerFinalABC = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        recipient_phone: CUSTOMER_PQR,
        sender_channel: 'RESTAURANT',
        message_type: 'CUSTOMER_ORDER_DECISION'
      }
    });
    assert.strictEqual(illegalCustomerFinalABC, null, 'Restaurant ABC must NEVER send the final customer decision');
    recordTestPass('Restaurant ABC strictly prohibited from sending final confirmation');

    // -------------------------------------------------------------------------
    // TEST 2: COMPLETE END-TO-END REJECT FLOW
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Full Customer Order & Central Owner REJECT Flow ---');

    const confToken2 = 'test_conf_token_reject_' + Date.now();
    const session2 = await prisma.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restA.id,
          customer_phone: CUSTOMER_2
        }
      },
      update: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Ayaan',
          cart: {
            items: [{ productRetailerId: 'item_2', productName: 'Paneer Butter Masala', quantity: 1, item_price: 220, currency: 'INR' }],
            subtotal: 220,
            currency: 'INR'
          },
          orderType: 'TAKEAWAY',
          confirmationToken: confToken2
        },
        expires_at: new Date(Date.now() + 3600000)
      },
      create: {
        restaurant_id: restA.id,
        customer_phone: CUSTOMER_2,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Ayaan',
          cart: {
            items: [{ productRetailerId: 'item_2', productName: 'Paneer Butter Masala', quantity: 1, item_price: 220, currency: 'INR' }],
            subtotal: 220,
            currency: 'INR'
          },
          orderType: 'TAKEAWAY',
          confirmationToken: confToken2
        },
        expires_at: new Date(Date.now() + 3600000)
      }
    });
    createdSessionIds.push(session2.id);

    // Customer places order on Restaurant ABC
    const confirmWebhook2 = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: restA.waba_id,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '919876543210',
                  phone_number_id: ABC_PHONE_ID
                },
                contacts: [{ profile: { name: 'Ayaan' }, wa_id: CUSTOMER_2 }],
                messages: [
                  {
                    from: CUSTOMER_2,
                    id: `wamid_confirm2_${Date.now()}`,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: {
                        id: `BTN_CONFIRM_ORDER:${confToken2}`,
                        title: 'Confirm Order'
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
    await makeWebhookRequest(confirmWebhook2);

    const order2 = await prisma.order.findFirst({
      where: {
        restaurant_id: restA.id,
        customer_phone: CUSTOMER_2
      },
      orderBy: { created_at: 'desc' }
    });
    assert(order2, 'Order 2 must exist');
    createdOrderIds.push(order2.id);

    // Retrieve Reject callback payload from Central outbox
    const ownerOutbox2 = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `owner_notif_${order2.id}`,
        sender_channel: 'CENTRAL'
      }
    });
    assert(ownerOutbox2, 'Owner notification must be in CENTRAL outbox');
    const rejectBtnPayload = ownerOutbox2.payload?.template?.components
      ?.find(c => c.type === 'button' && c.parameters[0].payload.startsWith('OWNER_REJECT:'))
      ?.parameters[0].payload;
    assert(rejectBtnPayload, 'Reject button payload must exist');

    // Owner clicks Reject in Central XYZ inbox
    const ownerRejectWebhookXYZ = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: centralAccount.waba_id,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: centralAccount.display_phone_number || '919137361650',
                  phone_number_id: XYZ_PHONE_ID
                },
                contacts: [{ profile: { name: 'Owner A' }, wa_id: OWNER_A_PHONE.replace(/[^\d]/g, '') }],
                messages: [
                  {
                    from: OWNER_A_PHONE.replace(/[^\d]/g, ''),
                    id: `wamid_owner_reject_${Date.now()}`,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: {
                        id: rejectBtnPayload,
                        title: 'Reject'
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

    const webhookResReject = await makeWebhookRequest(ownerRejectWebhookXYZ);
    assert.strictEqual(webhookResReject.status, 200, 'Central webhook response must be HTTP 200');

    // Verify order 2 transitioned to REJECTED
    const updatedOrder2 = await prisma.order.findUnique({ where: { id: order2.id } });
    assert.strictEqual(updatedOrder2.status, 'REJECTED', 'Order status must be REJECTED');
    recordTestPass('Order status transitioned to REJECTED in PostgreSQL');

    // Verify Central XYZ sends restopro_customer_order_rejected
    const customerRejectedOutbox = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        recipient_phone: CUSTOMER_2,
        sender_channel: 'CENTRAL',
        message_type: 'CUSTOMER_ORDER_DECISION'
      },
      orderBy: { created_at: 'desc' }
    });
    assert(customerRejectedOutbox, 'Central XYZ must enqueue customer rejected notification');
    assert.strictEqual(customerRejectedOutbox.payload?.template?.name, 'restopro_customer_order_rejected');
    recordTestPass('Central XYZ sends final Rejected notification to Customer');

    // -------------------------------------------------------------------------
    // TEST 3: MULTI-TENANT SIMULTANEOUS ROUTING & CROSS-TENANT ISOLATION
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Multi-Tenant Simultaneous Routing & Isolation ---');

    // Customer 3 orders from Restaurant A (ABC)
    const confToken3A = 'test_token_3a_' + Date.now();
    const session3A = await prisma.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restA.id,
          customer_phone: '919876611003'
        }
      },
      update: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Tenant A Customer',
          cart: {
            items: [{ productRetailerId: 'item_3a', productName: 'Biryani A', quantity: 1, item_price: 300, currency: 'INR' }],
            subtotal: 300,
            currency: 'INR'
          },
          orderType: 'DELIVERY',
          address: { addressText: 'Tenant A Address' },
          confirmationToken: confToken3A
        },
        expires_at: new Date(Date.now() + 3600000)
      },
      create: {
        restaurant_id: restA.id,
        customer_phone: '919876611003',
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Tenant A Customer',
          cart: {
            items: [{ productRetailerId: 'item_3a', productName: 'Biryani A', quantity: 1, item_price: 300, currency: 'INR' }],
            subtotal: 300,
            currency: 'INR'
          },
          orderType: 'DELIVERY',
          address: { addressText: 'Tenant A Address' },
          confirmationToken: confToken3A
        },
        expires_at: new Date(Date.now() + 3600000)
      }
    });
    createdSessionIds.push(session3A.id);

    // Customer 4 orders from Restaurant B (DEF)
    const confToken3B = 'test_token_3b_' + Date.now();
    const session3B = await prisma.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restB.id,
          customer_phone: '919876611004'
        }
      },
      update: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Tenant B Customer',
          cart: {
            items: [{ productRetailerId: 'item_3b', productName: 'Pasta B', quantity: 1, item_price: 400, currency: 'INR' }],
            subtotal: 400,
            currency: 'INR'
          },
          orderType: 'DELIVERY',
          address: { addressText: 'Tenant B Address' },
          confirmationToken: confToken3B
        },
        expires_at: new Date(Date.now() + 3600000)
      },
      create: {
        restaurant_id: restB.id,
        customer_phone: '919876611004',
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Tenant B Customer',
          cart: {
            items: [{ productRetailerId: 'item_3b', productName: 'Pasta B', quantity: 1, item_price: 400, currency: 'INR' }],
            subtotal: 400,
            currency: 'INR'
          },
          orderType: 'DELIVERY',
          address: { addressText: 'Tenant B Address' },
          confirmationToken: confToken3B
        },
        expires_at: new Date(Date.now() + 3600000)
      }
    });
    createdSessionIds.push(session3B.id);

    // Place both orders simultaneously
    await Promise.all([
      makeWebhookRequest({
        object: 'whatsapp_business_account',
        entry: [{
          id: restA.waba_id,
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919876543210', phone_number_id: ABC_PHONE_ID },
              contacts: [{ profile: { name: 'Tenant A Customer' }, wa_id: '919876611003' }],
              messages: [{
                from: '919876611003',
                id: `wamid_sim_a_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: 'interactive',
                interactive: { type: 'button_reply', button_reply: { id: `BTN_CONFIRM_ORDER:${confToken3A}`, title: 'Confirm' } }
              }]
            },
            field: 'messages'
          }]
        }]
      }),
      makeWebhookRequest({
        object: 'whatsapp_business_account',
        entry: [{
          id: restB.waba_id,
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919811122233', phone_number_id: DEF_PHONE_ID },
              contacts: [{ profile: { name: 'Tenant B Customer' }, wa_id: '919876611004' }],
              messages: [{
                from: '919876611004',
                id: `wamid_sim_b_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: 'interactive',
                interactive: { type: 'button_reply', button_reply: { id: `BTN_CONFIRM_ORDER:${confToken3B}`, title: 'Confirm' } }
              }]
            },
            field: 'messages'
          }]
        }]
      })
    ]);

    const orderA = await prisma.order.findFirst({
      where: { restaurant_id: restA.id, customer_phone: '919876611003' },
      orderBy: { created_at: 'desc' }
    });
    const orderB = await prisma.order.findFirst({
      where: { restaurant_id: restB.id, customer_phone: '919876611004' },
      orderBy: { created_at: 'desc' }
    });
    assert(orderA && orderB, 'Both orders A and B must exist');
    createdOrderIds.push(orderA.id, orderB.id);

    // Retrieve button callbacks
    const outboxA = await prisma.outboxMessage.findFirst({
      where: { restaurant_id: restA.id, idempotency_key: `owner_notif_${orderA.id}` }
    });
    const outboxB = await prisma.outboxMessage.findFirst({
      where: { restaurant_id: restB.id, idempotency_key: `owner_notif_${orderB.id}` }
    });
    const acceptPayloadA = outboxA.payload.template.components[1].parameters[0].payload;
    const acceptPayloadB = outboxB.payload.template.components[1].parameters[0].payload;

    // CROSS-TENANT ATTEMPT 1: Owner B tries to accept Order A on Central XYZ
    console.log('Testing cross-tenant rejection: Owner B attempts to accept Order A...');
    const crossTenantRes1 = await makeWebhookRequest({
      object: 'whatsapp_business_account',
      entry: [{
        id: centralAccount.waba_id,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: centralAccount.display_phone_number, phone_number_id: XYZ_PHONE_ID },
            contacts: [{ profile: { name: 'Owner B' }, wa_id: OWNER_B_PHONE.replace(/[^\d]/g, '') }],
            messages: [{
              from: OWNER_B_PHONE.replace(/[^\d]/g, ''),
              id: `wamid_hack_a_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: acceptPayloadA, title: 'Accept' } }
            }]
          },
          field: 'messages'
        }]
      }]
    });
    assert.strictEqual(crossTenantRes1.status, 200);
    // Order A must STILL be PENDING
    const checkOrderA = await prisma.order.findUnique({ where: { id: orderA.id } });
    assert.strictEqual(checkOrderA.status, 'PENDING_RESTAURANT_CONFIRMATION', 'Order A must NOT be accepted by Owner B');
    recordTestPass('Cross-tenant attack rejected: Owner B cannot accept Order A');

    // CROSS-TENANT ATTEMPT 2: Owner A tries to accept Order B on Central XYZ
    console.log('Testing cross-tenant rejection: Owner A attempts to accept Order B...');
    const crossTenantRes2 = await makeWebhookRequest({
      object: 'whatsapp_business_account',
      entry: [{
        id: centralAccount.waba_id,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: centralAccount.display_phone_number, phone_number_id: XYZ_PHONE_ID },
            contacts: [{ profile: { name: 'Owner A' }, wa_id: OWNER_A_PHONE.replace(/[^\d]/g, '') }],
            messages: [{
              from: OWNER_A_PHONE.replace(/[^\d]/g, ''),
              id: `wamid_hack_b_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: acceptPayloadB, title: 'Accept' } }
            }]
          },
          field: 'messages'
        }]
      }]
    });
    assert.strictEqual(crossTenantRes2.status, 200);
    // Order B must STILL be PENDING
    const checkOrderB = await prisma.order.findUnique({ where: { id: orderB.id } });
    assert.strictEqual(checkOrderB.status, 'PENDING_RESTAURANT_CONFIRMATION', 'Order B must NOT be accepted by Owner A');
    recordTestPass('Cross-tenant attack rejected: Owner A cannot accept Order B');

    // Legitimate owner decisions: Owner A accepts Order A, Owner B accepts Order B
    await Promise.all([
      makeWebhookRequest({
        object: 'whatsapp_business_account',
        entry: [{
          id: centralAccount.waba_id,
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: centralAccount.display_phone_number, phone_number_id: XYZ_PHONE_ID },
              contacts: [{ profile: { name: 'Owner A' }, wa_id: OWNER_A_PHONE.replace(/[^\d]/g, '') }],
              messages: [{
                from: OWNER_A_PHONE.replace(/[^\d]/g, ''),
                id: `wamid_ok_a_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: 'interactive',
                interactive: { type: 'button_reply', button_reply: { id: acceptPayloadA, title: 'Accept' } }
              }]
            },
            field: 'messages'
          }]
        }]
      }),
      makeWebhookRequest({
        object: 'whatsapp_business_account',
        entry: [{
          id: centralAccount.waba_id,
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: centralAccount.display_phone_number, phone_number_id: XYZ_PHONE_ID },
              contacts: [{ profile: { name: 'Owner B' }, wa_id: OWNER_B_PHONE.replace(/[^\d]/g, '') }],
              messages: [{
                from: OWNER_B_PHONE.replace(/[^\d]/g, ''),
                id: `wamid_ok_b_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: 'interactive',
                interactive: { type: 'button_reply', button_reply: { id: acceptPayloadB, title: 'Accept' } }
              }]
            },
            field: 'messages'
          }]
        }]
      })
    ]);

    const finalOrderA = await prisma.order.findUnique({ where: { id: orderA.id } });
    const finalOrderB = await prisma.order.findUnique({ where: { id: orderB.id } });
    assert.strictEqual(finalOrderA.status, 'ACCEPTED', 'Order A must be ACCEPTED by Owner A');
    assert.strictEqual(finalOrderB.status, 'ACCEPTED', 'Order B must be ACCEPTED by Owner B');
    recordTestPass('Simultaneous multi-restaurant orders cleanly accepted by their respective owners');

    // -------------------------------------------------------------------------
    // TEST 4: LEGACY RESTAURANT-NUMBER ACCEPT/REJECT REJECTION
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Strict Rejection of Legacy Restaurant-Number Decision Callbacks ---');

    // Create fresh order on Restaurant A
    const confToken4 = 'test_token_4_' + Date.now();
    const session4 = await prisma.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restA.id,
          customer_phone: '919876611005'
        }
      },
      update: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Legacy Test Customer',
          cart: {
            items: [{ productRetailerId: 'item_4', productName: 'Dal Makhani', quantity: 1, item_price: 180, currency: 'INR' }],
            subtotal: 180,
            currency: 'INR'
          },
          orderType: 'TAKEAWAY',
          confirmationToken: confToken4
        },
        expires_at: new Date(Date.now() + 3600000)
      },
      create: {
        restaurant_id: restA.id,
        customer_phone: '919876611005',
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          customerName: 'Legacy Test Customer',
          cart: {
            items: [{ productRetailerId: 'item_4', productName: 'Dal Makhani', quantity: 1, item_price: 180, currency: 'INR' }],
            subtotal: 180,
            currency: 'INR'
          },
          orderType: 'TAKEAWAY',
          confirmationToken: confToken4
        },
        expires_at: new Date(Date.now() + 3600000)
      }
    });
    createdSessionIds.push(session4.id);

    await makeWebhookRequest({
      object: 'whatsapp_business_account',
      entry: [{
        id: restA.waba_id,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '919876543210', phone_number_id: ABC_PHONE_ID },
            contacts: [{ profile: { name: 'Legacy Test Customer' }, wa_id: '919876611005' }],
            messages: [{
              from: '919876611005',
              id: `wamid_leg_order_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: `BTN_CONFIRM_ORDER:${confToken4}`, title: 'Confirm' } }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    const order4 = await prisma.order.findFirst({
      where: { restaurant_id: restA.id, customer_phone: '919876611005' },
      orderBy: { created_at: 'desc' }
    });
    assert(order4, 'Order 4 must exist');
    createdOrderIds.push(order4.id);

    // Generate signed callback for Order 4
    const signedAccept4 = generateSignedOwnerCallback({ orderId: order4.id, action: 'ACCEPT' });

    // Send owner callback to RESTAURANT ABC phone number ID (simulating legacy callback)
    const legacyCallbackRes = await makeWebhookRequest({
      object: 'whatsapp_business_account',
      entry: [{
        id: restA.waba_id,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '919876543210', phone_number_id: ABC_PHONE_ID }, // RESTAURANT NUMBER ABC
            contacts: [{ profile: { name: 'Owner A' }, wa_id: OWNER_A_PHONE.replace(/[^\d]/g, '') }],
            messages: [{
              from: OWNER_A_PHONE.replace(/[^\d]/g, ''),
              id: `wamid_leg_callback_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: signedAccept4, title: 'Accept' } }
            }]
          },
          field: 'messages'
        }]
      }]
    });
    assert.strictEqual(legacyCallbackRes.status, 200);

    // Verify order 4 was NOT changed (remains PENDING_RESTAURANT_CONFIRMATION)
    const checkOrder4 = await prisma.order.findUnique({ where: { id: order4.id } });
    assert.strictEqual(checkOrder4.status, 'PENDING_RESTAURANT_CONFIRMATION',
      'Owner decisions sent to restaurant number ABC must be strictly rejected');
    recordTestPass('Owner decision delivered to restaurant number ABC strictly rejected');

    // -------------------------------------------------------------------------
    // TEST 5: TAMPERED SIGNATURE REJECTION ON CENTRAL WEBHOOK
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Tampered Signature Rejection on Central Webhook ---');
    const tamperedPayload = signedAccept4.slice(0, -4) + 'FFFF';

    await makeWebhookRequest({
      object: 'whatsapp_business_account',
      entry: [{
        id: centralAccount.waba_id,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: centralAccount.display_phone_number, phone_number_id: XYZ_PHONE_ID },
            contacts: [{ profile: { name: 'Owner A' }, wa_id: OWNER_A_PHONE.replace(/[^\d]/g, '') }],
            messages: [{
              from: OWNER_A_PHONE.replace(/[^\d]/g, ''),
              id: `wamid_tamper_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: tamperedPayload, title: 'Accept' } }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    const checkOrderTampered = await prisma.order.findUnique({ where: { id: order4.id } });
    assert.strictEqual(checkOrderTampered.status, 'PENDING_RESTAURANT_CONFIRMATION',
      'Tampered signature must not transition order status');
    recordTestPass('Tampered HMAC callback strictly rejected with zero order state change');

    // -------------------------------------------------------------------------
    // TEST 6: DUPLICATE DECISION PROTECTION ON CENTRAL WEBHOOK
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: Duplicate Decision Protection on Central Webhook ---');

    // Now accept Order 4 validly on Central XYZ
    await makeWebhookRequest({
      object: 'whatsapp_business_account',
      entry: [{
        id: centralAccount.waba_id,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: centralAccount.display_phone_number, phone_number_id: XYZ_PHONE_ID },
            contacts: [{ profile: { name: 'Owner A' }, wa_id: OWNER_A_PHONE.replace(/[^\d]/g, '') }],
            messages: [{
              from: OWNER_A_PHONE.replace(/[^\d]/g, ''),
              id: `wamid_legit_a4_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: signedAccept4, title: 'Accept' } }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    const order4Accepted = await prisma.order.findUnique({ where: { id: order4.id } });
    assert.strictEqual(order4Accepted.status, 'ACCEPTED');

    const customerOutboxCountBefore = await prisma.outboxMessage.count({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `customer_decision_${order4.id}_accept`,
        message_type: 'CUSTOMER_ORDER_DECISION'
      }
    });
    assert.strictEqual(customerOutboxCountBefore, 1, 'Exactly 1 customer decision outbox message must exist for order 4');

    // Replay the exact same accept callback (duplicate click)
    await makeWebhookRequest({
      object: 'whatsapp_business_account',
      entry: [{
        id: centralAccount.waba_id,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: centralAccount.display_phone_number, phone_number_id: XYZ_PHONE_ID },
            contacts: [{ profile: { name: 'Owner A' }, wa_id: OWNER_A_PHONE.replace(/[^\d]/g, '') }],
            messages: [{
              from: OWNER_A_PHONE.replace(/[^\d]/g, ''),
              id: `wamid_dup_click_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: signedAccept4, title: 'Accept' } }
            }]
          },
          field: 'messages'
        }]
      }]
    });

    const customerOutboxCountAfter = await prisma.outboxMessage.count({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `customer_decision_${order4.id}_accept`,
        message_type: 'CUSTOMER_ORDER_DECISION'
      }
    });
    assert.strictEqual(customerOutboxCountAfter, 1, 'Zero duplicate outbox messages created on repeated clicks');
    recordTestPass('Duplicate owner decision safely ignored without duplicate customer notifications');

    console.log('\n============================================================');
    console.log('   ALL CENTRAL-ONLY E2E TESTS PASSED (0 FAILURES)           ');
    console.log('============================================================\n');

  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exitCode = 1;
  } finally {
    console.log('Cleaning up test fixtures...');
    try {
      if (createdOrderIds.length > 0) {
        const idempotencyKeys = createdOrderIds.flatMap(id => [
          `owner_notif_${id}`,
          `customer_decision_${id}_accept`,
          `customer_decision_${id}_reject`,
          `customer_ack_${id}`
        ]);
        await prisma.outboxMessage.deleteMany({
          where: {
            OR: [
              { idempotency_key: { in: idempotencyKeys } },
              { restaurant_id: { in: [restA.id, restB.id] }, recipient_phone: { in: TEST_PHONES } }
            ]
          }
        }).catch((e) => console.warn('Outbox cleanup warning:', e.message));
        await prisma.orderNotification.deleteMany({
          where: { order_id: { in: createdOrderIds } }
        }).catch((e) => console.warn('Notification cleanup warning:', e.message));
        await prisma.order.deleteMany({
          where: { id: { in: createdOrderIds } }
        }).catch((e) => console.warn('Order cleanup warning:', e.message));
      }
      if (createdSessionIds.length > 0) {
        await prisma.conversationSession.deleteMany({
          where: { id: { in: createdSessionIds } }
        }).catch(() => {});
      }
      console.log('Test fixtures cleaned up successfully.');
    } catch (cleanErr) {
      console.warn('Fixture cleanup warning:', cleanErr.message);
    }

    if (server) {
      server.close();
    }
    resetTemplateApprovalsForTesting();
  }
}

runSuite().catch(console.error);
