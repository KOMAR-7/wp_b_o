/**
 * RESTOPRO — Stage 10: Customer WhatsApp Conversational Outbound Dispatch Test Suite
 *
 * Verifies:
 * 1. Customer sends "Hi" -> Welcome catalog reply enqueued in OutboxMessage.
 * 2. Customer sends catalogue order -> Address prompt reply enqueued in OutboxMessage.
 * 3. Customer sends text address -> Save consent prompt reply enqueued with interactive buttons.
 * 4. Customer selects consent -> Fulfilment prompt reply enqueued (Delivery vs Takeaway buttons).
 * 5. Customer selects delivery -> Order review summary reply enqueued with action buttons.
 * 6. Customer confirms order -> Existing order created, owner alert enqueued, and customer receipt enqueued.
 * 7. Duplicate inbound webhook -> Idempotency prevents duplicate outbound replies.
 * 8. Invalid action handling -> Contextual reprompt enqueued; silent fallback after max reminders.
 * 9. WhatsApp API failure -> Outbox retry and status tracking behavior (PENDING retry vs FAILED terminal).
 * 10. Multi-tenant credential isolation -> Tenant A's outbox messages strictly resolve Tenant A's credentials.
 */

const crypto = require('crypto');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const { NotificationWorker } = require('../src/jobs/notification-worker');
const {
  claimPendingOutboxMessages,
  updateOutboxResult,
  dispatchPendingOutboxMessages,
  enqueueConversationReply
} = require('../src/services/outbox.service');
const {
  buildConversationReplyPayload,
  resolveRestaurantCredentials,
  sendWhatsAppMessage
} = require('../src/services/whatsapp.service');
const { handleIncomingMessage, processIncomingCart } = require('../src/services/conversation.service');

const TEST_PORT = 4991;
let server;

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

function computeSignature(payloadString, secret) {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(payloadString, 'utf8'))
    .digest('hex');
  return `sha256=${hash}`;
}

