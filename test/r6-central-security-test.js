require('./load-test-env');
process.env.NODE_ENV = 'test';
process.env.NOTIFICATION_ROUTING_MODE = 'CENTRAL';
process.env.OWNER_TEMPLATE_APPROVED = 'true';
process.env.CENTRAL_TEMPLATE_APPROVED = 'true';

const prisma = require('../src/config/database');
const config = require('../src/config/env');
const {
  processOwnerOrderDecision
} = require('../src/services/order.service');
const {
  createCentralAccount,
  getActiveCentralAccount,
  sanitizeCentralAccount
} = require('../src/services/central-whatsapp.service');
const {
  getRestaurantById,
  sanitizeRestaurant,
  formatInternalNotes
} = require('../src/services/admin-restaurant.service');
const { findTenantOrder, scopeQuery } = require('../src/services/tenant.service');
const { generateSignedOwnerCallback, verifySignedOwnerCallback } = require('../src/utils/callback-signer');
const { assertSafeCleanupFilter } = require('../src/utils/test-guard');

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

async function runTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — R6.6 CENTRAL SECURITY & ISOLATION TEST SUITE   ');
  console.log('   (TC-06 Cross-Tenant, Role Spoofing, Signature & Leakage)  ');
  console.log('============================================================\n');

  const createdCentralAccountIds = [];
  const createdRestaurantIds = [];
  const createdOrderIds = [];
  const createdOutboxIds = [];

  const centralPhoneId = '999888999111';
  const ownerAPhone = '919875550001';
  const ownerBPhone = '919875550002';
  const customerPhone = '919811115555';
  const unknownPhone = '919900001111';

  let previouslyActiveAccount = null;

  try {
    // Clean up any stale test accounts
    assertSafeCleanupFilter({ phone_number_id: centralPhoneId }, 'CentralWhatsAppAccount');
    await prisma.centralWhatsAppAccount.deleteMany({
      where: { phone_number_id: centralPhoneId }
    });
    previouslyActiveAccount = await prisma.centralWhatsAppAccount.findFirst({ where: { is_active: true } });
    if (previouslyActiveAccount) {
      await prisma.centralWhatsAppAccount.update({
        where: { id: previouslyActiveAccount.id },
        data: { is_active: false }
      });
    }

    // 1. Seed Active Central Account
    const centralAccount = await createCentralAccount({
      phoneNumberId: centralPhoneId,
      wabaId: 'waba_central_sec_01',
      accessToken: 'EAAB_test_super_secret_central_token_xyz',
      displayPhoneNumber: '+91 99988 89991',
      isActive: true
    });
    createdCentralAccountIds.push(centralAccount.id);

    // 2. Seed Restaurant A and Restaurant B
    const restA = await prisma.restaurant.create({
      data: {
        name: 'Fine Dining Alpha',
        address: '10 Alpha Tower',
        phone_number_id: '111666777001',
        waba_id: 'waba_rest_a_sec',
        owner_phone: `+${ownerAPhone}`,
        access_token_encrypted: 'mock_token_sec_a',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: formatInternalNotes('Notes Alpha', {
          optedIn: true,
          consentedAt: new Date().toISOString(),
          source: 'ADMIN_CHECKBOX',
          revoked: false,
          templateApproved: true
        })
      }
    });
    createdRestaurantIds.push(restA.id);

    const restB = await prisma.restaurant.create({
      data: {
        name: 'Bistro Beta',
        address: '20 Beta Avenue',
        phone_number_id: '111666777002',
        waba_id: 'waba_rest_b_sec',
        owner_phone: `+${ownerBPhone}`,
        access_token_encrypted: 'mock_token_sec_b',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: formatInternalNotes('Notes Beta', {
          optedIn: true,
          consentedAt: new Date().toISOString(),
          source: 'ADMIN_CHECKBOX',
          revoked: false,
          templateApproved: true
        })
      }
    });
    createdRestaurantIds.push(restB.id);

    // 3. Seed Order A (belongs to Restaurant A) and Order B (belongs to Restaurant B)
    const orderA = await prisma.order.create({
      data: {
        restaurant_id: restA.id,
        order_reference: 'RP-261108-SECA',
        customer_phone: customerPhone,
        customer_name: 'Customer Alice',
        order_type: 'DELIVERY',
        items: [{ productRetailerId: 'ITEM_1', productName: 'Truffle Pasta', quantity: 1, unitPrice: 600, lineTotal: 600 }],
        total_amount: 600,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderA.id);

    const orderB = await prisma.order.create({
      data: {
        restaurant_id: restB.id,
        order_reference: 'RP-261108-SECB',
        customer_phone: customerPhone,
        customer_name: 'Customer Bob',
        order_type: 'TAKEAWAY',
        items: [{ productRetailerId: 'ITEM_2', productName: 'Club Sandwich', quantity: 2, unitPrice: 200, lineTotal: 400 }],
        total_amount: 400,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderB.id);

    console.log('--- TEST GROUP 1: TC-06 — Cross-Tenant Owner Action Defense ---');
    // Owner of Restaurant A attempts to accept Restaurant B's order
    const acceptPayloadB = generateSignedOwnerCallback({ orderId: orderB.id, action: 'ACCEPT' });

    // Attack 1: Owner A tries to accept Order B through Central Number
    const attack1Result = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: acceptPayloadB
    });
    assert(attack1Result.success === false, 'TC-06: Owner A cannot accept Restaurant B order');
    assert(attack1Result.code === 'UNAUTHORIZED_OWNER', 'Rejected with UNAUTHORIZED_OWNER');

    // Attack 2: Attacker specifies restaurantId = restA.id with Order B ID
    const attack2Result = await processOwnerOrderDecision({
      restaurantId: restA.id,
      senderPhone: ownerAPhone,
      buttonPayload: acceptPayloadB
    });
    assert(attack2Result.success === false, 'TC-06: Cross-tenant restaurantId mismatch rejected');
    assert(attack2Result.code === 'CROSS_TENANT_VIOLATION', 'Rejected with CROSS_TENANT_VIOLATION');

    // Order B remains untouched
    const checkOrderB = await prisma.order.findUnique({ where: { id: orderB.id } });
    assert(checkOrderB.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order B preserved in pending state');

    console.log('\n--- TEST GROUP 2: Role Spoofing (Customer & Unknown Numbers) ---');
    // Customer phone tries to click Accept button for Order A
    const acceptPayloadA = generateSignedOwnerCallback({ orderId: orderA.id, action: 'ACCEPT' });
    const custAttackResult = await processOwnerOrderDecision({
      senderPhone: customerPhone,
      buttonPayload: acceptPayloadA
    });
    assert(custAttackResult.success === false, 'Customer phone cannot execute owner action');
    assert(custAttackResult.code === 'UNAUTHORIZED_OWNER', 'Customer rejected with UNAUTHORIZED_OWNER');

    // Unknown phone tries to click Accept button for Order A
    const unknownAttackResult = await processOwnerOrderDecision({
      senderPhone: unknownPhone,
      buttonPayload: acceptPayloadA
    });
    assert(unknownAttackResult.success === false, 'Unknown phone cannot execute owner action');
    assert(unknownAttackResult.code === 'UNAUTHORIZED_OWNER', 'Unknown phone rejected with UNAUTHORIZED_OWNER');

    console.log('\n--- TEST GROUP 3: Callback Signature Tampering & Timing Attacks ---');
    // Alter order ID in signed payload
    const tamperedPayload = acceptPayloadA.replace(orderA.id, orderB.id);
    const tamperedResult = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: tamperedPayload
    });
    assert(tamperedResult.success === false, 'Payload with altered order ID rejected');
    assert(tamperedResult.code === 'TAMPERED_CALLBACK', 'Rejected with TAMPERED_CALLBACK');

    // Alter action in signed payload (ACCEPT -> REJECT)
    const actionTamperedPayload = acceptPayloadA.replace('OWNER_ACCEPT', 'OWNER_REJECT');
    const actionTamperedResult = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: actionTamperedPayload
    });
    assert(actionTamperedResult.success === false, 'Payload with altered action rejected');
    assert(actionTamperedResult.code === 'TAMPERED_CALLBACK', 'Rejected with TAMPERED_CALLBACK');

    // Expired callback
    const expiredPayload = generateSignedOwnerCallback({ orderId: orderA.id, action: 'ACCEPT', ttlSeconds: -10 });
    const expiredResult = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: expiredPayload
    });
    assert(expiredResult.success === false, 'Expired callback rejected');
    assert(expiredResult.code === 'EXPIRED_CALLBACK', 'Rejected with EXPIRED_CALLBACK');

    console.log('\n--- TEST GROUP 4: Idempotency & Conflict Defenses ---');
    // Legitimate owner A accepts order A
    const legitResultA = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: acceptPayloadA
    });
    assert(legitResultA.success === true, 'Legitimate Owner A Accept succeeds');
    assert(legitResultA.newStatus === 'ACCEPTED', 'Order A updated to ACCEPTED');

    // Duplicate tap with identical payload
    const dupResultA = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: acceptPayloadA
    });
    assert(dupResultA.success === true, 'Duplicate identical decision handled idempotently');
    assert(dupResultA.isDuplicate === true, 'Flagged as isDuplicate: true');
    assert(dupResultA.alreadyDecided === true, 'Flagged as alreadyDecided: true');

    // Conflicting decision: Owner A taps Reject AFTER order is already Accepted
    const rejectPayloadA = generateSignedOwnerCallback({ orderId: orderA.id, action: 'REJECT' });
    const conflictResultA = await processOwnerOrderDecision({
      senderPhone: ownerAPhone,
      buttonPayload: rejectPayloadA
    });
    assert(conflictResultA.success === false, 'Conflicting Reject after Accept rejected');
    assert(conflictResultA.code === 'CONFLICTING_DECISION', 'Rejected with CONFLICTING_DECISION');

    // Final order status remains ACCEPTED
    const finalOrderA = await prisma.order.findUnique({ where: { id: orderA.id } });
    assert(finalOrderA.status === 'ACCEPTED', 'Order A status strictly preserved as ACCEPTED');

    console.log('\n--- TEST GROUP 5: Credential Secrecy & Zero Leakage ---');
    // 1. Sanitize Central WhatsApp Account
    const dbCentral = await getActiveCentralAccount();
    const sanitizedCentral = sanitizeCentralAccount(dbCentral);
    assert(sanitizedCentral.has_token === true, 'Sanitized Central account confirms token presence');
    assert(sanitizedCentral.access_token_encrypted === undefined, 'Raw encrypted token ciphertext stripped from sanitized Central account');
    assert(JSON.stringify(sanitizedCentral).includes('EAAB_test_super_secret') === false, 'Zero plaintext access token leakage in Central account representation');

    // 2. Restaurant Admin Sanitization
    const restRecordA = await getRestaurantById(restA.id);
    const sanitizedRestA = sanitizeRestaurant(restRecordA);
    assert(sanitizedRestA.id === restA.id, 'Restaurant sanitized successfully');
    assert(sanitizedRestA.access_token === undefined, 'Restaurant access token stripped');
    assert(sanitizedRestA.access_token_encrypted === undefined, 'Restaurant ciphertext stripped');
    assert(
      JSON.stringify(sanitizedRestA).includes('EAAB_test_super_secret') === false &&
      JSON.stringify(sanitizedRestA).includes('enc:v1') === false &&
      sanitizedRestA.central_account?.access_token_encrypted === undefined,
      'Zero Central credentials leak into restaurant API objects'
    );

    console.log('\n--- TEST GROUP 6: Tenant-Scoped Order Lookup Isolation ---');
    // Verify findTenantOrder enforces scoping
    const tenantAOrderA = await findTenantOrder(restA.id, orderA.id);
    assert(tenantAOrderA !== null, 'Tenant A can read its own Order A');

    const crossLookup = await findTenantOrder(restB.id, orderA.id);
    assert(crossLookup === null, 'Tenant B CANNOT find or access Tenant A order');

    // Missing restaurantId throws tenant violation
    let scopeErr = null;
    try {
      scopeQuery(null, { id: orderA.id });
    } catch (e) {
      scopeErr = e;
    }
    assert(scopeErr !== null && scopeErr.message.includes('TENANT VIOLATION'), 'scopeQuery enforces mandatory restaurantId scoping');

  } catch (err) {
    console.error('Unexpected error in R6.6 Security test:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up R6.6 Security test artifacts ---');
    if (createdOutboxIds.length > 0) {
      assertSafeCleanupFilter({ id: { in: createdOutboxIds } }, 'OutboxMessage');
      await prisma.outboxMessage.deleteMany({ where: { id: { in: createdOutboxIds } } });
    }
    if (createdOrderIds.length > 0) {
      assertSafeCleanupFilter({ order_id: { in: createdOrderIds } }, 'OrderNotification');
      await prisma.orderNotification.deleteMany({ where: { order_id: { in: createdOrderIds } } });
      assertSafeCleanupFilter({ id: { in: createdOrderIds } }, 'Order');
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdRestaurantIds.length > 0) {
      assertSafeCleanupFilter({ id: { in: createdRestaurantIds } }, 'Restaurant');
      await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } });
    }
    if (createdCentralAccountIds.length > 0) {
      assertSafeCleanupFilter({ id: { in: createdCentralAccountIds } }, 'CentralWhatsAppAccount');
      await prisma.centralWhatsAppAccount.deleteMany({ where: { id: { in: createdCentralAccountIds } } });
    }
    if (previouslyActiveAccount) {
      await prisma.centralWhatsAppAccount.update({
        where: { id: previouslyActiveAccount.id },
        data: { is_active: true }
      }).catch(() => {});
    }

    console.log(`\n============================================================`);
    console.log(`   R6.6 CENTRAL SECURITY RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`============================================================\n`);

    if (failed > 0) process.exit(1);
  }
}

runTests();
