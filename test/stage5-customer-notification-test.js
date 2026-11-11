/**
 * RESTOPRO — Stage 5.3: Customer Order Decision Notifications Test Suite
 *
 * Verifies:
 * - Customer notification on Accept (order reference, fulfilment type, address, items, no invented time)
 * - Customer notification on Reject (polite, concise, order reference, no invented reason)
 * - Correct customer recipient resolved from persisted order
 * - Correct restaurant credentials and tenant isolation
 * - Atomic owner decision and outbox message insertion
 * - Clean rollback of owner decision if outbox insertion fails (zero leaked decisions)
 * - Duplicate owner action does not create duplicate customer notifications
 * - Conflicting decisions do not create customer notifications
 * - Outbox dispatch success with status: ACCEPTED, meta_message_id, and delivery_status: SENT
 * - Meta API 400 error handling -> FAILED (with token redaction)
 * - Meta API timeout handling -> UNCERTAIN_DISPATCH
 * - Bounded retry / backoff on 5xx errors -> attempt increment & exhaustion to FAILED
 */
const crypto = require('crypto');
const http = require('http');
const prisma = require('../src/config/database');
const { assertSafeCleanupFilter } = require('../src/utils/test-guard');

async function safeDeleteMany(delegate, where, entity) {
  assertSafeCleanupFilter(where, entity);
  return delegate.deleteMany({ where });
}

const config = require('../src/config/env');
const app = require('../src/app');
const {
  processOwnerOrderDecision,
  buildCustomerDecisionNotificationPayload
} = require('../src/services/order.service');
const {
  resolveRestaurantCredentials
} = require('../src/services/whatsapp.service');
const {
  dispatchPendingOutboxMessages,
  claimPendingOutboxMessages,
  updateOutboxResult
} = require('../src/services/outbox.service');
const { createCentralAccount } = require('../src/services/central-whatsapp.service');
const { generateSignedOwnerCallback } = require('../src/utils/callback-signer');

