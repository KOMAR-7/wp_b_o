/**
 * RESTOPRO — Stage 4.3: Address Collection & Saved Addresses Test Suite
 * Tests ST4-07, ST4-08, ST4-09, and ST4-10:
 * - Saved address lookup, reuse, and cross-tenant/cross-customer isolation
 * - Manual text address validation (>= 10 chars, reprompt)
 * - Location pin parsing (including 0.0 preservation and range checks)
 * - Building name & room/flat number collection pipeline
 * - Explicit consent flow (Yes persists, No does not persist, duplicate prevention)
 * - Session integrity, 2-reminder cap, and concurrent safety
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
  calculateSessionExpiry,
  getContextualPromptForStep
} = require('../src/services/conversation.service');
const {
  validateTextAddress,
  validateCoordinates,
  validateBuildingName,
  validateRoomNumber,
  normalizeAddress,
  findCustomerSavedAddresses,
  findSavedAddressById,
  saveConsentedAddress
} = require('../src/services/address.service');

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

async function runStage4AddressTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 4.3: ADDRESS COLLECTION TEST SUITE     ');
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

    const testCartPayload = {
      catalog_id: 'CAT_TEST_43',
      product_items: [
        { product_retailer_id: 'SKU_BIRYANI', quantity: 1, item_price: 250.00, currency: 'INR' }
      ]
    };

    // -------------------------------------------------------------
    // TEST GROUP 1: Saved Addresses Lookup, Reuse & Isolation (ST4-07)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: Saved Addresses Lookup, Reuse & Isolation (ST4-07) ---');
    const custSaved1 = `9198111${Math.floor(10000 + Math.random() * 90000)}`;
    const custSaved2 = `9198112${Math.floor(10000 + Math.random() * 90000)}`;

    // Seed a saved address for custSaved1 at Tenant A
    const savedAddr1 = await prisma.savedAddress.create({
      data: {
        restaurant_id: tenantA.id,
        customer_phone: custSaved1,
        label: 'Home',
        address: 'Room/Flat: 402, Building: Sunrise Heights, Area: Andheri West, Mumbai',
        latitude: 19.1197000,
        longitude: 72.8468000
      }
    });
    createdSavedAddressIds.push(savedAddr1.id);

    // 1. Existing saved address lookup
    {
      const addresses = await findCustomerSavedAddresses(tenantA.id, custSaved1);
      assert(addresses.length === 1, 'Existing saved address retrieved for customer at Tenant A');
      assert(addresses[0].address.includes('Sunrise Heights'), 'Address text matches seeded record');
      assert(addresses[0].address.includes('402'), 'Address includes room/flat number');
    }

    // 2. Saved address reuse via cart submission routes to AWAITING_ADDRESS_CHOICE
    {
      const cartRes = await processIncomingCart(tenantA.id, custSaved1, testCartPayload);
      createdSessionIds.push(cartRes.session.id);
      assert(cartRes.session.current_step === 'AWAITING_ADDRESS_CHOICE', 'Customer with saved address transitions to AWAITING_ADDRESS_CHOICE');
      assert(cartRes.action.type === 'PROMPT_ADDRESS_CHOICE', 'Cart action prompts address choice');
      assert(cartRes.action.savedAddresses.length === 1, 'Saved address list included in action');
    }

    // 3. Saved address reuse via BTN_USE_SAVED_ADDRESS
    {
      const useSavedRes = await handleIncomingMessage(tenantA.id, custSaved1, {
        messageType: 'button',
        buttonReply: { payload: `BTN_USE_SAVED_ADDRESS:${savedAddr1.id}` }
      });

      assert(useSavedRes.session.current_step === 'AWAITING_ORDER_TYPE', 'Selecting saved address transitions to AWAITING_ORDER_TYPE');
      assert(useSavedRes.session.state.address.source === 'SAVED', 'Address source is SAVED');
      assert(useSavedRes.session.state.address.addressText === savedAddr1.address, 'Session address matches saved address text');
      assert(useSavedRes.session.state.addressSaved === true, 'Session marks addressSaved = true');
    }

    // 4. No saved address available routes to AWAITING_ADDRESS_INPUT
    {
      const custNoSaved = `9198113${Math.floor(10000 + Math.random() * 90000)}`;
      const cartRes = await processIncomingCart(tenantA.id, custNoSaved, testCartPayload);
      createdSessionIds.push(cartRes.session.id);
      assert(cartRes.session.current_step === 'AWAITING_ADDRESS_INPUT', 'Customer without saved address transitions directly to AWAITING_ADDRESS_INPUT');
      assert(cartRes.action.type === 'PROMPT_ADDRESS_COLLECTION', 'Action prompts address collection');
    }

    // 5. Cross-tenant address access rejected (Tenant B cannot see or use Tenant A address)
    {
      const tenantBAddresses = await findCustomerSavedAddresses(tenantB.id, custSaved1);
      assert(tenantBAddresses.length === 0, 'Tenant A address is invisible at Tenant B (Zero Cross-Tenant Leakage)');

      // Attempt to reuse Tenant A address at Tenant B
      const cartBRes = await processIncomingCart(tenantB.id, custSaved1, testCartPayload);
      createdSessionIds.push(cartBRes.session.id);
      assert(cartBRes.session.current_step === 'AWAITING_ADDRESS_INPUT', 'Tenant B session defaults to AWAITING_ADDRESS_INPUT (no saved address found for Tenant B)');

      // Force session to choice and attempt exploit with Tenant A address ID
      await prisma.conversationSession.update({
        where: { id: cartBRes.session.id },
        data: { current_step: 'AWAITING_ADDRESS_CHOICE' }
      });

      const exploitRes = await handleIncomingMessage(tenantB.id, custSaved1, {
        messageType: 'button',
        buttonReply: { payload: `BTN_USE_SAVED_ADDRESS:${savedAddr1.id}` }
      });

      assert(exploitRes.session.current_step === 'AWAITING_ADDRESS_CHOICE', 'Cross-tenant saved address selection rejected; step preserved');
      assert(!exploitRes.session.state.address, 'No address attached to Tenant B session');
    }

    // 6. Cross-customer address access rejected (Customer 2 cannot use Customer 1 address)
    {
      const cartRes2 = await processIncomingCart(tenantA.id, custSaved2, testCartPayload);
      createdSessionIds.push(cartRes2.session.id);

      await prisma.conversationSession.update({
        where: { id: cartRes2.session.id },
        data: { current_step: 'AWAITING_ADDRESS_CHOICE' }
      });

      const custExploitRes = await handleIncomingMessage(tenantA.id, custSaved2, {
        messageType: 'button',
        buttonReply: { payload: `BTN_USE_SAVED_ADDRESS:${savedAddr1.id}` }
      });

      assert(custExploitRes.session.current_step === 'AWAITING_ADDRESS_CHOICE', 'Cross-customer address access strictly rejected');
      assert(!custExploitRes.session.state.address, 'Customer 2 cannot claim Customer 1 address');
    }

    // 7. Generic BTN_USE_SAVED_ADDRESS (without ID) picks primary saved address
    {
      const custGeneric = `9198114${Math.floor(10000 + Math.random() * 90000)}`;
      const addrGen = await prisma.savedAddress.create({
        data: {
          restaurant_id: tenantA.id,
          customer_phone: custGeneric,
          label: 'Default',
          address: 'Flat 101, Palm Court, Malad West, Mumbai'
        }
      });
      createdSavedAddressIds.push(addrGen.id);

      const cartRes = await processIncomingCart(tenantA.id, custGeneric, testCartPayload);
      createdSessionIds.push(cartRes.session.id);

      const res = await handleIncomingMessage(tenantA.id, custGeneric, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_USE_SAVED_ADDRESS' }
      });

      assert(res.session.current_step === 'AWAITING_ORDER_TYPE', 'Generic BTN_USE_SAVED_ADDRESS transitions to AWAITING_ORDER_TYPE');
      assert(res.session.state.address.addressText === addrGen.address, 'Generic button loaded customer primary address');
    }

    // 8. BTN_ENTER_NEW_ADDRESS transitions from choice to AWAITING_ADDRESS_INPUT
    {
      const custChoiceNew = `9198115${Math.floor(10000 + Math.random() * 90000)}`;
      const addrNewChoice = await prisma.savedAddress.create({
        data: {
          restaurant_id: tenantA.id,
          customer_phone: custChoiceNew,
          address: 'House 5, Park Street, Kolkata'
        }
      });
      createdSavedAddressIds.push(addrNewChoice.id);

      const cartRes = await processIncomingCart(tenantA.id, custChoiceNew, testCartPayload);
      createdSessionIds.push(cartRes.session.id);

      const res = await handleIncomingMessage(tenantA.id, custChoiceNew, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ENTER_NEW_ADDRESS' }
      });

      assert(res.session.current_step === 'AWAITING_ADDRESS_INPUT', 'BTN_ENTER_NEW_ADDRESS transitions to AWAITING_ADDRESS_INPUT');
      assert(res.action.type === 'PROMPT_ADDRESS_INPUT', 'Action prompts for new address input');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Manual Text Address Capture & Validation (ST4-08)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Manual Text Address Capture & Validation (ST4-08) ---');
    const custManual = `9198121${Math.floor(10000 + Math.random() * 90000)}`;

    const cartManualRes = await processIncomingCart(tenantA.id, custManual, testCartPayload);
    createdSessionIds.push(cartManualRes.session.id);
    assert(cartManualRes.session.current_step === 'AWAITING_ADDRESS_INPUT', 'Session ready in AWAITING_ADDRESS_INPUT');

    // 9. Valid manual text address (>= 10 characters)
    {
      const validText = 'Flat 204, Royal Palms, Goregaon East, Mumbai 400065';
      const textRes = await handleIncomingMessage(tenantA.id, custManual, {
        messageType: 'text',
        text: validText
      });

      assert(textRes.session.current_step === 'AWAITING_SAVE_CONSENT', 'Valid text address transitions to AWAITING_SAVE_CONSENT');
      assert(textRes.session.state.address.source === 'MANUAL', 'Address source is MANUAL');
      assert(textRes.session.state.address.addressText === validText, 'Address text matches input');
      assert(textRes.session.state.address.latitude === null, 'Manual address has null latitude');
      assert(textRes.session.state.address.longitude === null, 'Manual address has null longitude');
      assert(textRes.action.type === 'VALID_TEXT_INPUT' || textRes.action.type === 'PROMPT_SAVE_CONSENT', 'Action prompts for save consent');

      // Verify no permanent DB record yet (ST4-08: do not save permanently yet)
      const count = await prisma.savedAddress.count({
        where: { restaurant_id: tenantA.id, customer_phone: custManual }
      });
      assert(count === 0, 'Address is NOT permanently saved before explicit consent (ST4-08)');
    }

    // 10. Address shorter than 10 characters rejected
    {
      const custShort = `9198122${Math.floor(10000 + Math.random() * 90000)}`;
      const cartShortRes = await processIncomingCart(tenantA.id, custShort, testCartPayload);
      createdSessionIds.push(cartShortRes.session.id);

      const shortRes = await handleIncomingMessage(tenantA.id, custShort, {
        messageType: 'text',
        text: 'Too short' // 9 characters
      });

      assert(shortRes.session.current_step === 'AWAITING_ADDRESS_INPUT', 'Short address rejected; step stays AWAITING_ADDRESS_INPUT');
      assert(!shortRes.session.state.address, 'No address stored for short text');
      assert(shortRes.session.state.unsupportedCount === 1, 'unsupportedCount incremented on invalid address');
      assert(shortRes.action.type === 'CONTEXTUAL_REPROMPT', 'Contextual reprompt issued for short address');
      assert(shortRes.action.message.includes('too short'), 'Reprompt indicates address is too short');
    }

    // 11. Empty address text rejected
    {
      const custEmpty = `9198123${Math.floor(10000 + Math.random() * 90000)}`;
      const cartEmptyRes = await processIncomingCart(tenantA.id, custEmpty, testCartPayload);
      createdSessionIds.push(cartEmptyRes.session.id);

      const emptyRes = await handleIncomingMessage(tenantA.id, custEmpty, {
        messageType: 'text',
        text: '     ' // Whitespace only
      });

      assert(emptyRes.session.current_step === 'AWAITING_ADDRESS_INPUT', 'Empty address rejected; step stays AWAITING_ADDRESS_INPUT');
      assert(emptyRes.session.state.unsupportedCount === 1, 'unsupportedCount incremented on whitespace');
    }

    // 12. Non-string address rejected via validateTextAddress helper
    {
      const checkObj = validateTextAddress(null);
      assert(checkObj.isValid === false, 'validateTextAddress rejects null');
      const checkNum = validateTextAddress(1234567890);
      assert(checkNum.isValid === false, 'validateTextAddress rejects numbers');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: WhatsApp Location Pin Parsing & Range Validation (ST4-09)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: WhatsApp Location Pin Parsing & Range Validation (ST4-09) ---');

    // 13. Valid coordinates parsed
    {
      const check = validateCoordinates(19.0760, 72.8777);
      assert(check.isValid === true, 'Valid coordinates (Mumbai) accepted');
      assert(check.latitude === 19.0760, 'Latitude correctly parsed');
      assert(check.longitude === 72.8777, 'Longitude correctly parsed');
    }

    // 14. Zero coordinates preserved (0.0, 0.0) without falsy coercion
    {
      const checkZero = validateCoordinates(0.0, 0.0);
      assert(checkZero.isValid === true, 'Zero coordinates (0.0, 0.0) valid');
      assert(checkZero.latitude === 0.0, 'Latitude 0.0 preserved');
      assert(checkZero.longitude === 0.0, 'Longitude 0.0 preserved');

      const checkZeroStr = validateCoordinates('0', '0.0');
      assert(checkZeroStr.isValid === true, 'String zero coordinates ("0", "0.0") valid');
      assert(checkZeroStr.latitude === 0, 'Parsed latitude is 0');
    }

    // 15. Missing coordinates rejected
    {
      const checkMissingLat = validateCoordinates(null, 72.8777);
      assert(checkMissingLat.isValid === false, 'Missing latitude rejected');
      const checkMissingLng = validateCoordinates(19.0760, null);
      assert(checkMissingLng.isValid === false, 'Missing longitude rejected');
    }

    // 16. Non-numeric coordinates rejected
    {
      const checkNaN = validateCoordinates('not_a_number', 72.8777);
      assert(checkNaN.isValid === false, 'Non-numeric string latitude rejected');
    }

    // 17. Out-of-range coordinates rejected
    {
      const checkLatHigh = validateCoordinates(95.0, 72.8777);
      assert(checkLatHigh.isValid === false, 'Latitude > 90 rejected');
      const checkLatLow = validateCoordinates(-95.0, 72.8777);
      assert(checkLatLow.isValid === false, 'Latitude < -90 rejected');

      const checkLngHigh = validateCoordinates(19.0760, 185.0);
      assert(checkLngHigh.isValid === false, 'Longitude > 180 rejected');
      const checkLngLow = validateCoordinates(19.0760, -185.0);
      assert(checkLngLow.isValid === false, 'Longitude < -180 rejected');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Direct Location Pin Normalization (Streamlined Flow)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Direct Location Pin Normalization (Streamlined Flow) ---');
    const custPin = `9198131${Math.floor(10000 + Math.random() * 90000)}`;

    const cartPinRes = await processIncomingCart(tenantA.id, custPin, testCartPayload);
    createdSessionIds.push(cartPinRes.session.id);
    assert(cartPinRes.session.current_step === 'AWAITING_ADDRESS_INPUT', 'Session initialized for location pin');

    // 18. Valid location pin triggers transition directly to AWAITING_SAVE_CONSENT (no friction turns)
    {
      const pinEvent = {
        messageType: 'location',
        location: {
          latitude: 19.1197,
          longitude: 72.8468,
          name: 'Green Valley',
          address: 'Andheri West, Mumbai'
        }
      };

      const pinRes = await handleIncomingMessage(tenantA.id, custPin, pinEvent);
      assert(pinRes.session.current_step === 'AWAITING_LOCATION_DETAILS', 'Location pin transitions to AWAITING_LOCATION_DETAILS');
      assert(pinRes.action.type === 'PROMPT_LOCATION_DETAILS', 'Action prompts for room and building name');

      const detailsRes = await handleIncomingMessage(tenantA.id, custPin, {
        messageType: 'text',
        text: 'Flat 101, Green Valley Heights'
      });
      assert(detailsRes.session.current_step === 'AWAITING_SAVE_CONSENT', 'Location details transition to AWAITING_SAVE_CONSENT');
      assert(detailsRes.session.state.address.source === 'LOCATION_PIN', 'Address source is LOCATION_PIN');
      assert(detailsRes.session.state.address.latitude === 19.1197, 'Coordinates preserved: latitude');
      assert(detailsRes.session.state.address.longitude === 72.8468, 'Coordinates preserved: longitude');
      assert(detailsRes.session.state.address.addressText.includes('Green Valley') || detailsRes.session.state.address.addressText.includes('19.1197'), 'Location address normalized');
      assert(detailsRes.action.type === 'PROMPT_SAVE_CONSENT', 'Action prompts for address saving consent');
    }

    // -------------------------------------------------------------
    // TEST GROUP 5: Explicit Address-Saving Consent Flow (ST4-10)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Explicit Address-Saving Consent Flow (ST4-10) ---');

    // 23. Explicit Yes (BTN_CONSENT_YES) persists row to saved_addresses
    {
      const consentYesRes = await handleIncomingMessage(tenantA.id, custPin, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CONSENT_YES' }
      });

      assert(consentYesRes.session.current_step === 'AWAITING_ORDER_TYPE', 'Consent YES transitions to AWAITING_ORDER_TYPE');
      assert(consentYesRes.session.state.addressSaved === true, 'Session state marks addressSaved = true');
      assert(consentYesRes.session.state.savedAddressId !== null, 'savedAddressId recorded in session');
      createdSavedAddressIds.push(consentYesRes.session.state.savedAddressId);

      // Verify row in database
      const dbRow = await prisma.savedAddress.findUnique({
        where: { id: consentYesRes.session.state.savedAddressId }
      });
      assert(dbRow !== null, 'Address record physically exists in saved_addresses table');
      assert(dbRow.restaurant_id === tenantA.id, 'Persisted record correctly scoped to tenantA');
      assert(dbRow.customer_phone === custPin, 'Persisted record correctly scoped to customer');
      assert(dbRow.address.includes('Green Valley') || dbRow.address.includes('19.1197'), 'Persisted record contains location details');
      assert(Number(dbRow.latitude) === 19.1197, 'Persisted record contains GPS latitude');
      assert(Number(dbRow.longitude) === 72.8468, 'Persisted record contains GPS longitude');
    }

    // 24. Explicit No (BTN_CONSENT_NO) does NOT persist row to saved_addresses
    {
      const custNoConsent = `9198141${Math.floor(10000 + Math.random() * 90000)}`;
      const cartNoConRes = await processIncomingCart(tenantA.id, custNoConsent, testCartPayload);
      createdSessionIds.push(cartNoConRes.session.id);

      // Submit manual text address
      await handleIncomingMessage(tenantA.id, custNoConsent, {
        messageType: 'text',
        text: 'Apartment 12A, Marina Bay Residences, Marine Lines, Mumbai'
      });

      // Tap NO
      const noRes = await handleIncomingMessage(tenantA.id, custNoConsent, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_CONSENT_NO' }
      });

      assert(noRes.session.current_step === 'AWAITING_ORDER_TYPE', 'Consent NO transitions to AWAITING_ORDER_TYPE');
      assert(noRes.session.state.addressSaved === false, 'Session marks addressSaved = false');
      assert(noRes.session.state.address !== undefined, 'Address retained in active conversation session state');
      assert(noRes.session.state.address.addressText.includes('Marina Bay'), 'Address text intact in session');

      // Verify ZERO rows in saved_addresses table
      const dbRows = await prisma.savedAddress.findMany({
        where: { restaurant_id: tenantA.id, customer_phone: custNoConsent }
      });
      assert(dbRows.length === 0, 'Zero rows created in saved_addresses table on BTN_CONSENT_NO');
    }

    // 25. Duplicate address prevention
    {
      const custDup = `9198151${Math.floor(10000 + Math.random() * 90000)}`;
      const normAddr = normalizeAddress({
        source: 'MANUAL',
        addressText: 'Flat 701, Silver Sands, Juhu Tara Road, Mumbai 400049'
      });

      // First save
      const firstSave = await saveConsentedAddress(tenantA.id, custDup, normAddr, 'Home');
      createdSavedAddressIds.push(firstSave.savedAddress.id);
      assert(firstSave.isDuplicate === false, 'First address save creates new row');

      // Second save with identical address
      const secondSave = await saveConsentedAddress(tenantA.id, custDup, normAddr, 'Home');
      assert(secondSave.isDuplicate === true, 'Second identical save detects duplicate');
      assert(secondSave.savedAddress.id === firstSave.savedAddress.id, 'Duplicate returns existing savedAddress ID without new row');

      const count = await prisma.savedAddress.count({
        where: { restaurant_id: tenantA.id, customer_phone: custDup }
      });
      assert(count === 1, 'Exactly 1 row exists in saved_addresses after duplicate save attempt');
    }

    // -------------------------------------------------------------
    // TEST GROUP 6: Session Security, Inactivity & Edge Cases
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Session Security, Inactivity & Edge Cases ---');
    const custSec = `9198161${Math.floor(10000 + Math.random() * 90000)}`;

    const cartSecRes = await processIncomingCart(tenantA.id, custSec, testCartPayload);
    createdSessionIds.push(cartSecRes.session.id);

    // 26. Inactivity TTL refreshed on address step
    {
      const beforeDate = new Date();
      await handleIncomingMessage(tenantA.id, custSec, {
        messageType: 'location',
        location: { latitude: 12.9716, longitude: 77.5946 }
      });
      await handleIncomingMessage(tenantA.id, custSec, {
        messageType: 'text',
        text: 'Flat 202, Metro Towers'
      });

      const s = await prisma.conversationSession.findUnique({
        where: { id: cartSecRes.session.id }
      });
      const remainingMs = new Date(s.expires_at).getTime() - beforeDate.getTime();
      assert(remainingMs > (1.9 * 60 * 60 * 1000), '2-Hour inactivity TTL refreshed on address input');
    }

    // 27. Invalid button in AWAITING_SAVE_CONSENT does not corrupt session
    {
      const badBtnRes = await handleIncomingMessage(tenantA.id, custSec, {
        messageType: 'button',
        buttonReply: { payload: 'BTN_ORDER_DELIVERY' } // Premature button
      });

      assert(badBtnRes.session.current_step === 'AWAITING_SAVE_CONSENT', 'Session current_step preserved in AWAITING_SAVE_CONSENT');
      assert(badBtnRes.session.state.cart.subtotal === 250.00, 'Cart subtotal uncorrupted after bad button');
    }

    // 28. Two unsupported message reminders followed by silent fallback
    {
      const custRem = `9198171${Math.floor(10000 + Math.random() * 90000)}`;
      const cartRemRes = await processIncomingCart(tenantA.id, custRem, testCartPayload);
      createdSessionIds.push(cartRemRes.session.id);

      // Advance to AWAITING_SAVE_CONSENT via location pin and details
      await handleIncomingMessage(tenantA.id, custRem, {
        messageType: 'location',
        location: { latitude: 28.6139, longitude: 77.2090 }
      });
      await handleIncomingMessage(tenantA.id, custRem, {
        messageType: 'text',
        text: 'Flat 303, CP View'
      });

      // 1st unsupported message (image)
      const r1 = await handleIncomingMessage(tenantA.id, custRem, { messageType: 'image' });
      assert(r1.action.type === 'CONTEXTUAL_REPROMPT', '1st unsupported message triggers CONTEXTUAL_REPROMPT');
      assert(r1.session.state.unsupportedCount === 1, 'unsupportedCount is 1');

      // 2nd unsupported message (audio)
      const r2 = await handleIncomingMessage(tenantA.id, custRem, { messageType: 'audio' });
      assert(r2.action.type === 'CONTEXTUAL_REPROMPT', '2nd unsupported message triggers CONTEXTUAL_REPROMPT');
      assert(r2.session.state.unsupportedCount === 2, 'unsupportedCount is 2');

      // 3rd unsupported message -> SILENT_FALLBACK
      const r3 = await handleIncomingMessage(tenantA.id, custRem, { messageType: 'sticker' });
      assert(r3.action.type === 'SILENT_FALLBACK', '3rd unsupported message triggers SILENT_FALLBACK');
      assert(r3.session.current_step === 'AWAITING_SAVE_CONSENT', 'Step preserved during silent fallback');
    }

    // 29. Webhook HTTP POST pipeline for location pin
    {
      const custWh = `9198181${Math.floor(10000 + Math.random() * 90000)}`;
      const wamidLoc = `wamid.LOC_PIN_${Date.now()}`;

      // Initialize session via cart
      await processIncomingCart(tenantA.id, custWh, testCartPayload);

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
                      id: wamidLoc,
                      timestamp: '1793893000',
                      type: 'location',
                      location: {
                        latitude: 13.0827,
                        longitude: 80.2707,
                        name: 'Chennai Central',
                        address: 'Chennai, Tamil Nadu'
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

      assert(res.statusCode === 200, 'HTTP POST location pin webhook returns HTTP 200');

      const ev = await prisma.webhookEvent.findUnique({ where: { event_key: wamidLoc } });
      assert(ev !== null && ev.processing_status === 'COMPLETED', 'Location pin webhookEvent completed in DB');
      createdWebhookEventIds.push(ev.id);

      const s = await prisma.conversationSession.findUnique({
        where: { restaurant_id_customer_phone: { restaurant_id: tenantA.id, customer_phone: custWh } }
      });
      assert(s.current_step === 'AWAITING_LOCATION_DETAILS', 'Session transitioned to AWAITING_LOCATION_DETAILS via webhook HTTP POST');
      createdSessionIds.push(s.id);
    }

    // 30. Concurrent address input safety
    {
      const custConc = `9198191${Math.floor(10000 + Math.random() * 90000)}`;
      await processIncomingCart(tenantA.id, custConc, testCartPayload);

      const results = await Promise.all([
        handleIncomingMessage(tenantA.id, custConc, { messageType: 'text', text: 'Flat 101, Building Alpha, Sector 5, Navi Mumbai' }),
        handleIncomingMessage(tenantA.id, custConc, { messageType: 'text', text: 'Flat 102, Building Beta, Sector 6, Navi Mumbai' })
      ]);

      const allOk = results.every(r => r.success === true);
      assert(allOk, 'Concurrent address messages resolve cleanly without deadlocks');

      const finalSession = await prisma.conversationSession.findUnique({
        where: { restaurant_id_customer_phone: { restaurant_id: tenantA.id, customer_phone: custConc } }
      });
      assert(finalSession.current_step === 'AWAITING_SAVE_CONSENT', 'Session is consistently in AWAITING_SAVE_CONSENT after concurrent calls');
      createdSessionIds.push(finalSession.id);
    }

  } catch (err) {
    console.error('\n❌ Unexpected error during Stage 4.3 test execution:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up test artifacts ---');
    try {
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
  console.log(`   STAGE 4.3 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage4AddressTests();
}

module.exports = { runStage4AddressTests };

