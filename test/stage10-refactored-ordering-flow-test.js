/**
 * RESTOPRO — Comprehensive Ordering Flow Test Suite (Stage 10 Refactor)
 *
 * Verifies all 26 scenarios defined in the UX specification:
 *  1. New customer greeting (interactive catalog message entry point)
 *  2. Catalogue order ingestion
 *  3. Cart creation and subtotal calculation (exact integer cents)
 *  4. Address selection options (buttons for Share Location, Enter Manually, Cancel Order)
 *  5. Saved address selection (interactive list reuse)
 *  6. Manual address collection (validation + phone number / ID defense)
 *  7. Location request & incoming location handling (direct normalization)
 *  8. Address save consent ('Save Address' persists to CustomerSavedAddress)
 *  9. Use Once behavior ('Use Once' does NOT persist to database)
 * 10. Home Delivery (requires address)
 * 11. Takeaway (no address required, Pay at Counter)
 * 12. Order summary calculations (structured confirmation breakdown)
 * 13. Minimum order / invalid quantity validation
 * 14. Confirm Order (Order created with PENDING_RESTAURANT_CONFIRMATION)
 * 15. Cancel Order (session reset to IDLE, no order created)
 * 16. Duplicate confirmation callbacks (idempotency token guard)
 * 17. Duplicate webhook delivery (idempotency layer drops duplicate)
 * 18. Invalid button callbacks (rejected for current state)
 * 19. Unexpected customer messages (max 2 reprompts + silent fallback)
 * 20. Expired conversation sessions (treated as IDLE)
 * 21. Multiple customers (state isolation)
 * 22. Multiple restaurants / tenant isolation
 * 23. Outbox creation and idempotency
 * 24. Owner notification (atomic outbox message with ACCEPT/REJECT)
 * 25. Customer confirmation receipt (order reference acknowledgment)
 * 26. Meta API failures and retry behavior (transient 503 vs terminal 400)
 */
require('./load-test-env');

const crypto = require('crypto');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const { NotificationWorker } = require('../src/jobs/notification-worker');
const { updateOutboxResult } = require('../src/services/outbox.service');
const {
  handleIncomingMessage,
  processIncomingCart,
  validateActionForStep,
  generateConfirmationToken,
  calculateSessionExpiry
} = require('../src/services/conversation.service');
const {
  validateTextAddress,
  normalizeAddress,
  findCustomerSavedAddresses,
  saveConsentedAddress
} = require('../src/services/address.service');
const {
  buildOrderSummary,
  createOrderWithReferenceRetry,
  confirmCustomerOrder
} = require('../src/services/order.service');
const {
  buildConversationReplyPayload,
  resolveRestaurantCredentials
} = require('../src/services/whatsapp.service');
const { enqueueConversationReply } = require('../src/services/outbox.service');

const TEST_PORT = 4992;
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

