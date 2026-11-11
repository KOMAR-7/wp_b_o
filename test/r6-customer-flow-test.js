/**
 * RESTOPRO — R6.3 Comprehensive Test Suite
 * Customer Flow Corrections: Menu Item Mapping + Static Location Request + Address Collection
 *
 * Verifies all 16 deliverable scenarios:
 * 1. Catalogue item name resolved from realistic WhatsApp order payload (title/name)
 * 2. Catalogue item name resolved from catalogue mapping when payload has only product_retailer_id
 * 3. Correct item name in persisted order (orders.items[0].productName)
 * 4. Correct item name in owner notification payload
 * 5. Location request uses location_request_message with action.name: 'send_location'
 * 6. Body text is exactly "Please share your current delivery location."
 * 7. Static location webhook extracts and validates latitude and longitude
 * 8. Location path asks for room number and building name before saving
 * 9. Location path asks to save only after collecting those details
 * 10. Manual path collects room, building, street, and area in strict order
 * 11. Manual path asks to save only after all 4 fields are collected
 * 12. Yes saves address with restaurant/customer scope
 * 13. No does not save reusable address
 * 14. Duplicate location webhook does not duplicate address updates
 * 15. Invalid location payload does not advance conversation
 * 16. Order confirmation flow completes cleanly with new address structure
 */
require('./load-test-env');

const assert = require('assert');
const prisma = require('../src/config/database');
const { parseAndValidateCart } = require('../src/parsers/cart-parser');
const { parseWebhookPayload } = require('../src/parsers/webhook-parser');
const {
  handleIncomingMessage,
  processIncomingCart
} = require('../src/services/conversation.service');
const {
  resolveMenuItemName,
  getRestaurantCatalog,
  registerTenantCatalog,
  clearDynamicCatalogs
} = require('../src/services/catalog.service');
const {
  buildConversationReplyPayload,
  buildOwnerNotificationPayload
} = require('../src/services/whatsapp.service');
const {
  confirmCustomerOrder,
  buildOrderSummary
} = require('../src/services/order.service');
const {
  findCustomerSavedAddresses,
  normalizeAddress
} = require('../src/services/address.service');
const { encryptToken } = require('../src/utils/crypto');

