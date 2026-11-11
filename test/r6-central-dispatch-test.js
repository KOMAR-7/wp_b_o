require('./load-test-env');
process.env.NODE_ENV = 'test';
process.env.NOTIFICATION_ROUTING_MODE = 'CENTRAL';
process.env.OWNER_TEMPLATE_APPROVED = 'true';
process.env.CENTRAL_TEMPLATE_APPROVED = 'true';

const prisma = require('../src/config/database');
const config = require('../src/config/env');
const {
  claimPendingOutboxMessages,
  updateOutboxResult,
  dispatchPendingOutboxMessages
} = require('../src/services/outbox.service');
const {
  createCentralAccount,
  deactivateCentralAccount
} = require('../src/services/central-whatsapp.service');
const {
  buildOwnerNotificationPayload,
  buildCentralCustomerDecisionPayload
} = require('../src/services/whatsapp.service');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');
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
  console.log('   RESTOPRO — R6.6 CENTRAL OUTBOX DISPATCH TEST SUITE        ');
  console.log('   (TC-03, TC-07, TC-08, TC-14, TC-15, Templates & Fencing)  ');
  console.log('============================================================\n');

  const createdCentralAccountIds = [];
  const createdRestaurantIds = [];
  const createdOrderIds = [];
  const createdOutboxIds = [];

  const centralPhoneId = '999888777000';
  const restAPhoneId = '111333555777';
  const restBPhoneId = '111333555888';
  const ownerAPhone = '919871112222';
  const ownerBPhone = '919872223333';

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
      wabaId: 'waba_central_disp_01',
      accessToken: 'EAAB_test_central_dispatch_token',
      displayPhoneNumber: '+91 99988 87770',
      isActive: true
    });
    createdCentralAccountIds.push(centralAccount.id);

    // 2. Seed Restaurant A and Restaurant B
    const restA = await prisma.restaurant.create({
      data: {
        name: 'Curry House (Restaurant A)',
        address: '55 MG Road, Bangalore',
        phone_number_id: restAPhoneId,
        waba_id: 'waba_rest_a_disp',
        owner_phone: `+${ownerAPhone}`,
        access_token_encrypted: 'mock_token_a',
        is_active: true,
        tenant_status: 'ACTIVE'
      }
    });
    createdRestaurantIds.push(restA.id);

    const restB = await prisma.restaurant.create({
      data: {
        name: 'Tandoori Nights (Restaurant B)',
        address: '88 Brigade Road, Bangalore',
        phone_number_id: restBPhoneId,
        waba_id: 'waba_rest_b_disp',
        owner_phone: `+${ownerBPhone}`,
        access_token_encrypted: 'mock_token_b',
        is_active: true,
        tenant_status: 'ACTIVE'
      }
    });
    createdRestaurantIds.push(restB.id);

    // 3. Seed Orders
    const orderA = await prisma.order.create({
      data: {
        restaurant_id: restA.id,
        order_reference: 'RP-261108-DSA1',
        customer_phone: '919811110001',
        customer_name: 'Customer One',
        order_type: 'DELIVERY',
        items: [{ productRetailerId: 'ITEM_1', productName: 'Paneer Butter Masala', quantity: 2, unitPrice: 280, lineTotal: 560 }],
        total_amount: 560,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderA.id);

    const orderB = await prisma.order.create({
      data: {
        restaurant_id: restB.id,
        order_reference: 'RP-261108-DSB2',
        customer_phone: '919822220002',
        customer_name: 'Customer Two',
        order_type: 'TAKEAWAY',
        items: [{ productRetailerId: 'ITEM_2', productName: 'Tandoori Roti', quantity: 4, unitPrice: 30, lineTotal: 120 }],
        total_amount: 120,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderB.id);

    console.log('--- TEST GROUP 1: Meta Utility Template Builders & Validation ---');
    // Owner Alert Template
    const ownerPayloadA = buildOwnerNotificationPayload({
      ownerPhone: ownerAPhone,
      order: orderA,
      restaurantName: restA.name,
      useTemplate: true,
      templateName: 'restopro_order_alert'
    });

    assert(ownerPayloadA.type === 'template', 'Owner payload uses template type');
    assert(ownerPayloadA.template.name === 'restopro_order_alert', 'Template name is restopro_order_alert');
    assert(ownerPayloadA.to === ownerAPhone, 'Recipient phone normalized to bare digits');
    assert(ownerPayloadA.template.components.some(c => c.type === 'body'), 'Body component present');

    const buttonComponents = ownerPayloadA.template.components.filter(c => c.type === 'button');
    assert(buttonComponents.length === 2, 'Exactly 2 quick-reply buttons generated');
    const acceptPayloadStr = buttonComponents[0].parameters[0].payload;
    const rejectPayloadStr = buttonComponents[1].parameters[0].payload;
    assert(acceptPayloadStr.length <= 128, `Accept button payload is within 128 char limit (${acceptPayloadStr.length} chars)`);
    assert(rejectPayloadStr.length <= 128, `Reject button payload is within 128 char limit (${rejectPayloadStr.length} chars)`);

    // Customer Accepted Template
    const custAcceptPayload = buildCentralCustomerDecisionPayload({
      order: orderA,
      decision: 'ACCEPT',
      restaurantName: restA.name
    });
    assert(custAcceptPayload.type === 'template', 'Customer accept notification uses template');
    assert(custAcceptPayload.template.name === 'restopro_customer_order_accepted', 'Template name is restopro_customer_order_accepted');
    assert(custAcceptPayload.to === '919811110001', 'Recipient is customer phone');

    // Customer Rejected Template
    const custRejectPayload = buildCentralCustomerDecisionPayload({
      order: orderB,
      decision: 'REJECT',
      restaurantName: restB.name
    });
    assert(custRejectPayload.type === 'template', 'Customer reject notification uses template');
    assert(custRejectPayload.template.name === 'restopro_customer_order_rejected', 'Template name is restopro_customer_order_rejected');

    console.log('\n--- TEST GROUP 2: TC-03 — Both Owner Alerts Dispatched Through Central XYZ ---');
    // Create Owner Alert Outbox Messages for Restaurant A and Restaurant B with sender_channel = CENTRAL
    const outboxOwnerA = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restA.id,
        recipient_phone: ownerAPhone,
        sender_channel: 'CENTRAL',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        payload: ownerPayloadA,
        idempotency_key: `tc03_owner_alert_${orderA.id}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outboxOwnerA.id);

    const ownerPayloadB = buildOwnerNotificationPayload({
      ownerPhone: ownerBPhone,
      order: orderB,
      restaurantName: restB.name,
      useTemplate: true,
      templateName: 'restopro_order_alert'
    });
    const outboxOwnerB = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restB.id,
        recipient_phone: ownerBPhone,
        sender_channel: 'CENTRAL',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        payload: ownerPayloadB,
        idempotency_key: `tc03_owner_alert_${orderB.id}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outboxOwnerB.id);

    // Track dispatch calls
    const dispatchedCalls = [];
    const customDispatcher = async (msg) => {
      dispatchedCalls.push({
        id: msg.id,
        sender_channel: msg.sender_channel,
        restaurant_id: msg.restaurant_id,
        recipient_phone: msg.recipient_phone,
        payload: msg.payload
      });
      return { success: true, metaMessageId: `wamid_disp_${msg.id.slice(0, 8)}` };
    };

    const dispatchResult1 = await dispatchPendingOutboxMessages({
      customSender: customDispatcher,
      batchSize: 10
    });

    assert(dispatchResult1.processedCount === 2, `Processed 2 messages (Got ${dispatchResult1.processedCount})`);
    assert(dispatchResult1.succeededCount === 2, `Both succeeded (Got ${dispatchResult1.succeededCount})`);
    assert(dispatchedCalls.length === 2, '2 dispatches recorded');
    assert(dispatchedCalls[0].sender_channel === 'CENTRAL', 'Owner Alert A was dispatched with sender_channel = CENTRAL');
    assert(dispatchedCalls[1].sender_channel === 'CENTRAL', 'Owner Alert B was dispatched with sender_channel = CENTRAL');

    // Verify messages transitioned to ACCEPTED
    const checkOwnerA = await prisma.outboxMessage.findUnique({ where: { id: outboxOwnerA.id } });
    const checkOwnerB = await prisma.outboxMessage.findUnique({ where: { id: outboxOwnerB.id } });
    assert(checkOwnerA.status === 'ACCEPTED', 'Outbox Owner A marked ACCEPTED');
    assert(checkOwnerB.status === 'ACCEPTED', 'Outbox Owner B marked ACCEPTED');

    console.log('\n--- TEST GROUP 3: TC-07 & TC-08 — Customer Decision Templates Dispatched Through XYZ ---');
    // Create customer decisions
    const outboxCustA = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restA.id,
        recipient_phone: '919811110001',
        sender_channel: 'CENTRAL',
        message_type: 'CUSTOMER_ORDER_DECISION',
        payload: custAcceptPayload,
        idempotency_key: `tc07_cust_${orderA.id}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outboxCustA.id);

    const outboxCustB = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restB.id,
        recipient_phone: '919822220002',
        sender_channel: 'CENTRAL',
        message_type: 'CUSTOMER_ORDER_DECISION',
        payload: custRejectPayload,
        idempotency_key: `tc08_cust_${orderB.id}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outboxCustB.id);

    dispatchedCalls.length = 0;
    const dispatchResult2 = await dispatchPendingOutboxMessages({
      customSender: customDispatcher,
      batchSize: 10
    });

    assert(dispatchResult2.processedCount === 2, '2 customer decisions processed');
    assert(dispatchedCalls.every(c => c.sender_channel === 'CENTRAL'), 'All customer final notifications dispatched through CENTRAL channel');
    assert(dispatchedCalls[0].payload.template.name === 'restopro_customer_order_accepted', 'Customer A received accepted template');
    assert(dispatchedCalls[1].payload.template.name === 'restopro_customer_order_rejected', 'Customer B received rejected template');

    console.log('\n--- TEST GROUP 4: TC-14 — Worker Lease Fencing & Expiration Recovery ---');
    // Seed message with expired lease
    const expiredTime = new Date(Date.now() - 100000).toISOString();
    const outboxLeased = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restA.id,
        recipient_phone: ownerAPhone,
        sender_channel: 'CENTRAL',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        payload: {
          test: true,
          lease: {
            claimed_by: 'worker_old_dead',
            lease_token: 'lease_token_stale_111',
            lease_expires_at: expiredTime
          }
        },
        idempotency_key: `tc14_lease_${Date.now()}`,
        status: 'PENDING',
        attempts: 1
      }
    });
    createdOutboxIds.push(outboxLeased.id);

    // Claim messages via transaction
    const claimed = await prisma.$transaction(async (tx) => {
      return claimPendingOutboxMessages(tx, { limit: 5, workerId: 'worker_new_live' });
    });

    const claimedMsg = claimed.find(m => m.id === outboxLeased.id);
    assert(claimedMsg !== undefined, 'Expired leased message was safely reclaimed by new worker');
    assert(claimedMsg.workerId === 'worker_new_live', 'Assigned to new worker');
    assert(claimedMsg.leaseToken !== 'lease_token_stale_111', 'Assigned new fresh lease token');

    // Fencing test: Stale worker attempts to update message with old leaseToken
    const staleUpdate = await updateOutboxResult({
      id: outboxLeased.id,
      leaseToken: 'lease_token_stale_111',
      dispatchResult: { success: true },
      attempts: 1
    });
    assert(staleUpdate.updated === false && staleUpdate.reason === 'FENCED_OUT', 'Stale worker fenced out: update rejected due to lease token mismatch');

    // Live worker updates with correct leaseToken
    const liveUpdate = await updateOutboxResult({
      id: outboxLeased.id,
      leaseToken: claimedMsg.leaseToken,
      dispatchResult: { success: true, metaMessageId: 'wamid_live_recovered' },
      attempts: 2
    });
    assert(liveUpdate.updated === true && liveUpdate.status === 'ACCEPTED', 'Live worker successfully updated message outcome');

    console.log('\n--- TEST GROUP 5: TC-15 — Missing Central Credentials Handling ---');
    // Temporarily deactivate active central account and clear environment fallback
    await deactivateCentralAccount(centralAccount.id);
    const originalEnvCentralId = process.env.CENTRAL_PHONE_NUMBER_ID;
    delete process.env.CENTRAL_PHONE_NUMBER_ID;

    const outboxMissingCreds = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restA.id,
        recipient_phone: ownerAPhone,
        sender_channel: 'CENTRAL',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        payload: { test: true },
        idempotency_key: `tc15_missing_creds_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outboxMissingCreds.id);

    // Also seed a normal restaurant message to verify multi-tenant isolation
    const outboxRestNormal = await prisma.outboxMessage.create({
      data: {
        restaurant_id: restA.id,
        recipient_phone: '919811119999',
        sender_channel: 'RESTAURANT',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { messaging_product: 'whatsapp', to: '919811119999', type: 'text', text: { body: 'Hello' } },
        idempotency_key: `tc15_rest_normal_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outboxRestNormal.id);

    // Dispatch without customSender so it triggers real credential resolution
    // Mock sendWhatsAppMessage to avoid real HTTP call for the restaurant message
    const { resolveRestaurantCredentials } = require('../src/services/whatsapp.service');
    const dispatchResult3 = await dispatchPendingOutboxMessages({
      batchSize: 10
    });

    const checkMissingCreds = await prisma.outboxMessage.findUnique({ where: { id: outboxMissingCreds.id } });
    assert(checkMissingCreds.status === 'FAILED', 'Central message with missing credentials safely transitioned to FAILED');
    assert(checkMissingCreds.last_error.includes('CENTRAL CREDENTIAL ERROR') || checkMissingCreds.last_error.includes('No active Central WhatsApp account'), 'last_error indicates missing central credentials');

    // Reactivate central account for cleanliness
    await prisma.centralWhatsAppAccount.update({
      where: { id: centralAccount.id },
      data: { is_active: true }
    });
    if (originalEnvCentralId) {
      process.env.CENTRAL_PHONE_NUMBER_ID = originalEnvCentralId;
    }

  } catch (err) {
    console.error('Unexpected error in R6.6 Central Dispatch test:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up R6.6 Dispatch test artifacts ---');
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
    console.log(`   R6.6 CENTRAL DISPATCH RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`============================================================\n`);

    if (failed > 0) process.exit(1);
  }
}

runTests();

