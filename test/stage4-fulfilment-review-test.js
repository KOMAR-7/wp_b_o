/**
 * RESTOPRO — Stage 4.4: Fulfilment Selection & Order Review Test Suite
 * Tests ST4-11, ST4-12, ST4-13, and ST4-14:
 * - Delivery vs Takeaway selection (ST4-11)
 * - Delivery requires completed address; Takeaway allows missing address
 * - Deterministic order summary review with integer paise/cents arithmetic (ST4-12)
 * - Change Address flow with confirmation token invalidation
 * - Customer order confirmation handler with atomic order creation (ST4-13)
 * - Initial status PENDING_RESTAURANT_CONFIRMATION
 * - Database-backed idempotency & replay protection on confirmation_token
 * - Customer cancellation handler (ST4-14) with session reset to IDLE
 * - Multi-tenant and customer isolation
 */
require('./load-test-env');
const crypto = require('crypto');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const {
  handleIncomingMessage,
  processIncomingCart,
  validateActionForStep,
  generateConfirmationToken,
  calculateSessionExpiry
} = require('../src/services/conversation.service');
const {
  generateOrderReference,
  buildOrderSummary,
  createOrderWithReferenceRetry,
  confirmCustomerOrder,
  cancelCustomerOrder
} = require('../src/services/order.service');

const TEST_PORT = 3994;
let server;