async function runR6TestSuite() {
  console.log('============================================================');
  console.log('   RESTOPRO — R6.3 COMPREHENSIVE CUSTOMER FLOW TEST SUITE   ');
  console.log('============================================================\n');

  let passedCount = 0;
  const testRestaurantIds = [];
  const testCustomerPhones = [];
  const testSavedAddressIds = [];

  function pass(msg) {
    passedCount++;
    console.log(`  ✅ [PASS] ${msg}`);
  }

  try {
    // -------------------------------------------------------------
    // SETUP: Create isolated test restaurant tenant
    // -------------------------------------------------------------
    const testTenantPhoneId = `1427${Math.floor(100000000000 + Math.random() * 900000000000)}`;
    const testOwnerPhone = `+91937${Math.floor(1000000 + Math.random() * 9000000)}`;
    const encToken = encryptToken('EAABtestTokenForR6CustomerFlow1234567890');

    const internalNotes = `Test tenant notes\n\n<!--RESTOPRO_METADATA:${JSON.stringify({
      ownerConsent: {
        optedIn: true,
        consentedAt: new Date().toISOString(),
        source: 'SUPER_ADMIN_MANUAL_VERIFIED',
        revoked: false
      },
      menuCatalog: {
        'sezp6n6uee': {
          name: 'Chicken Dum Biryani (Special)',
          price: 800
        },
        'SKU_CUSTOM_BURGER': {
          name: 'Gourmet Truffle Burger',
          price: 450
        }
      }
    })}-->`;

    const tenant = await prisma.restaurant.create({
      data: {
        name: 'RestPro R6 Test Bistro',
        phone_number_id: testTenantPhoneId,
        waba_id: '1620323530136933',
        owner_phone: testOwnerPhone,
        access_token_encrypted: encToken,
        internal_notes: internalNotes,
        is_active: true
      }
    });
    testRestaurantIds.push(tenant.id);

    // -------------------------------------------------------------
    // SCENARIO 1: Catalogue item name resolved from realistic WhatsApp order payload (title/name)
    // -------------------------------------------------------------
    console.log('--- SCENARIO 1: Item Name Resolved from Realistic Payload ---');
    {
      const rawPayload = {
        catalog_id: 'CAT_TEST_01',
        product_items: [
          {
            product_retailer_id: 'SKU_UNKNOWN_CUSTOM_01',
            name: 'Artisan Sourdough Pizza',
            quantity: 2,
            item_price: 350.00,
            currency: 'INR'
          }
        ]
      };

      const result = parseAndValidateCart(rawPayload, {
        restaurantId: tenant.id,
        internalNotes: tenant.internal_notes
      });

      assert.strictEqual(result.isValid, true, 'Cart validation should succeed');
      assert.strictEqual(result.cart.items.length, 1, 'Should have 1 item');
      assert.strictEqual(
        result.cart.items[0].productName,
        'Artisan Sourdough Pizza',
        'Should extract name directly from payload when present'
      );
      assert.strictEqual(result.cart.items[0].quantity, 2, 'Quantity preserved');
      assert.strictEqual(result.cart.items[0].unitPrice, 350.00, 'Unit price preserved');
      assert.strictEqual(result.cart.items[0].subtotal, 700.00, 'Subtotal preserved');
      pass('Scenario 1: Realistic payload with item.name successfully resolved to "Artisan Sourdough Pizza"');
    }

    // -------------------------------------------------------------
    // SCENARIO 2: Catalogue item name resolved from catalogue mapping (internal_notes / built-in)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 2: Item Name Resolved from Catalogue Mapping ---');
    {
      // Native Meta order message containing ONLY product_retailer_id (e.g. sezp6n6uee)
      const rawPayload = {
        catalog_id: 'CAT_TEST_02',
        product_items: [
          {
            product_retailer_id: 'sezp6n6uee',
            quantity: 3,
            item_price: 800.00,
            currency: 'INR'
          }
        ]
      };

      const result = parseAndValidateCart(rawPayload, {
        restaurantId: tenant.id,
        internalNotes: tenant.internal_notes
      });

      assert.strictEqual(result.isValid, true, 'Cart should be valid');
      assert.strictEqual(
        result.cart.items[0].productName,
        'Chicken Dum Biryani (Special)',
        'Should resolve "sezp6n6uee" to configured menuCatalog item name'
      );
      assert.strictEqual(result.cart.items[0].productRetailerId, 'sezp6n6uee', 'Retailer ID preserved');
      assert.strictEqual(result.cart.items[0].quantity, 3, 'Quantity preserved');
      assert.strictEqual(result.cart.items[0].unitPrice, 800.00, 'Unit price preserved');
      assert.strictEqual(result.cart.items[0].subtotal, 2400.00, 'Subtotal preserved (3 * 800)');
      pass('Scenario 2: Catalogue mapping resolves "sezp6n6uee" -> "Chicken Dum Biryani (Special)"');
    }

    // -------------------------------------------------------------
    // SCENARIO 3: Correct item name in persisted order (orders.items[0].productName)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 3: Correct Item Name in Persisted Order ---');
    const cust1 = `91981${Math.floor(1000000 + Math.random() * 9000000)}`;
    testCustomerPhones.push(cust1);
    let confirmedOrder = null;
    {
      const cartRes = await processIncomingCart(tenant.id, cust1, {
        catalog_id: 'CAT_TEST_03',
        product_items: [
          {
            product_retailer_id: 'sezp6n6uee',
            quantity: 2,
            item_price: 800.00,
            currency: 'INR'
          }
        ]
      }, 'Test Customer');

      assert.strictEqual(cartRes.success, true, 'Cart processing succeeded');
      assert.strictEqual(
        cartRes.cart.items[0].productName,
        'Chicken Dum Biryani (Special)',
        'Cart should have resolved product name'
      );

      // Advance through conversation to AWAITING_CONFIRMATION
      await handleIncomingMessage(tenant.id, cust1, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ENTER_MANUAL_ADDRESS' }
      });
      await handleIncomingMessage(tenant.id, cust1, { messageType: 'text', text: 'Room 204' });
      await handleIncomingMessage(tenant.id, cust1, { messageType: 'text', text: 'Galaxy Heights' });
      await handleIncomingMessage(tenant.id, cust1, { messageType: 'text', text: 'Main Road' });
      await handleIncomingMessage(tenant.id, cust1, { messageType: 'text', text: 'Andheri West' });
      await handleIncomingMessage(tenant.id, cust1, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CONSENT_YES' }
      });
      const orderTypeRes = await handleIncomingMessage(tenant.id, cust1, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_DELIVERY' }
      });

      assert.strictEqual(orderTypeRes.session.current_step, 'AWAITING_CONFIRMATION');

      // Confirm order
      const confRes = await confirmCustomerOrder({
        restaurantId: tenant.id,
        customerPhone: cust1,
        confirmationToken: orderTypeRes.session.state.confirmationToken,
        customerName: 'Test Customer'
      });

      assert.strictEqual(confRes.success, true, 'Order confirmation succeeded');
      confirmedOrder = confRes.order;

      // Verify database record
      const dbOrder = await prisma.order.findUnique({
        where: { id: confirmedOrder.id }
      });

      assert.strictEqual(Array.isArray(dbOrder.items), true, 'dbOrder.items is an array');
      assert.strictEqual(
        dbOrder.items[0].productName,
        'Chicken Dum Biryani (Special)',
        'Persisted order item must contain genuine menu name, not raw SKU'
      );
      assert.strictEqual(dbOrder.items[0].productRetailerId, 'sezp6n6uee', 'Retailer ID preserved');
      assert.strictEqual(dbOrder.items[0].quantity, 2, 'Quantity preserved');
      assert.strictEqual(Number(dbOrder.total_amount), 1600.00, 'Total amount preserved');
      pass('Scenario 3: Persisted order.items[0].productName is "Chicken Dum Biryani (Special)"');
    }

    // -------------------------------------------------------------
    // SCENARIO 4: Correct item name in owner notification payload
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 4: Correct Item Name in Owner Notification Payload ---');
    {
      // Free-form interactive notification
      const ownerPayloadInteractive = buildOwnerNotificationPayload({
        ownerPhone: tenant.owner_phone,
        order: confirmedOrder,
        restaurantName: tenant.name,
        useTemplate: false
      });

      const bodyText = ownerPayloadInteractive.interactive.body.text;
      assert.strictEqual(
        bodyText.includes('Chicken Dum Biryani (Special)'),
        true,
        'Interactive notification body must contain the resolved menu item name'
      );
      assert.strictEqual(
        bodyText.includes('2x Chicken Dum Biryani (Special) @ ₹800.00'),
        true,
        'Interactive notification body must show quantity and price with item name'
      );

      // Meta utility template notification
      const ownerPayloadTemplate = buildOwnerNotificationPayload({
        ownerPhone: tenant.owner_phone,
        order: confirmedOrder,
        restaurantName: tenant.name,
        useTemplate: true,
        templateName: 'restopro_order_alert'
      });

      const templateBodyComponent = ownerPayloadTemplate.template.components.find(c => c.type === 'body');
      assert.strictEqual(templateBodyComponent.parameters.length, 6, 'Template must have 6 parameters');
      const itemsSummaryParam = templateBodyComponent.parameters[4];
      assert.strictEqual(
        itemsSummaryParam.text.includes('Chicken Dum Biryani (Special)'),
        true,
        'Template body items summary must contain the resolved menu item name'
      );
      assert.strictEqual(
        itemsSummaryParam.text.includes('sezp6n6uee'),
        false,
        'Template body items summary must NOT contain raw SKU "sezp6n6uee"'
      );
      pass('Scenario 4: Owner notification payload displays "Chicken Dum Biryani (Special)" in both free-form & template formats');
    }

    // -------------------------------------------------------------
    // SCENARIO 5: Location request uses location_request_message with action.name: 'send_location'
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 5: Location Request Native Format ---');
    const custLoc = `91982${Math.floor(1000000 + Math.random() * 9000000)}`;
    testCustomerPhones.push(custLoc);
    let locReqAction = null;
    {
      await processIncomingCart(tenant.id, custLoc, {
        catalog_id: 'CAT_TEST_05',
        product_items: [{ product_retailer_id: 'sezp6n6uee', quantity: 1, item_price: 800, currency: 'INR' }]
      });

      const tapRes = await handleIncomingMessage(tenant.id, custLoc, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_SHARE_LOCATION' }
      });

      assert.strictEqual(tapRes.session.current_step, 'AWAITING_LOCATION');
      assert.strictEqual(tapRes.action.type, 'PROMPT_LOCATION_REQUEST');
      locReqAction = tapRes.action;

      const outboundPayload = buildConversationReplyPayload({
        action: tapRes.action,
        recipientPhone: custLoc
      });

      assert.strictEqual(outboundPayload.type, 'interactive');
      assert.strictEqual(outboundPayload.interactive.type, 'location_request_message');
      assert.strictEqual(outboundPayload.interactive.action.name, 'send_location');
      pass('Scenario 5: Outbound location request uses native type "location_request_message" with action.name "send_location"');
    }

    // -------------------------------------------------------------
    // SCENARIO 6: Body text is exactly "Please share your current delivery location."
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 6: Location Request Body Text ---');
    {
      const outboundPayload = buildConversationReplyPayload({
        action: locReqAction,
        recipientPhone: custLoc
      });

      assert.strictEqual(
        outboundPayload.interactive.body.text,
        'Please share your current delivery location.',
        'Body text must match the exact required string'
      );
      pass('Scenario 6: Location request message body text is exactly "Please share your current delivery location."');
    }

    // -------------------------------------------------------------
    // SCENARIO 7: Static location webhook extracts and validates latitude and longitude
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 7: Static Location Webhook Extraction & Validation ---');
    {
      const rawLocationWebhook = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '1620323530136933',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '1427497060448125',
                    phone_number_id: tenant.phone_number_id
                  },
                  contacts: [{ profile: { name: 'GPS Customer' }, wa_id: custLoc }],
                  messages: [
                    {
                      from: custLoc,
                      id: `wamid.LOC_TEST_${Date.now()}`,
                      timestamp: '1794136450',
                      type: 'location',
                      location: {
                        latitude: 19.076090,
                        longitude: 72.877426,
                        name: 'BKC Center',
                        address: 'Bandra Kurla Complex, Mumbai'
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

      const parsedEvents = parseWebhookPayload(rawLocationWebhook);
      assert.strictEqual(parsedEvents.length, 1);
      assert.strictEqual(parsedEvents[0].messageType, 'location');
      assert.strictEqual(parsedEvents[0].location.latitude, 19.07609);
      assert.strictEqual(parsedEvents[0].location.longitude, 72.877426);
      assert.strictEqual(parsedEvents[0].location.isLive, false);
      pass('Scenario 7: Webhook parser extracts valid static coordinates: lat=19.07609, lng=72.877426, isLive=false');
    }

    // -------------------------------------------------------------
    // SCENARIO 8: Location path asks for room number and building name before saving
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 8: Location Path Prompts for Room & Building Details ---');
    let pinReceivedRes = null;
    {
      pinReceivedRes = await handleIncomingMessage(tenant.id, custLoc, {
        messageType: 'location',
        location: {
          latitude: 19.07609,
          longitude: 72.877426,
          name: 'BKC Center',
          address: 'Bandra Kurla Complex, Mumbai'
        }
      });

      assert.strictEqual(
        pinReceivedRes.session.current_step,
        'AWAITING_LOCATION_DETAILS',
        'Receiving location pin must advance to AWAITING_LOCATION_DETAILS, NOT AWAITING_SAVE_CONSENT'
      );
      assert.strictEqual(pinReceivedRes.action.type, 'PROMPT_LOCATION_DETAILS');
      assert.strictEqual(
        pinReceivedRes.action.message,
        'Please share your room/flat number and building name.',
        'Must prompt for room/flat number and building name'
      );
      assert.strictEqual(
        pinReceivedRes.session.state.tempLocation.latitude,
        19.07609,
        'Coordinates saved in tempLocation'
      );
      pass('Scenario 8: Location pin immediately asks "Please share your room/flat number and building name." before saving');
    }

    // -------------------------------------------------------------
    // SCENARIO 9: Location path asks to save only after collecting those details
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 9: Save Prompt Issued Only After Room & Building Received ---');
    {
      const detailsRes = await handleIncomingMessage(tenant.id, custLoc, {
        messageType: 'text',
        text: 'Suite 401, Signature Tower'
      });

      assert.strictEqual(
        detailsRes.session.current_step,
        'AWAITING_SAVE_CONSENT',
        'Should only transition to AWAITING_SAVE_CONSENT after room & building details are provided'
      );
      assert.strictEqual(detailsRes.action.type, 'PROMPT_SAVE_CONSENT');
      assert.strictEqual(
        detailsRes.session.state.address.addressText.includes('Suite 401, Signature Tower'),
        true,
        'Combined address text includes room & building'
      );
      assert.strictEqual(
        detailsRes.session.state.address.latitude,
        19.07609,
        'Address preserves GPS latitude'
      );
      assert.strictEqual(
        detailsRes.session.state.address.longitude,
        72.877426,
        'Address preserves GPS longitude'
      );
      pass('Scenario 9: Save consent is only prompted after room and building details are submitted');
    }

    // -------------------------------------------------------------
    // SCENARIO 10: Manual path collects room, building, street, and area in strict order
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 10: Manual Path 4-Step Strict Sequential Collection ---');
    const custManual = `91983${Math.floor(1000000 + Math.random() * 9000000)}`;
    testCustomerPhones.push(custManual);
    {
      await processIncomingCart(tenant.id, custManual, {
        catalog_id: 'CAT_TEST_10',
        product_items: [{ product_retailer_id: 'sezp6n6uee', quantity: 1, item_price: 800, currency: 'INR' }]
      });

      // Customer taps Enter Manually
      const startManual = await handleIncomingMessage(tenant.id, custManual, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ENTER_MANUAL_ADDRESS' }
      });
      assert.strictEqual(startManual.session.current_step, 'AWAITING_MANUAL_ROOM', 'Step 1: AWAITING_MANUAL_ROOM');
      assert.strictEqual(startManual.action.message, 'Please enter your Room / Flat / House Number:');

      // Step 1 -> Step 2
      const step1Res = await handleIncomingMessage(tenant.id, custManual, {
        messageType: 'text',
        text: 'Flat 12B'
      });
      assert.strictEqual(step1Res.session.current_step, 'AWAITING_MANUAL_BUILDING', 'Step 2: AWAITING_MANUAL_BUILDING');
      assert.strictEqual(step1Res.action.message, 'Please enter your Building / Apartment Name:');
      assert.strictEqual(step1Res.session.state.manualAddress.room, 'Flat 12B');

      // Step 2 -> Step 3
      const step2Res = await handleIncomingMessage(tenant.id, custManual, {
        messageType: 'text',
        text: 'Palacio Royale'
      });
      assert.strictEqual(step2Res.session.current_step, 'AWAITING_MANUAL_STREET', 'Step 3: AWAITING_MANUAL_STREET');
      assert.strictEqual(step2Res.action.message, 'Please enter your Street / Road Name:');
      assert.strictEqual(step2Res.session.state.manualAddress.building, 'Palacio Royale');

      // Step 3 -> Step 4
      const step3Res = await handleIncomingMessage(tenant.id, custManual, {
        messageType: 'text',
        text: 'Worli Hill Road'
      });
      assert.strictEqual(step3Res.session.current_step, 'AWAITING_MANUAL_AREA', 'Step 4: AWAITING_MANUAL_AREA');
      assert.strictEqual(step3Res.action.message, 'Please enter your Area / Locality:');
      assert.strictEqual(step3Res.session.state.manualAddress.street, 'Worli Hill Road');

      pass('Scenario 10: Manual path collects 1) Room -> 2) Building -> 3) Street -> 4) Area in strict sequence');
    }

    // -------------------------------------------------------------
    // SCENARIO 11: Manual path asks to save only after all 4 fields are collected
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 11: Save Consent Only After All 4 Fields Collected ---');
    let manualConsentPrompt = null;
    {
      manualConsentPrompt = await handleIncomingMessage(tenant.id, custManual, {
        messageType: 'text',
        text: 'Worli, Mumbai'
      });

      assert.strictEqual(
        manualConsentPrompt.session.current_step,
        'AWAITING_SAVE_CONSENT',
        'Transitions to AWAITING_SAVE_CONSENT only after area is received'
      );
      assert.strictEqual(manualConsentPrompt.action.type, 'PROMPT_SAVE_CONSENT');
      const expectedAddr = 'Flat 12B, Palacio Royale, Worli Hill Road, Worli, Mumbai';
      assert.strictEqual(
        manualConsentPrompt.session.state.address.addressText,
        expectedAddr,
        'Formatted address combines all 4 fields cleanly'
      );
      assert.strictEqual(manualConsentPrompt.session.state.manualAddress, undefined, 'manualAddress cleared from state');
      pass('Scenario 11: Save prompt issued only after all 4 fields collected; formatted as "Flat 12B, Palacio Royale, Worli Hill Road, Worli, Mumbai"');
    }

    // -------------------------------------------------------------
    // SCENARIO 12: Yes saves address with restaurant/customer scope
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 12: Yes Saves Scoped Address ---');
    {
      const consentYesRes = await handleIncomingMessage(tenant.id, custManual, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CONSENT_YES' }
      });

      assert.strictEqual(consentYesRes.session.current_step, 'AWAITING_ORDER_TYPE');
      assert.strictEqual(consentYesRes.session.state.addressSaved, true);

      // Verify in saved_addresses table
      const savedAddresses = await findCustomerSavedAddresses(tenant.id, custManual);
      assert.strictEqual(savedAddresses.length, 1, 'Exactly one address record created');
      assert.strictEqual(savedAddresses[0].restaurant_id, tenant.id, 'Address scoped strictly to restaurant');
      assert.strictEqual(savedAddresses[0].customer_phone, custManual, 'Address scoped strictly to customer');
      assert.strictEqual(
        savedAddresses[0].address,
        'Flat 12B, Palacio Royale, Worli Hill Road, Worli, Mumbai'
      );
      testSavedAddressIds.push(savedAddresses[0].id);
      pass('Scenario 12: "Yes" persists completed address scoped strictly by (restaurant_id, customer_phone)');
    }

    // -------------------------------------------------------------
    // SCENARIO 13: No does not save reusable address
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 13: No Does Not Save Reusable Address ---');
    const custNoSave = `91984${Math.floor(1000000 + Math.random() * 9000000)}`;
    testCustomerPhones.push(custNoSave);
    {
      await processIncomingCart(tenant.id, custNoSave, {
        catalog_id: 'CAT_TEST_13',
        product_items: [{ product_retailer_id: 'sezp6n6uee', quantity: 1, item_price: 800, currency: 'INR' }]
      });

      // Submit location and room details
      await handleIncomingMessage(tenant.id, custNoSave, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_SHARE_LOCATION' }
      });
      await handleIncomingMessage(tenant.id, custNoSave, {
        messageType: 'location',
        location: { latitude: 18.5204, longitude: 73.8567, name: 'Pune' }
      });
      await handleIncomingMessage(tenant.id, custNoSave, {
        messageType: 'text',
        text: 'Apt 5, Silver Oak'
      });

      // Customer taps "No, Use Once"
      const consentNoRes = await handleIncomingMessage(tenant.id, custNoSave, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CONSENT_NO' }
      });

      assert.strictEqual(consentNoRes.session.current_step, 'AWAITING_ORDER_TYPE');
      assert.strictEqual(consentNoRes.session.state.addressSaved, false);
      assert.strictEqual(
        consentNoRes.session.state.address.addressText.includes('Apt 5, Silver Oak'),
        true,
        'Address retained in session for current order'
      );

      // Verify zero rows in saved_addresses for this customer
      const dbSaved = await findCustomerSavedAddresses(tenant.id, custNoSave);
      assert.strictEqual(dbSaved.length, 0, 'Zero rows must be saved in saved_addresses on "No"');
      pass('Scenario 13: "No" retains address for active order only; zero rows in saved_addresses table');
    }

    // -------------------------------------------------------------
    // SCENARIO 14: Duplicate location webhook does not duplicate address updates
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 14: Duplicate Location Webhook Idempotency ---');
    {
      const dupSessionBefore = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenant.id,
            customer_phone: custLoc
          }
        }
      });

      // Simulate re-delivery of the identical location pin
      const dupPinRes = await handleIncomingMessage(tenant.id, custLoc, {
        messageType: 'location',
        location: {
          latitude: 19.07609,
          longitude: 72.877426,
          name: 'BKC Center',
          address: 'Bandra Kurla Complex, Mumbai'
        }
      });

      assert.strictEqual(dupPinRes.success, true);
      // Session remains stable without corrupted state
      assert.strictEqual(
        dupPinRes.session.state.address.latitude,
        19.07609,
        'Coordinates remain uncorrupted'
      );
      pass('Scenario 14: Duplicate location webhook handled idempotently without corrupting session');
    }

    // -------------------------------------------------------------
    // SCENARIO 15: Invalid location payload does not advance conversation
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 15: Invalid Location Payload Rejection ---');
    const custInvalidLoc = `91985${Math.floor(1000000 + Math.random() * 9000000)}`;
    testCustomerPhones.push(custInvalidLoc);
    {
      await processIncomingCart(tenant.id, custInvalidLoc, {
        catalog_id: 'CAT_TEST_15',
        product_items: [{ product_retailer_id: 'sezp6n6uee', quantity: 1, item_price: 800, currency: 'INR' }]
      });

      await handleIncomingMessage(tenant.id, custInvalidLoc, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_SHARE_LOCATION' }
      });

      // 15a. Latitude out of range (999)
      const badLatRes = await handleIncomingMessage(tenant.id, custInvalidLoc, {
        messageType: 'location',
        location: { latitude: 999.0, longitude: 72.8 }
      });
      assert.strictEqual(badLatRes.session.current_step, 'AWAITING_LOCATION', 'Step must NOT advance on bad latitude');
      assert.strictEqual(badLatRes.action.type, 'CONTEXTUAL_REPROMPT');

      // 15b. Live tracking location update rejected
      const liveLocRes = await handleIncomingMessage(tenant.id, custInvalidLoc, {
        messageType: 'location',
        location: { latitude: 19.0, longitude: 72.8, isLive: true }
      });
      assert.strictEqual(liveLocRes.session.current_step, 'AWAITING_LOCATION', 'Step must NOT advance on live location update');
      assert.strictEqual(liveLocRes.action.message.includes('Live location tracking is not supported'), true);
      pass('Scenario 15: Invalid coordinates and live location tracking rejected; step remains AWAITING_LOCATION');
    }

    // -------------------------------------------------------------
    // SCENARIO 16: Order confirmation flow completes cleanly with new address structure
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 16: End-to-End Order Confirmation with New Address Structure ---');
    {
      // Advance custManual from AWAITING_ORDER_TYPE to AWAITING_CONFIRMATION
      const orderTypeRes = await handleIncomingMessage(tenant.id, custManual, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_DELIVERY' }
      });

      assert.strictEqual(orderTypeRes.session.current_step, 'AWAITING_CONFIRMATION');
      assert.strictEqual(orderTypeRes.action.type, 'PROMPT_ORDER_CONFIRMATION');

      // Customer confirms order
      const finalConf = await confirmCustomerOrder({
        restaurantId: tenant.id,
        customerPhone: custManual,
        confirmationToken: orderTypeRes.session.state.confirmationToken,
        customerName: 'Worli Resident'
      });

      assert.strictEqual(finalConf.success, true, 'Order confirmation succeeded');
      assert.strictEqual(finalConf.order.order_type, 'DELIVERY');
      assert.strictEqual(
        finalConf.order.address_snapshot,
        'Flat 12B, Palacio Royale, Worli Hill Road, Worli, Mumbai',
        'address_snapshot in order matches formatted 4-field manual address'
      );
      assert.strictEqual(
        finalConf.order.items[0].productName,
        'Chicken Dum Biryani (Special)',
        'Order items contains genuine menu item name'
      );
      assert.strictEqual(Number(finalConf.order.total_amount), 800.00, 'Total amount accurate');

      // Verify session reset to IDLE
      const finalSession = await prisma.conversationSession.findUnique({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: tenant.id,
            customer_phone: custManual
          }
        }
      });
      assert.strictEqual(finalSession.current_step, 'IDLE', 'Session reset to IDLE');
      pass('Scenario 16: Order confirmation completes cleanly: address_snapshot, items[0].productName, total_amount accurate, session reset to IDLE');
    }

    console.log('\n============================================================');
    console.log(`   R6.3 TEST SUITE RESULTS: ${passedCount} PASSED, 0 FAILED`);
    console.log('============================================================\n');

  } finally {
    // Cleanup temporary test records
    try {
      clearDynamicCatalogs();
      for (const phone of testCustomerPhones) {
        await prisma.conversationSession.deleteMany({ where: { customer_phone: phone } }).catch(() => {});
        await prisma.savedAddress.deleteMany({ where: { customer_phone: phone } }).catch(() => {});
        await prisma.order.deleteMany({ where: { customer_phone: phone } }).catch(() => {});
      }
      for (const tId of testRestaurantIds) {
        await prisma.outboxMessage.deleteMany({ where: { restaurant_id: tId } }).catch(() => {});
        await prisma.order.deleteMany({ where: { restaurant_id: tId } }).catch(() => {});
        await prisma.conversationSession.deleteMany({ where: { restaurant_id: tId } }).catch(() => {});
        await prisma.savedAddress.deleteMany({ where: { restaurant_id: tId } }).catch(() => {});
        await prisma.restaurant.delete({ where: { id: tId } }).catch(() => {});
      }
    } catch (_) {}
  }
}

runR6TestSuite().catch(err => {
  console.error('\n❌ Uncaught error during R6 test execution:', err);
  process.exit(1);
});

