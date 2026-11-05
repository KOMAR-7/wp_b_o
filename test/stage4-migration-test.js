/**
 * RESTOPRO — Stage 4.0: Schema Migration & Database Prerequisites Test Suite
 * Verifies confirmation_token, webhook worker lease fields, and durable outbox_messages queue.
 */
const crypto = require('crypto');
const prisma = require('../src/config/database');

async function runStage4MigrationTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 4.0: SCHEMA MIGRATION TEST SUITE       ');
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

  // Track created test IDs for reliable cleanup
  const createdOrderIds = [];
  const createdWebhookEventIds = [];
  const createdOutboxIds = [];

  try {
    // Lookup seeded restaurants
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
    // TEST GROUP 1: Orders - Multiple NULL confirmation_token Allowed
    // -------------------------------------------------------------
    console.log('--- TEST GROUP 1: Orders — Multiple NULL confirmation_token Allowed ---');
    const orderNull1 = await prisma.order.create({
      data: {
        restaurant_id: tenantA.id,
        order_reference: `RP-TEST-${Date.now()}-N1`,
        customer_phone: '919876543210',
        order_type: 'DELIVERY',
        items: [{ sku: 'TEST_ITEM', qty: 1, price: 100 }],
        total_amount: 100.00,
        confirmation_token: null
      }
    });
    createdOrderIds.push(orderNull1.id);
    assert(orderNull1.id && orderNull1.confirmation_token === null, 'First order with confirmation_token = NULL created successfully');

    const orderNull2 = await prisma.order.create({
      data: {
        restaurant_id: tenantA.id,
        order_reference: `RP-TEST-${Date.now()}-N2`,
        customer_phone: '919876543210',
        order_type: 'TAKEAWAY',
        items: [{ sku: 'TEST_ITEM_2', qty: 2, price: 50 }],
        total_amount: 100.00,
        confirmation_token: null
      }
    });
    createdOrderIds.push(orderNull2.id);
    assert(orderNull2.id && orderNull2.confirmation_token === null, 'Second order with confirmation_token = NULL created without unique constraint conflict');

    // -------------------------------------------------------------
    // TEST GROUP 2: Orders — Duplicate Non-Null Tokens Rejected
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Orders — Duplicate Non-Null Confirmation Tokens Rejected ---');
    const uniqueToken = `conf_test_${crypto.randomUUID()}`;
    const orderToken1 = await prisma.order.create({
      data: {
        restaurant_id: tenantA.id,
        order_reference: `RP-TEST-${Date.now()}-T1`,
        customer_phone: '919876543210',
        order_type: 'DELIVERY',
        items: [{ sku: 'TEST_ITEM', qty: 1, price: 150 }],
        total_amount: 150.00,
        confirmation_token: uniqueToken
      }
    });
    createdOrderIds.push(orderToken1.id);
    assert(orderToken1.confirmation_token === uniqueToken, 'Order with non-null confirmation_token persisted successfully');

    let duplicateTokenThrew = false;
    let duplicateErrorCode = null;
    try {
      await prisma.order.create({
        data: {
          restaurant_id: tenantB.id,
          order_reference: `RP-TEST-${Date.now()}-T2`,
          customer_phone: '919876543211',
          order_type: 'TAKEAWAY',
          items: [{ sku: 'TEST_ITEM', qty: 1, price: 150 }],
          total_amount: 150.00,
          confirmation_token: uniqueToken // Duplicate token across orders
        }
      });
    } catch (err) {
      duplicateTokenThrew = true;
      duplicateErrorCode = err.code;
    }
    assert(duplicateTokenThrew, 'Duplicate confirmation_token is rejected by PostgreSQL unique constraint');
    assert(duplicateErrorCode === 'P2002', 'Duplicate token triggers Prisma unique constraint error code P2002');

    // -------------------------------------------------------------
    // TEST GROUP 3: Existing Orders Remain Readable & Valid
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Existing Orders Remain Readable ---');
    const existingOrders = await prisma.order.findMany({
      where: {
        id: { notIn: createdOrderIds }
      }
    });
    assert(existingOrders.length > 0, `Pre-existing orders are found (${existingOrders.length} pre-existing orders)`);
    const allPreExistingHaveNullOrValidToken = existingOrders.every(
      (o) => o.confirmation_token === null || typeof o.confirmation_token === 'string'
    );
    assert(allPreExistingHaveNullOrValidToken, 'All pre-existing orders have valid nullable confirmation_token attribute');

    // -------------------------------------------------------------
    // TEST GROUP 4: Webhook Lease Fields Accept & Persist Values
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Webhook Lease Fields Persistence ---');
    const leaseToken = crypto.randomUUID();
    const leaseExpires = new Date(Date.now() + 120000); // 2 minutes in future
    const webhookWithLease = await prisma.webhookEvent.create({
      data: {
        event_key: `wamid.TEST_LEASE_${Date.now()}`,
        event_type: 'messages',
        restaurant_id: tenantA.id,
        processing_status: 'PROCESSING',
        claimed_by: 'worker-pm2-test-instance-1',
        lease_token: leaseToken,
        lease_expires_at: leaseExpires,
        attempt_count: 1,
        payload_summary: { test: true }
      }
    });
    createdWebhookEventIds.push(webhookWithLease.id);

    assert(webhookWithLease.claimed_by === 'worker-pm2-test-instance-1', 'claimed_by persists worker string identifier');
    assert(webhookWithLease.lease_token === leaseToken, 'lease_token persists UUID fencing token');
    assert(webhookWithLease.attempt_count === 1, 'attempt_count persists integer count');
    assert(webhookWithLease.lease_expires_at instanceof Date, 'lease_expires_at persists TIMESTAMPTZ object');

    // Test default attempt_count when omitted
    const webhookDefaultAttempt = await prisma.webhookEvent.create({
      data: {
        event_key: `wamid.TEST_DEFAULT_${Date.now()}`,
        event_type: 'messages',
        restaurant_id: tenantA.id,
        processing_status: 'RECEIVED'
      }
    });
    createdWebhookEventIds.push(webhookDefaultAttempt.id);
    assert(webhookDefaultAttempt.attempt_count === 0, 'attempt_count defaults to 0 when omitted');
    assert(webhookDefaultAttempt.claimed_by === null, 'claimed_by defaults to null');
    assert(webhookDefaultAttempt.lease_token === null, 'lease_token defaults to null');
    assert(webhookDefaultAttempt.lease_expires_at === null, 'lease_expires_at defaults to null');

    // -------------------------------------------------------------
    // TEST GROUP 5: Outbox Message Creation & Fields
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Outbox Message Creation ---');
    const outboxKey1 = `outbox_key_${Date.now()}_1`;
    const outboxMsg1 = await prisma.outboxMessage.create({
      data: {
        restaurant_id: tenantA.id,
        recipient_phone: '919876543210',
        message_type: 'TEXT',
        payload: { text: 'Your order has been submitted!' },
        idempotency_key: outboxKey1,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outboxMsg1.id);

    assert(outboxMsg1.id && typeof outboxMsg1.id === 'string', 'Outbox message created with UUID primary key');
    assert(outboxMsg1.status === 'PENDING', 'Outbox message defaults/persists status PENDING');
    assert(outboxMsg1.attempts === 0, 'Outbox message defaults attempts to 0');
    assert(outboxMsg1.payload && outboxMsg1.payload.text === 'Your order has been submitted!', 'Outbox message persists JSONB payload');
    assert(outboxMsg1.created_at instanceof Date, 'created_at is valid TIMESTAMPTZ');
    assert(outboxMsg1.updated_at instanceof Date, 'updated_at is valid TIMESTAMPTZ');

    // -------------------------------------------------------------
    // TEST GROUP 6: Outbox Duplicate Idempotency Key Rejected
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Outbox Idempotency Key Uniqueness ---');
    let duplicateIdempThrew = false;
    let duplicateIdempCode = null;
    try {
      await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantB.id,
          recipient_phone: '919876543210',
          message_type: 'TEXT',
          payload: { text: 'Duplicate message attempt' },
          idempotency_key: outboxKey1, // Duplicate key
          status: 'PENDING'
        }
      });
    } catch (err) {
      duplicateIdempThrew = true;
      duplicateIdempCode = err.code;
    }
    assert(duplicateIdempThrew, 'Duplicate idempotency_key is rejected by PostgreSQL unique constraint');
    assert(duplicateIdempCode === 'P2002', 'Duplicate idempotency_key triggers Prisma unique constraint error code P2002');

    // -------------------------------------------------------------
    // TEST GROUP 7: Invalid Restaurant Reference Rejected
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Outbox Foreign Key Integrity ---');
    let invalidRestaurantThrew = false;
    let invalidRestaurantCode = null;
    try {
      await prisma.outboxMessage.create({
        data: {
          restaurant_id: crypto.randomUUID(), // Non-existent restaurant UUID
          recipient_phone: '919876543210',
          message_type: 'TEXT',
          payload: { text: 'Orphan message' },
          idempotency_key: `outbox_key_orphan_${Date.now()}`
        }
      });
    } catch (err) {
      invalidRestaurantThrew = true;
      invalidRestaurantCode = err.code;
    }
    assert(invalidRestaurantThrew, 'Outbox message with non-existent restaurant_id is rejected by foreign key constraint');
    assert(invalidRestaurantCode === 'P2003', 'Foreign key violation triggers Prisma error code P2003');

    // -------------------------------------------------------------
    // TEST GROUP 8: Tenant-Scoped Outbox Queries
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 8: Tenant-Scoped Outbox Isolation ---');
    const outboxKeyA = `outbox_tenant_a_${Date.now()}`;
    const outboxKeyB = `outbox_tenant_b_${Date.now()}`;

    const msgA = await prisma.outboxMessage.create({
      data: {
        restaurant_id: tenantA.id,
        recipient_phone: '919876543210',
        message_type: 'ORDER_CONFIRMATION',
        payload: { summary: 'Order for Tenant A' },
        idempotency_key: outboxKeyA
      }
    });
    createdOutboxIds.push(msgA.id);

    const msgB = await prisma.outboxMessage.create({
      data: {
        restaurant_id: tenantB.id,
        recipient_phone: '919876543211',
        message_type: 'ORDER_CONFIRMATION',
        payload: { summary: 'Order for Tenant B' },
        idempotency_key: outboxKeyB
      }
    });
    createdOutboxIds.push(msgB.id);

    const tenantAOutbox = await prisma.outboxMessage.findMany({
      where: { restaurant_id: tenantA.id }
    });
    const tenantAContainsB = tenantAOutbox.some((m) => m.id === msgB.id);
    const tenantAContainsA = tenantAOutbox.some((m) => m.id === msgA.id);
    assert(tenantAContainsA, "Tenant A query retrieves Tenant A's outbox record");
    assert(!tenantAContainsB, "Tenant A query strictly excludes Tenant B's outbox record");

    const tenantBOutbox = await prisma.outboxMessage.findMany({
      where: { restaurant_id: tenantB.id }
    });
    const tenantBContainsA = tenantBOutbox.some((m) => m.id === msgA.id);
    const tenantBContainsB = tenantBOutbox.some((m) => m.id === msgB.id);
    assert(tenantBContainsB, "Tenant B query retrieves Tenant B's outbox record");
    assert(!tenantBContainsA, "Tenant B query strictly excludes Tenant A's outbox record");

    // Test relation join with restaurant
    const outboxWithRestaurant = await prisma.outboxMessage.findUnique({
      where: { id: msgA.id },
      include: { restaurant: true }
    });
    assert(outboxWithRestaurant.restaurant && outboxWithRestaurant.restaurant.id === tenantA.id, 'Outbox message correctly joins with parent restaurant');

  } finally {
    // Clean up test rows
    if (createdOutboxIds.length > 0) {
      await prisma.outboxMessage.deleteMany({
        where: { id: { in: createdOutboxIds } }
      });
    }
    if (createdWebhookEventIds.length > 0) {
      await prisma.webhookEvent.deleteMany({
        where: { id: { in: createdWebhookEventIds } }
      });
    }
    if (createdOrderIds.length > 0) {
      await prisma.order.deleteMany({
        where: { id: { in: createdOrderIds } }
      });
    }

    await prisma.$disconnect();
  }

  console.log('\n============================================================');
  console.log(`   STAGE 4.0 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage4MigrationTests().catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

module.exports = { runStage4MigrationTests };

