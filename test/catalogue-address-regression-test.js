/**
 * RESTOPRO — WhatsApp Catalogue Product Names & Address Deduplication Regression Test Suite
 *
 * Verifies fixes for:
 * Issue 1: Catalogue product name resolution:
 *   - Resolves product_retailer_id to human-readable names via payload, metadata, registry, cache, and Meta API.
 *   - Ensures raw retailer ID is NEVER displayed as product name when proper name can be resolved.
 *   - Uses clear fallback Item (retailer_id) when unresolvable; logs warning.
 *   - Preserves product_retailer_id as a separate identifier in order items and database.
 *   - Enforces strict tenant catalogue isolation.
 *
 * Issue 2: Duplicate delivery address prevention:
 *   - Deduplicates identical WhatsApp location pin name and address fields.
 *   - Combines customer-entered room/flat/building details with location address without repetition.
 *   - Normalizes whitespace, tabs, and extraneous punctuation.
 *   - Preserves genuinely different address components (flat, building, landmark, street, locality, city).
 *   - Preserves similar but distinct components (e.g. Sector 14 vs Sector 14A).
 */
require('./load-test-env');

const assert = require('assert');
const prisma = require('../src/config/database');
const { encryptToken } = require('../src/utils/crypto');
const {
  parseAndValidateCart,
  parseAndValidateCartAsync
} = require('../src/parsers/cart-parser');
const {
  resolveMenuItemName,
  resolveMenuItemNameAsync,
  getCachedProduct,
  setCachedProduct,
  clearCatalogCache,
  registerTenantCatalog,
  clearDynamicCatalogs,
  BUILT_IN_CATALOG_REGISTRY
} = require('../src/services/catalog.service');
const {
  combineAddressComponents,
  normalizeAddress,
  validateTextAddress
} = require('../src/services/address.service');
const {
  buildOrderSummary,
  confirmCustomerOrder
} = require('../src/services/order.service');
const {
  buildOwnerNotificationPayload,
  buildCustomerDecisionReplyPayload
} = require('../src/services/whatsapp.service');
const {
  handleIncomingMessage,
  processIncomingCart
} = require('../src/services/conversation.service');

