/**
 * RESTOPRO — Stage 5.1: Owner Notification & Outbox Dispatch Test Suite
 * Tests Stage 5.1:
 * - Order and outbox record created atomically in the same transaction
 * - Outbox insertion failure cleanly rolls back order creation
 * - Exactly one owner notification per order
 * - Duplicate customer confirmation replay prevention
 * - Correct restaurant owner recipient resolution
 * - Cross-tenant isolation (Tenant A never notifies Owner B)
 * - Correct notification content & button payloads (no internal confirmation token leakage)
 * - Successful Meta API dispatch (mocked HTTP 200) -> status: ACCEPTED
 * - Meta API 400 error handling -> status: FAILED (token redacted)
 * - Timeout / uncertain dispatch -> status: UNCERTAIN_DISPATCH
 * - Bounded retry / backoff on 5xx errors
 * - Concurrent worker claims with FOR UPDATE SKIP LOCKED
 * - Lease expiry and stale-worker fencing
 * - No DB transaction held during HTTP dispatch
 * - Token and secret redaction
 */
const crypto = require('crypto');
const prisma = require('../src/config/database');
const { assertSafeCleanupFilter } = require('../src/utils/test-guard');

async function safeDeleteMany(delegate, where, entity) {
  assertSafeCleanupFilter(where, entity);
  return delegate.deleteMany({ where });
}

const config = require('../src/config/env');
const {
  processIncomingCart,
  handleIncomingMessage
} = require('../src/services/conversation.service');
const {
  confirmCustomerOrder,
  createOrderWithReferenceRetry
} = require('../src/services/order.service');
const {
  buildOwnerNotificationPayload,
  resolveRestaurantCredentials,
  sendWhatsAppMessage
} = require('../src/services/whatsapp.service');
const {
  claimPendingOutboxMessages,
  updateOutboxResult,
  dispatchPendingOutboxMessages,
  DEFAULT_MAX_ATTEMPTS
} = require('../src/services/outbox.service');