async function runTestSuite() {
  console.log('\n============================================================');
  console.log(' RESTOPRO — REFACTORED ORDERING FLOW (26 SCENARIOS) TEST    ');
  console.log('============================================================\n');

  const createdSessionIds = [];
  const createdOrderIds = [];
  const createdOutboxIds = [];
  const createdSavedAddressIds = [];
  const createdRestaurantIds = [];

  // Start HTTP server for webhook integration scenarios
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, resolve);
  });

  try {
    // Setup isolated tenants
    let tenantA = await prisma.restaurant.findUnique({
      where: { phone_number_id: '111111111111111' }
    });
    let tenantB = await prisma.restaurant.findUnique({
      where: { phone_number_id: '222222222222222' }
    });

    if (!tenantA) {
      tenantA = await prisma.restaurant.create({
        data: {
          name: 'RestPro Alpha Diner',
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
          name: 'RestPro Beta Pizzeria',
          phone_number_id: '222222222222222',
          owner_phone: '+919876500002',
          access_token_encrypted: 'mock_token_beta',
          is_active: true
        }
      });
      createdRestaurantIds.push(tenantB.id);
    }

    const testCustPhone = `919810${Math.floor(100000 + Math.random() * 900000)}`;

    // -------------------------------------------------------------
    // SCENARIO 1: New customer greeting (Welcome message + catalog entry point)
    // -------------------------------------------------------------
    console.log('--- SCENARIO 1: New Customer Greeting ---');
    const wamidHi = `wamid.FLOW_HI_${Date.now()}`;
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_FLOW',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              contacts: [{ profile: { name: 'Omar' }, wa_id: testCustPhone }],
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
      assert(res.statusCode === 200, 'Scenario 1: Greeting webhook returns HTTP 200');

      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: testCustPhone
          }
        }
      });
      assert(session !== null, 'Scenario 1: Session initialized for customer');
      assert(session.current_step === 'AWAITING_CART', 'Scenario 1: Session step is AWAITING_CART');
      assert(session.state.customerName === 'Omar', 'Scenario 1: Customer name extracted from profile');
      if (session) createdSessionIds.push(session.id);

      const outbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidHi}` }
      });
      assert(outbox !== null, 'Scenario 1: Outbox message enqueued for greeting');
      assert(outbox.payload?.type === 'interactive' && outbox.payload?.interactive?.type === 'catalog_message',
        'Scenario 1: Welcome payload is an interactive catalog_message');
      assert(outbox.payload?.interactive?.action?.name === 'catalog_message',
        'Scenario 1: Interactive action name is catalog_message');
      assert(outbox.payload?.interactive?.body?.text.includes('Omar'),
        'Scenario 1: Welcome greeting is personalized with customer name');
      assert(outbox.payload?.interactive?.body?.text.includes('What would you like to enjoy today?'),
        'Scenario 1: Welcome message contains prompt to enjoy food');
      if (outbox) createdOutboxIds.push(outbox.id);
    }

    // -------------------------------------------------------------
    // SCENARIO 2: Catalogue order ingestion
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 2: Catalogue Order Ingestion ---');
    const wamidOrder = `wamid.FLOW_ORDER_${Date.now()}`;
    const cartItems = [
      { product_retailer_id: 'SKU_PIZZA_MARGHERITA', quantity: 2, item_price: 350.00, currency: 'INR' },
      { product_retailer_id: 'SKU_GARLIC_BREAD', quantity: 1, item_price: 120.00, currency: 'INR' }
    ];
    {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_FLOW',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              contacts: [{ profile: { name: 'Omar' }, wa_id: testCustPhone }],
              messages: [{
                from: testCustPhone,
                id: wamidOrder,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'order',
                order: {
                  catalog_id: 'CAT_FLOW',
                  product_items: cartItems
                }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const res = await makeWebhookRequest(payload);
      assert(res.statusCode === 200, 'Scenario 2: Catalogue order webhook returns HTTP 200');

      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: testCustPhone
          }
        }
      });
      assert(session.current_step === 'AWAITING_ADDRESS_INPUT',
        'Scenario 2: Session step set to AWAITING_ADDRESS_INPUT (no saved address)');
      assert(session.state.cart !== null && Array.isArray(session.state.cart.items),
        'Scenario 2: Cart items persisted in session state');
    }

    // -------------------------------------------------------------
    // SCENARIO 3: Cart creation and subtotal calculation
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 3: Cart Creation & Integer Cents Subtotal ---');
    {
      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: testCustPhone
          }
        }
      });
      // 2 * 350 + 1 * 120 = 820
      assert(session.state.cart.subtotal === 820, 'Scenario 3: Cart subtotal correctly calculated (820)');
      assert(session.state.cart.itemCount === 3, 'Scenario 3: Total item count is 3 (2 pizzas + 1 garlic bread)');
      assert(typeof session.state.confirmationToken === 'string' && session.state.confirmationToken.startsWith('conf_'),
        'Scenario 3: Fresh confirmation token generated and stored');
    }

    // -------------------------------------------------------------
    // SCENARIO 4: Address selection options (Buttons prompt)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 4: Address Selection Options Prompt ---');
    {
      const outbox = await prisma.outboxMessage.findUnique({
        where: { idempotency_key: `reply_${wamidOrder}` }
      });
      assert(outbox !== null, 'Scenario 4: Outbox reply enqueued for cart receipt');
      assert(outbox.payload?.type === 'interactive' && outbox.payload?.interactive?.type === 'button',
        'Scenario 4: Address prompt is an interactive button message');
      assert(outbox.payload?.interactive?.body?.text.includes('Cart Received'),
        'Scenario 4: Body summarizes cart received');
      assert(outbox.payload?.interactive?.body?.text.includes('820.00'),
        'Scenario 4: Body displays formatted subtotal ₹820.00');

      const buttons = outbox.payload?.interactive?.action?.buttons || [];
      const btnShareLoc = buttons.find(b => b.reply.id === 'BTN_SHARE_LOCATION');
      const btnEnterManual = buttons.find(b => b.reply.id === 'BTN_ENTER_MANUAL_ADDRESS');
      const btnCancel = buttons.find(b => b.reply.id === 'BTN_CANCEL_ORDER');

      assert(btnShareLoc !== undefined, 'Scenario 4: Provides BTN_SHARE_LOCATION button');
      assert(btnEnterManual !== undefined, 'Scenario 4: Provides BTN_ENTER_MANUAL_ADDRESS button');
      assert(btnCancel !== undefined, 'Scenario 4: Provides BTN_CANCEL_ORDER button');
      if (outbox) createdOutboxIds.push(outbox.id);
    }

    // -------------------------------------------------------------
    // SCENARIO 5: Saved address selection (Interactive List)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 5: Saved Address Selection ---');
    const custWithSaved = `919820${Math.floor(100000 + Math.random() * 900000)}`;
    const savedAddrRow = await prisma.savedAddress.create({
      data: {
        restaurant_id: tenantA.id,
        customer_phone: custWithSaved,
        label: 'Home',
        address: 'Flat 301, Sunshine Heights, Bandra West, Mumbai 400050',
        latitude: 19.0596,
        longitude: 72.8295
      }
    });
    createdSavedAddressIds.push(savedAddrRow.id);

    {
      // Process cart for customer with saved address
      const cartResult = await processIncomingCart(tenantA.id, custWithSaved, {
        catalog_id: 'CAT_FLOW',
        product_items: [{ product_retailer_id: 'SKU_BURGER', quantity: 1, item_price: 250, currency: 'INR' }]
      }, 'Saeem');
      createdSessionIds.push(cartResult.session.id);

      assert(cartResult.session.current_step === 'AWAITING_ADDRESS_CHOICE',
        'Scenario 5: Customer with saved address transitions to AWAITING_ADDRESS_CHOICE');
      assert(cartResult.action.type === 'PROMPT_ADDRESS_CHOICE',
        'Scenario 5: Action is PROMPT_ADDRESS_CHOICE');

      // Verify payload is interactive list
      const listPayload = buildConversationReplyPayload({
        action: cartResult.action,
        recipientPhone: custWithSaved,
        restaurantName: 'RestPro Alpha Diner'
      });
      assert(listPayload.type === 'interactive' && listPayload.interactive?.type === 'list',
        'Scenario 5: Interactive list generated when saved addresses exist');

      // Customer taps saved address list item
      const selectResult = await handleIncomingMessage(tenantA.id, custWithSaved, {
        messageType: 'interactive',
        interactiveReply: {
          subType: 'list_reply',
          id: `ADDR_SAVED_${savedAddrRow.id}`,
          title: 'Home'
        }
      });
      assert(selectResult.session.current_step === 'AWAITING_ORDER_TYPE',
        'Scenario 5: Selecting saved address skips friction and advances directly to AWAITING_ORDER_TYPE');
      assert(selectResult.session.state.address.addressText.includes('Sunshine Heights'),
        'Scenario 5: Session state stores saved address');
      assert(selectResult.session.state.addressSaved === true,
        'Scenario 5: addressSaved flag is true');
    }

    // -------------------------------------------------------------
    // SCENARIO 6: Manual address collection + Phone Number / ID Defense
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 6: Manual Address Collection & Defense ---');
    {
      // 6a. Reject phone number submitted as address
      const phoneAsAddrResult = validateTextAddress('9876543210');
      assert(phoneAsAddrResult.isValid === false, 'Scenario 6: Pure phone number rejected as address');
      assert(phoneAsAddrResult.error.includes('phone number'), 'Scenario 6: Rejection explains phone number check');

      const plusPhoneResult = validateTextAddress('+91 9876543210');
      assert(plusPhoneResult.isValid === false, 'Scenario 6: International phone number rejected as address');

      // 6b. Reject text shorter than 10 characters
      const shortAddrResult = validateTextAddress('Main Road');
      assert(shortAddrResult.isValid === false, 'Scenario 6: Text under 10 chars rejected');

      // 6c. Accept valid manual address
      const validManual = 'Flat 402, Sea View Apartments, Worli, Mumbai 400018';
      const validResult = validateTextAddress(validManual);
      assert(validResult.isValid === true, 'Scenario 6: Valid detailed text address accepted');
      assert(validResult.addressText === validManual, 'Scenario 6: Text normalized accurately');
    }

    // -------------------------------------------------------------
    // SCENARIO 7: Location request & incoming location handling
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 7: Location Request & Direct Normalization ---');
    const custLoc = `919830${Math.floor(100000 + Math.random() * 900000)}`;
    {
      // Customer starts cart
      const cartRes = await processIncomingCart(tenantA.id, custLoc, {
        catalog_id: 'CAT_FLOW',
        product_items: [{ product_retailer_id: 'SKU_PASTA', quantity: 1, item_price: 300, currency: 'INR' }]
      });
      createdSessionIds.push(cartRes.session.id);

      // Customer taps "Share Location"
      const tapLocRes = await handleIncomingMessage(tenantA.id, custLoc, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_SHARE_LOCATION' }
      });
      assert(tapLocRes.session.current_step === 'AWAITING_LOCATION',
        'Scenario 7: Tapping Share Location advances to AWAITING_LOCATION');
      assert(tapLocRes.action.type === 'PROMPT_LOCATION_REQUEST',
        'Scenario 7: Action is PROMPT_LOCATION_REQUEST');

      // Verify Meta location_request_message payload
      const locPayload = buildConversationReplyPayload({
        action: tapLocRes.action,
        recipientPhone: custLoc
      });
      assert(locPayload.interactive?.type === 'location_request_message',
        'Scenario 7: Generates official Meta Cloud API location_request_message');
      assert(locPayload.interactive?.action?.name === 'send_location',
        'Scenario 7: Interactive action name is send_location');

      // Customer sends location pin
      const pinRes = await handleIncomingMessage(tenantA.id, custLoc, {
        messageType: 'location',
        location: {
          latitude: 19.0760,
          longitude: 72.8777,
          name: 'BKC Business Hub',
          address: 'Bandra Kurla Complex, Mumbai'
        }
      });
      assert(pinRes.session.current_step === 'AWAITING_LOCATION_DETAILS',
        'Scenario 7: Location pin transitions to AWAITING_LOCATION_DETAILS');
      assert(pinRes.action.type === 'PROMPT_LOCATION_DETAILS',
        'Scenario 7: Action prompts for room and building name');

      // Customer provides room and building details per R6.3
      const detailsRes = await handleIncomingMessage(tenantA.id, custLoc, {
        messageType: 'text',
        text: 'Suite 502, Platina Building'
      });
      assert(detailsRes.session.current_step === 'AWAITING_SAVE_CONSENT',
        'Scenario 7: Details submission transitions to AWAITING_SAVE_CONSENT');
      assert(detailsRes.session.state.address.source === 'LOCATION_PIN',
        'Scenario 7: Address source is LOCATION_PIN');
      assert(detailsRes.session.state.address.latitude === 19.0760,
        'Scenario 7: Latitude preserved');
      assert(detailsRes.session.state.address.longitude === 72.8777,
        'Scenario 7: Longitude preserved');
    }

    // -------------------------------------------------------------
    // SCENARIO 8: Address save consent ('Save Address')
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 8: Address Save Consent (Save Address) ---');
    {
      const saveRes = await handleIncomingMessage(tenantA.id, custLoc, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CONSENT_YES' }
      });
      assert(saveRes.session.current_step === 'AWAITING_ORDER_TYPE',
        'Scenario 8: Consent YES advances to AWAITING_ORDER_TYPE');
      assert(saveRes.session.state.addressSaved === true,
        'Scenario 8: addressSaved set to true');

      const dbAddr = await prisma.savedAddress.findFirst({
        where: { restaurant_id: tenantA.id, customer_phone: custLoc }
      });
      assert(dbAddr !== null, 'Scenario 8: Address record durably created in CustomerSavedAddress');
      assert(Number(dbAddr.latitude) === 19.0760, 'Scenario 8: Database record preserves coordinates');
      if (dbAddr) createdSavedAddressIds.push(dbAddr.id);
    }

    // -------------------------------------------------------------
    // SCENARIO 9: Use Once behavior (not saved in database)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 9: Use Once Behavior ---');
    const custUseOnce = `919840${Math.floor(100000 + Math.random() * 900000)}`;
    {
      await processIncomingCart(tenantA.id, custUseOnce, {
        catalog_id: 'CAT_FLOW',
        product_items: [{ product_retailer_id: 'SKU_ROLL', quantity: 1, item_price: 150, currency: 'INR' }]
      });

      // Submit manual text address
      await handleIncomingMessage(tenantA.id, custUseOnce, {
        messageType: 'text',
        text: 'Suite 901, Crystal Towers, Prabhadevi, Mumbai 400025'
      });

      // Customer taps "Use Once"
      const useOnceRes = await handleIncomingMessage(tenantA.id, custUseOnce, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CONSENT_NO' }
      });
      assert(useOnceRes.session.current_step === 'AWAITING_ORDER_TYPE',
        'Scenario 9: Use Once advances to AWAITING_ORDER_TYPE');
      assert(useOnceRes.session.state.addressSaved === false,
        'Scenario 9: addressSaved is false');
      assert(useOnceRes.session.state.address !== null,
        'Scenario 9: Address retained in session state for active order');

      // Verify NOT saved in database
      const dbSavedCount = await prisma.savedAddress.count({
        where: { restaurant_id: tenantA.id, customer_phone: custUseOnce }
      });
      assert(dbSavedCount === 0, 'Scenario 9: Zero records created in CustomerSavedAddress on Use Once');
    }

    // -------------------------------------------------------------
    // SCENARIO 10: Home Delivery (requires address)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 10: Home Delivery Selection ---');
    {
      const delivRes = await handleIncomingMessage(tenantA.id, custLoc, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_DELIVERY' }
      });
      assert(delivRes.session.current_step === 'AWAITING_CONFIRMATION',
        'Scenario 10: Home Delivery advances to AWAITING_CONFIRMATION');
      assert(delivRes.session.state.orderType === 'DELIVERY',
        'Scenario 10: Order type stored as DELIVERY');
      assert(delivRes.action.type === 'PROMPT_ORDER_CONFIRMATION',
        'Scenario 10: Action is PROMPT_ORDER_CONFIRMATION');
    }

    // -------------------------------------------------------------
    // SCENARIO 11: Takeaway (no address required, Pay at Counter)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 11: Takeaway Selection ---');
    const custTakeaway = `919850${Math.floor(100000 + Math.random() * 900000)}`;
    {
      await processIncomingCart(tenantA.id, custTakeaway, {
        catalog_id: 'CAT_FLOW',
        product_items: [{ product_retailer_id: 'SKU_WRAP', quantity: 2, item_price: 180, currency: 'INR' }]
      }, 'Farhan');

      // Advance to AWAITING_ORDER_TYPE
      await prisma.conversationSession.update({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: custTakeaway
          }
        },
        data: { current_step: 'AWAITING_ORDER_TYPE' }
      });

      // Select Takeaway from order type
      const takeawayRes = await handleIncomingMessage(tenantA.id, custTakeaway, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_TAKEAWAY' }
      });
      assert(takeawayRes.session.current_step === 'AWAITING_CONFIRMATION',
        'Scenario 11: Takeaway succeeds without requiring delivery address');
      assert(takeawayRes.session.state.orderType === 'TAKEAWAY',
        'Scenario 11: Order type is TAKEAWAY');

      const summaryText = takeawayRes.action.summary?.summaryText || takeawayRes.action.summary?.text || takeawayRes.action.message || '';
      assert(summaryText.includes('Takeaway'),
        'Scenario 11: Summary indicates Takeaway (Counter Pickup)');
      assert(summaryText.includes('Pay at Counter'),
        'Scenario 11: Summary specifies Pay at Counter');
    }

    // -------------------------------------------------------------
    // SCENARIO 12: Order summary calculations (Exact structured breakdown)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 12: Order Summary Calculations & Breakdown ---');
    {
      const summary = buildOrderSummary({
        orderType: 'DELIVERY',
        cart: {
          items: [
            { productName: 'Margherita Pizza', quantity: 2, price: 350, unitPrice: 350, subtotal: 700 },
            { productName: 'Garlic Breadsticks', quantity: 1, price: 120, unitPrice: 120, subtotal: 120 }
          ],
          subtotal: 820
        },
        address: { addressText: 'Flat 402, Sea Green Apartments, Worli, Mumbai' },
        customerName: 'Omar',
        currency: 'INR'
      });

      assert(summary.subtotal === 820, 'Scenario 12: Subtotal is 820');
      assert(summary.deliveryFee === 0, 'Scenario 12: Delivery fee is 0 (Free)');
      assert(summary.total === 820, 'Scenario 12: Total payable is 820');
      assert(summary.text.includes('*Confirm Your Order*'), 'Scenario 12: Header is Confirm Your Order');
      assert(summary.text.includes('👤 *Deliver To:* Omar'), 'Scenario 12: Deliver To includes customer name');
      assert(summary.text.includes('📦 *Order Type:* Home Delivery'), 'Scenario 12: Order Type line present');
      assert(summary.text.includes('📍 *Address:* Flat 402'), 'Scenario 12: Formatted address line present');
      assert(summary.text.includes('1. Margherita Pizza (x2) — ₹700.00'), 'Scenario 12: Numbered item line 1');
      assert(summary.text.includes('2. Garlic Breadsticks (x1) — ₹120.00'), 'Scenario 12: Numbered item line 2');
      assert(summary.text.includes('*Total Payable:* ₹820.00 (Pay COD)'), 'Scenario 12: Total payable with Pay COD');
    }

    // -------------------------------------------------------------
    // SCENARIO 13: Minimum order / invalid quantity validation
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 13: Minimum Order / Cart Validation ---');
    {
      const zeroQtyCart = await processIncomingCart(tenantA.id, `919860${Date.now().toString().slice(-6)}`, {
        catalog_id: 'CAT_TEST',
        product_items: [{ product_retailer_id: 'SKU_TEST', quantity: 0, item_price: 100, currency: 'INR' }]
      });
      assert(zeroQtyCart.success === false, 'Scenario 13: Zero quantity cart rejected');
      assert(zeroQtyCart.code === 'INVALID_QUANTITY', 'Scenario 13: Rejection code is INVALID_QUANTITY');

      const negativePriceCart = await processIncomingCart(tenantA.id, `919860${Date.now().toString().slice(-6)}`, {
        catalog_id: 'CAT_TEST',
        product_items: [{ product_retailer_id: 'SKU_TEST', quantity: 1, item_price: -50, currency: 'INR' }]
      });
      assert(negativePriceCart.success === false, 'Scenario 13: Negative price cart rejected');
      assert(negativePriceCart.code === 'NEGATIVE_PRICE', 'Scenario 13: Rejection code is NEGATIVE_PRICE');
    }

    // -------------------------------------------------------------
    // SCENARIO 14: Confirm Order (PENDING_RESTAURANT_CONFIRMATION)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 14: Confirm Order ---');
    let confirmedOrderId = null;
    let confirmedOrderToken = null;
    {
      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: custLoc
          }
        }
      });
      confirmedOrderToken = session.state.confirmationToken;

      const confirmRes = await handleIncomingMessage(tenantA.id, custLoc, {
        messageType: 'button',
        buttonReply: { payload: `BTN_CONFIRM_ORDER:${confirmedOrderToken}` }
      });
      assert(confirmRes.success === true, 'Scenario 14: Confirm button returns success: true');
      assert(confirmRes.action.type === 'ORDER_CONFIRMED', 'Scenario 14: Action is ORDER_CONFIRMED');

      const orderInDb = await prisma.order.findUnique({
        where: { confirmation_token: confirmedOrderToken }
      });
      assert(orderInDb !== null, 'Scenario 14: Order physically created in database');
      assert(orderInDb.status === 'PENDING_RESTAURANT_CONFIRMATION',
        'Scenario 14: Order status is PENDING_RESTAURANT_CONFIRMATION');
      assert(Number(orderInDb.total_amount) === 300, 'Scenario 14: Order total_amount is 300.00');
      assert(orderInDb.order_type === 'DELIVERY', 'Scenario 14: Order type is DELIVERY');

      confirmedOrderId = orderInDb.id;
      createdOrderIds.push(confirmedOrderId);

      // Enqueue outbound customer receipt as webhook controller does
      if (confirmRes.action) {
        const receiptMsg = await enqueueConversationReply({
          restaurantId: tenantA.id,
          customerPhone: custLoc,
          action: confirmRes.action,
          inboundMessageId: `wamid.CONFIRM_${Date.now()}`,
          restaurantName: tenantA.name
        });
        if (receiptMsg) createdOutboxIds.push(receiptMsg.id);
      }

      // Verify conversation session reset to IDLE
      const afterSession = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: custLoc
          }
        }
      });
      assert(afterSession.current_step === 'IDLE', 'Scenario 14: Conversation session reset to IDLE');
    }

    // -------------------------------------------------------------
    // SCENARIO 15: Cancel Order (session reset to IDLE, zero orders created)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 15: Cancel Order ---');
    const custCancel = `919870${Math.floor(100000 + Math.random() * 900000)}`;
    {
      await processIncomingCart(tenantA.id, custCancel, {
        catalog_id: 'CAT_FLOW',
        product_items: [{ product_retailer_id: 'SKU_SOUP', quantity: 1, item_price: 180, currency: 'INR' }]
      });

      const cancelRes = await handleIncomingMessage(tenantA.id, custCancel, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CANCEL_ORDER' }
      });
      assert(cancelRes.success === true, 'Scenario 15: Cancel button returns success: true');
      assert(cancelRes.action.type === 'ORDER_CANCELLED', 'Scenario 15: Action is ORDER_CANCELLED');

      const s = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: custCancel
          }
        }
      });
      assert(s.current_step === 'IDLE', 'Scenario 15: Session reset to IDLE on cancel');

      const orderCount = await prisma.order.count({
        where: { restaurant_id: tenantA.id, customer_phone: custCancel }
      });
      assert(orderCount === 0, 'Scenario 15: ZERO order records created on cancellation');
    }

    // -------------------------------------------------------------
    // SCENARIO 16: Duplicate confirmation callbacks (Idempotency token guard)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 16: Duplicate Confirmation Callbacks ---');
    {
      const replayRes = await handleIncomingMessage(tenantA.id, custLoc, {
        messageType: 'button',
        buttonReply: { payload: `BTN_CONFIRM_ORDER:${confirmedOrderToken}` }
      });
      assert(replayRes.success === true, 'Scenario 16: Replay returns success: true');
      assert(replayRes.isDuplicate === true, 'Scenario 16: Intercepted duplicate with isDuplicate = true');
      assert(replayRes.order.id === confirmedOrderId, 'Scenario 16: Returns existing order record');

      const count = await prisma.order.count({
        where: { confirmation_token: confirmedOrderToken }
      });
      assert(count === 1, 'Scenario 16: Exactly 1 order exists for token (Zero duplicate orders)');
    }

    // -------------------------------------------------------------
    // SCENARIO 17: Duplicate webhook delivery
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 17: Duplicate Webhook Delivery ---');
    {
      // Re-send the exact payload from Scenario 1
      const dupePayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_FLOW',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: tenantA.phone_number_id },
              messages: [{
                from: testCustPhone,
                id: wamidHi, // identical message ID
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'Hi' }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const dupeRes = await makeWebhookRequest(dupePayload);
      assert(dupeRes.statusCode === 200, 'Scenario 17: Duplicate webhook acknowledged with HTTP 200');

      const outboxReplies = await prisma.outboxMessage.findMany({
        where: { idempotency_key: `reply_${wamidHi}` }
      });
      assert(outboxReplies.length === 1, 'Scenario 17: Exactly 1 outbox reply exists (Zero duplicate replies)');
    }

    // -------------------------------------------------------------
    // SCENARIO 18: Invalid button callbacks
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 18: Invalid Button Callbacks ---');
    {
      // Try to confirm an order while in IDLE
      const isValidInIdle = validateActionForStep('IDLE', 'BTN_CONFIRM_ORDER:conf_fake', null, {});
      assert(isValidInIdle === false, 'Scenario 18: BTN_CONFIRM_ORDER strictly rejected in IDLE');

      // Try order type button in AWAITING_CART
      const isValidInCart = validateActionForStep('AWAITING_CART', 'BTN_ORDER_DELIVERY', null, {});
      assert(isValidInCart === false, 'Scenario 18: BTN_ORDER_DELIVERY strictly rejected in AWAITING_CART');
    }

    // -------------------------------------------------------------
    // SCENARIO 19: Unexpected customer messages (Max 2 Reminders & Silent Fallback)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 19: Unexpected Messages & Silent Fallback ---');
    const custSpam = `919880${Math.floor(100000 + Math.random() * 900000)}`;
    {
      // Customer has already greeted and is in AWAITING_CART
      const spamSession = await prisma.conversationSession.create({
        data: {
          restaurant_id: tenantA.id,
          customer_phone: custSpam,
          current_step: 'AWAITING_CART',
          state: { unsupportedCount: 0 },
          expires_at: new Date(Date.now() + 3600000)
        }
      });
      createdSessionIds.push(spamSession.id);

      // 1st unexpected message
      const r1 = await handleIncomingMessage(tenantA.id, custSpam, { messageType: 'sticker' });
      assert(r1.action.type === 'CONTEXTUAL_REPROMPT', 'Scenario 19: 1st unexpected input triggers reprompt');
      assert(r1.action.repromptCount === 1, 'Scenario 19: Reprompt count is 1');

      // 2nd unexpected message
      const r2 = await handleIncomingMessage(tenantA.id, custSpam, { messageType: 'audio' });
      assert(r2.action.type === 'CONTEXTUAL_REPROMPT', 'Scenario 19: 2nd unexpected input triggers reprompt');
      assert(r2.action.repromptCount === 2, 'Scenario 19: Reprompt count is 2');

      // 3rd unexpected message -> Silent fallback
      const r3 = await handleIncomingMessage(tenantA.id, custSpam, { messageType: 'image' });
      assert(r3.action.type === 'SILENT_FALLBACK', 'Scenario 19: 3rd unexpected input triggers SILENT_FALLBACK');

      const spamOutbox = await prisma.outboxMessage.findFirst({
        where: { recipient_phone: custSpam, idempotency_key: { contains: 'SILENT' } }
      });
      assert(spamOutbox === null, 'Scenario 19: Zero outbox messages created for silent fallback');
    }

    // -------------------------------------------------------------
    // SCENARIO 20: Expired conversation sessions
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 20: Expired Conversation Sessions ---');
    const custExp = `919890${Math.floor(100000 + Math.random() * 900000)}`;
    {
      // Create session expired 5 hours ago
      const expiredSession = await prisma.conversationSession.create({
        data: {
          restaurant_id: tenantA.id,
          customer_phone: custExp,
          current_step: 'AWAITING_CONFIRMATION',
          state: {
            cart: { subtotal: 9999 },
            confirmationToken: 'conf_stale_12345'
          },
          expires_at: new Date(Date.now() - 5 * 3600 * 1000)
        }
      });
      createdSessionIds.push(expiredSession.id);

      // Customer sends new greeting
      const freshRes = await handleIncomingMessage(tenantA.id, custExp, {
        messageType: 'text',
        text: 'Hi'
      });
      assert(freshRes.session.current_step === 'AWAITING_CART',
        'Scenario 20: Expired session recovered and transitioned to AWAITING_CART');
      assert(freshRes.session.state.cart === undefined || freshRes.session.state.cart === null,
        'Scenario 20: Stale order cart cleared on expiry recovery');
    }

    // -------------------------------------------------------------
    // SCENARIO 21: Multiple customers (State isolation)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 21: Multiple Customers State Isolation ---');
    const custMulti1 = `919901${Math.floor(100000 + Math.random() * 900000)}`;
    const custMulti2 = `919902${Math.floor(100000 + Math.random() * 900000)}`;
    {
      const res1 = await processIncomingCart(tenantA.id, custMulti1, {
        catalog_id: 'CAT_FLOW',
        product_items: [{ product_retailer_id: 'SKU_1', quantity: 1, item_price: 200, currency: 'INR' }]
      });
      const res2 = await processIncomingCart(tenantA.id, custMulti2, {
        catalog_id: 'CAT_FLOW',
        product_items: [{ product_retailer_id: 'SKU_2', quantity: 3, item_price: 100, currency: 'INR' }]
      });

      assert(res1.session.id !== res2.session.id, 'Scenario 21: Customer 1 and 2 have distinct session IDs');
      assert(res1.cart.subtotal === 200, 'Scenario 21: Customer 1 subtotal is 200');
      assert(res2.cart.subtotal === 300, 'Scenario 21: Customer 2 subtotal is 300');
      assert(res1.session.customer_phone === custMulti1, 'Scenario 21: Customer 1 session scoped');
      assert(res2.session.customer_phone === custMulti2, 'Scenario 21: Customer 2 session scoped');
      createdSessionIds.push(res1.session.id, res2.session.id);
    }

    // -------------------------------------------------------------
    // SCENARIO 22: Multiple restaurants / Tenant isolation
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 22: Multiple Restaurants Tenant Isolation ---');
    {
      const credsA = await resolveRestaurantCredentials(tenantA.id);
      const credsB = await resolveRestaurantCredentials(tenantB.id);

      assert(credsA.phoneNumberId === tenantA.phone_number_id, 'Scenario 22: Tenant A resolves Tenant A phone_number_id');
      assert(credsB.phoneNumberId === tenantB.phone_number_id, 'Scenario 22: Tenant B resolves Tenant B phone_number_id');
      assert(credsA.phoneNumberId !== credsB.phoneNumberId, 'Scenario 22: Phone number IDs strictly distinct');
      assert(credsA.ownerPhone !== credsB.ownerPhone, 'Scenario 22: Owner phones strictly distinct');
    }

    // -------------------------------------------------------------
    // SCENARIO 23: Outbox creation and idempotency
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 23: Outbox Creation & Idempotency ---');
    {
      const testKey = `idemp_test_${Date.now()}`;
      const msg1 = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: testCustPhone,
          message_type: 'CUSTOMER_CONVERSATION_REPLY',
          payload: { text: { body: 'Test idempotency' } },
          idempotency_key: testKey,
          status: 'PENDING'
        }
      });
      createdOutboxIds.push(msg1.id);

      let duplicateBlocked = false;
      try {
        await prisma.outboxMessage.create({
          data: {
            restaurant_id: tenantA.id,
            recipient_phone: testCustPhone,
            message_type: 'CUSTOMER_CONVERSATION_REPLY',
            payload: { text: { body: 'Test idempotency dupe' } },
            idempotency_key: testKey,
            status: 'PENDING'
          }
        });
      } catch (err) {
        duplicateBlocked = err.code === 'P2002';
      }
      assert(duplicateBlocked === true, 'Scenario 23: Duplicate idempotency key blocked by database unique constraint');
    }

    // -------------------------------------------------------------
    // SCENARIO 24: Owner notification
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 24: Owner Notification ---');
    {
      const ownerOutbox = await prisma.outboxMessage.findFirst({
        where: {
          restaurant_id: tenantA.id,
          message_type: 'OWNER_ORDER_NOTIFICATION',
          idempotency_key: `owner_notif_${confirmedOrderId}`
        }
      });
      assert(ownerOutbox !== null, 'Scenario 24: Owner outbox message created for confirmed order');
      assert(ownerOutbox.recipient_phone === tenantA.owner_phone.trim(),
        'Scenario 24: Recipient phone matches restaurant owner_phone');
      assert(ownerOutbox.payload?.type === 'interactive', 'Scenario 24: Owner notification is interactive');

      const ownerButtons = ownerOutbox.payload?.interactive?.action?.buttons || [];
      const acceptBtn = ownerButtons.find(b => b.reply.id.startsWith('OWNER_ACCEPT:'));
      const rejectBtn = ownerButtons.find(b => b.reply.id.startsWith('OWNER_REJECT:'));
      assert(acceptBtn !== undefined, 'Scenario 24: Provides OWNER_ACCEPT button');
      assert(rejectBtn !== undefined, 'Scenario 24: Provides OWNER_REJECT button');
      if (ownerOutbox) createdOutboxIds.push(ownerOutbox.id);
    }

    // -------------------------------------------------------------
    // SCENARIO 25: Customer confirmation receipt
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 25: Customer Confirmation Receipt ---');
    {
      const receiptOutbox = await prisma.outboxMessage.findFirst({
        where: {
          restaurant_id: tenantA.id,
          recipient_phone: custLoc,
          message_type: 'CUSTOMER_CONVERSATION_REPLY',
          idempotency_key: { contains: 'CONFIRM' }
        }
      });
      assert(receiptOutbox !== null, 'Scenario 25: Customer receipt outbox message enqueued');
      const body = receiptOutbox.payload?.text?.body || '';
      assert(body.includes('RP-'), 'Scenario 25: Customer receipt contains order reference (RP- prefix)');
      assert(body.includes('placed') || body.includes('confirmed') || body.includes('received'),
        'Scenario 25: Receipt confirms order was placed/received');
      if (receiptOutbox) createdOutboxIds.push(receiptOutbox.id);
    }

    // -------------------------------------------------------------
    // SCENARIO 26: Meta API failures and retry behavior
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 26: Meta API Failures & Retry Behavior ---');
    {
      // Clear out any stale pending messages from prior test scenarios so worker targets this test message
      await prisma.outboxMessage.updateMany({
        where: { status: 'PENDING' },
        data: { status: 'DELIVERED' }
      });

      const worker = new NotificationWorker({ batchSize: 10 });

      // 26a. Transient 503 Server Error -> Retryable (stays PENDING)
      // Pre-lease to worker to prevent external background workers from racing
      const leaseToken503 = crypto.randomUUID();
      const transientMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: testCustPhone,
          message_type: 'CUSTOMER_CONVERSATION_REPLY',
          payload: {
            text: { body: 'Transient 503 test' },
            lease: {
              claimed_by: worker.workerId,
              lease_token: leaseToken503,
              lease_expires_at: new Date(Date.now() + 60000).toISOString(),
              claimed_at: new Date().toISOString()
            }
          },
          idempotency_key: `meta_503_${Date.now()}`,
          status: 'PENDING',
          attempts: 1
        }
      });
      createdOutboxIds.push(transientMsg.id);

      await updateOutboxResult({
        id: transientMsg.id,
        leaseToken: leaseToken503,
        dispatchResult: {
          success: false,
          isRetryable: true,
          statusCode: 503,
          error: 'Meta Server Busy (503)'
        },
        attempts: 1,
        maxAttempts: 5
      });

      const after503 = await prisma.outboxMessage.findUnique({ where: { id: transientMsg.id } });
      assert(after503.status === 'PENDING', 'Scenario 26: Transient 503 error keeps message in PENDING status');
      assert(after503.attempts === 1, 'Scenario 26: Attempt count incremented to 1');
      assert(after503.last_error.includes('503'), 'Scenario 26: last_error records 503 details');

      // 26b. Terminal 400 Bad Request -> Non-retryable (transitions to FAILED)
      const leaseToken400 = crypto.randomUUID();
      const terminalMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: testCustPhone,
          message_type: 'CUSTOMER_CONVERSATION_REPLY',
          payload: {
            text: { body: 'Terminal 400 test' },
            lease: {
              claimed_by: worker.workerId,
              lease_token: leaseToken400,
              lease_expires_at: new Date(Date.now() + 60000).toISOString(),
              claimed_at: new Date().toISOString()
            }
          },
          idempotency_key: `meta_400_${Date.now()}`,
          status: 'PENDING',
          attempts: 1
        }
      });
      createdOutboxIds.push(terminalMsg.id);

      await updateOutboxResult({
        id: terminalMsg.id,
        leaseToken: leaseToken400,
        dispatchResult: {
          success: false,
          isRetryable: false,
          statusCode: 400,
          error: 'Invalid recipient wa_id (400)'
        },
        attempts: 1,
        maxAttempts: 5
      });

      const after400 = await prisma.outboxMessage.findUnique({ where: { id: terminalMsg.id } });
      assert(after400.status === 'FAILED', 'Scenario 26: Non-retryable 400 error immediately sets status to FAILED');
      assert(after400.attempts === 1, 'Scenario 26: Attempt count recorded as 1');
    }

  } catch (err) {
    console.error('\n❌ Uncaught error during test suite execution:', err);
    failedTests++;
  } finally {
    // Teardown
    console.log('\n--- Cleaning up test artifacts ---');
    try {
      if (createdOutboxIds.length > 0) {
        await prisma.outboxMessage.deleteMany({ where: { id: { in: createdOutboxIds } } });
      }
      if (createdSavedAddressIds.length > 0) {
        await prisma.savedAddress.deleteMany({ where: { id: { in: createdSavedAddressIds } } });
      }
      if (createdOrderIds.length > 0) {
        await prisma.orderNotification.deleteMany({ where: { order_id: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdSessionIds.length > 0) {
        await prisma.conversationSession.deleteMany({ where: { id: { in: createdSessionIds } } });
      }
      if (createdRestaurantIds.length > 0) {
        await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } });
      }
    } catch (cleanupErr) {
      console.warn('Warning during test cleanup:', cleanupErr.message);
    }

    if (server && server.close) {
      await new Promise(resolve => server.close(resolve));
    }
    await prisma.$disconnect();
  }

  console.log('\n============================================================');
  console.log(`   REFACTORED FLOW TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite();
