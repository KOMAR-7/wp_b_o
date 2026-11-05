/**
 * RESTOPRO — Stage 4.1: Cart Processing & Conversation Session Test Suite
 * Verifies catalogue cart parsing, decimal-safe arithmetic, defensive validation,
 * session cart replacement, confirmation token regeneration, and webhook pipeline.
 */
const crypto = require('crypto');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const {
  parseAndValidateCart,
  toIntegerCents,
  fromIntegerCents,
  isPositiveInteger
} = require('../src/parsers/cart-parser');
const {
  processIncomingCart,
  generateConfirmationToken,
  calculateSessionExpiry,
  INACTIVITY_TTL_MS
} = require('../src/services/conversation.service');

const TEST_PORT = 3995;
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

async function runStage4CartTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 4.1: CART PROCESSING TEST SUITE        ');
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

  // Cleanup trackers
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
    // TEST GROUP 1: Catalogue Cart Parser & Defensive Validation
    // -------------------------------------------------------------
    console.log('--- TEST GROUP 1: Catalogue Cart Parser & Defensive Validation ---');

    // 1. Valid single-item cart
    {
      const cartPayload = {
        catalog_id: 'CAT_123',
        text: 'Less spicy please',
        product_items: [
          { product_retailer_id: 'SKU_BIRYANI_01', quantity: 1, item_price: 250.00, currency: 'INR' }
        ]
      };
      const res = parseAndValidateCart(cartPayload);
      assert(res.isValid === true, 'Valid single-item cart accepted');
      assert(res.cart.subtotal === 250.00, 'Single-item subtotal is 250.00');
      assert(res.cart.itemCount === 1, 'Single-item total item count is 1');
      assert(res.cart.customerNote === 'Less spicy please', 'Customer note extracted');
      assert(res.cart.items[0].productName === 'SKU_BIRYANI_01', 'SKU used as productName display fallback');
    }

    // 2. Valid multi-item cart
    {
      const cartPayload = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_BIRYANI_01', quantity: 2, item_price: 240.00, currency: 'INR' },
          { product_retailer_id: 'SKU_COKE_01', quantity: 1, item_price: 60.00, currency: 'INR' }
        ]
      };
      const res = parseAndValidateCart(cartPayload);
      assert(res.isValid === true, 'Valid multi-item cart accepted');
      assert(res.cart.subtotal === 540.00, 'Multi-item subtotal is 540.00 (2*240 + 1*60)');
      assert(res.cart.itemCount === 3, 'Multi-item total item count is 3 (2 + 1)');
      assert(res.cart.distinctItemCount === 2, 'Distinct item count is 2');
    }

    // 3. Empty cart
    {
      const emptyCart = { catalog_id: 'CAT_123', product_items: [] };
      const res = parseAndValidateCart(emptyCart);
      assert(res.isValid === false, 'Empty cart rejected');
      assert(res.code === 'CART_EMPTY', 'Empty cart returns CART_EMPTY error code');
    }

    // 4. Missing product retailer ID
    {
      const missingSkuCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: '', quantity: 1, item_price: 100.00, currency: 'INR' }
        ]
      };
      const res = parseAndValidateCart(missingSkuCart);
      assert(res.isValid === false, 'Cart with empty product_retailer_id rejected');
      assert(res.code === 'MISSING_PRODUCT_ID', 'Missing SKU returns MISSING_PRODUCT_ID');
    }

    // 5. Invalid quantity (string non-numeric)
    {
      const invalidQtyCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_1', quantity: 'two', item_price: 100.00, currency: 'INR' }
        ]
      };
      const res = parseAndValidateCart(invalidQtyCart);
      assert(res.isValid === false, 'Non-numeric quantity string rejected');
      assert(res.code === 'INVALID_QUANTITY', 'Non-numeric quantity returns INVALID_QUANTITY');
    }

    // 6. Zero and negative quantity
    {
      const zeroQtyCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_1', quantity: 0, item_price: 100.00, currency: 'INR' }
        ]
      };
      const resZero = parseAndValidateCart(zeroQtyCart);
      assert(resZero.isValid === false, 'Zero quantity (0) rejected; never converted to 1');
      assert(resZero.code === 'INVALID_QUANTITY', 'Zero quantity returns INVALID_QUANTITY');

      const negQtyCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_1', quantity: -3, item_price: 100.00, currency: 'INR' }
        ]
      };
      const resNeg = parseAndValidateCart(negQtyCart);
      assert(resNeg.isValid === false, 'Negative quantity (-3) rejected; never converted to 1');
      assert(resNeg.code === 'INVALID_QUANTITY', 'Negative quantity returns INVALID_QUANTITY');
    }

    // 7. Decimal quantity
    {
      const decimalQtyCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_1', quantity: 1.5, item_price: 100.00, currency: 'INR' }
        ]
      };
      const res = parseAndValidateCart(decimalQtyCart);
      assert(res.isValid === false, 'Decimal quantity (1.5) rejected');
      assert(res.code === 'INVALID_QUANTITY', 'Decimal quantity returns INVALID_QUANTITY');
    }

    // 8. Invalid price (non-numeric, NaN)
    {
      const invalidPriceCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_1', quantity: 1, item_price: 'free', currency: 'INR' }
        ]
      };
      const res = parseAndValidateCart(invalidPriceCart);
      assert(res.isValid === false, 'Non-numeric price ("free") rejected');
      assert(res.code === 'INVALID_PRICE', 'Non-numeric price returns INVALID_PRICE');
    }

    // 9. Negative price
    {
      const negPriceCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_1', quantity: 1, item_price: -50.00, currency: 'INR' }
        ]
      };
      const res = parseAndValidateCart(negPriceCart);
      assert(res.isValid === false, 'Negative price (-50) rejected; never converted to 0');
      assert(res.code === 'NEGATIVE_PRICE', 'Negative price returns NEGATIVE_PRICE');
    }

    // 10. Zero price (free item is valid non-negative value)
    {
      const zeroPriceCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_FREE_SAMPLE', quantity: 1, item_price: 0, currency: 'INR' }
        ]
      };
      const res = parseAndValidateCart(zeroPriceCart);
      assert(res.isValid === true, 'Zero price (0.00) accepted as valid non-negative price');
      assert(res.cart.subtotal === 0.00, 'Subtotal for zero-price item is 0.00');
    }

    // 11. Mixed currencies
    {
      const mixedCurrencyCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_1', quantity: 1, item_price: 100.00, currency: 'INR' },
          { product_retailer_id: 'SKU_2', quantity: 1, item_price: 10.00, currency: 'USD' }
        ]
      };
      const res = parseAndValidateCart(mixedCurrencyCart);
      assert(res.isValid === false, 'Mixed currencies (INR vs USD) rejected');
      assert(res.code === 'CURRENCY_MISMATCH', 'Mixed currencies returns CURRENCY_MISMATCH');
    }

    // 12. Missing currency
    {
      const missingCurrencyCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_1', quantity: 1, item_price: 100.00, currency: '' }
        ]
      };
      const res = parseAndValidateCart(missingCurrencyCart);
      assert(res.isValid === false, 'Missing currency rejected');
      assert(res.code === 'INVALID_CURRENCY', 'Missing currency returns INVALID_CURRENCY');
    }

    // 13. Decimal-safe subtotal arithmetic
    {
      // 3 * 19.99 = 59.97, 7 * 9.99 = 69.93. Total = 129.90 (in raw float, 3 * 19.99 = 59.970000000000006)
      const decimalArithmeticCart = {
        catalog_id: 'CAT_123',
        product_items: [
          { product_retailer_id: 'SKU_A', quantity: 3, item_price: 19.99, currency: 'USD' },
          { product_retailer_id: 'SKU_B', quantity: 7, item_price: 9.99, currency: 'USD' }
        ]
      };
      const res = parseAndValidateCart(decimalArithmeticCart);
      assert(res.isValid === true, 'Decimal arithmetic cart accepted');
      assert(res.cart.items[0].subtotal === 59.97, 'Item A subtotal is exactly 59.97');
      assert(res.cart.items[1].subtotal === 69.93, 'Item B subtotal is exactly 69.93');
      assert(res.cart.subtotal === 129.90, 'Cart total is exactly 129.90 without floating-point drift');
    }

    // 14. Malformed payload (null or not an object)
    {
      const nullRes = parseAndValidateCart(null);
      assert(nullRes.isValid === false, 'null payload rejected');
      assert(nullRes.code === 'MALFORMED_ORDER_OBJECT', 'null payload returns MALFORMED_ORDER_OBJECT');

      const stringRes = parseAndValidateCart("invalid");
      assert(stringRes.isValid === false, 'string payload rejected');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Conversation Session & Cart Integration
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Conversation Session & Cart Integration ---');

    const customer1 = `9198765${Math.floor(10000 + Math.random() * 90000)}`;
    const customer2 = `9198766${Math.floor(10000 + Math.random() * 90000)}`;

    const cartA = {
      catalog_id: 'CAT_A',
      product_items: [
        { product_retailer_id: 'SKU_BURGER', quantity: 2, item_price: 120.00, currency: 'INR' }
      ]
    };

    // 15. Initial cart submission creates session
    {
      const result = await processIncomingCart(tenantA.id, customer1, cartA);
      assert(result.success === true, 'processIncomingCart succeeds for initial cart');
      assert(result.session && result.session.id, 'Session created in conversation_sessions');
      assert(result.session.current_step === 'AWAITING_ADDRESS_INPUT', 'Next step set to address collection step (AWAITING_ADDRESS_INPUT)');
      assert(result.session.state.cart.subtotal === 240.00, 'Session state contains normalized cart with subtotal 240.00');
      assert(typeof result.confirmationToken === 'string' && result.confirmationToken.startsWith('conf_'), 'Fresh confirmation token generated');
      assert(result.session.state.confirmationToken === result.confirmationToken, 'Confirmation token stored in session state');

      createdSessionIds.push(result.session.id);
    }

    // 16. Cart replacement on resubmission
    {
      const cartB = {
        catalog_id: 'CAT_A',
        product_items: [
          { product_retailer_id: 'SKU_PIZZA', quantity: 1, item_price: 350.00, currency: 'INR' },
          { product_retailer_id: 'SKU_GARLIC_BREAD', quantity: 1, item_price: 110.00, currency: 'INR' }
        ]
      };

      const prevSession = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: customer1
          }
        }
      });
      const previousToken = prevSession.state.confirmationToken;

      const result = await processIncomingCart(tenantA.id, customer1, cartB);
      assert(result.success === true, 'Cart resubmission succeeds');
      assert(result.session.state.cart.subtotal === 460.00, 'Previous cart replaced entirely (new subtotal = 460.00, not 240+460)');
      assert(result.session.state.cart.items.length === 2, 'New cart has exactly 2 items (old burger discarded)');
      assert(result.session.state.cart.items[0].productRetailerId === 'SKU_PIZZA', 'New item SKU_PIZZA present');

      // 17. Confirmation token regeneration & old token invalidation
      assert(result.confirmationToken !== previousToken, 'Fresh confirmation token generated on cart replacement');
      assert(result.session.state.confirmationToken === result.confirmationToken, 'Session state reflects latest confirmation token');
      assert(result.session.state.confirmationToken !== previousToken, 'Previous confirmation token is completely invalidated');
    }

    // 18. Tenant session isolation
    {
      // Customer 1 places order at Tenant B simultaneously
      const resultTenantB = await processIncomingCart(tenantB.id, customer1, cartA);
      assert(resultTenantB.success === true, 'Same customer can place cart at Tenant B');
      assert(resultTenantB.session.restaurant_id === tenantB.id, 'Tenant B session has restaurant_id of Tenant B');

      createdSessionIds.push(resultTenantB.session.id);

      const sessionTenantA = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: customer1
          }
        }
      });

      assert(sessionTenantA.restaurant_id === tenantA.id, 'Tenant A session restaurant_id preserved');
      assert(sessionTenantA.id !== resultTenantB.session.id, 'Tenant A and Tenant B sessions have distinct IDs (zero state leakage)');
      assert(sessionTenantA.state.cart.subtotal === 460.00, 'Tenant A cart subtotal unchanged by Tenant B cart');
    }

    // 19. Customer session isolation
    {
      const resultCustomer2 = await processIncomingCart(tenantA.id, customer2, cartA);
      assert(resultCustomer2.success === true, 'Customer 2 cart processed at Tenant A');
      assert(resultCustomer2.session.customer_phone === customer2, 'Customer 2 session has customer_phone of Customer 2');

      createdSessionIds.push(resultCustomer2.session.id);

      const sessionCustomer1 = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: customer1
          }
        }
      });

      assert(sessionCustomer1.id !== resultCustomer2.session.id, 'Customer 1 and Customer 2 have distinct session IDs');
      assert(sessionCustomer1.state.cart.subtotal === 460.00, 'Customer 1 cart untouched by Customer 2');
    }

    // 20. 2-Hour inactivity expiry calculation
    {
      const expiry = calculateSessionExpiry();
      const diffMs = expiry.getTime() - Date.now();
      const twoHoursMs = 2 * 60 * 60 * 1000;
      assert(Math.abs(diffMs - twoHoursMs) < 5000, 'calculateSessionExpiry generates timestamp ~2 hours in the future');
    }

    // 21. Expired session reset upon receiving new cart
    {
      const customerExpired = `9198767${Math.floor(10000 + Math.random() * 90000)}`;
      // Create an expired session manually
      const expiredSession = await prisma.conversationSession.create({
        data: {
          restaurant_id: tenantA.id,
          customer_phone: customerExpired,
          current_step: 'AWAITING_CONFIRMATION',
          state: {
            staleData: 'must_be_cleared',
            cart: { subtotal: 999 }
          },
          expires_at: new Date(Date.now() - 1000) // 1 second in past
        }
      });
      createdSessionIds.push(expiredSession.id);

      const res = await processIncomingCart(tenantA.id, customerExpired, cartA);
      assert(res.success === true, 'Cart submission to expired session succeeds');
      assert(res.session.state.staleData === undefined, 'Expired session stale state cleared on cart resubmission');
      assert(res.session.state.cart.subtotal === 240.00, 'Expired session refreshed with new cart');
      assert(new Date(res.session.expires_at) > new Date(), 'Expired session refreshed with future expires_at');
    }

    // 22. Zero Order rows created in this phase
    {
      const ordersBefore = await prisma.order.count();
      await processIncomingCart(tenantA.id, `9198768${Math.floor(10000 + Math.random() * 90000)}`, cartA);
      const ordersAfter = await prisma.order.count();
      assert(ordersBefore === ordersAfter, 'Zero Order records created during cart processing');
    }

    // 23. Concurrent cart updates safety
    {
      const concurrentCustomer = `9198769${Math.floor(10000 + Math.random() * 90000)}`;
      const cart1 = { catalog_id: 'C1', product_items: [{ product_retailer_id: 'S1', quantity: 1, item_price: 10, currency: 'INR' }] };
      const cart2 = { catalog_id: 'C2', product_items: [{ product_retailer_id: 'S2', quantity: 2, item_price: 20, currency: 'INR' }] };
      const cart3 = { catalog_id: 'C3', product_items: [{ product_retailer_id: 'S3', quantity: 3, item_price: 30, currency: 'INR' }] };

      const results = await Promise.all([
        processIncomingCart(tenantA.id, concurrentCustomer, cart1),
        processIncomingCart(tenantA.id, concurrentCustomer, cart2),
        processIncomingCart(tenantA.id, concurrentCustomer, cart3)
      ]);

      const allSucceeded = results.every(r => r.success === true);
      assert(allSucceeded, 'All 3 concurrent cart updates handled cleanly');

      const finalSession = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: concurrentCustomer
          }
        }
      });
      assert(finalSession !== null, 'Exactly one session row exists after concurrent updates');
      assert(finalSession.state.cart && finalSession.state.cart.items.length === 1, 'Final session contains a single, valid, uncorrupted cart');
      createdSessionIds.push(finalSession.id);
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: End-to-End Webhook Pipeline Integration
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: End-to-End Webhook Pipeline Integration ---');

    const webhookCustomer = `9198711${Math.floor(10000 + Math.random() * 90000)}`;
    const wamidValid = `wamid.CART_TEST_${Date.now()}`;

    const validWebhookPayload = {
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
                contacts: [{ profile: { name: 'Alice Customer' }, wa_id: webhookCustomer }],
                messages: [
                  {
                    from: webhookCustomer,
                    id: wamidValid,
                    timestamp: '1793890000',
                    type: 'order',
                    order: {
                      catalog_id: 'CAT_WH_01',
                      text: 'No cutlery needed',
                      product_items: [
                        { product_retailer_id: 'SKU_PANEER_TIKKA', quantity: 2, item_price: 180.00, currency: 'INR' }
                      ]
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

    // 24. Valid catalogue cart webhook processed to HTTP 200
    {
      const rawBody = JSON.stringify(validWebhookPayload);
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

      assert(res.statusCode === 200, 'Valid catalogue cart webhook returns HTTP 200');
      assert(res.body === 'EVENT_RECEIVED', 'Returns EVENT_RECEIVED');

      // Verify webhook_events record exists and status is COMPLETED
      const eventRecord = await prisma.webhookEvent.findUnique({
        where: { event_key: wamidValid }
      });
      assert(eventRecord !== null, 'Webhook event persisted to database');
      assert(eventRecord.processing_status === 'COMPLETED', 'Webhook event processing_status marked COMPLETED');
      createdWebhookEventIds.push(eventRecord.id);

      // Verify session updated
      const session = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenantA.id,
            customer_phone: webhookCustomer
          }
        }
      });
      assert(session !== null, 'Conversation session created via webhook pipeline');
      assert(session.state.cart.subtotal === 360.00, 'Session state cart subtotal is 360.00 (2*180)');
      assert(session.state.cart.customerNote === 'No cutlery needed', 'Customer note persisted in session cart');
      createdSessionIds.push(session.id);
    }

    // 25. Duplicate webhook event safely dropped via event_key
    {
      const rawBody = JSON.stringify(validWebhookPayload);
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

      assert(res.statusCode === 200, 'Duplicate webhook returns HTTP 200 without reprocessing');
      assert(res.body === 'EVENT_RECEIVED', 'Returns EVENT_RECEIVED');

      const count = await prisma.webhookEvent.count({
        where: { event_key: wamidValid }
      });
      assert(count === 1, 'Exactly one row exists in webhook_events for event_key (deduplicated)');
    }

    // 26. Multiple messages in one webhook payload
    {
      const custMulti1 = `9198722${Math.floor(10000 + Math.random() * 90000)}`;
      const custMulti2 = `9198733${Math.floor(10000 + Math.random() * 90000)}`;
      const wamidMulti1 = `wamid.MULTI_1_${Date.now()}`;
      const wamidMulti2 = `wamid.MULTI_2_${Date.now()}`;

      const multiPayload = {
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
                      from: custMulti1,
                      id: wamidMulti1,
                      timestamp: '1793890010',
                      type: 'order',
                      order: {
                        catalog_id: 'CAT_MULTI',
                        product_items: [
                          { product_retailer_id: 'SKU_ITEM_1', quantity: 1, item_price: 150.00, currency: 'INR' }
                        ]
                      }
                    },
                    {
                      from: custMulti2,
                      id: wamidMulti2,
                      timestamp: '1793890011',
                      type: 'order',
                      order: {
                        catalog_id: 'CAT_MULTI',
                        product_items: [
                          { product_retailer_id: 'SKU_ITEM_2', quantity: 2, item_price: 75.00, currency: 'INR' }
                        ]
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

      const rawBody = JSON.stringify(multiPayload);
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

      assert(res.statusCode === 200, 'Multi-message webhook processed to HTTP 200');

      const ev1 = await prisma.webhookEvent.findUnique({ where: { event_key: wamidMulti1 } });
      const ev2 = await prisma.webhookEvent.findUnique({ where: { event_key: wamidMulti2 } });
      assert(ev1 && ev1.processing_status === 'COMPLETED', 'First message event completed');
      assert(ev2 && ev2.processing_status === 'COMPLETED', 'Second message event completed');
      createdWebhookEventIds.push(ev1.id, ev2.id);

      const sess1 = await prisma.conversationSession.findUnique({
        where: { restaurant_id_customer_phone: { restaurant_id: tenantA.id, customer_phone: custMulti1 } }
      });
      const sess2 = await prisma.conversationSession.findUnique({
        where: { restaurant_id_customer_phone: { restaurant_id: tenantA.id, customer_phone: custMulti2 } }
      });
      assert(sess1 && sess1.state.cart.subtotal === 150.00, 'Customer 1 session created with subtotal 150.00');
      assert(sess2 && sess2.state.cart.subtotal === 150.00, 'Customer 2 session created with subtotal 150.00 (2*75)');
      createdSessionIds.push(sess1.id, sess2.id);
    }

    // 27. Malformed cart webhook persists as FAILED
    {
      const wamidBad = `wamid.BAD_CART_${Date.now()}`;
      const badCartPayload = {
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
                      from: `9198799${Math.floor(10000 + Math.random() * 90000)}`,
                      id: wamidBad,
                      timestamp: '1793890020',
                      type: 'order',
                      order: {
                        catalog_id: 'CAT_BAD',
                        product_items: [
                          { product_retailer_id: 'SKU_BAD', quantity: -5, item_price: -20.00, currency: 'INR' }
                        ]
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

      const rawBody = JSON.stringify(badCartPayload);
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

      assert(res.statusCode === 200, 'Malformed cart webhook acknowledged with HTTP 200 to prevent Meta retry loop');

      const badEvent = await prisma.webhookEvent.findUnique({ where: { event_key: wamidBad } });
      assert(badEvent !== null, 'Malformed cart event was persisted to database for audit');
      assert(badEvent.processing_status === 'FAILED', 'Malformed cart marked FAILED in webhook_events');
      assert(typeof badEvent.payload_summary.error === 'string', 'Error message recorded in payload_summary');
      createdWebhookEventIds.push(badEvent.id);
    }

  } finally {
    // Clean up created test records
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
  console.log(`   STAGE 4.1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage4CartTests().catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

module.exports = { runStage4CartTests };

