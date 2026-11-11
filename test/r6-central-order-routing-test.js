require('./load-test-env');
process.env.NODE_ENV = 'test';

const prisma = require('../src/config/database');
const config = require('../src/config/env');
const {
  confirmCustomerOrder,
  processOwnerOrderDecision
} = require('../src/services/order.service');
const {
  createCentralAccount
} = require('../src/services/central-whatsapp.service');
const { formatInternalNotes } = require('../src/services/admin-restaurant.service');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');
const { setTemplateApprovalForTesting, resetTemplateApprovalsForTesting } = require('../src/services/template-config.service');
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
  console.log('   RESTOPRO — R6.6 CENTRAL ORDER ROUTING TEST SUITE          ');
  console.log('   (TC-01, TC-02, TC-10, TC-17, LEGACY vs CENTRAL Modes)    ');
  console.log('============================================================\n');

  const createdCentralAccountIds = [];
  const createdRestaurantIds = [];
  const createdOrderIds = [];
  const createdSessionIds = [];
  const createdOutboxIds = [];

  const centralPhoneId = '999888555111';

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
      wabaId: 'waba_central_routing_01',
      accessToken: 'EAAB_test_central_routing_token',
      displayPhoneNumber: '+91 99988 85551',
      isActive: true,
      templates: {
        restopro_order_alert: { isApproved: true, status: 'APPROVED', approvalSource: 'TEST' },
        restopro_customer_order_accepted: { isApproved: true, status: 'APPROVED', approvalSource: 'TEST' },
        restopro_customer_order_rejected: { isApproved: true, status: 'APPROVED', approvalSource: 'TEST' }
      }
    });
    createdCentralAccountIds.push(centralAccount.id);

    // 2. Seed Restaurant A and Restaurant B
    const restA = await prisma.restaurant.create({
      data: {
        name: 'The Spice Route (Restaurant A)',
        address: '10 Connaught Place, New Delhi',
        phone_number_id: '111444666001',
        waba_id: 'waba_rest_a_route',
        owner_phone: '+919871110001',
        access_token_encrypted: 'mock_token_a',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: formatInternalNotes('Rest A Notes', {
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
        name: 'Sushi World (Restaurant B)',
        address: '25 Khan Market, New Delhi',
        phone_number_id: '111444666002',
        waba_id: 'waba_rest_b_route',
        owner_phone: '+919872220002',
        access_token_encrypted: 'mock_token_b',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: formatInternalNotes('Rest B Notes', {
          optedIn: true,
          consentedAt: new Date().toISOString(),
          source: 'ADMIN_CHECKBOX',
          revoked: false,
          templateApproved: true
        })
      }
    });
    createdRestaurantIds.push(restB.id);

    console.log('--- TEST GROUP 1: TC-01 & TC-02 — CENTRAL Mode Order Placement & Routing ---');
    process.env.NOTIFICATION_ROUTING_MODE = 'CENTRAL';
    config.routingMode = 'CENTRAL';
    process.env.CENTRAL_TEMPLATE_APPROVED = 'true';
    process.env.OWNER_TEMPLATE_APPROVED = 'true';

    // Restaurant A: Customer confirms order
    const custPhoneA = '919811119001';
    const confTokenA = `conf_token_a_${Date.now()}`;
    const sessionA = await prisma.conversationSession.create({
      data: {
        restaurant_id: restA.id,
        customer_phone: custPhoneA,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          orderType: 'DELIVERY',
          confirmationToken: confTokenA,
          customerName: 'Customer A',
          address: { addressText: 'Flat 12B, Connaught Circus' },
          cart: {
            items: [{ productRetailerId: 'ITEM_A1', productName: 'Butter Chicken', quantity: 1, item_price: 400, currency: 'INR' }],
            subtotal: 400,
            currency: 'INR'
          }
        },
        expires_at: new Date(Date.now() + 3600 * 1000)
      }
    });
    createdSessionIds.push(sessionA.id);

    const resultA = await confirmCustomerOrder({
      restaurantId: restA.id,
      customerPhone: custPhoneA,
      confirmationToken: confTokenA
    });
    assert(resultA.success === true, 'Restaurant A order confirmed successfully');
    createdOrderIds.push(resultA.order.id);

    // Verify Owner Alert Outbox Message for Restaurant A
    const ownerOutboxA = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `owner_notif_${resultA.order.id}`
      }
    });
    assert(ownerOutboxA !== null, 'Owner alert outbox message created');
    assert(ownerOutboxA.sender_channel === 'CENTRAL', 'TC-01: Owner alert sender_channel is CENTRAL in CENTRAL mode');
    assert(ownerOutboxA.recipient_phone.replace(/[^\d]/g, '') === '919871110001', 'Recipient is Owner A');
    assert(ownerOutboxA.payload.template?.name === 'restopro_order_alert', 'Owner alert uses approved template restopro_order_alert');
    if (ownerOutboxA) createdOutboxIds.push(ownerOutboxA.id);

    // Restaurant B: Customer confirms order
    const custPhoneB = '919822229002';
    const confTokenB = `conf_token_b_${Date.now()}`;
    const sessionB = await prisma.conversationSession.create({
      data: {
        restaurant_id: restB.id,
        customer_phone: custPhoneB,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          orderType: 'TAKEAWAY',
          confirmationToken: confTokenB,
          customerName: 'Customer B',
          cart: {
            items: [{ productRetailerId: 'ITEM_B1', productName: 'Salmon Roll', quantity: 2, item_price: 350, currency: 'INR' }],
            subtotal: 700,
            currency: 'INR'
          }
        },
        expires_at: new Date(Date.now() + 3600 * 1000)
      }
    });
    createdSessionIds.push(sessionB.id);

    const resultB = await confirmCustomerOrder({
      restaurantId: restB.id,
      customerPhone: custPhoneB,
      confirmationToken: confTokenB
    });
    assert(resultB.success === true, 'Restaurant B order confirmed successfully');
    createdOrderIds.push(resultB.order.id);

    // Verify Owner Alert Outbox Message for Restaurant B
    const ownerOutboxB = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restB.id,
        idempotency_key: `owner_notif_${resultB.order.id}`
      }
    });
    assert(ownerOutboxB !== null, 'Owner alert outbox message for B created');
    assert(ownerOutboxB.sender_channel === 'CENTRAL', 'TC-02: Owner alert B sender_channel is CENTRAL in CENTRAL mode');
    assert(ownerOutboxB.recipient_phone.replace(/[^\d]/g, '') === '919872220002', 'Recipient is Owner B');
    if (ownerOutboxB) createdOutboxIds.push(ownerOutboxB.id);

    console.log('\n--- TEST GROUP 2: CENTRAL Mode Owner Decision to Customer Routing ---');
    // Owner A accepts order
    const acceptPayloadA = generateSignedOwnerCallback({ orderId: resultA.order.id, action: 'ACCEPT' });
    const decisionResultA = await processOwnerOrderDecision({
      senderPhone: '919871110001',
      buttonPayload: acceptPayloadA
    });
    assert(decisionResultA.success === true, 'Owner A decision processed successfully');
    assert(decisionResultA.newStatus === 'ACCEPTED', 'Order A updated to ACCEPTED');

    const custDecisionOutboxA = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `customer_decision_${resultA.order.id}_accept`
      }
    });
    assert(custDecisionOutboxA !== null, 'Customer decision outbox message created');
    assert(custDecisionOutboxA.sender_channel === 'CENTRAL', 'Customer final notification sender_channel is CENTRAL');
    assert(custDecisionOutboxA.payload.template?.name === 'restopro_customer_order_accepted', 'Uses restopro_customer_order_accepted template');
    if (custDecisionOutboxA) createdOutboxIds.push(custDecisionOutboxA.id);

    console.log('\n--- TEST GROUP 3: LEGACY Mode Regression Verification ---');
    process.env.NOTIFICATION_ROUTING_MODE = 'LEGACY';
    config.routingMode = 'LEGACY';

    // Place order under LEGACY mode
    const custPhoneLegacy = '919833339003';
    const confTokenLegacy = `conf_token_leg_${Date.now()}`;
    const sessionLegacy = await prisma.conversationSession.create({
      data: {
        restaurant_id: restA.id,
        customer_phone: custPhoneLegacy,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          orderType: 'TAKEAWAY',
          confirmationToken: confTokenLegacy,
          customerName: 'Customer Legacy',
          cart: {
            items: [{ productRetailerId: 'ITEM_A2', productName: 'Garlic Naan', quantity: 2, item_price: 60, currency: 'INR' }],
            subtotal: 120,
            currency: 'INR'
          }
        },
        expires_at: new Date(Date.now() + 3600 * 1000)
      }
    });
    createdSessionIds.push(sessionLegacy.id);

    const resultLegacy = await confirmCustomerOrder({
      restaurantId: restA.id,
      customerPhone: custPhoneLegacy,
      confirmationToken: confTokenLegacy
    });
    assert(resultLegacy.success === true, 'Legacy mode order confirmed');
    createdOrderIds.push(resultLegacy.order.id);

    const ownerOutboxLegacy = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `owner_notif_${resultLegacy.order.id}`
      }
    });
    assert(ownerOutboxLegacy !== null, 'Legacy owner outbox message created');
    assert(ownerOutboxLegacy.sender_channel === 'RESTAURANT', 'LEGACY mode: Owner alert sender_channel is RESTAURANT');
    if (ownerOutboxLegacy) createdOutboxIds.push(ownerOutboxLegacy.id);

    // Process owner decision under LEGACY mode
    const acceptPayloadLegacy = generateSignedOwnerCallback({ orderId: resultLegacy.order.id, action: 'ACCEPT' });
    const decisionLegacy = await processOwnerOrderDecision({
      restaurantId: restA.id,
      senderPhone: '919871110001',
      buttonPayload: acceptPayloadLegacy
    });
    assert(decisionLegacy.success === true, 'Legacy owner decision succeeded');

    const custDecisionOutboxLegacy = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restA.id,
        idempotency_key: `customer_decision_${resultLegacy.order.id}_accept`
      }
    });
    assert(custDecisionOutboxLegacy.sender_channel === 'RESTAURANT', 'LEGACY mode: Customer final decision sender_channel is RESTAURANT');
    assert(custDecisionOutboxLegacy.payload.type === 'text', 'LEGACY mode: Customer notification uses conversational text payload');
    if (custDecisionOutboxLegacy) createdOutboxIds.push(custDecisionOutboxLegacy.id);

    console.log('\n--- TEST GROUP 4: Missing Template Configuration Controlled Failure ---');
    process.env.NOTIFICATION_ROUTING_MODE = 'CENTRAL';
    config.routingMode = 'CENTRAL';
    delete process.env.CENTRAL_TEMPLATE_APPROVED;
    delete process.env.OWNER_TEMPLATE_APPROVED;
    setTemplateApprovalForTesting('restopro_order_alert', false);

    // Restaurant with templateApproved: false
    const restUnapproved = await prisma.restaurant.create({
      data: {
        name: 'The Unapproved Kitchen',
        address: '99 Unapproved Lane',
        phone_number_id: '111999888777',
        waba_id: 'waba_unapproved',
        owner_phone: '+919879998888',
        access_token_encrypted: 'mock_token',
        is_active: true,
        tenant_status: 'ACTIVE',
        internal_notes: formatInternalNotes('Unapproved Notes', {
          optedIn: true,
          consentedAt: new Date().toISOString(),
          source: 'ADMIN_CHECKBOX',
          revoked: false,
          templateApproved: false
        })
      }
    });
    createdRestaurantIds.push(restUnapproved.id);

    const custPhoneUnapp = '919844449004';
    const confTokenUnapp = `conf_token_unapp_${Date.now()}`;
    const sessionUnapp = await prisma.conversationSession.create({
      data: {
        restaurant_id: restUnapproved.id,
        customer_phone: custPhoneUnapp,
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          orderType: 'TAKEAWAY',
          confirmationToken: confTokenUnapp,
          cart: {
            items: [{ productRetailerId: 'ITEM_U1', productName: 'Salad', quantity: 1, item_price: 150, currency: 'INR' }],
            subtotal: 150,
            currency: 'INR'
          }
        },
        expires_at: new Date(Date.now() + 3600 * 1000)
      }
    });
    createdSessionIds.push(sessionUnapp.id);

    const resultUnapp = await confirmCustomerOrder({
      restaurantId: restUnapproved.id,
      customerPhone: custPhoneUnapp,
      confirmationToken: confTokenUnapp
    });
    assert(resultUnapp.success === true, 'Order created successfully even when template unapproved');
    createdOrderIds.push(resultUnapp.order.id);

    const outboxUnapp = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: restUnapproved.id,
        idempotency_key: `owner_notif_${resultUnapp.order.id}`
      }
    });
    assert(outboxUnapp !== null, 'Outbox message created');
    assert(outboxUnapp.status === 'FAILED', 'Status is controlled FAILED when template unapproved');
    assert(outboxUnapp.last_error.includes('BLOCKED_TEMPLATE_NOT_CONFIGURED'), 'last_error specifies BLOCKED_TEMPLATE_NOT_CONFIGURED');
    if (outboxUnapp) createdOutboxIds.push(outboxUnapp.id);
    resetTemplateApprovalsForTesting();

    console.log('\n--- TEST GROUP 5: TC-10 — Simultaneous Conflicting Decisions (Accept vs Reject Race) ---');
    // Seed fresh order for race test
    const orderRace = await prisma.order.create({
      data: {
        restaurant_id: restA.id,
        order_reference: 'RP-261108-RACE',
        customer_phone: '919855559005',
        order_type: 'TAKEAWAY',
        items: [{ productRetailerId: 'ITEM_A1', productName: 'Biryani', quantity: 1, unitPrice: 350, lineTotal: 350 }],
        total_amount: 350,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });
    createdOrderIds.push(orderRace.id);

    process.env.OWNER_TEMPLATE_APPROVED = 'true';
    process.env.CENTRAL_TEMPLATE_APPROVED = 'true';

    const acceptPayloadRace = generateSignedOwnerCallback({ orderId: orderRace.id, action: 'ACCEPT' });
    const rejectPayloadRace = generateSignedOwnerCallback({ orderId: orderRace.id, action: 'REJECT' });

    // Execute Accept and Reject concurrently
    const [raceResult1, raceResult2] = await Promise.all([
      processOwnerOrderDecision({ senderPhone: '919871110001', buttonPayload: acceptPayloadRace }),
      processOwnerOrderDecision({ senderPhone: '919871110001', buttonPayload: rejectPayloadRace })
    ]);

    const oneSucceeded = (raceResult1.success && !raceResult2.success) || (!raceResult1.success && raceResult2.success);
    assert(oneSucceeded === true, 'TC-10: Exactly ONE of the simultaneous conflicting decisions succeeded');

    const failedResult = raceResult1.success ? raceResult2 : raceResult1;
    assert(failedResult.code === 'CONFLICTING_DECISION', 'Losing concurrent decision rejected with CONFLICTING_DECISION');

    const finalOrderRace = await prisma.order.findUnique({ where: { id: orderRace.id } });
    assert(finalOrderRace.status === 'ACCEPTED' || finalOrderRace.status === 'REJECTED', 'Order ended in deterministic single finalized status');

    console.log('\n--- TEST GROUP 6: TC-17 — Five Restaurants Ordering Concurrently ---');
    const fiveRestaurants = [];
    for (let i = 1; i <= 5; i++) {
      const rest = await prisma.restaurant.create({
        data: {
          name: `Concurrent Restaurant ${i}`,
          address: `${i * 10} Sector Road`,
          phone_number_id: `11155500000${i}`,
          waba_id: `waba_conc_${i}`,
          owner_phone: `+91987000000${i}`,
          access_token_encrypted: `mock_token_conc_${i}`,
          is_active: true,
          tenant_status: 'ACTIVE',
          internal_notes: formatInternalNotes(`Concurrent Notes ${i}`, {
            optedIn: true,
            consentedAt: new Date().toISOString(),
            source: 'ADMIN_CHECKBOX',
            revoked: false,
            templateApproved: true
          })
        }
      });
      createdRestaurantIds.push(rest.id);
      fiveRestaurants.push(rest);
    }

    // Execute 5 concurrent order confirmations across the 5 restaurants
    const concurrentConfirmations = await Promise.all(
      fiveRestaurants.map(async (r, index) => {
        const custPhone = `91981100000${index + 1}`;
        const confToken = `token_conc_${index + 1}_${Date.now()}`;
        const session = await prisma.conversationSession.create({
          data: {
            restaurant_id: r.id,
            customer_phone: custPhone,
            current_step: 'AWAITING_CONFIRMATION',
            state: {
              orderType: 'DELIVERY',
              confirmationToken: confToken,
              address: { addressText: `Flat ${index + 1}` },
              cart: {
                items: [{ productRetailerId: `ITEM_${index + 1}`, productName: `Dish ${index + 1}`, quantity: 1, item_price: 200, currency: 'INR' }],
                subtotal: 200,
                currency: 'INR'
              }
            },
            expires_at: new Date(Date.now() + 3600 * 1000)
          }
        });
        createdSessionIds.push(session.id);

        return confirmCustomerOrder({
          restaurantId: r.id,
          customerPhone: custPhone,
          confirmationToken: confToken
        });
      })
    );

    assert(concurrentConfirmations.every(c => c.success === true), 'TC-17: All 5 concurrent orders placed successfully');
    concurrentConfirmations.forEach(c => createdOrderIds.push(c.order.id));

    // Verify 5 distinct owner notifications created with sender_channel = CENTRAL
    const fiveOwnerOutbox = await prisma.outboxMessage.findMany({
      where: {
        order_id: undefined,
        restaurant_id: { in: fiveRestaurants.map(r => r.id) },
        message_type: 'OWNER_ORDER_NOTIFICATION'
      }
    });

    assert(fiveOwnerOutbox.length === 5, 'TC-17: Exactly 5 owner alerts created concurrently');
    assert(fiveOwnerOutbox.every(o => o.sender_channel === 'CENTRAL'), 'All 5 owner alerts use sender_channel = CENTRAL');
    fiveOwnerOutbox.forEach(o => createdOutboxIds.push(o.id));

  } catch (err) {
    console.error('Unexpected error in R6.6 Central Order Routing test:', err);
    failed++;
  } finally {
    // Reset configuration to default LEGACY mode
    process.env.NOTIFICATION_ROUTING_MODE = 'LEGACY';
    config.routingMode = 'LEGACY';

    console.log('\n--- Cleaning up R6.6 Routing test artifacts ---');
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
    if (createdSessionIds.length > 0) {
      assertSafeCleanupFilter({ id: { in: createdSessionIds } }, 'ConversationSession');
      await prisma.conversationSession.deleteMany({ where: { id: { in: createdSessionIds } } });
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
    console.log(`   R6.6 CENTRAL ORDER ROUTING RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`============================================================\n`);

    if (failed > 0) process.exit(1);
  }
}

runTests();