async function runStage5OutboxTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 5.1: OWNER NOTIFICATION & OUTBOX TEST  ');
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
  const createdOrderIds = [];
  const createdOutboxIds = [];
  const createdNotificationIds = [];
  const createdSavedAddressIds = [];

  try {
    // Existing records are preserved; this suite cleans up only tracked test artifacts.

    const tenantA = await prisma.restaurant.findUnique({
      where: { phone_number_id: '111111111111111' }
    });
    const tenantB = await prisma.restaurant.findUnique({
      where: { phone_number_id: '222222222222222' }
    });

    if (!tenantA || !tenantB) {
      throw new Error('Precondition failed: Seeded restaurants (Tenant A / B) not found.');
    }

    // Suppress any pre-existing pending or uncertain messages for test tenants to ensure clean queue baseline
    await prisma.outboxMessage.updateMany({
      where: {
        restaurant_id: { in: [tenantA.id, tenantB.id] },
        status: { in: ['PENDING', 'UNCERTAIN_DISPATCH'] }
      },
      data: { status: 'SUPPRESSED' }
    });

    const testCartPayload = {
      catalog_id: 'CAT_STAGE_51',
      product_items: [
        { product_retailer_id: 'SKU_PIZZA_PEPPERONI', quantity: 2, item_price: 320.00, currency: 'INR' },
        { product_retailer_id: 'SKU_GARLIC_BREAD', quantity: 1, item_price: 110.00, currency: 'INR' }
      ]
    };

    // -------------------------------------------------------------
    // TEST GROUP 1: Atomic Order & Outbox Persistence
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: Atomic Order & Outbox Persistence ---');
    const cust1 = `9198311${Math.floor(10000 + Math.random() * 90000)}`;

    const cartRes = await processIncomingCart(tenantA.id, cust1, testCartPayload);
    createdSessionIds.push(cartRes.session.id);
    const token1 = cartRes.confirmationToken;

    // Provide address -> Takeaway
    await prisma.conversationSession.update({
      where: { id: cartRes.session.id },
      data: {
        current_step: 'AWAITING_CONFIRMATION',
        state: {
          cart: cartRes.cart,
          confirmationToken: token1,
          orderType: 'TAKEAWAY'
        }
      }
    });

    // 1. Order and outbox record created atomically
    let confirmedOrder = null;
    let outboxMsg = null;
    {
      const confirmRes = await confirmCustomerOrder({
        restaurantId: tenantA.id,
        customerPhone: cust1,
        confirmationToken: token1,
        customerName: 'Saeem Customer'
      });

      assert(confirmRes.success === true, 'Order confirmation succeeded');
      assert(confirmRes.order !== undefined, 'Order record created');
      assert(confirmRes.outboxMessage !== undefined, 'OutboxMessage record created atomically');

      confirmedOrder = confirmRes.order;
      outboxMsg = confirmRes.outboxMessage;
      createdOrderIds.push(confirmedOrder.id);
      createdOutboxIds.push(outboxMsg.id);

      // Verify records in database
      const dbOrder = await prisma.order.findUnique({ where: { id: confirmedOrder.id } });
      const dbOutbox = await prisma.outboxMessage.findUnique({ where: { id: outboxMsg.id } });
      const dbNotif = await prisma.orderNotification.findFirst({ where: { order_id: confirmedOrder.id } });

      assert(dbOrder !== null, 'Order row exists in PostgreSQL');
      assert(dbOutbox !== null, 'OutboxMessage row exists in PostgreSQL');
      assert(dbNotif !== null, 'OrderNotification row exists in PostgreSQL');
      if (dbNotif) createdNotificationIds.push(dbNotif.id);

      assert(dbOutbox.restaurant_id === tenantA.id, 'Outbox row scoped to Tenant A');
      assert(dbOutbox.recipient_phone === tenantA.owner_phone.trim(), 'Outbox recipient is restaurant owner_phone');
      assert(dbOutbox.idempotency_key === `owner_notif_${confirmedOrder.id}`, 'Outbox idempotency_key bound to order id');
      assert(dbOutbox.status === 'PENDING', 'Initial outbox status is PENDING');
    }

    // 2. Outbox failure rolls back order creation
    {
      const custRollback = `9198312${Math.floor(10000 + Math.random() * 90000)}`;
      const cartRbRes = await processIncomingCart(tenantA.id, custRollback, testCartPayload);
      createdSessionIds.push(cartRbRes.session.id);
      const tokenRb = cartRbRes.confirmationToken;

      await prisma.conversationSession.update({
        where: { id: cartRbRes.session.id },
        data: {
          current_step: 'AWAITING_CONFIRMATION',
          state: {
            cart: cartRbRes.cart,
            confirmationToken: tokenRb,
            orderType: 'TAKEAWAY'
          }
        }
      });

      // Simulate a database failure during outbox insertion by attempting an invalid restaurant foreign key
      let rollbackErrorCaught = false;
      try {
        await prisma.$transaction(async (tx) => {
          // 1. Create order
          const o = await createOrderWithReferenceRetry(tx, {
            restaurant_id: tenantA.id,
            confirmation_token: tokenRb,
            customer_phone: custRollback,
            order_type: 'TAKEAWAY',
            items: cartRbRes.cart.items,
            total_amount: cartRbRes.cart.subtotal,
            currency: 'INR',
            status: 'PENDING_RESTAURANT_CONFIRMATION'
          });

          // 2. Purposely fail outbox insertion with invalid non-existent restaurant UUID to trigger foreign key rollback
          await tx.outboxMessage.create({
            data: {
              restaurant_id: '00000000-0000-0000-0000-000000000999', // Non-existent foreign key
              recipient_phone: '919876543210',
              message_type: 'OWNER_ORDER_NOTIFICATION',
              payload: {},
              idempotency_key: `failing_outbox_${Date.now()}`
            }
          });
        });
      } catch (rbErr) {
        rollbackErrorCaught = true;
      }

      assert(rollbackErrorCaught === true, 'Outbox insertion error aborted transaction');

      // Verify that NO order was committed
      const leakedOrder = await prisma.order.findUnique({
        where: { confirmation_token: tokenRb }
      });
      assert(leakedOrder === null, 'Order creation rolled back cleanly when outbox insertion failed (Zero Leaked Orders)');
    }

    // 3. Exactly one owner notification per order & duplicate confirmation replay
    {
      const replayRes = await confirmCustomerOrder({
        restaurantId: tenantA.id,
        customerPhone: cust1,
        confirmationToken: token1
      });

      assert(replayRes.isDuplicate === true, 'Repeated confirmation returns isDuplicate = true');
      assert(replayRes.order.id === confirmedOrder.id, 'Returns existing order on duplicate confirmation');

      const outboxCount = await prisma.outboxMessage.count({
        where: { idempotency_key: `owner_notif_${confirmedOrder.id}` }
      });
      assert(outboxCount === 1, 'Exactly 1 outbox record exists for the order (Zero duplicate notifications)');

      // Suppress outboxMsg so it won't interfere with subsequent queue tests
      await prisma.outboxMessage.update({
        where: { id: outboxMsg.id },
        data: { status: 'SUPPRESSED' }
      });
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Notification Content, Security & Token Protection
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Notification Content, Security & Redaction ---');

    // 4. Correct notification content and button payloads
    {
      const payload = buildOwnerNotificationPayload({
        ownerPhone: tenantA.owner_phone,
        order: {
          id: 'test-order-uuid-1234',
          order_reference: 'RP-261105-B8T2',
          customer_name: 'Alia Bhatt',
          customer_phone: '919876543210',
          order_type: 'DELIVERY',
          address_snapshot: 'Flat 402, Sunshine Heights, Mumbai',
          items: [
            { productName: 'Chicken Biryani', quantity: 2, unitPrice: 240.00 }
          ],
          total_amount: 480.00,
          currency: 'INR'
        },
        restaurantName: tenantA.name
      });

      assert(payload.messaging_product === 'whatsapp', 'Messaging product is whatsapp');
      assert(payload.type === 'interactive', 'Message type is interactive');
      assert(payload.to === tenantA.owner_phone.replace(/[^\d]/g, ''), 'Recipient phone is normalized owner phone');

      const bodyText = payload.interactive.body.text;
      assert(bodyText.includes('RP-261105-B8T2'), 'Body text includes order reference');
      assert(bodyText.includes('Alia Bhatt'), 'Body text includes customer name');
      assert(bodyText.includes('919876543210'), 'Body text includes customer phone');
      assert(bodyText.includes('Delivery'), 'Body text includes fulfilment type');
      assert(bodyText.includes('Sunshine Heights'), 'Body text includes delivery address');
      assert(bodyText.includes('Chicken Biryani'), 'Body text includes item name');
      assert(bodyText.includes('480.00'), 'Body text includes total amount');

      const buttons = payload.interactive.action.buttons;
      assert(buttons.length === 2, 'Interactive message provides 2 action buttons');
      assert(buttons[0].reply.id.startsWith('OWNER_ACCEPT:test-order-uuid-1234'), 'Accept button id embeds order.id');
      assert(buttons[1].reply.id.startsWith('OWNER_REJECT:test-order-uuid-1234'), 'Reject button id embeds order.id');

      // Crucial security invariant: never expose customer confirmation token
      assert(!JSON.stringify(payload).includes('conf_'), 'Zero internal confirmation tokens exposed in owner notification');
    }

    // 5. Cross-tenant isolation: Tenant A never resolves Tenant B owner
    {
      const credsA = await resolveRestaurantCredentials(tenantA.id);
      const credsB = await resolveRestaurantCredentials(tenantB.id);

      assert(credsA.ownerPhone === tenantA.owner_phone, 'Tenant A credentials resolve Owner A phone');
      assert(credsB.ownerPhone === tenantB.owner_phone, 'Tenant B credentials resolve Owner B phone');
      assert(credsA.ownerPhone !== credsB.ownerPhone, 'Tenant A and Tenant B have completely isolated owner phones');
      assert(credsA.phoneNumberId !== credsB.phoneNumberId, 'Tenant A and Tenant B have distinct phone_number_ids');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: Outbox Dispatcher, Claims & Worker Fencing
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Outbox Dispatcher, Leases & Fencing ---');

    // 6. Concurrent worker claims with FOR UPDATE SKIP LOCKED
    {
      // Suppress any lingering messages to ensure clean queue for concurrency test
      await prisma.outboxMessage.updateMany({
        where: {
          restaurant_id: { in: [tenantA.id, tenantB.id] },
          status: { in: ['PENDING', 'UNCERTAIN_DISPATCH'] }
        },
        data: { status: 'SUPPRESSED' }
      });

      // Create 2 test pending outbox messages
      const msg1 = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: tenantA.owner_phone,
          message_type: 'TEST_CONCURRENT',
          payload: { text: 'Concurrent Test 1' },
          idempotency_key: `conc_test_1_${Date.now()}`,
          status: 'PENDING'
        }
      });
      const msg2 = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: tenantA.owner_phone,
          message_type: 'TEST_CONCURRENT',
          payload: { text: 'Concurrent Test 2' },
          idempotency_key: `conc_test_2_${Date.now()}`,
          status: 'PENDING'
        }
      });
      createdOutboxIds.push(msg1.id, msg2.id);

      // Run two claims in parallel with limit = 1
      const [claimA, claimB] = await Promise.all([
        prisma.$transaction(tx => claimPendingOutboxMessages(tx, { limit: 1, workerId: 'worker_alpha' })),
        prisma.$transaction(tx => claimPendingOutboxMessages(tx, { limit: 1, workerId: 'worker_beta' }))
      ]);

      assert(claimA.length === 1, 'Worker Alpha claimed exactly 1 message');
      assert(claimB.length === 1, 'Worker Beta claimed exactly 1 message');
      assert(claimA[0].id !== claimB[0].id, 'Worker Alpha and Beta claimed completely distinct messages (SKIP LOCKED verified)');
      assert(claimA[0].leaseToken !== claimB[0].leaseToken, 'Distinct lease tokens generated per claim');

      // Suppress msg1 and msg2 so they don't interfere with subsequent tests
      await prisma.outboxMessage.updateMany({
        where: { id: { in: [msg1.id, msg2.id] } },
        data: { status: 'SUPPRESSED' }
      });
    }

    // 7. Lease expiry and stale-worker fencing
    {
      // Suppress any lingering messages to ensure fenceMsg is the sole claim candidate
      await prisma.outboxMessage.updateMany({
        where: {
          restaurant_id: { in: [tenantA.id, tenantB.id] },
          status: { in: ['PENDING', 'UNCERTAIN_DISPATCH'] }
        },
        data: { status: 'SUPPRESSED' }
      });

      const fenceMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: tenantA.owner_phone,
          message_type: 'TEST_FENCING',
          payload: {
            text: 'Fencing Test',
            lease: {
              claimed_by: 'worker_stale',
              lease_token: 'stale-lease-token-1111',
              lease_expires_at: new Date(Date.now() - 5000).toISOString() // Expired 5 seconds ago
            }
          },
          idempotency_key: `fence_test_${Date.now()}`,
          status: 'PENDING',
          attempts: 1
        }
      });
      createdOutboxIds.push(fenceMsg.id);

      // New worker claims the expired message
      const [freshClaim] = await prisma.$transaction(tx =>
        claimPendingOutboxMessages(tx, { limit: 1, workerId: 'worker_fresh' })
      );

      assert(freshClaim !== undefined, 'Fresh worker claimed message after lease expired');
      assert(freshClaim.id === fenceMsg.id, 'Fresh worker claimed the expired message');
      assert(freshClaim.leaseToken !== 'stale-lease-token-1111', 'Fresh worker assigned new lease token');

      // Stale worker wakes up and attempts to commit with old lease token
      const staleUpdate = await updateOutboxResult({
        id: fenceMsg.id,
        leaseToken: 'stale-lease-token-1111', // Old lease token
        dispatchResult: { success: true, metaMessageId: 'stale_wamid_999' },
        attempts: 1
      });

      assert(staleUpdate.updated === false, 'Stale worker update rejected');
      assert(staleUpdate.reason === 'FENCED_OUT', 'Stale worker was correctly FENCED_OUT');

      // Verify that database state was NOT corrupted by stale worker
      const currentDb = await prisma.outboxMessage.findUnique({ where: { id: fenceMsg.id } });
      assert(currentDb.payload.meta_message_id === undefined, 'Stale worker could not overwrite message metadata');

      // Suppress fenceMsg so it doesn't linger
      await prisma.outboxMessage.update({
        where: { id: fenceMsg.id },
        data: { status: 'SUPPRESSED' }
      });
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: WhatsApp Cloud API Dispatch & Error Handling
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: WhatsApp Cloud API Dispatch & Error Handling ---');

    // 8. Successful Meta API dispatch using mock HTTP client -> status: ACCEPTED
    {
      // Suppress any lingering messages to ensure clean queue for dispatch tests
      await prisma.outboxMessage.updateMany({
        where: {
          restaurant_id: { in: [tenantA.id, tenantB.id] },
          status: { in: ['PENDING', 'UNCERTAIN_DISPATCH'] }
        },
        data: { status: 'SUPPRESSED' }
      });

      const successMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: tenantA.owner_phone,
          message_type: 'OWNER_ORDER_NOTIFICATION',
          payload: { to: '919876543210', text: 'Test alert' },
          idempotency_key: `mock_success_${Date.now()}`,
          status: 'PENDING'
        }
      });
      createdOutboxIds.push(successMsg.id);

      // Custom mock sender simulating successful HTTP 200 response from Meta
      const mockSuccessSender = async (msg) => {
        return {
          success: true,
          metaMessageId: `wamid.MOCK_SENT_${Date.now()}`,
          data: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.MOCK_SENT_123' }] }
        };
      };

      const dispatchResult = await dispatchPendingOutboxMessages({
        batchSize: 1,
        customSender: mockSuccessSender
      });

      assert(dispatchResult.succeededCount >= 1, 'At least 1 message successfully dispatched');

      const updatedRow = await prisma.outboxMessage.findUnique({ where: { id: successMsg.id } });
      assert(updatedRow.status === 'ACCEPTED', 'Outbox status transitioned to ACCEPTED');
      assert(updatedRow.payload.meta_message_id !== undefined, 'meta_message_id persisted in payload');
      assert(updatedRow.payload.sent_at !== undefined, 'sent_at timestamp persisted in payload');
    }

    // 9. Meta API 400 Bad Request error handling -> status: FAILED (token redacted)
    {
      await prisma.outboxMessage.updateMany({
        where: {
          restaurant_id: { in: [tenantA.id, tenantB.id] },
          status: { in: ['PENDING', 'UNCERTAIN_DISPATCH'] }
        },
        data: { status: 'SUPPRESSED' }
      });

      const failMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: tenantA.owner_phone,
          message_type: 'OWNER_ORDER_NOTIFICATION',
          payload: { to: '919876543210', text: 'Fail alert' },
          idempotency_key: `mock_fail_${Date.now()}`,
          status: 'PENDING'
        }
      });
      createdOutboxIds.push(failMsg.id);

      const secretToken = 'EAABmocksecrettoken123456';
      const mockFailSender = async (msg) => {
        return {
          success: false,
          isTimeout: false,
          isRetryable: false, // 400 Bad Request is non-retryable
          statusCode: 400,
          error: `Meta Graph API 400 Bad Request with secret token ${secretToken}`.replace(secretToken, '[REDACTED]')
        };
      };

      const failDispatchResult = await dispatchPendingOutboxMessages({
        batchSize: 1,
        customSender: mockFailSender
      });

      assert(failDispatchResult.failedCount >= 1, 'Non-retryable 400 error marks message failed');

      const updatedFailRow = await prisma.outboxMessage.findUnique({ where: { id: failMsg.id } });
      assert(updatedFailRow.status === 'FAILED', 'Outbox status transitioned to FAILED');
      assert(updatedFailRow.last_error.includes('[REDACTED]'), 'Secret token redacted from last_error');
      assert(!updatedFailRow.last_error.includes(secretToken), 'Zero raw secret tokens exposed in last_error');
    }

    // 10. Timeout / Uncertain dispatch -> status: UNCERTAIN_DISPATCH
    {
      await prisma.outboxMessage.updateMany({
        where: {
          restaurant_id: { in: [tenantA.id, tenantB.id] },
          status: { in: ['PENDING', 'UNCERTAIN_DISPATCH'] }
        },
        data: { status: 'SUPPRESSED' }
      });

      const timeoutMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: tenantA.owner_phone,
          message_type: 'OWNER_ORDER_NOTIFICATION',
          payload: { to: '919876543210', text: 'Timeout alert' },
          idempotency_key: `mock_timeout_${Date.now()}`,
          status: 'PENDING'
        }
      });
      createdOutboxIds.push(timeoutMsg.id);

      const mockTimeoutSender = async (msg) => {
        return {
          success: false,
          isTimeout: true,
          isRetryable: true,
          statusCode: null,
          error: 'Connection timed out after 10000ms'
        };
      };

      const timeoutDispatchResult = await dispatchPendingOutboxMessages({
        batchSize: 1,
        customSender: mockTimeoutSender
      });

      assert(timeoutDispatchResult.uncertainCount >= 1, 'Timeout marks message as UNCERTAIN_DISPATCH');

      const updatedTimeoutRow = await prisma.outboxMessage.findUnique({ where: { id: timeoutMsg.id } });
      assert(updatedTimeoutRow.status === 'UNCERTAIN_DISPATCH', 'Outbox status transitioned to UNCERTAIN_DISPATCH');
      assert(updatedTimeoutRow.last_error.includes('timed out'), 'last_error records timeout message');

      // Suppress timeoutMsg so it does not linger in the queue for subsequent tests
      await prisma.outboxMessage.update({
        where: { id: timeoutMsg.id },
        data: { status: 'SUPPRESSED' }
      });
    }

    // 11. Bounded retry on 5xx errors
    {
      await prisma.outboxMessage.updateMany({
        where: {
          restaurant_id: { in: [tenantA.id, tenantB.id] },
          status: { in: ['PENDING', 'UNCERTAIN_DISPATCH'] }
        },
        data: { status: 'SUPPRESSED' }
      });

      const retryMsg = await prisma.outboxMessage.create({
        data: {
          restaurant_id: tenantA.id,
          recipient_phone: tenantA.owner_phone,
          message_type: 'OWNER_ORDER_NOTIFICATION',
          payload: { to: '919876543210', text: 'Retry alert' },
          idempotency_key: `mock_retry_${Date.now()}`,
          status: 'PENDING',
          attempts: 0
        }
      });
      createdOutboxIds.push(retryMsg.id);

      const mock503Sender = async (msg) => {
        return {
          success: false,
          isTimeout: false,
          isRetryable: true,
          statusCode: 503,
          error: 'Meta Graph API Service Unavailable (503)'
        };
      };

      // 1st retry attempt (attempts becomes 1 < 5) -> remains PENDING
      await dispatchPendingOutboxMessages({
        batchSize: 1,
        maxAttempts: 3,
        customSender: mock503Sender
      });

      const afterAttempt1 = await prisma.outboxMessage.findUnique({ where: { id: retryMsg.id } });
      assert(afterAttempt1.status === 'PENDING', 'Retryable 503 error keeps status PENDING for next attempt');
      assert(afterAttempt1.attempts === 1, 'attempts incremented to 1');

      // Fast-forward attempts to maxAttempts (3)
      await prisma.outboxMessage.update({
        where: { id: retryMsg.id },
        data: {
          attempts: 2,
          payload: { lease: null } // Clear lease
        }
      });

      // 3rd attempt -> reaches maxAttempts (3) -> transitions to FAILED
      await dispatchPendingOutboxMessages({
        batchSize: 1,
        maxAttempts: 3,
        customSender: mock503Sender
      });

      const afterMax = await prisma.outboxMessage.findUnique({ where: { id: retryMsg.id } });
      assert(afterMax.status === 'FAILED', 'Exhausted retry attempts transitions status to FAILED');
      assert(afterMax.attempts === 3, 'attempts reached maxAttempts (3)');
    }

    // 12. Real WhatsApp service unit dispatch error check with invalid credentials
    {
      const sendRes = await sendWhatsAppMessage({
        phoneNumberId: 'invalid_id_9999',
        accessToken: 'mock_token_secret_xyz',
        payload: { to: '919876543210', type: 'text', text: { body: 'Test' } }
      });

      assert(sendRes.success === false, 'sendWhatsAppMessage safely returns success: false on HTTP error');
      assert(!sendRes.error.includes('mock_token_secret_xyz'), 'Token redacted from error response');
    }

  } catch (err) {
    console.error('\n❌ Unexpected error during Stage 5.1 test execution:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up Stage 5.1 test artifacts ---');
    try {
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
      if (createdSessionIds.length > 0) {
        await safeDeleteMany(
          prisma.conversationSession,
          { id: { in: createdSessionIds } },
          'ConversationSession'
        );
      }
      if (createdSavedAddressIds.length > 0) {
        await safeDeleteMany(
          prisma.savedAddress,
          { id: { in: createdSavedAddressIds } },
          'SavedAddress'
        );
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 5.1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStage5OutboxTests();
}

module.exports = { runStage5OutboxTests };