function makeWebhookRequest(payload, secret = config.meta.appSecret) {
  return new Promise((resolve, reject) => {
    const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const signature = computeSignature(rawBody, secret);

    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        'X-Hub-Signature-256': signature
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

async function runStage10Tests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 10: CONVERSATIONAL OUTBOUND DISPATCH    ');
  console.log('============================================================\n');

  // Track created artifacts for guaranteed teardown
  const createdSessionIds = [];
  const createdOrderIds = [];
  const createdOutboxIds = [];
  const createdWebhookEventIds = [];
  const createdRestaurantIds = [];

  // Start HTTP server for webhook pipeline tests
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, resolve);
  });

  try {
    // 0. Ensure seeded tenants exist or create isolated test tenants
    let tenantA = await prisma.restaurant.findUnique({
      where: { phone_number_id: '111111111111111' }
    });
    let tenantB = await prisma.restaurant.findUnique({
      where: { phone_number_id: '222222222222222' }
    });

    if (!tenantA) {
      tenantA = await prisma.restaurant.create({
        data: {
          name: 'Stage10 Tenant Alpha',
          phone_number_id: '111111111111111',
          owner_phone: '+919876500001',
          access_token_encrypted: 'mock_token_alpha',
          is_active: true
        }
      });
      createdRestaurantIds.push(tenantA.id);
    }

    if (!tenantB) {
      tenantB = await prisma.restaurant.create({
        data: {
          name: 'Stage10 Tenant Beta',
          phone_number_id: '222222222222222',
          owner_phone: '+919876500002',
          access_token_encrypted: 'mock_token_beta',
          is_active: true
        }
      });
      createdRestaurantIds.push(tenantB.id);
    }

    const testCustPhone = `9199100${Math.floor(10000 + Math.random() * 90000)}`;

    // -------------------------------------------------------------
    // TEST 1: Customer sends "Hi" -> Welcome response enqueued
    // -------------------------------------------------------------
    console.log('--- TEST 1: Greeting "Hi" -> Welcome Outbox Enqueued ---');
    const wamidHi = `wamid.STAGE10_HI_${Date.now()}`;
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: testCustPhone,
                id: wamidHi,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'Hi' }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res = await makeWebhookRequest(payload);
      assert(res.statusCode === 200, 'POST "Hi" webhook returns HTTP 200');

      // Verify conversation session transitioned to AWAITING_CART
      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: testCustPhone
          }
        }
      });
      assert(session !== null, 'Customer conversation session created');
      assert(session.current_step === 'AWAITING_CART', 'Session step transitioned to AWAITING_CART');
      if (session) createdSessionIds.push(session.id);

      // Verify OutboxMessage was enqueued
      const outbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidHi}` }
      });
      assert(outbox !== null, 'OutboxMessage enqueued for greeting reply');
      assert(outbox.restaurant_id === tenantA.id, 'Outbox scoped to Tenant A');
      assert(outbox.recipient_phone === testCustPhone, 'Outbox recipient matches customer phone');
      assert(outbox.message_type === 'CUSTOMER_CONVERSATION_REPLY', 'Message type is CUSTOMER_CONVERSATION_REPLY');
      assert(['PENDING', 'PROCESSING', 'FAILED', 'SENT'].includes(outbox.status), 'Initial outbox status is valid');
      const isCatalogInteractive = outbox.payload?.type === 'interactive' && outbox.payload?.interactive?.type === 'catalog_message';
      const isText = outbox.payload?.type === 'text';
      assert(isCatalogInteractive || isText, 'Payload is catalog_message interactive or text type');
      const welcomeBody = outbox.payload?.interactive?.body?.text || outbox.payload?.text?.body || '';
      assert(welcomeBody.includes('Welcome') || welcomeBody.includes('enjoy today') || welcomeBody.includes('catalogue'), 'Payload invites customer with welcome / catalog message');
      if (outbox) createdOutboxIds.push(outbox.id);
    }

    // -------------------------------------------------------------
    // TEST 2: Customer sends catalogue order -> Address prompt enqueued
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Catalogue Order -> Address Prompt Enqueued ---');
    const wamidCart = `wamid.STAGE10_CART_${Date.now()}`;
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: testCustPhone,
                id: wamidCart,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'order',
                order: {
                  catalog_id: 'CAT_TEST_10',
                  product_items: [
                    { product_retailer_id: 'SKU_PIZZA_LARGE', quantity: 2, item_price: 450.00, currency: 'INR' },
                    { product_retailer_id: 'SKU_GARLIC_BREAD', quantity: 1, item_price: 150.00, currency: 'INR' }
                  ]
                }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res = await makeWebhookRequest(payload);
      assert(res.statusCode === 200, 'POST catalogue order returns HTTP 200');

      // Verify conversation session state
      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: testCustPhone
          }
        }
      });
      assert(session.current_step === 'AWAITING_ADDRESS_INPUT', 'Session advanced to AWAITING_ADDRESS_INPUT');
      assert(session.state.cart.subtotal === 1050, 'Cart subtotal accurately calculated (2*450 + 150 = 1050)');

      // Verify OutboxMessage
      const outbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidCart}` }
      });
      assert(outbox !== null, 'OutboxMessage enqueued for catalogue order receipt');
      const isInteractiveBtnOrList = outbox.payload?.type === 'interactive';
      const isTextMsg = outbox.payload?.type === 'text';
      assert(isInteractiveBtnOrList || isTextMsg, 'Payload is interactive button/list or text message');
      const cartBody = outbox.payload?.interactive?.body?.text || outbox.payload?.text?.body || '';
      assert(cartBody.includes('Cart Received') || cartBody.includes('delivery address'), 'Payload acknowledges Cart Received');
      assert(cartBody.includes('1050'), 'Payload contains accurate subtotal in text');
      assert(cartBody.includes('delivery address') || cartBody.includes('location pin'), 'Payload prompts for address/pin');
      if (outbox) createdOutboxIds.push(outbox.id);
    }

    // -------------------------------------------------------------
    // TEST 3: Customer sends text address -> Save consent prompt enqueued
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Text Address -> Save Consent Prompt Enqueued ---');
    const wamidAddr = `wamid.STAGE10_ADDR_${Date.now()}`;
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: testCustPhone,
                id: wamidAddr,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'Flat 402, Sea Pearl Heights, Bandra West, Mumbai 400050' }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res = await makeWebhookRequest(payload);
      assert(res.statusCode === 200, 'POST text address returns HTTP 200');

      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: testCustPhone
          }
        }
      });
      assert(session.current_step === 'AWAITING_SAVE_CONSENT', 'Session advanced to AWAITING_SAVE_CONSENT');

      const outbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidAddr}` }
      });
      assert(outbox !== null, 'OutboxMessage enqueued for address receipt');
      assert(outbox.payload?.type === 'interactive', 'Address consent is an interactive message');
      assert(outbox.payload?.interactive?.type === 'button', 'Interactive type is button');
      assert(outbox.payload?.interactive?.action?.buttons?.length === 2, 'Has exactly 2 buttons (Yes / No)');

      const btnYes = outbox.payload?.interactive?.action?.buttons.find(b => b.reply.id === 'BTN_CONSENT_YES');
      const btnNo = outbox.payload?.interactive?.action?.buttons.find(b => b.reply.id === 'BTN_CONSENT_NO');
      assert(btnYes !== undefined && btnYes.reply.title.length <= 20, 'BTN_CONSENT_YES present and title <= 20 chars');
      assert(btnNo !== undefined && btnNo.reply.title.length <= 20, 'BTN_CONSENT_NO present and title <= 20 chars');
      if (outbox) createdOutboxIds.push(outbox.id);
    }

    // -------------------------------------------------------------
    // TEST 4: Customer selects consent -> Fulfilment prompt enqueued
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Consent Tap -> Fulfilment Prompt Enqueued ---');
    const wamidConsent = `wamid.STAGE10_CONSENT_${Date.now()}`;
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: testCustPhone,
                id: wamidConsent,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'interactive',
                interactive: {
                  type: 'button_reply',
                  button_reply: {
                    id: 'BTN_CONSENT_YES',
                    title: '✅ Yes, Save'
                  }
                }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res = await makeWebhookRequest(payload);
      assert(res.statusCode === 200, 'POST consent button reply returns HTTP 200');

      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: testCustPhone
          }
        }
      });
      assert(session.current_step === 'AWAITING_ORDER_TYPE', 'Session advanced to AWAITING_ORDER_TYPE');

      const outbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidConsent}` }
      });
      assert(outbox !== null, 'OutboxMessage enqueued for fulfilment selection prompt');
      assert(outbox.payload?.type === 'interactive', 'Order type prompt is interactive');
      assert(outbox.payload?.interactive?.action?.buttons?.length >= 2, 'Has at least 2 buttons (Delivery & Takeaway)');

      const btnDelivery = outbox.payload?.interactive?.action?.buttons.find(b => b.reply.id === 'BTN_ORDER_DELIVERY');
      const btnTakeaway = outbox.payload?.interactive?.action?.buttons.find(b => b.reply.id === 'BTN_ORDER_TAKEAWAY');
      assert(btnDelivery !== undefined && btnDelivery.reply.title.length <= 20, 'BTN_ORDER_DELIVERY button valid');
      assert(btnTakeaway !== undefined && btnTakeaway.reply.title.length <= 20, 'BTN_ORDER_TAKEAWAY button valid');
      if (outbox) createdOutboxIds.push(outbox.id);
    }

    // -------------------------------------------------------------
    // TEST 5: Customer selects Delivery -> Order Review enqueued
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Fulfilment Selection -> Order Summary Review Enqueued ---');
    const wamidType = `wamid.STAGE10_TYPE_${Date.now()}`;
    let confirmationToken = null;
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: testCustPhone,
                id: wamidType,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'button',
                button: {
                  payload: 'BTN_ORDER_DELIVERY',
                  text: '🚚 Delivery'
                }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res = await makeWebhookRequest(payload);
      assert(res.statusCode === 200, 'POST order type button returns HTTP 200');

      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: testCustPhone
          }
        }
      });
      assert(session.current_step === 'AWAITING_CONFIRMATION', 'Session advanced to AWAITING_CONFIRMATION');
      confirmationToken = session.state.confirmationToken;
      assert(confirmationToken && confirmationToken.startsWith('conf_'), 'Session has active confirmation token');

      const outbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidType}` }
      });
      assert(outbox !== null, 'OutboxMessage enqueued for order confirmation prompt');
      assert(outbox.payload?.type === 'interactive', 'Confirmation prompt is interactive');
      assert(outbox.payload?.interactive?.action?.buttons?.length === 3, 'Delivery review has 3 buttons (Confirm, Cancel, Change Address)');

      const btnConfirm = outbox.payload?.interactive?.action?.buttons.find(b => b.reply.id.startsWith('BTN_CONFIRM_ORDER:'));
      const btnCancel = outbox.payload?.interactive?.action?.buttons.find(b => b.reply.id === 'BTN_CANCEL_ORDER');
      const btnChange = outbox.payload?.interactive?.action?.buttons.find(b => b.reply.id === 'BTN_CHANGE_ADDRESS');

      assert(btnConfirm !== undefined, 'BTN_CONFIRM_ORDER button present');
      assert(btnConfirm.reply.id === `BTN_CONFIRM_ORDER:${confirmationToken}`, 'BTN_CONFIRM_ORDER embeds matching token');
      assert(btnConfirm.reply.title.length <= 20, 'Confirm button title <= 20 chars');
      assert(btnCancel !== undefined && btnCancel.reply.title.length <= 20, 'Cancel button title <= 20 chars');
      assert(btnChange !== undefined && btnChange.reply.title.length <= 20, 'Change Address button title <= 20 chars');

      // Verify body text length compliance
      assert(outbox.payload.interactive.body.text.length <= 1024, 'Interactive body strictly under 1024 characters');
      assert(outbox.payload.interactive.body.text.includes('Confirm Your Order') || outbox.payload.interactive.body.text.includes('ORDER SUMMARY'), 'Summary text contains confirmation header');
      if (outbox) createdOutboxIds.push(outbox.id);
    }

    // -------------------------------------------------------------
    // TEST 6: Customer confirms -> Order created + Owner alert + Customer receipt
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Customer Confirmation -> Order + Owner Outbox + Customer Outbox ---');
    const wamidConfirm = `wamid.STAGE10_CONFIRM_${Date.now()}`;
    let createdOrderId = null;
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: testCustPhone,
                id: wamidConfirm,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'interactive',
                interactive: {
                  type: 'button_reply',
                  button_reply: {
                    id: `BTN_CONFIRM_ORDER:${confirmationToken}`,
                    title: '✅ Confirm Order'
                  }
                }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res = await makeWebhookRequest(payload);
      assert(res.statusCode === 200, 'POST confirm button returns HTTP 200');

      // 1. Verify Order created in DB
      const order = await prisma.order.findUnique({
        where: { confirmation_token: confirmationToken }
      });
      assert(order !== null, 'Order successfully created in database');
      assert(order.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order status is PENDING_RESTAURANT_CONFIRMATION');
      assert(order.restaurant_id === tenantA.id, 'Order scoped to Tenant A');
      assert(Number(order.total_amount) === 1050, 'Order total matches 1050');
      if (order) {
        createdOrderId = order.id;
        createdOrderIds.push(order.id);
      }

      // 2. Verify Owner Notification Outbox record
      const ownerOutbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `owner_notif_${order.id}` }
      });
      assert(ownerOutbox !== null, 'Owner OutboxMessage created atomically');
      assert(ownerOutbox.message_type === 'OWNER_ORDER_NOTIFICATION', 'Owner message type is OWNER_ORDER_NOTIFICATION');
      assert(ownerOutbox.recipient_phone.replace(/[^\d]/g, '') === tenantA.owner_phone.replace(/[^\d]/g, ''), 'Owner recipient matches restaurant owner phone');
      if (ownerOutbox) createdOutboxIds.push(ownerOutbox.id);

      // 3. Verify Customer Confirmation Receipt Outbox record
      const customerReceiptOutbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidConfirm}` }
      });
      assert(customerReceiptOutbox !== null, 'Customer confirmation receipt OutboxMessage enqueued');
      assert(customerReceiptOutbox.message_type === 'CUSTOMER_CONVERSATION_REPLY', 'Customer receipt is CUSTOMER_CONVERSATION_REPLY');
      assert(customerReceiptOutbox.payload?.type === 'text', 'Customer receipt payload is text');
      assert(customerReceiptOutbox.payload?.text?.body.includes(order.order_reference), 'Receipt mentions order reference');
      if (customerReceiptOutbox) createdOutboxIds.push(customerReceiptOutbox.id);
    }

    // -------------------------------------------------------------
    // TEST 7: Duplicate inbound webhook -> Idempotency prevents duplicates
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: Inbound Retry -> Zero Duplicate Outbox Replies ---');
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: testCustPhone,
                id: wamidHi, // Replayed identical message ID from Test 1
                timestamp: '1793990000',
                type: 'text',
                text: { body: 'Hi' }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res = await makeWebhookRequest(payload);
      assert(res.statusCode === 200, 'Replayed webhook acknowledged with HTTP 200');

      // Check how many OutboxMessages exist with idempotency_key reply_wamidHi
      const outboxCount = await prisma.outboxMessage.count({
        where: { idempotency_key: `reply_${wamidHi}` }
      });
      assert(outboxCount === 1, 'Exactly 1 outbox message exists for this messageId (Zero Duplicate Replies)');
    }

    // -------------------------------------------------------------
    // TEST 8: Invalid Action Handling & Silent Fallback
    // -------------------------------------------------------------
    console.log('\n--- TEST 8: Invalid Action & Silent Fallback ---');
    const custBad = `9199200${Math.floor(10000 + Math.random() * 90000)}`;
    const wamidBad1 = `wamid.STAGE10_BAD1_${Date.now()}`;
    const wamidBad2 = `wamid.STAGE10_BAD2_${Date.now()}`;
    const wamidBad3 = `wamid.STAGE10_BAD3_${Date.now()}`;

    // Establish session in AWAITING_CART
    await handleIncomingMessage(tenantA.id, custBad, { messageType: 'text', text: 'Hi' });

    // 1st unsupported message -> contextual reprompt enqueued
    {
      const payload1 = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: custBad,
                id: wamidBad1,
                timestamp: '1793990010',
                type: 'image',
                image: { id: 'img_invalid' }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res1 = await makeWebhookRequest(payload1);
      assert(res1.statusCode === 200, 'Unsupported message 1 handled with HTTP 200');

      const outbox1 = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidBad1}` }
      });
      assert(outbox1 !== null, 'Reprompt outbox message 1 was enqueued');
      assert(outbox1.payload?.text?.body.includes('catalogue'), 'Reprompt 1 guides customer to catalogue');
      if (outbox1) createdOutboxIds.push(outbox1.id);
    }

    // 2nd unsupported message -> contextual reprompt enqueued
    {
      const payload2 = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: custBad,
                id: wamidBad2,
                timestamp: '1793990011',
                type: 'audio',
                audio: { id: 'aud_invalid' }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res2 = await makeWebhookRequest(payload2);
      assert(res2.statusCode === 200, 'Unsupported message 2 handled with HTTP 200');

      const outbox2 = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidBad2}` }
      });
      assert(outbox2 !== null, 'Reprompt outbox message 2 was enqueued');
      if (outbox2) createdOutboxIds.push(outbox2.id);
    }

    // 3rd unsupported message -> SILENT FALLBACK (no outbox message created)
    {
      const payload3 = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_10',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: custBad,
                id: wamidBad3,
                timestamp: '1793990012',
                type: 'sticker',
                sticker: { id: 'stk_invalid' }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res3 = await makeWebhookRequest(payload3);
      assert(res3.statusCode === 200, '3rd unsupported message handled with HTTP 200');

      const outbox3 = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidBad3}` }
      });
      assert(outbox3 === null, 'Silent fallback adhered to: ZERO outbox message created after 2 reminders');
    }

    // -------------------------------------------------------------
    // TEST 9: WhatsApp API Failure & Outbox Retry Behavior
    // -------------------------------------------------------------
    console.log('\n--- TEST 9: WhatsApp API Failure & Outbox Retries ---');
    {
      // Flush prior conversational messages with mock success sender so retry/terminal messages are processed cleanly
      const flushWorker = new NotificationWorker({ batchSize: 50 });
      await flushWorker.processCycle(async () => ({ success: true, metaMessageId: 'mock_flush_wamid' }));

      // 9a. Test Retryable Failure (500 Error / Timeout)
      const retryMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: testCustPhone,
          message_type: 'CUSTOMER_CONVERSATION_REPLY',
          payload: { text: { body: 'Retryable message test' } },
          idempotency_key: `retry_test_${Date.now()}`,
          status: 'PENDING',
          attempts: 0
        }
      });
      createdOutboxIds.push(retryMsg.id);

      // Simulate a custom sender returning retryable 503 error
      const mock503Sender = async () => ({
        success: false,
        isTimeout: false,
        isRetryable: true,
        statusCode: 503,
        error: 'Meta Server Unavailable (503)'
      });

      const worker = new NotificationWorker({ batchSize: 10 });
      await worker.processCycle(mock503Sender);

      const after503 = await prisma.outboxMessage.findUnique({ where: { id: retryMsg.id } });
      assert(after503.status === 'PENDING', 'Retryable error keeps message in PENDING status for retry');
      assert(after503.attempts === 1, 'Attempt counter incremented to 1');
      assert(after503.last_error && after503.last_error.includes('503'), 'Last error recorded 503 error details');

      // 9b. Test Terminal Failure (400 Bad Request / 401 Unauthorized)
      const terminalMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: testCustPhone,
          message_type: 'CUSTOMER_CONVERSATION_REPLY',
          payload: { text: { body: 'Terminal message test' } },
          idempotency_key: `terminal_test_${Date.now()}`,
          status: 'PENDING',
          attempts: 0
        }
      });
      createdOutboxIds.push(terminalMsg.id);

      const mock400Sender = async () => ({
        success: false,
        isTimeout: false,
        isRetryable: false,
        statusCode: 400,
        error: 'Invalid recipient phone number (400)'
      });

      await worker.processCycle(mock400Sender);
      const after400 = await prisma.outboxMessage.findUnique({ where: { id: terminalMsg.id } });
      assert(after400.status === 'FAILED', 'Non-retryable 400 error immediately transitions message to FAILED');
      assert(after400.attempts === 1, 'Attempt count recorded');
      assert(after400.last_error && after400.last_error.includes('400'), 'Last error records failure details');
    }

    // -------------------------------------------------------------
    // TEST 10: Multi-Tenant Credential Isolation
    // -------------------------------------------------------------
    console.log('\n--- TEST 10: Multi-Tenant Credential Isolation ---');
    {
      const credsA = await resolveRestaurantCredentials(tenantA.id);
      const credsB = await resolveRestaurantCredentials(tenantB.id);

      assert(credsA.phoneNumberId === tenantA.phone_number_id, "Tenant A resolves Tenant A's phoneNumberId");
      assert(credsB.phoneNumberId === tenantB.phone_number_id, "Tenant B resolves Tenant B's phoneNumberId");
      assert(credsA.phoneNumberId !== credsB.phoneNumberId, 'Tenants A and B have strictly distinct phone number IDs');

      // Enqueue Outbox message for Tenant A
      const outboxA = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: testCustPhone,
          message_type: 'CUSTOMER_CONVERSATION_REPLY',
          payload: { text: { body: 'Tenant A Isolation Test' } },
          idempotency_key: `tenant_iso_A_${Date.now()}`,
          status: 'PENDING'
        }
      });
      createdOutboxIds.push(outboxA.id);

      // Verify that when resolving credentials for Outbox A, it ALWAYS resolves Tenant A
      const resolvedForA = await resolveRestaurantCredentials(outboxA.restaurant_id);
      assert(resolvedForA.restaurantId === tenantA.id, 'Resolved credential restaurantId strictly equals Tenant A');
      assert(resolvedForA.phoneNumberId === tenantA.phone_number_id, 'Resolved credential phoneNumberId strictly equals Tenant A');
      assert(resolvedForA.phoneNumberId !== tenantB.phone_number_id, "Tenant A message CANNOT resolve Tenant B's phone number ID");
    }

  } catch (err) {
    console.error('\n❌ Unexpected error during Stage 10 test execution:', err);
    failedTests++;
  } finally {
    console.log('\n--- Cleaning up Stage 10 test artifacts ---');
    try {
      if (createdOutboxIds.length > 0) {
        await prisma.outboxMessage.deleteMany({
          where: { id: { in: createdOutboxIds } }
        });
      }
      if (createdOrderIds.length > 0) {
        await prisma.order.deleteMany({
          where: { id: { in: createdOrderIds } }
        });
      }
      if (createdSessionIds.length > 0) {
        await prisma.conversationSession.deleteMany({
          where: { id: { in: createdSessionIds } }
        });
      }
      if (createdRestaurantIds.length > 0) {
        await prisma.restaurant.deleteMany({
          where: { id: { in: createdRestaurantIds } }
        });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }

    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 10 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage10Tests().catch((err) => {
    console.error('Test execution fatal error:', err);
    process.exit(1);
  });
}

module.exports = { runStage10Tests };