function makeRequest({ method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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

function computeSignature(payloadString, secret) {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(payloadString, 'utf8'))
    .digest('hex');
  return `sha256=${hash}`;
}

async function runStage4FulfilmentTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 4.4: FULFILMENT & ORDER REVIEW TEST    ');
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
  const createdSessionIds = [];
  const createdOrderIds = [];
  const createdSavedAddressIds = [];
  const createdWebhookEventIds = [];

  // Start HTTP server for webhook tests
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, resolve);
  });

  try {
    const tenantA = await prisma.restaurant.findUnique({
      where: { phone_number_id: '111111111111111' }
    });
    const tenantB = await prisma.restaurant.findUnique({
      where: { phone_number_id: '222222222222222' }
    });

    if (!tenantA || !tenantB) {
      throw new Error('Precondition failed: Seeded restaurants (Tenant A / B) not found.');
    }

    const standardCartPayload = {
      catalog_id: 'CAT_STAGE_44',
      product_items: [
        { product_retailer_id: 'SKU_BIRYANI_SPL', quantity: 2, item_price: 240.00, currency: 'INR' },
        { product_retailer_id: 'SKU_COKE_CAN', quantity: 1, item_price: 60.00, currency: 'INR' }
      ]
    };

    // -------------------------------------------------------------
    // TEST GROUP 1: Fulfilment Selection — Delivery vs. Takeaway (ST4-11)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: Fulfilment Selection — Delivery vs Takeaway (ST4-11) ---');
    const custDelivery = `9198211${Math.floor(10000 + Math.random() * 90000)}`;

    // 1. Setup session through address collection
    const cartDelRes = await processIncomingCart(tenantA.id, custDelivery, standardCartPayload);
    createdSessionIds.push(cartDelRes.session.id);

    // Provide address
    await handleIncomingMessage(tenantA.id, custDelivery, {
      messageType: 'text',
      text: 'Flat 402, Sunshine Heights, Andheri West, Mumbai 400058'
    });

    // Provide consent
    await handleIncomingMessage(tenantA.id, custDelivery, {
      messageType: 'button',
      buttonReply: { payload: 'BTN_CONSENT_YES' }
    });

    // 2. Delivery Selection with valid address
    {
      const delRes = await handleIncomingMessage(tenantA.id, custDelivery, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_DELIVERY' }
      });

      assert(delRes.session.current_step === 'AWAITING_CONFIRMATION', 'BTN_ORDER_DELIVERY transitions to AWAITING_CONFIRMATION');
      assert(delRes.session.state.orderType === 'DELIVERY', 'Session state stores orderType = DELIVERY');
      assert(delRes.action.type === 'PROMPT_ORDER_CONFIRMATION', 'Action prompts for order confirmation');
      assert(delRes.action.summary.orderType === 'DELIVERY', 'Order summary reflects DELIVERY');
      assert(delRes.action.summary.addressSnapshot.includes('Sunshine Heights'), 'Delivery summary includes address snapshot');
      assert(delRes.action.buttons.some(b => b.id === 'BTN_CHANGE_ADDRESS'), 'Delivery summary provides BTN_CHANGE_ADDRESS button');
    }

    // 3. Takeaway Selection without address
    {
      const custTakeaway = `9198212${Math.floor(10000 + Math.random() * 90000)}`;
      const cartTakRes = await processIncomingCart(tenantA.id, custTakeaway, standardCartPayload);
      createdSessionIds.push(cartTakRes.session.id);

      // Force session directly to AWAITING_ORDER_TYPE without address
      await prisma.conversationSession.update({
        where: { id: cartTakRes.session.id },
        data: {
          current_step: 'AWAITING_ORDER_TYPE',
          state: {
            cart: cartTakRes.cart,
            confirmationToken: cartTakRes.confirmationToken,
            address: null // No address
          }
        }
      });

      const takRes = await handleIncomingMessage(tenantA.id, custTakeaway, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_TAKEAWAY' }
      });

      assert(takRes.session.current_step === 'AWAITING_CONFIRMATION', 'BTN_ORDER_TAKEAWAY succeeds without delivery address');
      assert(takRes.session.state.orderType === 'TAKEAWAY', 'Session state stores orderType = TAKEAWAY');
      assert(takRes.action.summary.addressSnapshot === null, 'Takeaway summary has null address snapshot');
      assert(takRes.action.summary.summaryText.includes('Takeaway (Self-Pickup)'), 'Summary text notes Takeaway (Self-Pickup)');
      assert(!takRes.action.buttons.some(b => b.id === 'BTN_CHANGE_ADDRESS'), 'Takeaway summary does NOT provide BTN_CHANGE_ADDRESS button');
    }

    // 4. Delivery Guard: Delivery without an address is strictly rejected
    {
      const custNoAddr = `9198213${Math.floor(10000 + Math.random() * 90000)}`;
      const cartNoAddrRes = await processIncomingCart(tenantA.id, custNoAddr, standardCartPayload);
      createdSessionIds.push(cartNoAddrRes.session.id);

      // Force session to AWAITING_ORDER_TYPE with null address
      await prisma.conversationSession.update({
        where: { id: cartNoAddrRes.session.id },
        data: {
          current_step: 'AWAITING_ORDER_TYPE',
          state: {
            cart: cartNoAddrRes.cart,
            confirmationToken: cartNoAddrRes.confirmationToken,
            address: null
          }
        }
      });

      const rejectDelRes = await handleIncomingMessage(tenantA.id, custNoAddr, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_DELIVERY' }
      });

      assert(rejectDelRes.session.current_step === 'AWAITING_ORDER_TYPE', 'Delivery without address is rejected; stays in AWAITING_ORDER_TYPE');
      assert(rejectDelRes.action.type === 'CONTEXTUAL_REPROMPT', 'Contextual reprompt issued for missing address');
      assert(rejectDelRes.action.message.includes('Delivery orders require a valid delivery address'), 'Reprompt message specifies delivery address requirement');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Order Review & Deterministic Calculations (ST4-12)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Order Review & Price Calculations (ST4-12) ---');

    // 5. Order summary accuracy and integer-cents calculation
    {
      const summary = buildOrderSummary({
        cart: {
          items: [
            { productRetailerId: 'SKU_1', productName: 'Biryani', quantity: 3, unitPrice: 199.99, currency: 'INR' },
            { productRetailerId: 'SKU_2', productName: 'Raita', quantity: 2, unitPrice: 40.50, currency: 'INR' }
          ],
          itemCount: 5,
          currency: 'INR'
        },
        orderType: 'DELIVERY',
        address: { addressText: 'Flat 101, Test Tower, Mumbai', latitude: 19.1, longitude: 72.8 },
        confirmationToken: 'conf_test_summary_123'
      });

      // 3 * 199.99 = 599.97; 2 * 40.50 = 81.00; Subtotal = 680.97
      assert(summary.subtotal === 680.97, 'Subtotal correctly calculated with zero floating-point drift (680.97)');
      assert(summary.items.length === 2, 'Summary contains exactly 2 item snapshots');
      assert(summary.items[0].lineTotal === 599.97, 'Line total 1 is exactly 599.97');
      assert(summary.items[1].lineTotal === 81.00, 'Line total 2 is exactly 81.00');
      assert(summary.currency === 'INR', 'Currency is INR');
      assert(summary.summaryText.includes('₹680.97'), 'Summary text renders correct subtotal');
    }

    // 6. Change Address flow invalidates confirmation token
    {
      const custChange = `9198221${Math.floor(10000 + Math.random() * 90000)}`;
      const cartChangeRes = await processIncomingCart(tenantA.id, custChange, standardCartPayload);
      createdSessionIds.push(cartChangeRes.session.id);
      const originalToken = cartChangeRes.confirmationToken;

      // Provide address
      await handleIncomingMessage(tenantA.id, custChange, {
        messageType: 'text',
        text: 'Initial Address, Sector 17, Vashi, Navi Mumbai 400703'
      });
      // Skip consent
      await handleIncomingMessage(tenantA.id, custChange, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CONSENT_NO' }
      });
      // Choose Delivery -> AWAITING_CONFIRMATION
      await handleIncomingMessage(tenantA.id, custChange, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_DELIVERY' }
      });

      // Tap Change Address
      const changeRes = await handleIncomingMessage(tenantA.id, custChange, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CHANGE_ADDRESS' }
      });

      assert(changeRes.session.current_step === 'AWAITING_ADDRESS_INPUT', 'BTN_CHANGE_ADDRESS returns session to address collection');
      assert(changeRes.session.state.confirmationToken !== originalToken, 'Previous confirmation token is completely invalidated');
      assert(changeRes.session.state.address === null, 'Previous address cleared from session state');

      // Attempting to confirm with old token must be rejected
      const staleConfirmRes = await handleIncomingMessage(tenantA.id, custChange, {
        messageType: 'button',
        buttonReply: { payload: `BTN_CONFIRM_ORDER:${originalToken}` }
      });
      assert(staleConfirmRes.session.current_step === 'AWAITING_ADDRESS_INPUT', 'Stale confirmation token rejected; order not created');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: Customer Order Confirmation Handler (ST4-13)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Customer Order Confirmation Handler (ST4-13) ---');
    const custConfirm = `9198231${Math.floor(10000 + Math.random() * 90000)}`;

    const cartConfRes = await processIncomingCart(tenantA.id, custConfirm, standardCartPayload);
    createdSessionIds.push(cartConfRes.session.id);
    const validToken = cartConfRes.confirmationToken;

    // Provide address
    await handleIncomingMessage(tenantA.id, custConfirm, {
      messageType: 'text',
      text: 'Flat 901, Blue Horizon, Worli Sea Face, Mumbai 400018'
    });
    // Consent YES
    await handleIncomingMessage(tenantA.id, custConfirm, {
      messageType: 'button',
      buttonReply: { payload: 'BTN_CONSENT_YES' }
    });
    // Choose Delivery
    await handleIncomingMessage(tenantA.id, custConfirm, {
      messageType: 'button',
      buttonReply: { payload: 'BTN_ORDER_DELIVERY' }
    });

    // 7. Atomic order creation with status PENDING_RESTAURANT_CONFIRMATION
    let createdOrderRef = null;
    {
      const confirmRes = await handleIncomingMessage(tenantA.id, custConfirm, {
        messageType: 'button',
        buttonReply: { payload: `BTN_CONFIRM_ORDER:${validToken}` }
      });

      assert(confirmRes.success === true, 'Order confirmation returns success');
      assert(confirmRes.order !== undefined, 'Order object returned in response');
      assert(confirmRes.order.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order status is strictly PENDING_RESTAURANT_CONFIRMATION');
      assert(confirmRes.order.confirmation_token === validToken, 'Order records confirmation_token');
      assert(confirmRes.order.restaurant_id === tenantA.id, 'Order scoped to Tenant A');
      assert(confirmRes.order.customer_phone === custConfirm, 'Order scoped to customer phone');
      assert(Number(confirmRes.order.total_amount) === 540.00, 'Order total_amount matches subtotal (540.00)');
      assert(confirmRes.order.currency === 'INR', 'Order currency is INR');
      assert(confirmRes.order.order_type === 'DELIVERY', 'Order type is DELIVERY');
      assert(confirmRes.order.order_reference.startsWith('RP-'), 'Order reference matches RP- prefix');
      assert(confirmRes.action.type === 'ORDER_CONFIRMED', 'Action type is ORDER_CONFIRMED');

      createdOrderRef = confirmRes.order.order_reference;
      createdOrderIds.push(confirmRes.order.id);

      // Verify session reset to IDLE
      const sessionAfter = await prisma.conversationSession.findUnique({
        where: { id: cartConfRes.session.id }
      });
      assert(sessionAfter.current_step === 'IDLE', 'Conversation session reset to IDLE after order confirmation');
      assert(sessionAfter.state.lastOrderReference === createdOrderRef, 'Session records lastOrderReference');
    }

    // 8. Idempotency & Replay Protection: Repeated confirmation returns existing order
    {
      const replayRes = await handleIncomingMessage(tenantA.id, custConfirm, {
        messageType: 'button',
        buttonReply: { payload: `BTN_CONFIRM_ORDER:${validToken}` }
      });

      assert(replayRes.success === true, 'Replay confirmation returns success');
      assert(replayRes.isDuplicate === true, 'Response marks isDuplicate = true');
      assert(replayRes.order.order_reference === createdOrderRef, 'Returns same order reference on replay');

      // Verify ZERO duplicate rows created in orders table
      const orderCount = await prisma.order.count({
        where: { confirmation_token: validToken }
      });
      assert(orderCount === 1, 'Exactly 1 row exists in orders table for confirmation_token (Zero Duplicates)');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Customer Order Cancellation (ST4-14)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Customer Order Cancellation (ST4-14) ---');
    const custCancel = `9198241${Math.floor(10000 + Math.random() * 90000)}`;

    const cartCanRes = await processIncomingCart(tenantA.id, custCancel, standardCartPayload);
    createdSessionIds.push(cartCanRes.session.id);

    // Set to AWAITING_CONFIRMATION
    await prisma.conversationSession.update({
      where: { id: cartCanRes.session.id },
      data: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          cart: cartCanRes.cart,
          confirmationToken: cartCanRes.confirmationToken,
          orderType: 'TAKEAWAY'
        }
      }
    });

    // 9. Cancel Order resets session to IDLE and creates zero orders
    {
      const cancelRes = await handleIncomingMessage(tenantA.id, custCancel, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CANCEL_ORDER' }
      });

      assert(cancelRes.success === true, 'Cancellation returns success');
      assert(cancelRes.action.type === 'ORDER_CANCELLED', 'Action type is ORDER_CANCELLED');
      assert(cancelRes.action.nextStep === 'IDLE', 'Action indicates nextStep IDLE');

      const s = await prisma.conversationSession.findUnique({
        where: { id: cartCanRes.session.id }
      });
      assert(s.current_step === 'IDLE', 'Session current_step reset to IDLE in database');
      assert(s.state.cancelledAt !== undefined, 'Session state records cancelledAt timestamp');

      // Verify zero orders created for this customer
      const count = await prisma.order.count({
        where: { restaurant_id: tenantA.id, customer_phone: custCancel }
      });
      assert(count === 0, 'Zero rows created in orders table on cancellation');
    }

    // -------------------------------------------------------------
    // TEST GROUP 5: Order Reference Collision Resilience
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Order Reference Collision Resilience ---');

    // 10. Cryptographic format: RP-YYMMDD-XXXX
    {
      const ref = generateOrderReference();
      const parts = ref.split('-');
      assert(parts.length === 3, 'Order reference has 3 dash-separated parts');
      assert(parts[0] === 'RP', 'Prefix is RP');
      assert(parts[1].length === 6, 'Date part has 6 characters (YYMMDD)');
      assert(parts[2].length === 4, 'Suffix has 4 characters');
    }

    // 11. Bounded collision retry handling
    {
      const mockOrderData = {
        restaurant_id: tenantA.id,
        customer_phone: '919825100000',
        order_type: 'TAKEAWAY',
        items: [{ sku: 'TEST', qty: 1 }],
        total_amount: 100.00,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      };

      // Create an order directly
      const firstOrder = await prisma.order.create({
        data: {
          ...mockOrderData,
          order_reference: 'RP-261105-COLL'
        }
      });
      createdOrderIds.push(firstOrder.id);

      // Verify createOrderWithReferenceRetry generates non-colliding references
      const safeOrder = await createOrderWithReferenceRetry(prisma, mockOrderData);
      assert(safeOrder.order_reference !== 'RP-261105-COLL', 'createOrderWithReferenceRetry assigns unique reference');
      createdOrderIds.push(safeOrder.id);
    }

    // -------------------------------------------------------------
    // TEST GROUP 6: Multi-Tenant & Cross-Customer Isolation
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Multi-Tenant & Cross-Customer Isolation ---');

    // 12. Cross-tenant confirmation attempt blocked
    {
      const custCross = `9198261${Math.floor(10000 + Math.random() * 90000)}`;
      const cartA = await processIncomingCart(tenantA.id, custCross, standardCartPayload);
      createdSessionIds.push(cartA.session.id);
      const tokenA = cartA.confirmationToken;

      // Advance Tenant A session to AWAITING_CONFIRMATION
      await prisma.conversationSession.update({
        where: { id: cartA.session.id },
        data: {
          current_step: 'AWAITING_CONFIRMATION',
          state: {
            cart: cartA.cart,
            confirmationToken: tokenA,
            orderType: 'TAKEAWAY'
          }
        }
      });

      // Attempt to confirm Tenant A's token at Tenant B
      const crossRes = await handleIncomingMessage(tenantB.id, custCross, {
        messageType: 'button',
        buttonReply: { payload: `BTN_CONFIRM_ORDER:${tokenA}` }
      });

      assert(crossRes.success === false || crossRes.session?.current_step !== 'IDLE', 'Cross-tenant confirmation rejected');
      const orderCountTenantB = await prisma.order.count({
        where: { restaurant_id: tenantB.id, customer_phone: custCross }
      });
      assert(orderCountTenantB === 0, 'Zero orders created at Tenant B for Tenant A token');
    }

    // -------------------------------------------------------------
    // TEST GROUP 7: Webhook Pipeline Integration (HTTP POST)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Webhook Pipeline Integration (HTTP POST) ---');
    const custWh = `9198271${Math.floor(10000 + Math.random() * 90000)}`;
    const wamidConfirm = `wamid.CONFIRM_${Date.now()}`;

    // Setup session at AWAITING_CONFIRMATION
    const cartWhRes = await processIncomingCart(tenantA.id, custWh, standardCartPayload);
    createdSessionIds.push(cartWhRes.session.id);
    const whToken = cartWhRes.confirmationToken;

    await prisma.conversationSession.update({
      where: { id: cartWhRes.session.id },
      data: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          cart: cartWhRes.cart,
          confirmationToken: whToken,
          orderType: 'TAKEAWAY'
        }
      }
    });

    // 13. HTTP POST confirm button webhook returns HTTP 200 and creates Order
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550001111',
                    phone_number_id: tenantA.phone_number_id
                  },
                  messages: [
                    {
                      from: custWh,
                      id: wamidConfirm,
                      timestamp: '1793894000',
                      type: 'button',
                      button: {
                        payload: `BTN_CONFIRM_ORDER:${whToken}`,
                        text: '✅ Confirm Order'
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

      const rawBody = JSON.stringify(payload);
      const signature = computeSignature(rawBody, config.meta.appSecret);

      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature
        },
        body: rawBody
      });

      assert(res.statusCode === 200, 'HTTP POST confirm button returns HTTP 200');

      const ev = await prisma.webhookEvent.findUnique({ where: { event_key: wamidConfirm } });
      assert(ev !== null && ev.processing_status === 'COMPLETED', 'Confirm webhookEvent marked COMPLETED in database');
      createdWebhookEventIds.push(ev.id);

      const createdOrder = await prisma.order.findUnique({
        where: { confirmation_token: whToken }
      });
      assert(createdOrder !== null, 'Order record created via webhook HTTP POST pipeline');
      assert(createdOrder.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order status is PENDING_RESTAURANT_CONFIRMATION via webhook');
      createdOrderIds.push(createdOrder.id);
    }

  } catch (err) {
    console.error('\n❌ Unexpected error during Stage 4.4 test execution:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up test artifacts ---');
    try {
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
      if (createdSavedAddressIds.length > 0) {
        await prisma.savedAddress.deleteMany({
          where: { id: { in: createdSavedAddressIds } }
        });
      }
      if (createdWebhookEventIds.length > 0) {
        await prisma.webhookEvent.deleteMany({
          where: { id: { in: createdWebhookEventIds } }
        });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }

    if (server) {
      server.close();
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 4.4 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage4FulfilmentTests();
}

module.exports = { runStage4FulfilmentTests };