async function runRegressionTestSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — CATALOGUE PRODUCTS & ADDRESS REGRESSION TESTS ');
  console.log('============================================================\n');

  let passed = 0;
  function pass(msg) {
    passed++;
    console.log(`  ✅ [PASS] ${msg}`);
  }

  const testRestaurantIds = [];
  const testCustomerPhones = [];

  try {
    // =============================================================
    // PART 1: ADDRESS DEDUPLICATION & NORMALIZATION (ISSUE 2)
    // =============================================================
    console.log('--- PART 1: Address Deduplication & Normalization ---');

    // Test 1: Production Bug Case — Identical location name & address with customer flat/building
    {
      const customerDetails = '5004, Ksa';
      const locName = '245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India';
      const locAddress = '245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India';

      const combined = combineAddressComponents(customerDetails, locName, locAddress);
      const expected = '5004, Ksa, 245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India';

      assert.strictEqual(combined, expected, 'Address must not repeat the street and locality twice');
      pass('REG-ADDR-01: Identical location.name and location.address are deduplicated without repeating');
    }

    // Test 2: Consecutive duplicate segments eliminated
    {
      const rawAddress = '5004, KSA Regency, Hussaini Baug, Madanpura, Mumbai 08, KSA Regency, Hussaini Baug, Madanpura, Madanpura';
      const cleaned = combineAddressComponents(rawAddress);
      const expected = '5004, KSA Regency, Hussaini Baug, Madanpura, Mumbai 08';

      assert.strictEqual(cleaned, expected, 'Trailing repeated segments must be eliminated');
      pass('REG-ADDR-02: Trailing repeated segments and repeated locality names are cleanly deduplicated');
    }

    // Test 3: Normalization of whitespace, tabs, newlines, and extraneous commas
    {
      const part1 = '  Flat 101 , \n Building A \t , ';
      const part2 = ' , , MG Road , , Near Metro Station . , ';
      const part3 = ' Pune, Maharashtra 411001 ';

      const combined = combineAddressComponents(part1, part2, part3);
      assert.strictEqual(
        combined,
        'Flat 101, Building A, MG Road, Near Metro Station, Pune, Maharashtra 411001',
        'Whitespace, tabs, newlines, and stray commas must be normalized cleanly'
      );
      pass('REG-ADDR-03: Irregular whitespace, newlines, tabs, and stray commas normalized');
    }

    // Test 4: Preserves genuinely distinct address elements (flat, building, landmark, street, locality, city)
    {
      const parts = [
        'Shop No. 5',
        'Zainab Heritage',
        'Opposite City Bank',
        'Bhendi Bazaar',
        'Mumbai',
        'Maharashtra 400003'
      ];
      const combined = combineAddressComponents(parts);
      assert.strictEqual(
        combined,
        'Shop No. 5, Zainab Heritage, Opposite City Bank, Bhendi Bazaar, Mumbai, Maharashtra 400003',
        'All distinct address levels must be preserved in order'
      );
      pass('REG-ADDR-04: Distinct address elements (shop, building, landmark, locality, city) preserved');
    }

    // Test 5: Preserves similar but distinct elements (e.g. Sector 14 vs Sector 14A)
    {
      const combined = combineAddressComponents('Sector 14', 'Sector 14A', 'Near Market');
      assert.strictEqual(
        combined,
        'Sector 14, Sector 14A, Near Market',
        'Similar looking distinct components must not be removed'
      );
      pass('REG-ADDR-05: Similar but distinct address parts (Sector 14 vs Sector 14A) are preserved');
    }

    // Test 6: Location pin normalizeAddress integration
    {
      const norm = normalizeAddress({
        source: 'LOCATION_PIN',
        buildingName: 'KSA Regency',
        roomNumber: '5004',
        addressText: '245a, Maulana Azad Rd, Madanpura, Mumbai',
        latitude: 18.9685,
        longitude: 72.8283
      });

      assert(norm.addressText.includes('Room/Flat: 5004'), 'Contains room number');
      assert(norm.addressText.includes('Building: KSA Regency'), 'Contains building name');
      assert(norm.addressText.includes('245a, Maulana Azad Rd'), 'Contains street');
      assert.strictEqual(
        norm.addressText.split('KSA Regency').length - 1,
        1,
        'Building name must appear exactly once'
      );
      pass('REG-ADDR-06: normalizeAddress integrates combineAddressComponents with zero duplicate tags');
    }

    // =============================================================
    // PART 2: CATALOGUE PRODUCT NAME RESOLUTION (ISSUE 1)
    // =============================================================
    console.log('\n--- PART 2: Catalogue Product Name Resolution ---');

    // Create isolated test restaurant tenant
    const tenantPhoneId = `1427${Math.floor(100000000000 + Math.random() * 900000000000)}`;
    const tenantOwnerPhone = `+91937${Math.floor(1000000 + Math.random() * 9000000)}`;
    const encToken = encryptToken('EAABtestTokenForCatalogueRegression12345');

    const internalNotes = `Test tenant notes\n\n<!--RESTOPRO_METADATA:${JSON.stringify({
      ownerConsent: {
        optedIn: true,
        consentedAt: new Date().toISOString(),
        source: 'SUPER_ADMIN_MANUAL_VERIFIED',
        revoked: false
      },
      menuCatalog: {
        'zfzb9a6ptg': {
          name: 'Mutton Seekh Kebab (4 Pcs)',
          price: 180,
          category: 'Starters'
        },
        'SKU_GULAB_JAMUN': {
          name: 'Gulab Jamun (2 pcs)',
          price: 90
        }
      }
    })}-->`;

    const tenant = await prisma.restaurant.create({
      data: {
        name: 'RestPro Catalogue Test Bistro',
        phone_number_id: tenantPhoneId,
        waba_id: '1620323530136933',
        owner_phone: tenantOwnerPhone,
        access_token_encrypted: encToken,
        internal_notes: internalNotes,
        is_active: true
      }
    });
    testRestaurantIds.push(tenant.id);

    // Test 7: Built-in registry resolution (sezp6n6uee -> Chicken Dum Biryani (Special))
    {
      const res = resolveMenuItemName({
        restaurantId: tenant.id,
        productRetailerId: 'sezp6n6uee',
        internalNotes: tenant.internal_notes
      });

      assert.strictEqual(res.isResolved, true, 'Should resolve built-in SKU');
      assert.strictEqual(res.name, 'Chicken Dum Biryani (Special)', 'Resolved to Chicken Dum Biryani');
      assert.strictEqual(res.source, 'BUILT_IN_REGISTRY', 'Source is BUILT_IN_REGISTRY');
      pass('REG-CAT-01: Built-in registry resolves "sezp6n6uee" -> "Chicken Dum Biryani (Special)"');
    }

    // Test 8: Tenant metadata menuCatalog resolution (zfzb9a6ptg -> Mutton Seekh Kebab (4 Pcs))
    {
      const res = resolveMenuItemName({
        restaurantId: tenant.id,
        productRetailerId: 'zfzb9a6ptg',
        internalNotes: tenant.internal_notes
      });

      assert.strictEqual(res.isResolved, true, 'Should resolve tenant menuCatalog SKU');
      assert.strictEqual(res.name, 'Mutton Seekh Kebab (4 Pcs)', 'Resolved to genuine menu item name');
      assert.strictEqual(res.source, 'TENANT_METADATA', 'Source is TENANT_METADATA');
      pass('REG-CAT-02: Tenant metadata menuCatalog resolves "zfzb9a6ptg" -> "Mutton Seekh Kebab (4 Pcs)"');
    }

    // Test 9: Direct payload attributes resolution
    {
      const res = resolveMenuItemName({
        restaurantId: tenant.id,
        productRetailerId: 'sku_custom_wrap',
        rawItem: { name: 'Paneer Tikka Kathi Roll', item_price: 150 }
      });

      assert.strictEqual(res.isResolved, true, 'Payload name accepted');
      assert.strictEqual(res.name, 'Paneer Tikka Kathi Roll', 'Name extracted directly from payload');
      assert.strictEqual(res.source, 'PAYLOAD', 'Source is PAYLOAD');
      pass('REG-CAT-03: Direct payload attributes resolve item name when present');
    }

    // Test 10: In-Memory TTL Cache resolution
    {
      clearCatalogCache();
      setCachedProduct(tenant.id, 'sku_cached_drink', {
        name: 'Fresh Lime Soda (Sweet & Salt)',
        price: 70,
        source: 'META_CATALOG_API'
      });

      const cached = getCachedProduct(tenant.id, 'sku_cached_drink');
      assert.strictEqual(cached?.name, 'Fresh Lime Soda (Sweet & Salt)', 'Cache retrieval succeeds');

      const res = resolveMenuItemName({
        restaurantId: tenant.id,
        productRetailerId: 'sku_cached_drink'
      });

      assert.strictEqual(res.isResolved, true, 'Cache resolves item name');
      assert.strictEqual(res.name, 'Fresh Lime Soda (Sweet & Salt)', 'Cached name returned');
      pass('REG-CAT-04: In-Memory TTL Cache returns resolved product without external query');
    }

    // Test 11: Unresolved SKU fallback — Never silently pretends retailer ID is product name
    {
      const unmatchableSku = 'unresolved_sku_xyz999';
      const res = resolveMenuItemName({
        restaurantId: tenant.id,
        productRetailerId: unmatchableSku,
        fallbackIfUnresolved: true
      });

      assert.strictEqual(res.isResolved, false, 'isResolved must be false');
      assert.strictEqual(res.name, `Item (${unmatchableSku})`, 'Clear fallback name provided');
      assert.strictEqual(res.source, 'FALLBACK_UNRESOLVED', 'Source marked as FALLBACK_UNRESOLVED');
      pass('REG-CAT-05: Unresolved retailer ID returns Item (retailer_id) fallback with isResolved: false');
    }

    // Test 12: parseAndValidateCart with multi-item realistic Meta catalogue order
    {
      const rawPayload = {
        catalog_id: '1661745362087273',
        text: 'Please deliver quickly',
        product_items: [
          {
            product_retailer_id: 'sezp6n6uee',
            quantity: 2,
            item_price: 800.00,
            currency: 'INR'
          },
          {
            product_retailer_id: 'zfzb9a6ptg',
            quantity: 1,
            item_price: 180.00,
            currency: 'INR'
          },
          {
            product_retailer_id: 'unknown_mystery_sku',
            quantity: 1,
            item_price: 50.00,
            currency: 'INR'
          }
        ]
      };

      const result = parseAndValidateCart(rawPayload, {
        restaurantId: tenant.id,
        internalNotes: tenant.internal_notes
      });

      assert.strictEqual(result.isValid, true, 'Cart validation succeeds');
      assert.strictEqual(result.cart.items.length, 3, 'All 3 items processed');

      // Item 1: Built-in registry
      assert.strictEqual(result.cart.items[0].productName, 'Chicken Dum Biryani (Special)');
      assert.strictEqual(result.cart.items[0].productRetailerId, 'sezp6n6uee');
      assert.strictEqual(result.cart.items[0].isResolved, true);

      // Item 2: Tenant metadata
      assert.strictEqual(result.cart.items[1].productName, 'Mutton Seekh Kebab (4 Pcs)');
      assert.strictEqual(result.cart.items[1].productRetailerId, 'zfzb9a6ptg');
      assert.strictEqual(result.cart.items[1].isResolved, true);

      // Item 3: Unresolved fallback
      assert.strictEqual(result.cart.items[2].productName, 'Item (unknown_mystery_sku)');
      assert.strictEqual(result.cart.items[2].productRetailerId, 'unknown_mystery_sku');
      assert.strictEqual(result.cart.items[2].isResolved, false);

      assert.strictEqual(result.cart.subtotal, 1830.00, 'Subtotal accurate (2*800 + 1*180 + 1*50)');
      pass('REG-CAT-06: parseAndValidateCart accurately normalizes resolved, tenant, and fallback items');
    }

    // Test 13: parseAndValidateCartAsync with async resolution & caching
    {
      clearCatalogCache();
      const rawPayload = {
        catalog_id: '1661745362087273',
        product_items: [
          {
            product_retailer_id: 'sezp6n6uee',
            quantity: 1,
            item_price: 800.00,
            currency: 'INR'
          },
          {
            product_retailer_id: 'zfzb9a6ptg',
            quantity: 1,
            item_price: 180.00,
            currency: 'INR'
          }
        ]
      };

      const result = await parseAndValidateCartAsync(rawPayload, {
        restaurantId: tenant.id,
        internalNotes: tenant.internal_notes,
        accessToken: 'mock_token'
      });

      assert.strictEqual(result.isValid, true, 'Async validation succeeds');
      assert.strictEqual(result.cart.items[0].productName, 'Chicken Dum Biryani (Special)');
      assert.strictEqual(result.cart.items[1].productName, 'Mutton Seekh Kebab (4 Pcs)');
      pass('REG-CAT-07: parseAndValidateCartAsync completes cleanly and preserves resolved names');
    }

    // Test 14: Order Summary Snapshot & Customer Confirmation formatting
    {
      const cart = {
        currency: 'INR',
        itemCount: 2,
        subtotal: 980.00,
        items: [
          {
            productRetailerId: 'sezp6n6uee',
            productName: 'Chicken Dum Biryani (Special)',
            quantity: 1,
            unitPrice: 800.00,
            isResolved: true
          },
          {
            productRetailerId: 'zfzb9a6ptg',
            productName: 'Mutton Seekh Kebab (4 Pcs)',
            quantity: 1,
            unitPrice: 180.00,
            isResolved: true
          }
        ]
      };

      const address = {
        addressText: '5004, Ksa, 245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India'
      };

      const summary = buildOrderSummary({
        cart,
        orderType: 'DELIVERY',
        address,
        restaurantName: tenant.name,
        customerName: 'Madi Khan'
      });

      // Verify human-readable summary text
      assert(summary.summaryText.includes('1. Chicken Dum Biryani (Special) (x1) — ₹800.00'), 'Summary has item 1');
      assert(summary.summaryText.includes('2. Mutton Seekh Kebab (4 Pcs) (x1) — ₹180.00'), 'Summary has item 2');
      assert(!summary.summaryText.includes('zfzb9a6ptg'), 'Summary text must NOT contain raw SKU "zfzb9a6ptg"');

      // Verify non-duplicated address
      assert.strictEqual(
        summary.addressSnapshot.split('Maulana Azad Rd').length - 1,
        1,
        'Address snapshot must contain street name exactly once'
      );

      pass('REG-CAT-08: buildOrderSummary produces formatted items and clean single address');
    }

    // Test 15: Owner Notification Template {{5}} parameter formatting
    {
      const mockOrder = {
        id: 'mock-order-uuid-test-15',
        order_reference: 'RP-261111-TEST',
        customer_name: 'Madi Khan',
        customer_phone: '+919152115523',
        order_type: 'DELIVERY',
        address_snapshot: '5004, Ksa, 245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India',
        items: [
          {
            productRetailerId: 'sezp6n6uee',
            productName: 'Chicken Dum Biryani (Special)',
            quantity: 1,
            unitPrice: 800.00
          },
          {
            productRetailerId: 'zfzb9a6ptg',
            productName: 'Mutton Seekh Kebab (4 Pcs)',
            quantity: 1,
            unitPrice: 180.00
          }
        ],
        total_amount: 980.00,
        currency: 'INR'
      };

      const payload = buildOwnerNotificationPayload({
        ownerPhone: tenantOwnerPhone,
        order: mockOrder,
        restaurantName: tenant.name,
        useTemplate: true
      });

      const bodyComp = payload.template.components.find(c => c.type === 'body');
      const itemsParam = bodyComp.parameters[4].text;
      const addressParam = bodyComp.parameters[3].text;

      assert(itemsParam.includes('1x Chicken Dum Biryani (Special)'), 'Template items includes Biryani');
      assert(itemsParam.includes('1x Mutton Seekh Kebab (4 Pcs)'), 'Template items includes Kebab');
      assert(!itemsParam.includes('zfzb9a6ptg'), 'Template items must NOT contain raw SKU "zfzb9a6ptg"');

      assert.strictEqual(
        addressParam.split('Maulana Azad Rd').length - 1,
        1,
        'Template {{4}} address parameter contains street name exactly once'
      );

      pass('REG-CAT-09: buildOwnerNotificationPayload formats items and address with zero SKU or address leakage');
    }

    // Test 16: Customer Decision notification formatting
    {
      const mockOrder = {
        id: 'mock-order-id-123',
        order_reference: 'RP-261111-TEST',
        restaurant_id: tenant.id,
        order_type: 'DELIVERY',
        address_snapshot: '5004, Ksa, 245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India',
        items: [
          {
            productRetailerId: 'sezp6n6uee',
            productName: 'Chicken Dum Biryani (Special)',
            quantity: 1,
            unitPrice: 800.00
          },
          {
            productRetailerId: 'zfzb9a6ptg',
            productName: 'Mutton Seekh Kebab (4 Pcs)',
            quantity: 1,
            unitPrice: 180.00
          }
        ],
        total_amount: 980.00,
        currency: 'INR'
      };

      const reply = buildCustomerDecisionReplyPayload({
        order: mockOrder,
        decision: 'ACCEPT',
        restaurantName: tenant.name
      });

      const body = reply.text.body;
      assert(body.includes('1x Chicken Dum Biryani (Special) @ ₹800.00'), 'Customer decision text includes Biryani');
      assert(body.includes('1x Mutton Seekh Kebab (4 Pcs) @ ₹180.00'), 'Customer decision text includes Kebab');
      assert(!body.includes('zfzb9a6ptg'), 'Customer decision text must NOT contain raw SKU');
      assert.strictEqual(
        body.split('Maulana Azad Rd').length - 1,
        1,
        'Customer decision text contains delivery address exactly once'
      );

      pass('REG-CAT-10: buildCustomerDecisionReplyPayload produces clean items and non-duplicated address');
    }

    // Test 17: Tenant Isolation Guarantee — Tenant A mappings never leak to Tenant B
    {
      const tenantBPhoneId = `1427${Math.floor(100000000000 + Math.random() * 900000000000)}`;
      const tenantB = await prisma.restaurant.create({
        data: {
          name: 'RestPro Tenant B',
          phone_number_id: tenantBPhoneId,
          waba_id: '1620323530136933',
          owner_phone: `+91937${Math.floor(1000000 + Math.random() * 9000000)}`,
          access_token_encrypted: encToken,
          internal_notes: `<!--RESTOPRO_METADATA:{"menuCatalog":{"zfzb9a6ptg":{"name":"Different Restaurant Dish","price":220}}}-->`,
          is_active: true
        }
      });
      testRestaurantIds.push(tenantB.id);

      const resA = resolveMenuItemName({
        restaurantId: tenant.id,
        productRetailerId: 'zfzb9a6ptg',
        internalNotes: tenant.internal_notes
      });

      const resB = resolveMenuItemName({
        restaurantId: tenantB.id,
        productRetailerId: 'zfzb9a6ptg',
        internalNotes: tenantB.internal_notes
      });

      assert.strictEqual(resA.name, 'Mutton Seekh Kebab (4 Pcs)', 'Tenant A resolves its own item name');
      assert.strictEqual(resB.name, 'Different Restaurant Dish', 'Tenant B resolves its own item name');
      assert.notStrictEqual(resA.name, resB.name, 'Tenant A and Tenant B maintain complete catalogue isolation');
      pass('REG-CAT-11: Strict multi-tenant isolation enforced for catalogue resolutions');
    }

    // =============================================================
    // PART 3: END-TO-END CONVERSATION & PERSISTENCE FLOW
    // =============================================================
    console.log('\n--- PART 3: End-to-End Conversation & Order Persistence ---');

    {
      const custPhone = `+91915${Math.floor(1000000 + Math.random() * 9000000)}`;
      testCustomerPhones.push(custPhone);

      // Step 1: Customer submits catalog cart
      const rawOrderPayload = {
        catalog_id: '1661745362087273',
        product_items: [
          { product_retailer_id: 'sezp6n6uee', quantity: 1, item_price: 800.00, currency: 'INR' },
          { product_retailer_id: 'zfzb9a6ptg', quantity: 1, item_price: 180.00, currency: 'INR' }
        ]
      };

      const cartRes = await processIncomingCart(tenant.id, custPhone, rawOrderPayload, 'Madi Khan');
      assert.strictEqual(cartRes.success, true, 'Cart processing succeeded');
      assert.strictEqual(cartRes.session.current_step, 'AWAITING_ADDRESS_INPUT', 'Step is AWAITING_ADDRESS_INPUT');
      assert.strictEqual(cartRes.session.state.cart.items[0].productName, 'Chicken Dum Biryani (Special)');
      assert.strictEqual(cartRes.session.state.cart.items[1].productName, 'Mutton Seekh Kebab (4 Pcs)');
      pass('REG-E2E-01: Incoming catalogue order cart processed with resolved product names in session');

      // Step 2: Customer shares WhatsApp location pin (with identical name and address)
      const locRes = await handleIncomingMessage(tenant.id, custPhone, {
        messageType: 'location',
        location: {
          latitude: 18.9685487,
          longitude: 72.8283845,
          name: '245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India',
          address: '245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India'
        }
      });
      assert.strictEqual(locRes.session.current_step, 'AWAITING_LOCATION_DETAILS', 'Step is AWAITING_LOCATION_DETAILS');
      pass('REG-E2E-02: WhatsApp location pin received and transitioned to AWAITING_LOCATION_DETAILS');

      // Step 3: Customer enters room/building text "5004, Ksa"
      const textRes = await handleIncomingMessage(tenant.id, custPhone, {
        messageType: 'text',
        text: '5004, Ksa'
      });
      assert.strictEqual(textRes.session.current_step, 'AWAITING_SAVE_CONSENT', 'Step is AWAITING_SAVE_CONSENT');
      assert.strictEqual(
        textRes.session.state.address.addressText,
        '5004, Ksa, 245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India',
        'Session address must not duplicate location name and address'
      );
      pass('REG-E2E-03: Room & building combined with location without duplicate address string');

      // Step 4: Customer declines to save address (one-time use)
      const consentRes = await handleIncomingMessage(tenant.id, custPhone, {
        messageType: 'interactive',
        interactiveReply: { id: 'BTN_CONSENT_NO' }
      });
      assert.strictEqual(consentRes.session.current_step, 'AWAITING_ORDER_TYPE', 'Step is AWAITING_ORDER_TYPE');

      // Step 5: Customer chooses Delivery
      const typeRes = await handleIncomingMessage(tenant.id, custPhone, {
        messageType: 'interactive',
        interactiveReply: { id: 'BTN_ORDER_DELIVERY' }
      });
      assert.strictEqual(typeRes.session.current_step, 'AWAITING_CONFIRMATION', 'Step is AWAITING_CONFIRMATION');

      // Step 6: Customer confirms order
      const confRes = await confirmCustomerOrder({
        restaurantId: tenant.id,
        customerPhone: custPhone,
        confirmationToken: typeRes.session.state.confirmationToken,
        customerName: 'Madi Khan'
      });

      assert.strictEqual(confRes.success, true, 'Order confirmation succeeded');
      assert.strictEqual(confRes.order.status, 'PENDING_RESTAURANT_CONFIRMATION');

      // Verify persisted order in PostgreSQL
      const persistedOrder = await prisma.order.findUnique({
        where: { id: confRes.order.id }
      });

      assert.strictEqual(
        persistedOrder.address_snapshot,
        '5004, Ksa, 245a, Maulana Azad Rd, near nagori clinic, Ashadham Colony, Madanpura, Mumbai, Maharashtra 400008, India',
        'Persisted address_snapshot in DB must be clean and non-duplicated'
      );

      const itemsInDb = persistedOrder.items;
      assert.strictEqual(itemsInDb.length, 2, '2 items in database');
      assert.strictEqual(itemsInDb[0].productName, 'Chicken Dum Biryani (Special)');
      assert.strictEqual(itemsInDb[0].productRetailerId, 'sezp6n6uee');
      assert.strictEqual(itemsInDb[1].productName, 'Mutton Seekh Kebab (4 Pcs)');
      assert.strictEqual(itemsInDb[1].productRetailerId, 'zfzb9a6ptg');

      pass('REG-E2E-04: Order persisted in PostgreSQL with genuine product names, preserved retailer IDs, and deduplicated address');
    }

    console.log('\n============================================================');
    console.log(`   REGRESSION TEST RESULTS: ${passed} PASSED, 0 FAILED`);
    console.log('============================================================\n');

  } finally {
    // Teardown isolated test fixtures
    try {
      clearDynamicCatalogs();
      clearCatalogCache();

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

runRegressionTestSuite().catch(err => {
  console.error('\n❌ Uncaught error during regression test execution:', err);
  process.exit(1);
});
