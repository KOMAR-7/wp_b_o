/**
 * RESTOPRO — Stage 2: Multi-Tenant Database, Schema & Idempotency Test Suite
 * Verifies PostgreSQL models, constraints, tenant isolation, and durable webhook ingestion.
 */
require('./load-test-env');
const crypto = require('crypto');
const http = require('http');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');
const {
  resolveTenantByPhoneNumberId,
  scopeQuery,
  findTenantOrder,
  findTenantSession,
  findTenantAddresses
} = require('../src/services/tenant.service');
const { recordIncomingEvent } = require('../src/services/webhook.service');

const TEST_PORT = 3998;
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

async function runStage2Tests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 2: MULTI-TENANT DATABASE TEST SUITE    ');
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

  // Start HTTP server for webhook testing
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, resolve);
  });

  try {
    // -------------------------------------------------------------
    // TEST GROUP 1: Database Connection & Seed Data Integrity
    // -------------------------------------------------------------
    console.log('--- TEST GROUP 1: Multi-Tenant Seeding & Independent Storage ---');
    const tenantA = await prisma.restaurant.findUnique({
      where: { phone_number_id: '111111111111111' }
    });
    assert(tenantA !== null, 'Tenant A (Spice Garden) exists in PostgreSQL');
    assert(tenantA.name.includes('Spice Garden'), 'Tenant A has correct commercial name');

    const tenantB = await prisma.restaurant.findUnique({
      where: { phone_number_id: '222222222222222' }
    });
    assert(tenantB !== null, 'Tenant B (Ocean Breeze) exists in PostgreSQL');
    assert(tenantB.name.includes('Ocean Breeze'), 'Tenant B has correct commercial name');
    assert(tenantA.id !== tenantB.id, 'Tenant A and Tenant B have distinct UUID primary keys');

    // -------------------------------------------------------------
    // TEST GROUP 2: Tenant Resolution by phone_number_id
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Tenant Resolution by Meta phone_number_id ---');
    {
      const resolvedA = await resolveTenantByPhoneNumberId('111111111111111');
      assert(resolvedA && resolvedA.id === tenantA.id, 'Resolves Tenant A from phone_number_id 111111111111111');

      const resolvedB = await resolveTenantByPhoneNumberId('222222222222222');
      assert(resolvedB && resolvedB.id === tenantB.id, 'Resolves Tenant B from phone_number_id 222222222222222');

      const resolvedUnknown = await resolveTenantByPhoneNumberId('999999999999999');
      assert(resolvedUnknown === null, 'Unknown phone_number_id safely returns null');

      const resolvedEmpty = await resolveTenantByPhoneNumberId('');
      assert(resolvedEmpty === null, 'Empty phone_number_id safely returns null');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: Multi-Tenant Data Isolation (Orders, Sessions, Addresses)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Multi-Tenant Isolation & Zero Cross-Tenant Leakage ---');
    // Clean up any test records from prior runs
    await prisma.orderNotification.deleteMany({
      where: { restaurant_id: { in: [tenantA.id, tenantB.id] } }
    });
    await prisma.order.deleteMany({
      where: { restaurant_id: { in: [tenantA.id, tenantB.id] } }
    });
    await prisma.savedAddress.deleteMany({
      where: { restaurant_id: { in: [tenantA.id, tenantB.id] } }
    });
    await prisma.conversationSession.deleteMany({
      where: { restaurant_id: { in: [tenantA.id, tenantB.id] } }
    });

    // 3.1 Create Order for Tenant A
    const orderA = await prisma.order.create({
      data: {
        restaurant_id: tenantA.id,
        order_reference: 'RP-TEST-A101',
        customer_name: 'Customer Omar',
        customer_phone: '919876543210',
        order_type: 'DELIVERY',
        items: [{ product_retailer_id: 'SKU_1', name: 'Biryani', quantity: 2, unit_price: 240, line_total: 480, currency: 'INR' }],
        total_amount: 480.00,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });

    // 3.2 Create Order for Tenant B
    const orderB = await prisma.order.create({
      data: {
        restaurant_id: tenantB.id,
        order_reference: 'RP-TEST-B201',
        customer_name: 'Customer Alice',
        customer_phone: '919876543210', // Same customer phone ordering from different restaurant!
        order_type: 'TAKEAWAY',
        items: [{ product_retailer_id: 'SKU_9', name: 'Coffee', quantity: 1, unit_price: 120, line_total: 120, currency: 'INR' }],
        total_amount: 120.00,
        currency: 'INR',
        status: 'PENDING_RESTAURANT_CONFIRMATION'
      }
    });

    // 3.3 Verify Tenant Scoping on Orders
    const queryAforA = await findTenantOrder(tenantA.id, orderA.id);
    assert(queryAforA !== null && queryAforA.order_reference === 'RP-TEST-A101', 'Tenant A can read its own order A');

    const queryAforB = await findTenantOrder(tenantA.id, orderB.id);
    assert(queryAforB === null, 'Tenant A CANNOT read Tenant B order (Cross-tenant read blocked)');

    const queryBforA = await findTenantOrder(tenantB.id, orderA.id);
    assert(queryBforA === null, 'Tenant B CANNOT read Tenant A order (Cross-tenant read blocked)');

    // 3.4 Verify Session Isolation for Same Customer Across Tenants
    await prisma.conversationSession.create({
      data: {
        restaurant_id: tenantA.id,
        customer_phone: '919876543210',
        current_step: 'AWAITING_CART',
        state: { cart: 'biryani' },
        expires_at: new Date(Date.now() + 7200000)
      }
    });

    await prisma.conversationSession.create({
      data: {
        restaurant_id: tenantB.id,
        customer_phone: '919876543210', // Same phone number!
        current_step: 'AWAITING_ADDRESS_INPUT',
        state: { cart: 'coffee' },
        expires_at: new Date(Date.now() + 7200000)
      }
    });

    const sessionA = await findTenantSession(tenantA.id, '919876543210');
    assert(sessionA.current_step === 'AWAITING_CART', 'Tenant A session is isolated');

    const sessionB = await findTenantSession(tenantB.id, '919876543210');
    assert(sessionB.current_step === 'AWAITING_ADDRESS_INPUT', 'Tenant B session is isolated for same customer phone');

    // 3.5 Verify Saved Address Isolation
    await prisma.savedAddress.create({
      data: {
        restaurant_id: tenantA.id,
        customer_phone: '919876543210',
        label: 'Home',
        address: 'Flat 302, Andheri West, Mumbai'
      }
    });

    const addressesAtA = await findTenantAddresses(tenantA.id, '919876543210');
    assert(addressesAtA.length === 1, 'Customer has 1 saved address at Tenant A');

    const addressesAtB = await findTenantAddresses(tenantB.id, '919876543210');
    assert(addressesAtB.length === 0, 'Customer has 0 saved addresses at Tenant B (Address books are strictly tenant-isolated)');

    // -------------------------------------------------------------
    // TEST GROUP 4: Database Constraints & Referential Integrity
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Database Constraints & Referential Integrity ---');
    {
      // Unique constraint on phone_number_id
      let duplicatePhoneThrew = false;
      try {
        await prisma.restaurant.create({
          data: {
            name: 'Duplicate Phone Tenant',
            phone_number_id: '111111111111111', // Duplicate of Tenant A!
            waba_id: 'WABA_DUP',
            owner_phone: '+919999999999',
            access_token_encrypted: 'token'
          }
        });
      } catch (err) {
        duplicatePhoneThrew = (err.code === 'P2002');
      }
      assert(duplicatePhoneThrew, 'Duplicate phone_number_id triggers unique constraint P2002');

      // Unique constraint on order_reference
      let duplicateOrderRefThrew = false;
      try {
        await prisma.order.create({
          data: {
            restaurant_id: tenantA.id,
            order_reference: 'RP-TEST-A101', // Duplicate of orderA!
            customer_name: 'Dupe',
            customer_phone: '1234567890',
            order_type: 'DELIVERY',
            items: [],
            total_amount: 100,
            status: 'ACCEPTED'
          }
        });
      } catch (err) {
        duplicateOrderRefThrew = (err.code === 'P2002');
      }
      assert(duplicateOrderRefThrew, 'Duplicate order_reference triggers unique constraint P2002');

      // Foreign key constraint on non-existent restaurant
      let invalidFkThrew = false;
      try {
        await prisma.order.create({
          data: {
            restaurant_id: '00000000-0000-0000-0000-000000000000', // Non-existent restaurant UUID
            order_reference: 'RP-NON-EXISTENT',
            customer_name: 'Ghost',
            customer_phone: '1234567890',
            order_type: 'DELIVERY',
            items: [],
            total_amount: 100,
            status: 'ACCEPTED'
          }
        });
      } catch (err) {
        invalidFkThrew = (err.code === 'P2003');
      }
      assert(invalidFkThrew, 'Non-existent restaurant_id triggers foreign key violation P2003');

      // Restrict delete on restaurant with active orders
      let deleteRestrictThrew = false;
      try {
        await prisma.restaurant.delete({
          where: { id: tenantA.id }
        });
      } catch (err) {
        deleteRestrictThrew = (err.code === 'P2003' || /restrict/i.test(err.message) || /foreign key/i.test(err.message));
      }
      assert(deleteRestrictThrew, 'Deleting restaurant with existing orders is restricted (onDelete: Restrict)');

      // Missing tenantId in scopeQuery throws violation
      let missingTenantThrew = false;
      try {
        scopeQuery(null, { customer_phone: '123' });
      } catch (err) {
        missingTenantThrew = err.message.includes('[TENANT VIOLATION]');
      }
      assert(missingTenantThrew, 'scopeQuery strictly rejects queries with missing restaurant_id');
    }

    // -------------------------------------------------------------
    // TEST GROUP 5: Durable Webhook Ingestion & Idempotency
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Durable Webhook Ingestion & Idempotency ---');
    const testEventKey = `wamid.STAGE2_TEST_${Date.now()}`;
    const testWebhookEvent = {
      messageId: testEventKey,
      phoneNumberId: '111111111111111',
      senderPhone: '919876543210',
      messageType: 'text',
      category: 'INCOMING_MESSAGE',
      timestamp: String(Math.floor(Date.now() / 1000))
    };

    {
      // First ingestion: must persist to PostgreSQL
      const result1 = await recordIncomingEvent(testWebhookEvent);
      assert(result1.isDuplicate === false, 'First webhook ingestion is NOT marked duplicate');
      assert(result1.eventRecord !== null, 'First webhook persists eventRecord to database');

      const savedDbEvent = await prisma.webhookEvent.findUnique({
        where: { event_key: testEventKey }
      });
      assert(savedDbEvent !== null, 'Event is found in webhook_events table');
      assert(savedDbEvent.restaurant_id === tenantA.id, 'Event is associated with resolved Tenant A');
      assert(savedDbEvent.processing_status === 'RECEIVED', 'Event initial status is RECEIVED');
    }

    {
      // Second ingestion with identical event_key: must be flagged as duplicate without throwing
      const result2 = await recordIncomingEvent(testWebhookEvent);
      assert(result2.isDuplicate === true, 'Duplicate webhook event_key correctly detected as isDuplicate: true');

      // Verify no duplicate row was created in DB
      const allMatching = await prisma.webhookEvent.findMany({
        where: { event_key: testEventKey }
      });
      assert(allMatching.length === 1, 'Database contains exactly 1 row (Idempotency guaranteed via unique constraint)');
    }

    // -------------------------------------------------------------
    // TEST GROUP 6: End-to-End HTTP Webhook Controller Ingestion
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: End-to-End HTTP Webhook Ingestion ---');
    {
      const httpEventKey = `wamid.HTTP_TEST_${Date.now()}`;
      const httpPayload = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_TEST',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    phone_number_id: '111111111111111',
                    display_phone_number: '155501'
                  },
                  messages: [
                    {
                      from: '919876543210',
                      id: httpEventKey,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: 'Hello RESTOPRO' }
                    }
                  ]
                }
              }
            ]
          }
        ]
      });

      const signature = computeSignature(httpPayload, config.meta.appSecret);

      // Send HTTP POST to webhook receiver
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': signature
        },
        body: httpPayload
      });

      assert(res.statusCode === 200, 'HTTP Webhook returns 200 after durable DB persistence');

      // Verify row exists in PostgreSQL
      const persistedHttpEvent = await prisma.webhookEvent.findUnique({
        where: { event_key: httpEventKey }
      });
      assert(persistedHttpEvent !== null, 'HTTP webhook message was persisted to PostgreSQL');
      assert(persistedHttpEvent.processing_status === 'COMPLETED', 'HTTP webhook message transitioned to COMPLETED');

      // Send duplicate request over HTTP: must return 200 without creating a second record
      const resDuplicate = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': signature
        },
        body: httpPayload
      });

      assert(resDuplicate.statusCode === 200, 'Duplicate HTTP webhook returns 200 cleanly');
      const dupeCheck = await prisma.webhookEvent.findMany({
        where: { event_key: httpEventKey }
      });
      assert(dupeCheck.length === 1, 'Database maintains exactly 1 record after duplicate HTTP webhook');
    }

    // -------------------------------------------------------------
    // TEST GROUP 7: Concurrent Duplicate Webhook Storm
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Concurrent Duplicate Webhook Storm (5 Simultaneous Requests) ---');
    {
      const stormEventKey = `wamid.STORM_${Date.now()}`;
      const stormPayload = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_STORM',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: '111111111111111', display_phone_number: '155501' },
                  messages: [
                    {
                      from: '919876543210',
                      id: stormEventKey,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: 'Concurrent storm test' }
                    }
                  ]
                }
              }
            ]
          }
        ]
      });

      const signature = computeSignature(stormPayload, config.meta.appSecret);

      // Fire 5 identical requests simultaneously
      const promises = Array(5).fill(null).map(() =>
        makeRequest({
          method: 'POST',
          path: '/api/webhook',
          headers: {
            'Content-Type': 'application/json',
            'x-hub-signature-256': signature
          },
          body: stormPayload
        })
      );

      const responses = await Promise.all(promises);
      const allStatus200 = responses.every(r => r.statusCode === 200);
      assert(allStatus200, 'All 5 concurrent requests acknowledged with HTTP 200');

      const stormRows = await prisma.webhookEvent.findMany({
        where: { event_key: stormEventKey }
      });
      assert(stormRows.length === 1, 'Exactly 1 database row exists after concurrent storm (Race condition immune)');
    }

    // -------------------------------------------------------------
    // TEST GROUP 8: Multi-Message Batch with Mixed New & Duplicate Messages
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 8: Multi-Message Batch with Mixed New & Duplicate Messages ---');
    {
      const msgIdAlpha = `wamid.BATCH_ALPHA_${Date.now()}`;
      const msgIdBeta = `wamid.BATCH_BETA_${Date.now()}`;
      const msgIdGamma = `wamid.BATCH_GAMMA_${Date.now()}`;

      // Batch 1: Contains Alpha and Beta
      const batch1Payload = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_BATCH',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: '111111111111111' },
                  messages: [
                    { from: '919876543210', id: msgIdAlpha, timestamp: '1730000000', type: 'text', text: { body: 'Msg Alpha' } },
                    { from: '919876543210', id: msgIdBeta, timestamp: '1730000001', type: 'text', text: { body: 'Msg Beta' } }
                  ]
                }
              }
            ]
          }
        ]
      });

      const res1 = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': computeSignature(batch1Payload, config.meta.appSecret) },
        body: batch1Payload
      });
      assert(res1.statusCode === 200, 'Batch 1 with Alpha & Beta returns HTTP 200');

      // Batch 2: Contains Alpha (duplicate) and Gamma (new)
      const batch2Payload = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_BATCH',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: '111111111111111' },
                  messages: [
                    { from: '919876543210', id: msgIdAlpha, timestamp: '1730000000', type: 'text', text: { body: 'Msg Alpha' } },
                    { from: '919876543210', id: msgIdGamma, timestamp: '1730000002', type: 'text', text: { body: 'Msg Gamma' } }
                  ]
                }
              }
            ]
          }
        ]
      });

      const res2 = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': computeSignature(batch2Payload, config.meta.appSecret) },
        body: batch2Payload
      });
      assert(res2.statusCode === 200, 'Batch 2 with Alpha (dupe) & Gamma (new) returns HTTP 200');

      const alphaCheck = await prisma.webhookEvent.findMany({ where: { event_key: msgIdAlpha } });
      const betaCheck = await prisma.webhookEvent.findMany({ where: { event_key: msgIdBeta } });
      const gammaCheck = await prisma.webhookEvent.findMany({ where: { event_key: msgIdGamma } });

      assert(alphaCheck.length === 1, 'Alpha has exactly 1 row (duplicate safely dropped)');
      assert(betaCheck.length === 1, 'Beta has exactly 1 row');
      assert(gammaCheck.length === 1, 'Gamma has exactly 1 row (new message in batch processed successfully)');
    }

    // -------------------------------------------------------------
    // TEST GROUP 9: Status Update Delivery Progression (Sent -> Delivered -> Read)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 9: Status Progression for Same Message ID ---');
    {
      const trackedWamid = `wamid.TRACKED_${Date.now()}`;

      // Status 1: sent
      const resSent = await recordIncomingEvent({
        category: 'STATUS_RECEIPT',
        messageId: trackedWamid,
        status: 'sent',
        phoneNumberId: '111111111111111'
      });
      assert(resSent.isDuplicate === false, 'Status "sent" is persisted');

      // Status 2: delivered
      const resDelivered = await recordIncomingEvent({
        category: 'STATUS_RECEIPT',
        messageId: trackedWamid,
        status: 'delivered',
        phoneNumberId: '111111111111111'
      });
      assert(resDelivered.isDuplicate === false, 'Status "delivered" for same wamid is NOT flagged duplicate');

      // Status 3: read
      const resRead = await recordIncomingEvent({
        category: 'STATUS_RECEIPT',
        messageId: trackedWamid,
        status: 'read',
        phoneNumberId: '111111111111111'
      });
      assert(resRead.isDuplicate === false, 'Status "read" for same wamid is NOT flagged duplicate');

      // Repeat Status 3: read (identical duplicate)
      const resReadDupe = await recordIncomingEvent({
        category: 'STATUS_RECEIPT',
        messageId: trackedWamid,
        status: 'read',
        phoneNumberId: '111111111111111'
      });
      assert(resReadDupe.isDuplicate === true, 'Repeat of status "read" is correctly flagged as duplicate');

      // Status 4: failed with Meta error code and details
      const failWamid = `wamid.FAIL_${Date.now()}`;
      const resFailed = await recordIncomingEvent({
        category: 'STATUS_RECEIPT',
        messageId: failWamid,
        status: 'failed',
        recipientId: '919372015523',
        phoneNumberId: '111111111111111',
        errors: [{
          code: 131051,
          title: 'Message failed to send',
          message: 'Template dispatch rejected by Meta',
          error_data: {
            details: 'Template restopro_order_alert parameter count mismatch'
          }
        }]
      });
      assert(resFailed.isDuplicate === false, 'Status "failed" is persisted to database');

      // Verify exact fields persisted in PostgreSQL payload_summary
      const savedFailEvent = await prisma.webhookEvent.findUnique({
        where: { event_key: `status:${failWamid}:failed` }
      });
      assert(savedFailEvent !== null, 'Failed status record exists in PostgreSQL');
      assert(savedFailEvent.payload_summary.status === 'failed', 'Status "failed" stored in payload_summary');
      assert(savedFailEvent.payload_summary.recipientId === '919372015523', 'Recipient ID stored in payload_summary');
      assert(Array.isArray(savedFailEvent.payload_summary.errors), 'Errors array stored in payload_summary');
      assert(savedFailEvent.payload_summary.errors[0].code === 131051, 'Meta error code 131051 persisted');
      assert(savedFailEvent.payload_summary.errors[0].title === 'Message failed to send', 'Error title persisted');
      assert(savedFailEvent.payload_summary.errors[0].details.includes('parameter count mismatch'), 'error_data.details persisted in payload_summary');
    }

    // -------------------------------------------------------------
    // TEST GROUP 10: Unknown phone_number_id Safe Handling
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 10: Unknown phone_number_id Handling ---');
    {
      const unknownEventKey = `wamid.UNKNOWN_PHONE_${Date.now()}`;
      const resUnknown = await recordIncomingEvent({
        category: 'INCOMING_MESSAGE',
        messageId: unknownEventKey,
        phoneNumberId: '999999999999999', // Unknown tenant
        messageType: 'text',
        text: 'Unknown tenant ping'
      });
      assert(resUnknown.isDuplicate === false, 'Unknown phone_number_id event persists without error');

      const savedUnknown = await prisma.webhookEvent.findUnique({
        where: { event_key: unknownEventKey }
      });
      assert(savedUnknown !== null, 'Unknown phone_number_id row created in webhook_events');
      assert(savedUnknown.restaurant_id === null, 'restaurant_id safely set to null for unmapped tenant');
    }

    // -------------------------------------------------------------
    // TEST GROUP 11: Audit Trail Completeness in payload_summary
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 11: Audit Trail Completeness ---');
    {
      const auditEventKey = `wamid.AUDIT_DETAIL_${Date.now()}`;
      await recordIncomingEvent({
        category: 'INCOMING_MESSAGE',
        messageId: auditEventKey,
        phoneNumberId: '111111111111111',
        senderPhone: '919876543210',
        messageType: 'order',
        order: {
          catalogId: 'CAT_TEST',
          calculatedSubtotal: 350.00,
          currency: 'INR',
          items: [{ productRetailerId: 'SKU_X', quantity: 1, unitPrice: 350.00 }]
        }
      });

      const auditRow = await prisma.webhookEvent.findUnique({
        where: { event_key: auditEventKey }
      });
      assert(auditRow.payload_summary !== null, 'Audit row contains payload_summary');
      assert(auditRow.payload_summary.order.calculatedSubtotal === 350, 'payload_summary contains parsed subtotal');
      assert(auditRow.payload_summary.order.items[0].productRetailerId === 'SKU_X', 'payload_summary contains item SKU for debugging/retry');
    }

    // -------------------------------------------------------------
    // TEST GROUP 12: Composite Foreign Key Integrity (order_id, restaurant_id)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 12: Composite Foreign Key Integrity ---');
    {
      // 12.1 Matching order_id and restaurant_id: Insertion must succeed
      const validNotification = await prisma.orderNotification.create({
        data: {
          order_id: orderA.id,
          restaurant_id: tenantA.id, // Matching: orderA belongs to tenantA
          recipient_phone: tenantA.owner_phone,
          notification_type: 'ORDER_ALERT',
          template_name: 'order_alert_v1',
          delivery_status: 'PENDING'
        }
      });
      assert(validNotification.id !== null, 'Matching (order_id, restaurant_id) notification insertion succeeds');
      assert(validNotification.restaurant_id === tenantA.id, 'Persisted notification has correct restaurant_id');

      // 12.2 Mismatched restaurant_id: PostgreSQL must reject with Foreign Key Violation
      let mismatchedFkThrew = false;
      let fkErrorCode = null;
      try {
        await prisma.orderNotification.create({
          data: {
            order_id: orderA.id,        // Belongs to Tenant A!
            restaurant_id: tenantB.id,   // Mismatched: Assigned to Tenant B!
            recipient_phone: tenantB.owner_phone,
            notification_type: 'ORDER_ALERT',
            template_name: 'order_alert_v1',
            delivery_status: 'PENDING'
          }
        });
      } catch (err) {
        mismatchedFkThrew = true;
        fkErrorCode = err.code;
      }
      assert(mismatchedFkThrew, 'Mismatched restaurant_id is rejected by PostgreSQL foreign key constraint');
      assert(fkErrorCode === 'P2003', 'Mismatched insert triggers Prisma foreign key error code P2003');

      // 12.3 Existing records remain valid and queryable
      const fetchedNotification = await prisma.orderNotification.findUnique({
        where: { id: validNotification.id },
        include: { order: true, restaurant: true }
      });
      assert(fetchedNotification !== null, 'Existing notification remains valid and queryable');
      assert(fetchedNotification.order.id === orderA.id, 'Notification correctly joins with parent order');
      assert(fetchedNotification.restaurant.id === tenantA.id, 'Notification correctly joins with parent restaurant');
    }

  } finally {
    // -------------------------------------------------------------
    // TEST GROUP 13: Graceful Server & Database Lifecycle Shutdown
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 13: Graceful Shutdown Lifecycle ---');
    let serverClosedCleanly = false;
    let prismaDisconnectedCleanly = false;

    try {
      await new Promise((resolve) => server.close((err) => {
        if (!err) serverClosedCleanly = true;
        resolve();
      }));
      assert(serverClosedCleanly, 'HTTP server closes and stops accepting connections cleanly');
    } catch (e) {
      assert(false, 'HTTP server close threw an error: ' + e.message);
    }

    try {
      await prisma.$disconnect();
      prismaDisconnectedCleanly = true;
      assert(prismaDisconnectedCleanly, 'Prisma database client disconnects cleanly without hanging');
    } catch (e) {
      assert(false, 'Prisma disconnect threw an error: ' + e.message);
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 2 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStage2Tests().catch((err) => {
  console.error('Fatal Stage 2 test error:', err);
  process.exit(1);
});
