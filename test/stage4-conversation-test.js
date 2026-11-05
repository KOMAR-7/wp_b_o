/**
 * RESTOPRO — Stage 4.2: Deterministic Conversation Engine Test Suite
 * Verifies finite state machine, whitelist validation, contextual re-prompts,
 * 2-reminder limit, silent fallback, session isolation, and webhook integration.
 */
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
  calculateSessionExpiry,
  getContextualPromptForStep,
  INACTIVITY_TTL_MS,
  MAX_CONSECUTIVE_REMINDERS
} = require('../src/services/conversation.service');

const TEST_PORT = 3996;
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

async function runStage4ConversationTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 4.2: CONVERSATION ENGINE TEST SUITE    ');
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

    // -------------------------------------------------------------
    // TEST GROUP 1: Valid Text Input for Implemented States
    // -------------------------------------------------------------
    console.log('--- TEST GROUP 1: Valid Text Input Across States ---');
    const cust1 = `9198611${Math.floor(10000 + Math.random() * 90000)}`;

    // 1. Greeting in IDLE advances to AWAITING_CART
    {
      const event = {
        messageType: 'text',
        text: 'Hi'
      };
      const res = await handleIncomingMessage(tenantA.id, cust1, event);
      assert(res.success === true, 'handleIncomingMessage succeeds for greeting');
      assert(res.session.current_step === 'AWAITING_CART', 'Session step advances from IDLE to AWAITING_CART');
      assert(res.action.type === 'SEND_WELCOME_CATALOG', 'Action is SEND_WELCOME_CATALOG');
      assert(res.session.state.unsupportedCount === 0, 'unsupportedCount initialized to 0');
      createdSessionIds.push(res.session.id);
    }

    // 2. Free-form text inquiry in AWAITING_CART (Decision D-02)
    {
      const event = {
        messageType: 'text',
        text: 'Can I get 2 Chicken Biryanis?'
      };
      const res = await handleIncomingMessage(tenantA.id, cust1, event);
      assert(res.success === true, 'Text inquiry handled in AWAITING_CART');
      assert(res.session.current_step === 'AWAITING_CART', 'State remains AWAITING_CART (no free-form NLP state advancement)');
      assert(res.action.type === 'REDIRECT_TO_CATALOG', 'Action is REDIRECT_TO_CATALOG');
      assert(res.session.state.unsupportedCount === 0, 'unsupportedCount reset on recognized inquiry');
    }

    // 3. Valid text address input in AWAITING_ADDRESS_INPUT
    {
      // Set session to AWAITING_ADDRESS_INPUT
      await prisma.conversationSession.update({
        where: { id: createdSessionIds[0] },
        data: { current_step: 'AWAITING_ADDRESS_INPUT' }
      });

      const event = {
        messageType: 'text',
        text: 'Flat 402, Sea Green Apartments, Bandra West, Mumbai'
      };
      const res = await handleIncomingMessage(tenantA.id, cust1, event);
      assert(res.success === true, 'Address text input accepted in AWAITING_ADDRESS_INPUT');
      assert(res.action.type === 'VALID_TEXT_INPUT', 'Action is VALID_TEXT_INPUT');
      assert(res.action.text === event.text, 'Address text preserved accurately');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Interactive Button & List Whitelist Validation
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Interactive Button & List Whitelist Validation ---');

    // 4. Valid interactive button reply for AWAITING_ADDRESS_CHOICE
    {
      const validChoiceBtn = validateActionForStep('AWAITING_ADDRESS_CHOICE', 'BTN_USE_SAVED_ADDRESS', null, {});
      assert(validChoiceBtn === true, 'BTN_USE_SAVED_ADDRESS is valid in AWAITING_ADDRESS_CHOICE');

      const validNewAddrBtn = validateActionForStep('AWAITING_ADDRESS_CHOICE', 'BTN_ENTER_NEW_ADDRESS', null, {});
      assert(validNewAddrBtn === true, 'BTN_ENTER_NEW_ADDRESS is valid in AWAITING_ADDRESS_CHOICE');
    }

    // 5. Valid interactive list reply for AWAITING_ADDRESS_CHOICE
    {
      const validListReply = validateActionForStep('AWAITING_ADDRESS_CHOICE', null, 'ADDR_SAVED_123', {});
      assert(validListReply === true, 'ADDR_SAVED_123 list ID is valid in AWAITING_ADDRESS_CHOICE');
    }

    // 6. Valid button for AWAITING_SAVE_CONSENT
    {
      const consentYes = validateActionForStep('AWAITING_SAVE_CONSENT', 'BTN_CONSENT_YES', null, {});
      const consentNo = validateActionForStep('AWAITING_SAVE_CONSENT', 'BTN_CONSENT_NO', null, {});
      assert(consentYes && consentNo, 'BTN_CONSENT_YES and BTN_CONSENT_NO are valid in AWAITING_SAVE_CONSENT');
    }

    // 7. Valid button for AWAITING_ORDER_TYPE
    {
      const deliveryBtn = validateActionForStep('AWAITING_ORDER_TYPE', 'BTN_ORDER_DELIVERY', null, {});
      const takeawayBtn = validateActionForStep('AWAITING_ORDER_TYPE', 'BTN_ORDER_TAKEAWAY', null, {});
      assert(deliveryBtn && takeawayBtn, 'BTN_ORDER_DELIVERY and BTN_ORDER_TAKEAWAY are valid in AWAITING_ORDER_TYPE');
    }

    // 8. Valid button for AWAITING_CONFIRMATION with token match
    {
      const activeToken = 'conf_valid_123';
      const validConfirmBtn = validateActionForStep(
        'AWAITING_CONFIRMATION',
        `BTN_CONFIRM_ORDER:${activeToken}`,
        null,
        { confirmationToken: activeToken }
      );
      assert(validConfirmBtn === true, 'BTN_CONFIRM_ORDER with matching token is valid in AWAITING_CONFIRMATION');

      const cancelBtn = validateActionForStep('AWAITING_CONFIRMATION', 'BTN_CANCEL_ORDER', null, {});
      assert(cancelBtn === true, 'BTN_CANCEL_ORDER is valid in AWAITING_CONFIRMATION');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: Invalid Button & List Rejection Defense
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Invalid Action Rejection Defense ---');

    // 9. Invalid button ID in AWAITING_CART
    {
      const invalidBtn = validateActionForStep('AWAITING_CART', 'BTN_CONFIRM_ORDER', null, {});
      assert(invalidBtn === false, 'BTN_CONFIRM_ORDER strictly rejected in AWAITING_CART');
    }

    // 10. Invalid button ID in AWAITING_ORDER_TYPE
    {
      const bogusBtn = validateActionForStep('AWAITING_ORDER_TYPE', 'BTN_BOGUS_ACTION', null, {});
      assert(bogusBtn === false, 'Unrecognized button ID strictly rejected in AWAITING_ORDER_TYPE');
    }

    // 11. Stale / mismatched confirmation token rejected in AWAITING_CONFIRMATION
    {
      const activeToken = 'conf_fresh_999';
      const staleToken = 'conf_stale_111';
      const staleConfirmBtn = validateActionForStep(
        'AWAITING_CONFIRMATION',
        `BTN_CONFIRM_ORDER:${staleToken}`,
        null,
        { confirmationToken: activeToken }
      );
      assert(staleConfirmBtn === false, 'BTN_CONFIRM_ORDER with stale token is strictly rejected');
    }

    // 12. Invalid list ID in other states
    {
      const invalidList = validateActionForStep('AWAITING_ORDER_TYPE', null, 'RANDOM_ROW_ID', {});
      assert(invalidList === false, 'List replies strictly rejected in AWAITING_ORDER_TYPE');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Two Unsupported-Message Re-Prompts & Silent Fallback
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Unsupported Input & 2-Reminder Limit (Decision D-06) ---');
    const custReprompt = `9198622${Math.floor(10000 + Math.random() * 90000)}`;

    // Set up session in AWAITING_CART
    await handleIncomingMessage(tenantA.id, custReprompt, { messageType: 'text', text: 'Hi' });

    // 13. 1st unsupported message -> repromptCount = 1
    {
      const eventBad1 = {
        messageType: 'image', // Unsupported image
        image: { id: 'img_123' }
      };
      const res1 = await handleIncomingMessage(tenantA.id, custReprompt, eventBad1);
      assert(res1.action.type === 'CONTEXTUAL_REPROMPT', '1st unsupported input returns CONTEXTUAL_REPROMPT');
      assert(res1.action.repromptCount === 1, 'Reprompt count is 1');
      assert(res1.session.state.unsupportedCount === 1, 'Session state records unsupportedCount = 1');
    }

    // 14. 2nd unsupported message -> repromptCount = 2
    {
      const eventBad2 = {
        messageType: 'interactive',
        interactiveReply: { subType: 'button_reply', id: 'BTN_INVALID_PREMATURE' }
      };
      const res2 = await handleIncomingMessage(tenantA.id, custReprompt, eventBad2);
      assert(res2.action.type === 'CONTEXTUAL_REPROMPT', '2nd unsupported input returns CONTEXTUAL_REPROMPT');
      assert(res2.action.repromptCount === 2, 'Reprompt count is 2');
      assert(res2.session.state.unsupportedCount === 2, 'Session state records unsupportedCount = 2');
    }

    // 15. 3rd unsupported message -> SILENT_FALLBACK (Going quiet to prevent customer spam)
    {
      const eventBad3 = {
        messageType: 'audio',
        audio: { id: 'aud_123' }
      };
      const res3 = await handleIncomingMessage(tenantA.id, custReprompt, eventBad3);
      assert(res3.action.type === 'SILENT_FALLBACK', '3rd unsupported input triggers SILENT_FALLBACK');
      assert(res3.action.repromptCount === 2, 'Reprompt count capped at 2');
      assert(res3.session.current_step === 'AWAITING_CART', 'State machine step preserved (AWAITING_CART)');
    }

    // -------------------------------------------------------------
    // TEST GROUP 5: Invalid Transition Does Not Mutate Session State
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Session Integrity Under Invalid Input ---');
    const custIntegrity = `9198633${Math.floor(10000 + Math.random() * 90000)}`;

    // Create session with valid cart
    const cartPayload = {
      catalog_id: 'CAT_INTEGRITY',
      product_items: [{ product_retailer_id: 'SKU_PIZZA_X', quantity: 2, item_price: 300.00, currency: 'INR' }]
    };
    const cartRes = await processIncomingCart(tenantA.id, custIntegrity, cartPayload);
    createdSessionIds.push(cartRes.session.id);

    const originalSubtotal = cartRes.session.state.cart.subtotal;
    const originalToken = cartRes.confirmationToken;
    const originalStep = cartRes.session.current_step;

    // Send invalid button while in address step
    const badBtnEvent = {
      messageType: 'button',
      buttonReply: { payload: 'BTN_ORDER_DELIVERY' } // Premature delivery button
    };
    const badRes = await handleIncomingMessage(tenantA.id, custIntegrity, badBtnEvent);

    assert(badRes.session.current_step === originalStep, 'Session current_step unchanged after invalid button');
    assert(badRes.session.state.cart.subtotal === originalSubtotal, 'Cart subtotal uncorrupted after invalid button');
    assert(badRes.session.state.confirmationToken === originalToken, 'Confirmation token preserved after invalid button');

    // -------------------------------------------------------------
    // TEST GROUP 6: Expired Session Handling
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Expired Session Recovery ---');
    const custExpired = `9198644${Math.floor(10000 + Math.random() * 90000)}`;

    // Manually create expired session
    const expiredSess = await prisma.conversationSession.create({
      data: {
        restaurant_id: tenantA.id,
        customer_phone: custExpired,
        current_step: 'AWAITING_CONFIRMATION',
        state: { staleOrderData: true, cart: { subtotal: 999 } },
        expires_at: new Date(Date.now() - 5000) // Expired 5 seconds ago
      }
    });
    createdSessionIds.push(expiredSess.id);

    // Customer sends greeting "Hi" to expired session
    const expiredRes = await handleIncomingMessage(tenantA.id, custExpired, { messageType: 'text', text: 'Hi' });
    assert(expiredRes.session.current_step === 'AWAITING_CART', 'Expired session reset to AWAITING_CART on fresh greeting');
    assert(expiredRes.session.state.staleOrderData === undefined, 'Stale order data cleared from expired session');
    assert(new Date(expiredRes.session.expires_at) > new Date(), 'Session expires_at refreshed to 2 hours in future');

    // -------------------------------------------------------------
    // TEST GROUP 7: Tenant & Customer Isolation
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Multi-Tenant & Customer Isolation ---');
    const sharedPhone = `9198655${Math.floor(10000 + Math.random() * 90000)}`;

    // Customer starts conversation at Tenant A
    const resA = await handleIncomingMessage(tenantA.id, sharedPhone, { messageType: 'text', text: 'Hi' });
    // Same customer starts conversation at Tenant B
    const resB = await handleIncomingMessage(tenantB.id, sharedPhone, { messageType: 'text', text: 'Hello' });

    assert(resA.session.restaurant_id === tenantA.id, 'Session A belongs to Tenant A');
    assert(resB.session.restaurant_id === tenantB.id, 'Session B belongs to Tenant B');
    assert(resA.session.id !== resB.session.id, 'Tenant A and Tenant B have completely isolated sessions');

    createdSessionIds.push(resA.session.id, resB.session.id);

    // -------------------------------------------------------------
    // TEST GROUP 8: Webhook Controller Pipeline Integration
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 8: Webhook Pipeline Integration ---');

    const webhookUser = `9198666${Math.floor(10000 + Math.random() * 90000)}`;
    const wamidGreeting = `wamid.GREET_${Date.now()}`;

    // 16. Valid greeting webhook through HTTP POST /api/webhook
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
                      from: webhookUser,
                      id: wamidGreeting,
                      timestamp: '1793892000',
                      type: 'text',
                      text: { body: 'Hello' }
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

      assert(res.statusCode === 200, 'HTTP POST greeting webhook returns HTTP 200');

      const ev = await prisma.webhookEvent.findUnique({ where: { event_key: wamidGreeting } });
      assert(ev && ev.processing_status === 'COMPLETED', 'Webhook event completed in database');
      createdWebhookEventIds.push(ev.id);

      const sess = await prisma.conversationSession.findUnique({
        where: { restaurant_id_customer_phone: { restaurant_id: tenantA.id, customer_phone: webhookUser } }
      });
      assert(sess && sess.current_step === 'AWAITING_CART', 'Session transitioned to AWAITING_CART via webhook controller');
      createdSessionIds.push(sess.id);
    }

    // 17. Duplicate greeting webhook safely ignored
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
                      from: webhookUser,
                      id: wamidGreeting,
                      timestamp: '1793892000',
                      type: 'text',
                      text: { body: 'Hello' }
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

      assert(res.statusCode === 200, 'Duplicate greeting returns HTTP 200 without duplicate execution');
      const count = await prisma.webhookEvent.count({ where: { event_key: wamidGreeting } });
      assert(count === 1, 'Exactly 1 row exists in webhook_events for event_key');
    }

    // 18. Multiple messages in single webhook
    {
      const multiUser1 = `9198677${Math.floor(10000 + Math.random() * 90000)}`;
      const multiUser2 = `9198688${Math.floor(10000 + Math.random() * 90000)}`;
      const wamidM1 = `wamid.MULTI_TEXT_1_${Date.now()}`;
      const wamidM2 = `wamid.MULTI_TEXT_2_${Date.now()}`;

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
                    { from: multiUser1, id: wamidM1, timestamp: '1793892010', type: 'text', text: { body: 'Hi' } },
                    { from: multiUser2, id: wamidM2, timestamp: '1793892011', type: 'text', text: { body: 'Start' } }
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

      assert(res.statusCode === 200, 'Multi-message text webhook returns HTTP 200');

      const ev1 = await prisma.webhookEvent.findUnique({ where: { event_key: wamidM1 } });
      const ev2 = await prisma.webhookEvent.findUnique({ where: { event_key: wamidM2 } });
      assert(ev1 && ev1.processing_status === 'COMPLETED', 'First message event completed');
      assert(ev2 && ev2.processing_status === 'COMPLETED', 'Second message event completed');
      createdWebhookEventIds.push(ev1.id, ev2.id);

      const s1 = await prisma.conversationSession.findUnique({
        where: { restaurant_id_customer_phone: { restaurant_id: tenantA.id, customer_phone: multiUser1 } }
      });
      const s2 = await prisma.conversationSession.findUnique({
        where: { restaurant_id_customer_phone: { restaurant_id: tenantA.id, customer_phone: multiUser2 } }
      });
      assert(s1 && s1.current_step === 'AWAITING_CART', 'Customer 1 session created');
      assert(s2 && s2.current_step === 'AWAITING_CART', 'Customer 2 session created');
      createdSessionIds.push(s1.id, s2.id);
    }

    // 19. Concurrent state transitions
    {
      const concUser = `9198699${Math.floor(10000 + Math.random() * 90000)}`;

      const results = await Promise.all([
        handleIncomingMessage(tenantA.id, concUser, { messageType: 'text', text: 'Hi' }),
        handleIncomingMessage(tenantA.id, concUser, { messageType: 'text', text: 'Hello' }),
        handleIncomingMessage(tenantA.id, concUser, { messageType: 'text', text: 'Menu' })
      ]);

      const allSuccess = results.every(r => r.success === true);
      assert(allSuccess, 'All 3 concurrent state transitions handled cleanly');

      const s = await prisma.conversationSession.findUnique({
        where: { restaurant_id_customer_phone: { restaurant_id: tenantA.id, customer_phone: concUser } }
      });
      assert(s !== null && s.current_step === 'AWAITING_CART', 'Single consistent session exists after concurrent calls');
      createdSessionIds.push(s.id);
    }

  } finally {
    // Cleanup created test rows
    if (createdSessionIds.length > 0) {
      await prisma.conversationSession.deleteMany({
        where: { id: { in: createdSessionIds } }
      });
    }
    if (createdWebhookEventIds.length > 0) {
      await prisma.webhookEvent.deleteMany({
        where: { id: { in: createdWebhookEventIds } }
      });
    }

    await prisma.$disconnect();

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 4.2 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage4ConversationTests().catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

module.exports = { runStage4ConversationTests };

