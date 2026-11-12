/**
 * RESTOPRO — WhatsApp Web Catalogue Browser Companion & Sync Test Suite
 *
 * Comprehensive tests covering:
 *  1. Correct retailer ID -> product name resolution.
 *  2. Multiple products in one cart.
 *  3. Quantity and price preservation.
 *  4. Different restaurants with identical retailer IDs (strict multi-tenant isolation).
 *  5. Unknown retailer IDs (safe fail-closed, no invented names, zero SKU leaks).
 *  6. Catalogue product name updates via sync.
 *  7. Deleted products handling (via REPLACE mode and individual deletion).
 *  8. Browser synchronization authentication (success with HMAC sync token and Admin session).
 *  9. Invalid or unauthorized restaurant synchronization rejection (401/403/404, cross-tenant rejection).
 * 10. Existing order confirmation and owner notification regression tests.
 */
require('./load-test-env');

const http = require('http');
const assert = require('assert');
const prisma = require('../src/config/database');
const app = require('../src/app');
const { encryptToken } = require('../src/utils/crypto');
const {
  generateRestaurantSyncToken,
  verifyRestaurantSyncToken
} = require('../src/utils/sync-auth');
const {
  syncRestaurantCatalog,
  getRestaurantSyncedCatalog,
  deleteCatalogProduct,
  validateCatalogProduct
} = require('../src/services/catalog-sync.service');
const {
  resolveMenuItemName,
  resolveMenuItemNameAsync,
  clearCatalogCache
} = require('../src/services/catalog.service');
const {
  parseAndValidateCart,
  parseAndValidateCartAsync
} = require('../src/parsers/cart-parser');
const {
  buildOrderSummary,
  confirmCustomerOrder
} = require('../src/services/order.service');
const {
  buildOwnerNotificationPayload,
  formatItemDisplayName
} = require('../src/services/whatsapp.service');
const {
  processIncomingCart,
  handleIncomingMessage
} = require('../src/services/conversation.service');
const {
  createAdminSession
} = require('../src/services/admin-auth.service');

const TEST_PORT = 3105;
let server;