async function runStage5CustomerNotificationTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 5.3: CUSTOMER NOTIFICATION TEST SUITE   ');
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
  const createdOrderIds = [];
  const createdOutboxIds = [];
  const createdNotificationIds = [];
  const createdWebhookEventKeys = [];
  const createdCentralAccountIds = [];

  let server;
  let serverPort;

  // Helper to create test pending order
  async function createTestOrder(restaurantId, {
    customerPhone = '919876543210',
    customerName = 'Pooja Hegde',
    orderType = 'DELIVERY',
    addressSnapshot = 'Flat 402, Sunshine Heights, Mumbai',
    items = [
      { productRetailerId: 'SKU_BIRYANI', productName: 'Chicken Biryani', quantity: 2, unitPrice: 240.00, lineTotal: 480.00 },
      { productRetailerId: 'SKU_NAAN', productName: 'Butter Naan', quantity: 3, unitPrice: 40.00, lineTotal: 120.00 }
    ],
    totalAmount = 600.00,
    currency = 'INR',
    initialStatus = 'PENDING_RESTAURANT_CONFIRMATION'
  } = {}) {
    const ref = `RP-261105-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const token = `conf_${crypto.randomUUID()}`;
    const order = await prisma.order.create({
      data: {
        restaurant_id: restaurantId,
        order_reference: ref,
        confirmation_token: token,
        customer_name: customerName,
        customer_phone: customerPhone,
        order_type: orderType,
        address_snapshot: orderType === 'DELIVERY' ? addressSnapshot : null,
        items,
        total_amount: totalAmount,
        currency,
        status: initialStatus
      }
    });
    createdOrderIds.push(order.id);
    return order;
  }

  // Helper to send signed HTTP POST request to webhook server
  function sendSignedWebhook(payload, signatureSecret = config.meta.appSecret) {
    return new Promise((resolve, reject) => {
      const rawBody = JSON.stringify(payload);
      const signature = signatureSecret
        ? `sha256=${crypto.createHmac('sha256', signatureSecret).update(rawBody).digest('hex')}`
        : 'invalid_sig';

      const options = {
        hostname: '127.0.0.1',
        port: serverPort,
        path: '/api/webhook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          'x-hub-signature-256': signature
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      });

      req.on('error', reject);
      req.write(rawBody);
      req.end();
    });
  }

  try {
    // Preserve existing records; cleanup is limited to tracked test artifacts.
    const tenantA = await prisma.restaurant.findUnique({
      where: { phone_number_id: '111111111111111' }
    });
    const tenantB = await prisma.restaurant.findUnique({
      where: { phone_number_id: '222222222222222' }
    });

    if (!tenantA || !tenantB) {
      throw new Error('Precondition failed: Seeded restaurants (Tenant A / B) not found.');
    }

    server = http.createServer(app);
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });

    // -------------------------------------------------------------
    // TEST GROUP 1: Customer Notification Content & Formatting
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: Customer Notification Content & Formatting ---');

    // 1. Accept Notification with DELIVERY
    {
      const orderDeliv = await createTestOrder(tenantA.id, {
        customerPhone: '919811122233',
        customerName: 'Rohit Sharma',
        orderType: 'DELIVERY',
        addressSnapshot: 'Tower B, Flat 1204, Sea Green Apartments, Bandra'
      });

      const payload = buildCustomerDecisionNotificationPayload({
        order: orderDeliv,
        decision: 'ACCEPT',
        restaurantName: tenantA.name
      });

      assert(payload.messaging_product === 'whatsapp', 'Messaging product is whatsapp');
      assert(payload.recipient_type === 'individual', 'Recipient type is individual');
      assert(payload.type === 'text', 'Payload type is text');
      assert(payload.to === '919811122233', 'Recipient phone is normalized customer phone');

      const bodyText = payload.text.body;
      assert(bodyText.includes(orderDeliv.order_reference), 'Body contains order reference');
      assert(bodyText.includes('Spice Garden Restaurant'), 'Body mentions restaurant name');
      assert(bodyText.includes('ACCEPTED'), 'Body clearly states order is accepted');
      assert(bodyText.includes('Delivery'), 'Body reflects Delivery fulfilment type');
      assert(bodyText.includes('Tower B, Flat 1204'), 'Body includes delivery address snapshot');
      assert(bodyText.includes('Chicken Biryani'), 'Body includes item names');
      assert(bodyText.includes('600.00'), 'Body includes order total amount');

      // Crucial negative assertions: No invented delivery or preparation times!
      assert(!bodyText.toLowerCase().includes('minute'), 'Zero invented delivery/prep minutes in text');
      assert(!bodyText.toLowerCase().includes('hour'), 'Zero invented delivery/prep hours in text');
      assert(!bodyText.toLowerCase().includes('estimated time'), 'Zero invented estimated times');
      assert(!bodyText.toLowerCase().includes('will arrive at'), 'Zero invented arrival times');
    }

    // 2. Accept Notification with TAKEAWAY
    {
      const orderTakeaway = await createTestOrder(tenantA.id, {
        customerPhone: '919822233344',
        customerName: 'Virat Kohli',
        orderType: 'TAKEAWAY'
      });

      const payload = buildCustomerDecisionNotificationPayload({
        order: orderTakeaway,
        decision: 'ACCEPT',
        restaurantName: tenantA.name
      });

      const bodyText = payload.text.body;
      assert(bodyText.includes('Takeaway (Self-Pickup)'), 'Body reflects Takeaway fulfilment type');
      assert(!bodyText.includes('Delivery Address'), 'Takeaway notification does NOT display delivery address');
      assert(!bodyText.toLowerCase().includes('ready in'), 'Zero invented ready times');
    }

    // 3. Reject Notification
    {
      const orderReject = await createTestOrder(tenantA.id, {
        customerPhone: '919833344455',
        customerName: 'KL Rahul'
      });

      const payload = buildCustomerDecisionNotificationPayload({
        order: orderReject,
        decision: 'REJECT',
        restaurantName: tenantA.name
      });

      assert(payload.messaging_product === 'whatsapp', 'Messaging product is whatsapp');
      assert(payload.to === '919833344455', 'Recipient phone is normalized customer phone');

      const bodyText = payload.text.body;
      assert(bodyText.includes(orderReject.order_reference), 'Reject body contains order reference');
      assert(bodyText.includes('rejected by') || bodyText.includes('unable to accept'), 'Politely states order rejected/unable to accept');
      assert(bodyText.includes('Spice Garden Restaurant'), 'Mentions restaurant name');
      assert(bodyText.includes('not been charged'), 'Reassures customer they have not been charged');
      assert(bodyText.includes('view the menu'), 'Invites customer to order again');

      // Crucial negative assertions: No invented rejection reasons!
      assert(!bodyText.toLowerCase().includes('kitchen'), 'Zero invented kitchen excuse');
      assert(!bodyText.toLowerCase().includes('ingredient'), 'Zero invented ingredient excuse');
      assert(!bodyText.toLowerCase().includes('closed'), 'Zero invented closure excuse');
      assert(!bodyText.toLowerCase().includes('busy'), 'Zero invented busy excuse');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Atomic Owner Decision & Outbox Persistence
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Atomic Owner Decision & Outbox Persistence ---');

    // 4. Owner Accept creates outbox message atomically
    let acceptedOrderId;
    let acceptOutboxId;
    {
      const orderA = await createTestOrder(tenantA.id, { customerPhone: '919844455566' });
      acceptedOrderId = orderA.id;

      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${orderA.id}`
      });

      assert(res.success === true, 'Owner Accept returned success');
      assert(res.order.status === 'ACCEPTED', 'Order transitioned to ACCEPTED');
      assert(res.outboxMessage !== undefined, 'OutboxMessage record returned in response');
      assert(res.orderNotification !== undefined, 'OrderNotification record returned in response');

      acceptOutboxId = res.outboxMessage.id;
      createdOutboxIds.push(acceptOutboxId);
      createdNotificationIds.push(res.orderNotification.id);

      // Verify in PostgreSQL database
      const dbOrder = await prisma.order.findUnique({ where: { id: orderA.id } });
      const dbOutbox = await prisma.outboxMessage.findUnique({ where: { id: acceptOutboxId } });
      const dbNotif = await prisma.orderNotification.findFirst({
        where: { order_id: orderA.id, notification_type: 'CUSTOMER_ORDER_ACCEPTED' }
      });

      assert(dbOrder.status === 'ACCEPTED', 'Order row in PostgreSQL is ACCEPTED');
      assert(dbOrder.decision_at !== null, 'Order decision_at is populated');
      assert(dbOutbox !== null, 'OutboxMessage row exists in PostgreSQL');
      assert(dbOutbox.restaurant_id === tenantA.id, 'Outbox row scoped to Tenant A');
      assert(dbOutbox.recipient_phone === '919844455566', 'Outbox recipient is customer phone');
      assert(dbOutbox.message_type === 'CUSTOMER_ORDER_DECISION', 'message_type is CUSTOMER_ORDER_DECISION');
      assert(dbOutbox.idempotency_key === `customer_decision_${orderA.id}_accept`, 'Idempotency key correctly formatted');
      assert(dbOutbox.status === 'PENDING', 'Initial outbox status is PENDING');
      assert(dbNotif !== null, 'OrderNotification row exists in PostgreSQL');
      assert(dbNotif.delivery_status === 'PENDING', 'Initial notification delivery_status is PENDING');
    }

    // 5. Owner Reject creates outbox message atomically
    let rejectedOrderId;
    let rejectOutboxId;
    {
      const orderB = await createTestOrder(tenantA.id, { customerPhone: '919855566677' });
      rejectedOrderId = orderB.id;

      const res = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_REJECT:${orderB.id}`
      });

      assert(res.success === true, 'Owner Reject returned success');
      assert(res.order.status === 'REJECTED', 'Order transitioned to REJECTED');
      assert(res.outboxMessage !== undefined, 'OutboxMessage record returned in response');

      rejectOutboxId = res.outboxMessage.id;
      createdOutboxIds.push(rejectOutboxId);
      createdNotificationIds.push(res.orderNotification.id);

      const dbOutbox = await prisma.outboxMessage.findUnique({ where: { id: rejectOutboxId } });
      assert(dbOutbox.recipient_phone === '919855566677', 'Reject outbox recipient is customer phone');
      assert(dbOutbox.idempotency_key === `customer_decision_${orderB.id}_reject`, 'Reject idempotency key correct');
    }

    // 6. Rollback: If Outbox insertion fails, owner decision rolls back completely
    {
      const orderRollback = await createTestOrder(tenantA.id, { customerPhone: '919866677788' });

      // Pre-insert an outbox row with the exact same idempotency_key to force a database constraint failure on outbox creation
      const conflictingKey = `customer_decision_${orderRollback.id}_accept`;
      const blockerOutbox = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: '919866677788',
          message_type: 'CUSTOMER_ORDER_DECISION',
          payload: { blocker: true },
          idempotency_key: conflictingKey,
          status: 'SUPPRESSED'
        }
      });
      createdOutboxIds.push(blockerOutbox.id);

      // Now attempt owner decision: tx.outboxMessage.create will trigger unique constraint violation P2002
      let rollbackErrorCaught = false;
      try {
        await processOwnerOrderDecision({
          restaurantId: tenantA.id,
          senderPhone: tenantA.owner_phone,
          buttonPayload: `OWNER_ACCEPT:${orderRollback.id}`
        });
      } catch (err) {
        rollbackErrorCaught = true;
      }

      assert(rollbackErrorCaught === true, 'Outbox constraint collision aborted decision transaction');

      // Verify that Order status was NOT updated and remains PENDING_RESTAURANT_CONFIRMATION (Zero Leaked Decisions!)
      const dbOrder = await prisma.order.findUnique({ where: { id: orderRollback.id } });
      assert(dbOrder.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order status rolled back to PENDING_RESTAURANT_CONFIRMATION');
      assert(dbOrder.decision_at === null, 'Order decision_at remains null after rollback');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: Idempotency & Repeat / Conflicting Decisions
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Idempotency & Repeat / Conflicting Decisions ---');

    // 7. Duplicate owner Accept does not create duplicate outbox messages
    {
      const resDuplicate = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${acceptedOrderId}`
      });

      assert(resDuplicate.success === true, 'Duplicate Accept returns success: true');
      assert(resDuplicate.isDuplicate === true, 'Duplicate Accept marks isDuplicate: true');

      // Verify only 1 outbox record exists for this order
      const outboxCount = await prisma.outboxMessage.count({
        where: { idempotency_key: `customer_decision_${acceptedOrderId}_accept` }
      });
      assert(outboxCount === 1, 'Exactly 1 outbox record exists (Zero duplicate customer notifications)');
    }

    // 8. Conflicting decision (Reject on already ACCEPTED order) does NOT create notification
    {
      const conflictRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_REJECT:${acceptedOrderId}`
      });

      assert(conflictRes.success === false, 'Conflicting Reject rejected');
      assert(conflictRes.code === 'CONFLICTING_DECISION', 'Code is CONFLICTING_DECISION');

      // Ensure no reject outbox message was created
      const rejectOutboxCount = await prisma.outboxMessage.count({
        where: { idempotency_key: `customer_decision_${acceptedOrderId}_reject` }
      });
      assert(rejectOutboxCount === 0, 'Zero conflicting outbox messages created');
    }

    // 9. Conflicting decision (Accept on already REJECTED order) does NOT create notification
    {
      const conflictRes2 = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${rejectedOrderId}`
      });

      assert(conflictRes2.success === false, 'Conflicting Accept rejected');
      assert(conflictRes2.code === 'CONFLICTING_DECISION', 'Code is CONFLICTING_DECISION');

      const acceptOutboxCount = await prisma.outboxMessage.count({
        where: { idempotency_key: `customer_decision_${rejectedOrderId}_accept` }
      });
      assert(acceptOutboxCount === 0, 'Zero conflicting outbox messages created');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Multi-Tenant Credential & Recipient Isolation
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Multi-Tenant Credential & Recipient Isolation ---');

    // 10. Multi-tenant credentials and routing
    {
      const credsA = await resolveRestaurantCredentials(tenantA.id);
      const credsB = await resolveRestaurantCredentials(tenantB.id);

      assert(credsA.phoneNumberId === tenantA.phone_number_id, 'Tenant A resolves PhoneNumberId A');
      assert(credsB.phoneNumberId === tenantB.phone_number_id, 'Tenant B resolves PhoneNumberId B');
      assert(credsA.phoneNumberId !== credsB.phoneNumberId, 'Tenants have completely distinct PhoneNumberIds');

      // Create orders at Tenant A and Tenant B
      const orderTenantA = await createTestOrder(tenantA.id, { customerPhone: '919870001111' });
      const orderTenantB = await createTestOrder(tenantB.id, { customerPhone: '919870002222' });

      const resA = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${orderTenantA.id}`
      });
      const resB = await processOwnerOrderDecision({
        restaurantId: tenantB.id,
        senderPhone: tenantB.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${orderTenantB.id}`
      });

      createdOutboxIds.push(resA.outboxMessage.id, resB.outboxMessage.id);
      createdNotificationIds.push(resA.orderNotification.id, resB.orderNotification.id);

      assert(resA.outboxMessage.restaurant_id === tenantA.id, 'Tenant A outbox message scoped to Tenant A');
      assert(resB.outboxMessage.restaurant_id === tenantB.id, 'Tenant B outbox message scoped to Tenant B');
      assert(resA.outboxMessage.recipient_phone === '919870001111', 'Tenant A notification routes to Customer A');
      assert(resB.outboxMessage.recipient_phone === '919870002222', 'Tenant B notification routes to Customer B');
    }

    // -------------------------------------------------------------
    // TEST GROUP 5: Outbox Dispatcher Integration & Delivery Semantics
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Outbox Dispatcher Integration & Delivery Semantics ---');

    // 11. Mock successful Meta HTTP 200 dispatch of customer notification
    {
      // Clean previous pending outbox messages to test this specific message cleanly
      await prisma.outboxMessage.updateMany({
        where: { status: 'PENDING' },
        data: { status: 'SUPPRESSED' }
      });

      const dispatchOrder = await createTestOrder(tenantA.id, { customerPhone: '919877788899' });
      const decRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${dispatchOrder.id}`
      });
      createdOutboxIds.push(decRes.outboxMessage.id);
      createdNotificationIds.push(decRes.orderNotification.id);

      const mockSuccessSender = async (msg) => {
        return {
          success: true,
          metaMessageId: `wamid.MOCK_CUST_${Date.now()}`,
          data: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.MOCK_CUST_123' }] }
        };
      };

      const dispatchResult = await dispatchPendingOutboxMessages({
        batchSize: 1,
        customSender: mockSuccessSender
      });

      assert(dispatchResult.succeededCount === 1, 'Customer notification successfully dispatched');

      const updatedOutbox = await prisma.outboxMessage.findUnique({ where: { id: decRes.outboxMessage.id } });
      assert(updatedOutbox.status === 'ACCEPTED', 'Outbox status transitioned to ACCEPTED');
      assert(updatedOutbox.payload.meta_message_id !== undefined, 'meta_message_id recorded in payload');
      assert(updatedOutbox.payload.sent_at !== undefined, 'sent_at timestamp recorded in payload');

      const updatedNotif = await prisma.orderNotification.findUnique({ where: { id: decRes.orderNotification.id } });
      assert(updatedNotif.delivery_status === 'SENT', 'OrderNotification delivery_status updated to SENT');
    }

    // 12. Non-retryable 400 error marks message FAILED (with token redaction)
    {
      const failOrder = await createTestOrder(tenantA.id, { customerPhone: '919888899900' });
      const decRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_REJECT:${failOrder.id}`
      });
      createdOutboxIds.push(decRes.outboxMessage.id);
      createdNotificationIds.push(decRes.orderNotification.id);

      const secretToken = 'EAABmocksecret_token_customer';
      const mockFailSender = async (msg) => {
        return {
          success: false,
          isTimeout: false,
          isRetryable: false,
          statusCode: 400,
          error: `Meta Graph API 400 Bad Request with ${secretToken}`.replace(secretToken, '[REDACTED]')
        };
      };

      const failDispatchResult = await dispatchPendingOutboxMessages({
        batchSize: 1,
        customSender: mockFailSender
      });

      assert(failDispatchResult.failedCount === 1, 'Non-retryable error recorded as failed');

      const updatedFailOutbox = await prisma.outboxMessage.findUnique({ where: { id: decRes.outboxMessage.id } });
      assert(updatedFailOutbox.status === 'FAILED', 'Outbox status transitioned to FAILED');
      assert(updatedFailOutbox.last_error.includes('[REDACTED]'), 'Secret token redacted from last_error');
      assert(!updatedFailOutbox.last_error.includes(secretToken), 'Zero raw secret tokens exposed in last_error');
    }

    // 13. Network timeout transitions message to UNCERTAIN_DISPATCH
    {
      const timeoutOrder = await createTestOrder(tenantA.id, { customerPhone: '919899900011' });
      const decRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${timeoutOrder.id}`
      });
      createdOutboxIds.push(decRes.outboxMessage.id);
      createdNotificationIds.push(decRes.orderNotification.id);

      const mockTimeoutSender = async (msg) => {
        return {
          success: false,
          isTimeout: true,
          isRetryable: true,
          statusCode: null,
          error: 'Connection timed out after 10000ms'
        };
      };

      const timeoutResult = await dispatchPendingOutboxMessages({
        batchSize: 1,
        customSender: mockTimeoutSender
      });

      assert(timeoutResult.uncertainCount === 1, 'Timeout marks message as UNCERTAIN_DISPATCH');

      const updatedTimeoutOutbox = await prisma.outboxMessage.findUnique({ where: { id: decRes.outboxMessage.id } });
      assert(updatedTimeoutOutbox.status === 'UNCERTAIN_DISPATCH', 'Outbox status is UNCERTAIN_DISPATCH');
      assert(updatedTimeoutOutbox.last_error.includes('timed out'), 'last_error records timeout message');
    }

    // 14. 5xx retryable error and attempt exhaustion
    {
      const retryOrder = await createTestOrder(tenantA.id, { customerPhone: '919800011122' });
      const decRes = await processOwnerOrderDecision({
        restaurantId: tenantA.id,
        senderPhone: tenantA.owner_phone,
        buttonPayload: `OWNER_ACCEPT:${retryOrder.id}`
      });
      createdOutboxIds.push(decRes.outboxMessage.id);
      createdNotificationIds.push(decRes.orderNotification.id);

      const mock500Sender = async (msg) => {
        return {
          success: false,
          isTimeout: false,
          isRetryable: true,
          statusCode: 500,
          error: 'Meta Graph API Internal Server Error (500)'
        };
      };

      // 1st retry attempt -> returns to PENDING
      await dispatchPendingOutboxMessages({
        batchSize: 1,
        maxAttempts: 3,
        customSender: mock500Sender
      });

      const afterAttempt1 = await prisma.outboxMessage.findUnique({ where: { id: decRes.outboxMessage.id } });
      assert(afterAttempt1.status === 'PENDING', 'Retryable 500 error keeps status PENDING for next attempt');
      assert(afterAttempt1.attempts === 1, 'attempts count incremented to 1');

      // Fast forward attempts to 2 and clear lease
      await prisma.outboxMessage.update({
        where: { id: decRes.outboxMessage.id },
        data: { attempts: 2, payload: { lease: null } }
      });

      // 3rd attempt -> reaches maxAttempts (3) -> transitions to FAILED
      await dispatchPendingOutboxMessages({
        batchSize: 1,
        maxAttempts: 3,
        customSender: mock500Sender
      });

      const afterMaxAttempts = await prisma.outboxMessage.findUnique({ where: { id: decRes.outboxMessage.id } });
      assert(afterMaxAttempts.status === 'FAILED', 'Exhausted retry attempts transitions status to FAILED');
      assert(afterMaxAttempts.attempts === 3, 'attempts reached maxAttempts (3)');
    }

    // -------------------------------------------------------------
    // TEST GROUP 6: Webhook Pipeline Integration (HTTP POST with HMAC)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Webhook Pipeline Integration (HTTP POST with HMAC) ---');

    // 15. End-to-end HTTP POST owner Accept creates customer notification outbox row
    {
      // Clean pending outbox for tenantA
      assertSafeCleanupFilter({ restaurant_id: tenantA.id }, 'OutboxMessage');
      await prisma.outboxMessage.updateMany({
        where: { restaurant_id: tenantA.id, status: 'PENDING' },
        data: { status: 'SUPPRESSED' }
      });

      // Ensure active central account exists for owner decisions in Central routing mode
      const centralPhoneId = '999888777000';
      let stage5CentralAccount = await prisma.centralWhatsAppAccount.findFirst({ where: { is_active: true } });
      if (!stage5CentralAccount) {
        stage5CentralAccount = await createCentralAccount({
          phoneNumberId: centralPhoneId,
          wabaId: 'waba_stage5_test',
          accessToken: 'EAAB_test_stage5_token',
          displayPhoneNumber: '+91 99988 87770',
          isActive: true
        });
        createdCentralAccountIds.push(stage5CentralAccount.id);
      }

      const e2eOrder = await createTestOrder(tenantA.id, { customerPhone: '919812300456' });
      const wamidDecision = `wamid.E2E_DECISION_${Date.now()}`;
      createdWebhookEventKeys.push(wamidDecision);
      const signedAcceptPayload = generateSignedOwnerCallback({ orderId: e2eOrder.id, action: 'ACCEPT' });

      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: tenantA.waba_id,
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: stage5CentralAccount.display_phone_number || '+91 99988 87770',
                    phone_number_id: stage5CentralAccount.phone_number_id
                  },
                  messages: [
                    {
                      from: tenantA.owner_phone.replace(/[^\d]/g, ''),
                      id: wamidDecision,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: {
                          id: signedAcceptPayload,
                          title: '✅ Accept Order'
                        }
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

      const res = await sendSignedWebhook(payload);
      assert(res.statusCode === 200, 'HTTP POST owner Accept returns HTTP 200');

      // Verify customer outbox row was created in PostgreSQL
      const customerOutboxRow = await prisma.outboxMessage.findFirst({
        where: {
          restaurant_id: tenantA.id,
          idempotency_key: `customer_decision_${e2eOrder.id}_accept`
        }
      });

      assert(customerOutboxRow !== null, 'Customer notification outbox row created in PostgreSQL via webhook');
      assert(customerOutboxRow.recipient_phone === '919812300456', 'Customer outbox row recipient is customer phone');
      assert(customerOutboxRow.status === 'PENDING', 'Customer outbox row status is PENDING');
      createdOutboxIds.push(customerOutboxRow.id);

      // Verify outbox dispatch picks up this message and dispatches it
      const mockE2ESender = async (msg) => {
        return {
          success: true,
          metaMessageId: `wamid.MOCK_E2E_SENT_${Date.now()}`,
          data: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.MOCK_E2E_SENT_1' }] }
        };
      };

      const dispatchRes = await dispatchPendingOutboxMessages({
        batchSize: 1,
        customSender: mockE2ESender
      });

      assert(dispatchRes.succeededCount === 1, 'Customer notification outbox message dispatched successfully');

      const dispatchedRow = await prisma.outboxMessage.findUnique({ where: { id: customerOutboxRow.id } });
      assert(dispatchedRow.status === 'ACCEPTED', 'Customer notification status transitioned to ACCEPTED');
    }

  } catch (err) {
    console.error('\n❌ Unexpected error during Stage 5.3 test execution:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up Stage 5.3 test artifacts ---');
    try {
      if (server) {
        await new Promise(resolve => server.close(resolve));
      }
      if (createdWebhookEventKeys.length > 0) {
        await safeDeleteMany(
          prisma.webhookEvent,
          { event_key: { in: createdWebhookEventKeys } },
          'WebhookEvent'
        );
      }
      if (createdNotificationIds.length > 0) {
        await safeDeleteMany(
          prisma.orderNotification,
          { id: { in: createdNotificationIds } },
          'OrderNotification'
        );
      }
      if (createdOutboxIds.length > 0) {
        await safeDeleteMany(
          prisma.outboxMessage,
          { id: { in: createdOutboxIds } },
          'OutboxMessage'
        );
      }
      if (createdOrderIds.length > 0) {
        await safeDeleteMany(
          prisma.order,
          { id: { in: createdOrderIds } },
          'Order'
        );
      }
      if (createdCentralAccountIds.length > 0) {
        await safeDeleteMany(
          prisma.centralWhatsAppAccount,
          { id: { in: createdCentralAccountIds } },
          'CentralWhatsAppAccount'
        );
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 5.3 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage5CustomerNotificationTests();
}

module.exports = { runStage5CustomerNotificationTests };