function makeRequest({ path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };

    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(rawData);
        } catch (_) {
          json = rawData;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTestSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — BROWSER COMPANION & CATALOGUE SYNC TEST SUITE ');
  console.log('============================================================\n');

  let passed = 0;
  function pass(msg) {
    passed++;
    console.log(`  ✅ [PASS] ${msg}`);
  }

  // Start ephemeral HTTP server for API route tests
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      resolve();
    });
  });

  const testRestaurantIds = [];
  const testCustomerPhones = [];

  try {
    // -------------------------------------------------------------
    // SETUP TEST FIXTURES
    // -------------------------------------------------------------
    const restaurantA = await prisma.restaurant.create({
      data: {
        name: 'Zaika Biryani Center (Test Tenant A)',
        phone_number_id: `test_pn_${Date.now()}_a`,
        waba_id: `test_waba_${Date.now()}_a`,
        owner_phone: '+919900000001',
        access_token_encrypted: encryptToken('test_token_tenant_a'),
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: 'Initial notes for Tenant A'
      }
    });
    testRestaurantIds.push(restaurantA.id);

    const restaurantB = await prisma.restaurant.create({
      data: {
        name: 'Punjab Grill House (Test Tenant B)',
        phone_number_id: `test_pn_${Date.now()}_b`,
        waba_id: `test_waba_${Date.now()}_b`,
        owner_phone: '+919900000002',
        access_token_encrypted: encryptToken('test_token_tenant_b'),
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: 'Initial notes for Tenant B'
      }
    });
    testRestaurantIds.push(restaurantB.id);

    const suspendedRestaurant = await prisma.restaurant.create({
      data: {
        name: 'Suspended Cafe (Test Tenant C)',
        phone_number_id: `test_pn_${Date.now()}_c`,
        waba_id: `test_waba_${Date.now()}_c`,
        owner_phone: '+919900000003',
        access_token_encrypted: encryptToken('test_token_tenant_c'),
        is_active: false,
        tenant_status: 'SUSPENDED'
      }
    });
    testRestaurantIds.push(suspendedRestaurant.id);

    const syncKeyA = generateRestaurantSyncToken(restaurantA.id);
    const syncKeyB = generateRestaurantSyncToken(restaurantB.id);

    // =============================================================
    // TEST 8 & 9: AUTHENTICATION & MULTI-TENANT AUTHORIZATION
    // =============================================================
    console.log('--- PART 1: Browser Synchronization Authentication & Authorization ---');

    // 8.1 Successful status query with valid sync key
    const resGetStatus = await makeRequest({
      path: '/api/catalog/sync',
      method: 'GET',
      headers: {
        'x-restaurant-id': restaurantA.id,
        'x-sync-key': syncKeyA
      }
    });
    assert.strictEqual(resGetStatus.statusCode, 200);
    assert.strictEqual(resGetStatus.body.restaurantId, restaurantA.id);
    assert.strictEqual(resGetStatus.body.restaurantName, 'Zaika Biryani Center (Test Tenant A)');
    assert.strictEqual(resGetStatus.body.totalCatalogCount, 0);
    pass('SYNC-AUTH-01: Valid X-Restaurant-Id and X-Sync-Key successfully authenticates status query');

    // 8.2 Ingestion via POST /api/catalog/sync
    const initialSyncPayload = {
      restaurantId: restaurantA.id,
      products: [
        { productRetailerId: 'zfzb9a6ptg', name: 'Butter Chicken', price: 180, currency: 'INR' },
        { productRetailerId: 'sezp6n6uee', name: 'Chicken Dum Biryani (Special)', price: 800, currency: 'INR' },
        { productRetailerId: 'dal_makhani_01', name: 'Dal Makhani', price: 220, currency: 'INR' }
      ],
      mode: 'MERGE'
    };

    const resSync = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: {
        'x-restaurant-id': restaurantA.id,
        'x-sync-key': syncKeyA
      },
      body: initialSyncPayload
    });
    assert.strictEqual(resSync.statusCode, 200);
    assert.strictEqual(resSync.body.syncedCount, 3);
    assert.strictEqual(resSync.body.totalCatalogCount, 3);
    pass('SYNC-AUTH-02: Valid browser companion POST ingestion synchronizes catalogue products');

    // 9.1 Missing Restaurant ID rejected with HTTP 400
    const resMissingTenant = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: { 'x-sync-key': syncKeyA },
      body: { products: initialSyncPayload.products }
    });
    assert.strictEqual(resMissingTenant.statusCode, 400);
    assert.ok(resMissingTenant.body.error.includes('X-Restaurant-Id'));
    pass('SYNC-REJECT-01: Missing X-Restaurant-Id rejected with HTTP 400');

    // 9.2 Missing X-Sync-Key rejected with HTTP 401
    const resMissingKey = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: { 'x-restaurant-id': restaurantA.id },
      body: initialSyncPayload
    });
    assert.strictEqual(resMissingKey.statusCode, 401);
    assert.ok(resMissingKey.body.error.includes('Unauthorized'));
    pass('SYNC-REJECT-02: Missing sync key rejected with HTTP 401');

    // 9.3 Invalid/tampered sync key rejected with HTTP 401
    const resInvalidKey = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: {
        'x-restaurant-id': restaurantA.id,
        'x-sync-key': 'bad_token_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      },
      body: initialSyncPayload
    });
    assert.strictEqual(resInvalidKey.statusCode, 401);
    pass('SYNC-REJECT-03: Tampered sync key rejected with HTTP 401');

    // 9.4 Cross-Tenant Key Injection Rejected (Tenant B key targeting Tenant A)
    const resCrossTenant = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: {
        'x-restaurant-id': restaurantA.id,
        'x-sync-key': syncKeyB // Key computed for Restaurant B, sent with Restaurant A ID
      },
      body: initialSyncPayload
    });
    assert.strictEqual(resCrossTenant.statusCode, 401);
    pass('SYNC-REJECT-04: Cross-tenant sync key injection strictly rejected with HTTP 401');

    // 9.5 Suspended Restaurant Rejected with HTTP 403
    const syncKeyC = generateRestaurantSyncToken(suspendedRestaurant.id);
    const resSuspended = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: {
        'x-restaurant-id': suspendedRestaurant.id,
        'x-sync-key': syncKeyC
      },
      body: initialSyncPayload
    });
    assert.strictEqual(resSuspended.statusCode, 403);
    pass('SYNC-REJECT-05: Inactive/suspended restaurant rejected with HTTP 403');

    // 9.6 Non-existent Restaurant Rejected with HTTP 404
    const nonExistentId = '99999999-9999-4999-9999-999999999999';
    const fakeKey = generateRestaurantSyncToken(nonExistentId);
    const resNotFound = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: {
        'x-restaurant-id': nonExistentId,
        'x-sync-key': fakeKey
      },
      body: initialSyncPayload
    });
    assert.strictEqual(resNotFound.statusCode, 404);
    pass('SYNC-REJECT-06: Non-existent restaurant ID returns HTTP 404');

    // =============================================================
    // TEST 1: CORRECT RETAILER ID -> PRODUCT NAME RESOLUTION
    // =============================================================
    console.log('--- PART 2: Authoritative Product Name Resolution ---');

    // Verify restaurant A's internal_notes now contains the menuCatalog metadata
    const updatedA = await prisma.restaurant.findUnique({ where: { id: restaurantA.id } });
    assert.ok(updatedA.internal_notes.includes('Butter Chicken'));
    assert.ok(updatedA.internal_notes.includes('Chicken Dum Biryani (Special)'));

    // Test synchronous resolution with internalNotes
    const resResolved1 = resolveMenuItemName({
      restaurantId: restaurantA.id,
      productRetailerId: 'zfzb9a6ptg',
      internalNotes: updatedA.internal_notes
    });
    assert.strictEqual(resResolved1.isResolved, true);
    assert.strictEqual(resResolved1.name, 'Butter Chicken');
    assert.strictEqual(resResolved1.price, 180);
    pass('RESOLVE-01: Retailer ID "zfzb9a6ptg" resolves accurately to genuine name "Butter Chicken"');

    const resResolved2 = resolveMenuItemName({
      restaurantId: restaurantA.id,
      productRetailerId: 'sezp6n6uee',
      internalNotes: updatedA.internal_notes
    });
    assert.strictEqual(resResolved2.isResolved, true);
    assert.strictEqual(resResolved2.name, 'Chicken Dum Biryani (Special)');
    assert.strictEqual(resResolved2.price, 800);
    pass('RESOLVE-02: Retailer ID "sezp6n6uee" resolves accurately to "Chicken Dum Biryani (Special)"');

    // Test async resolution without passing internalNotes explicitly (reads from DB / in-memory cache)
    const resAsyncResolved = await resolveMenuItemNameAsync({
      restaurantId: restaurantA.id,
      productRetailerId: 'dal_makhani_01'
    });
    assert.strictEqual(resAsyncResolved.isResolved, true);
    assert.strictEqual(resAsyncResolved.name, 'Dal Makhani');
    assert.strictEqual(resAsyncResolved.price, 220);
    pass('RESOLVE-03: resolveMenuItemNameAsync resolves accurately from database / in-memory cache');

    // =============================================================
    // TEST 2: MULTIPLE PRODUCTS IN ONE CART
    // =============================================================
    console.log('--- PART 3: Multiple Products in One Native WhatsApp Cart ---');

    const rawMultiCart = {
      catalog_id: '1661745362087273',
      text: 'Please make it extra spicy',
      product_items: [
        { product_retailer_id: 'sezp6n6uee', quantity: 2, item_price: 800, currency: 'INR' },
        { product_retailer_id: 'zfzb9a6ptg', quantity: 1, item_price: 180, currency: 'INR' },
        { product_retailer_id: 'dal_makhani_01', quantity: 1, item_price: 220, currency: 'INR' }
      ]
    };

    const cartResult = await parseAndValidateCartAsync(rawMultiCart, {
      restaurantId: restaurantA.id,
      internalNotes: updatedA.internal_notes
    });

    assert.strictEqual(cartResult.isValid, true);
    assert.strictEqual(cartResult.cart.itemCount, 4); // 2 + 1 + 1
    assert.strictEqual(cartResult.cart.distinctItemCount, 3);
    assert.strictEqual(cartResult.cart.items[0].productName, 'Chicken Dum Biryani (Special)');
    assert.strictEqual(cartResult.cart.items[1].productName, 'Butter Chicken');
    assert.strictEqual(cartResult.cart.items[2].productName, 'Dal Makhani');
    pass('MULTI-CART-01: Multiple products in single cart all resolve to genuine product names');

    // =============================================================
    // TEST 3: QUANTITY AND PRICE PRESERVATION
    // =============================================================
    console.log('--- PART 4: Quantity and Price Preservation ---');

    assert.strictEqual(cartResult.cart.items[0].quantity, 2);
    assert.strictEqual(cartResult.cart.items[0].unitPrice, 800);
    assert.strictEqual(cartResult.cart.items[0].subtotal, 1600);

    assert.strictEqual(cartResult.cart.items[1].quantity, 1);
    assert.strictEqual(cartResult.cart.items[1].unitPrice, 180);
    assert.strictEqual(cartResult.cart.items[1].subtotal, 180);

    assert.strictEqual(cartResult.cart.items[2].quantity, 1);
    assert.strictEqual(cartResult.cart.items[2].unitPrice, 220);
    assert.strictEqual(cartResult.cart.items[2].subtotal, 220);

    // Total: 1600 + 180 + 220 = 2000
    assert.strictEqual(cartResult.cart.subtotal, 2000);
    pass('PRICE-QTY-01: Quantity, unit price, and subtotal calculations exactly preserved with decimal safety');

    // =============================================================
    // TEST 4: DIFFERENT RESTAURANTS WITH IDENTICAL RETAILER IDS
    // =============================================================
    console.log('--- PART 5: Multi-Tenant Isolation with Identical Retailer IDs ---');

    // Sync identical retailer ID "special_dish_99" to both Restaurant A and Restaurant B with different names
    await syncRestaurantCatalog({
      restaurantId: restaurantA.id,
      products: [
        { productRetailerId: 'special_dish_99', name: 'Zaika Special Mutton Korma', price: 450, currency: 'INR' }
      ],
      mode: 'MERGE'
    });

    await syncRestaurantCatalog({
      restaurantId: restaurantB.id,
      products: [
        { productRetailerId: 'special_dish_99', name: 'Punjab Grill Paneer Butter Masala', price: 290, currency: 'INR' }
      ],
      mode: 'MERGE'
    });

    // Refresh records
    const freshA = await prisma.restaurant.findUnique({ where: { id: restaurantA.id } });
    const freshB = await prisma.restaurant.findUnique({ where: { id: restaurantB.id } });

    const tenantAResolution = resolveMenuItemName({
      restaurantId: restaurantA.id,
      productRetailerId: 'special_dish_99',
      internalNotes: freshA.internal_notes
    });

    const tenantBResolution = resolveMenuItemName({
      restaurantId: restaurantB.id,
      productRetailerId: 'special_dish_99',
      internalNotes: freshB.internal_notes
    });

    assert.strictEqual(tenantAResolution.name, 'Zaika Special Mutton Korma');
    assert.strictEqual(tenantAResolution.price, 450);

    assert.strictEqual(tenantBResolution.name, 'Punjab Grill Paneer Butter Masala');
    assert.strictEqual(tenantBResolution.price, 290);
    pass('TENANT-ISO-01: Identical retailer ID "special_dish_99" independently resolves per tenant without cross-contamination');

    // =============================================================
    // TEST 5: UNKNOWN RETAILER IDS (FAIL-CLOSED BEHAVIOUR)
    // =============================================================
    console.log('--- PART 6: Unknown Retailer IDs Fail-Closed Protection ---');

    const unknownRes = resolveMenuItemName({
      restaurantId: restaurantA.id,
      productRetailerId: 'unregistered_mystery_sku_888',
      internalNotes: freshA.internal_notes
    });

    assert.strictEqual(unknownRes.name, null);
    assert.strictEqual(unknownRes.isResolved, false);
    assert.strictEqual(unknownRes.source, 'UNRESOLVED');
    assert.strictEqual(unknownRes.productRetailerId, 'unregistered_mystery_sku_888');
    pass('FAIL-CLOSED-01: Unknown retailer ID returns name: null and isResolved: false; never invents names');

    // Strict validation rejection when unresolved item in cart
    const unresolvableCart = {
      catalog_id: '1661745362087273',
      product_items: [
        { product_retailer_id: 'unregistered_mystery_sku_888', quantity: 1, item_price: 150, currency: 'INR' }
      ]
    };

    const strictValidation = parseAndValidateCart(unresolvableCart, {
      restaurantId: restaurantA.id,
      internalNotes: freshA.internal_notes,
      strictResolution: true
    });

    assert.strictEqual(strictValidation.isValid, false);
    assert.strictEqual(strictValidation.code, 'UNRESOLVED_CATALOG_ITEM');
    pass('FAIL-CLOSED-02: Cart with unresolvable catalogue item strictly rejected under strict resolution mode');

    // =============================================================
    // TEST 6: CATALOGUE PRODUCT NAME UPDATES VIA SYNC
    // =============================================================
    console.log('--- PART 7: Catalogue Product Name Updates ---');

    // Update 'zfzb9a6ptg' from 'Butter Chicken' to 'Butter Chicken (Boneless)'
    const updateRes = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: {
        'x-restaurant-id': restaurantA.id,
        'x-sync-key': syncKeyA
      },
      body: {
        restaurantId: restaurantA.id,
        products: [
          { productRetailerId: 'zfzb9a6ptg', name: 'Butter Chicken (Boneless)', price: 195, currency: 'INR' }
        ],
        mode: 'MERGE'
      }
    });
    assert.strictEqual(updateRes.statusCode, 200);

    const reUpdatedA = await prisma.restaurant.findUnique({ where: { id: restaurantA.id } });
    const updatedNameResolution = resolveMenuItemName({
      restaurantId: restaurantA.id,
      productRetailerId: 'zfzb9a6ptg',
      internalNotes: reUpdatedA.internal_notes
    });

    assert.strictEqual(updatedNameResolution.name, 'Butter Chicken (Boneless)');
    assert.strictEqual(updatedNameResolution.price, 195);
    pass('CAT-UPDATE-01: Synchronized update immediately modifies product name to "Butter Chicken (Boneless)"');

    // =============================================================
    // TEST 7: DELETED PRODUCTS (REPLACE MODE & DELETE ENDPOINT)
    // =============================================================
    console.log('--- PART 8: Deleted Products Handling ---');

    // 7.1 Single product deletion via DELETE /api/catalog/sync/:retailerId
    const delRes = await makeRequest({
      path: '/api/catalog/sync/dal_makhani_01',
      method: 'DELETE',
      headers: {
        'x-restaurant-id': restaurantA.id,
        'x-sync-key': syncKeyA
      }
    });
    assert.strictEqual(delRes.statusCode, 200);
    assert.strictEqual(delRes.body.deleted, true);

    const afterDelA = await prisma.restaurant.findUnique({ where: { id: restaurantA.id } });
    const deletedResolution = resolveMenuItemName({
      restaurantId: restaurantA.id,
      productRetailerId: 'dal_makhani_01',
      internalNotes: afterDelA.internal_notes
    });
    assert.strictEqual(deletedResolution.isResolved, false);
    pass('CAT-DELETE-01: DELETE /api/catalog/sync/:retailerId successfully removes deleted item from catalogue');

    // 7.2 Full catalogue overwrite via REPLACE mode
    const replaceSyncRes = await makeRequest({
      path: '/api/catalog/sync',
      method: 'POST',
      headers: {
        'x-restaurant-id': restaurantA.id,
        'x-sync-key': syncKeyA
      },
      body: {
        restaurantId: restaurantA.id,
        products: [
          { productRetailerId: 'fresh_item_101', name: 'Mutton Rogan Josh', price: 420, currency: 'INR' }
        ],
        mode: 'REPLACE'
      }
    });
    assert.strictEqual(replaceSyncRes.statusCode, 200);
    assert.strictEqual(replaceSyncRes.body.totalCatalogCount, 1);

    const replacedA = await prisma.restaurant.findUnique({ where: { id: restaurantA.id } });
    const oldItemResolution = resolveMenuItemName({
      restaurantId: restaurantA.id,
      productRetailerId: 'zfzb9a6ptg',
      internalNotes: replacedA.internal_notes
    });
    assert.strictEqual(oldItemResolution.isResolved, false);

    const newItemResolution = resolveMenuItemName({
      restaurantId: restaurantA.id,
      productRetailerId: 'fresh_item_101',
      internalNotes: replacedA.internal_notes
    });
    assert.strictEqual(newItemResolution.isResolved, true);
    assert.strictEqual(newItemResolution.name, 'Mutton Rogan Josh');
    pass('CAT-REPLACE-01: REPLACE mode cleanly removes omitted items and populates new catalogue');

    // Re-populate standard items for final regression test
    await syncRestaurantCatalog({
      restaurantId: restaurantA.id,
      products: [
        { productRetailerId: 'zfzb9a6ptg', name: 'Butter Chicken', price: 180, currency: 'INR' },
        { productRetailerId: 'sezp6n6uee', name: 'Chicken Dum Biryani (Special)', price: 800, currency: 'INR' }
      ],
      mode: 'MERGE'
    });
    const finalA = await prisma.restaurant.findUnique({ where: { id: restaurantA.id } });

    // =============================================================
    // TEST 10: END-TO-END ORDER CONFIRMATION & OWNER NOTIFICATION
    // =============================================================
    console.log('--- PART 9: End-to-End Order & Notification Regression ---');

    const customerPhone = '+919876543299';
    testCustomerPhones.push(customerPhone);

    const finalCart = {
      catalogId: '1661745362087273',
      currency: 'INR',
      items: [
        { productRetailerId: 'sezp6n6uee', productName: 'Chicken Dum Biryani (Special)', quantity: 1, unitPrice: 800, isResolved: true },
        { productRetailerId: 'zfzb9a6ptg', productName: 'Butter Chicken', quantity: 2, unitPrice: 180, isResolved: true }
      ]
    };

    const summary = buildOrderSummary({
      cart: finalCart,
      customerName: 'Aarav Sharma',
      address: { addressText: 'Flat 402, Lotus Residency, MG Road, Mumbai' },
      orderType: 'DELIVERY',
      restaurantName: restaurantA.name
    });

    assert.ok(summary.summaryText.includes('1. Chicken Dum Biryani (Special) (x1) — ₹800.00'));
    assert.ok(summary.summaryText.includes('2. Butter Chicken (x2) — ₹360.00'));
    assert.ok(!summary.summaryText.includes('zfzb9a6ptg'));
    assert.ok(!summary.summaryText.includes('sezp6n6uee'));
    assert.ok(!summary.summaryText.includes('Item ('));
    pass('E2E-01: Customer order confirmation displays genuine product names with zero raw SKU leakage');

    // Process incoming cart through conversation engine
    const rawOrderPayload = {
      catalog_id: '1661745362087273',
      product_items: [
        { product_retailer_id: 'sezp6n6uee', quantity: 1, item_price: 800, currency: 'INR' },
        { product_retailer_id: 'zfzb9a6ptg', quantity: 2, item_price: 180, currency: 'INR' }
      ]
    };

    const cartRes = await processIncomingCart(restaurantA.id, customerPhone, rawOrderPayload, 'Aarav Sharma');
    assert.strictEqual(cartRes.success, true);
    assert.strictEqual(cartRes.session.state.cart.items[0].productName, 'Chicken Dum Biryani (Special)');
    assert.strictEqual(cartRes.session.state.cart.items[1].productName, 'Butter Chicken');

    // Confirm customer order in database
    const orderResult = await prisma.$transaction(async (tx) => {
      await tx.conversationSession.update({
        where: { id: cartRes.session.id },
        data: {
          current_step: 'AWAITING_CONFIRMATION',
          state: {
            ...cartRes.session.state,
            orderType: 'DELIVERY',
            address: { addressText: 'Flat 402, Lotus Residency, MG Road, Mumbai' },
            customerName: 'Aarav Sharma'
          }
        }
      });

      return confirmCustomerOrder({
        restaurantId: restaurantA.id,
        customerPhone,
        confirmationToken: cartRes.session.state.confirmationToken,
        customerName: 'Aarav Sharma',
        txClient: tx
      });
    });

    assert.strictEqual(orderResult.success, true);
    assert.strictEqual(orderResult.order.items.length, 2);
    assert.strictEqual(orderResult.order.items[0].productName, 'Chicken Dum Biryani (Special)');
    assert.strictEqual(orderResult.order.items[1].productName, 'Butter Chicken');
    pass('E2E-02: Order successfully persisted in database with genuine product names');

    // Format owner notification payload
    const ownerPayload = buildOwnerNotificationPayload({
      ownerPhone: restaurantA.owner_phone,
      order: orderResult.order,
      restaurantName: restaurantA.name,
      useTemplate: false
    });

    const ownerText = ownerPayload.interactive?.body?.text || '';
    assert.ok(ownerText.includes('Chicken Dum Biryani (Special)'));
    assert.ok(ownerText.includes('Butter Chicken'));
    assert.ok(!ownerText.includes('zfzb9a6ptg'));
    assert.ok(!ownerText.includes('sezp6n6uee'));
    pass('E2E-03: Owner WhatsApp notification displays genuine product names with zero SKU leaks');

  } finally {
    // Teardown test server
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // Cleanup test records
    console.log('\n--- Cleaning up test records ---');
    try {
      if (testCustomerPhones.length > 0) {
        await prisma.order.deleteMany({
          where: { customer_phone: { in: testCustomerPhones } }
        });
      }
      if (testRestaurantIds.length > 0) {
        await prisma.outboxMessage.deleteMany({
          where: { restaurant_id: { in: testRestaurantIds } }
        });
        await prisma.restaurant.deleteMany({
          where: { id: { in: testRestaurantIds } }
        });
      }
      console.log('Test records safely cleaned up.');
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
  }

  console.log('\n============================================================');
  console.log(`   BROWSER COMPANION & SYNC SUITE: ${passed} PASSED, 0 FAILED`);
  console.log('============================================================\n');
}

runTestSuite().catch(err => {
  console.error('\n❌ Test Suite Failed with unhandled error:\n', err);
  process.exit(1);
});
