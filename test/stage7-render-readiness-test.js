/**
 * RESTOPRO — Stage 7: Render Production Readiness Audit Test Suite
 *
 * Verifies:
 * 1. Background Worker Lifecycle & Outbox Batch Dispatch (NotificationWorker)
 * 2. Multi-Worker Concurrency Defense & Lease Fencing (FOR UPDATE SKIP LOCKED)
 * 3. Automated Session Cleanup Job (ST7-02)
 * 4. 30-Minute Order Timeout Auto-Expiry & Customer Notification Job (ST7-03)
 * 5. Web Service Reverse Proxy & Edge Router Compatibility (Render proxy trust)
 * 6. Health Check Endpoint Compliance (/health)
 * 7. Render Blueprint & Configuration Validation (render.yaml, backup-db.sh)
 * 8. State Recovery Across Worker/Server Restarts (ST7-04)
 * 9. Database Outage & Transaction Rollback Resilience (ST7-05)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const app = require('../src/app');

const { NotificationWorker } = require('../src/jobs/notification-worker');
const { cleanupExpiredSessions } = require('../src/jobs/session-cleanup');
const { expireUnacknowledgedOrders } = require('../src/jobs/order-timeout');
const { claimPendingOutboxMessages, updateOutboxResult } = require('../src/services/outbox.service');

const TEST_PORT = 4998;
const TEST_TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_PHONE_ID = '111111111111111';
const TEST_OWNER_PHONE = '+919876543210';
const TEST_CUSTOMER_PHONE = '+919876500077';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${message}`);
  } else {
    failedTests++;
    console.error(`  ❌ [FAIL] ${message}`);
  }
}

function sendHttpRequest({
  path = '/',
  method = 'GET',
  headers = {},
  body = null
}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const reqHeaders = {
      ...(bodyBuffer ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuffer.length } : {}),
      ...headers
    };

    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          rawBody: data
        });
      });
    });

    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function cleanupTestData() {
  try {
    // Delete test notifications
    await prisma.orderNotification.deleteMany({
      where: {
        recipient_phone: { in: [TEST_CUSTOMER_PHONE, TEST_OWNER_PHONE] }
      }
    });

    // Delete test outbox messages
    await prisma.outboxMessage.deleteMany({
      where: {
        recipient_phone: { in: [TEST_CUSTOMER_PHONE, TEST_OWNER_PHONE] }
      }
    });

    // Delete test orders
    await prisma.order.deleteMany({
      where: {
        customer_phone: TEST_CUSTOMER_PHONE
      }
    });

    // Delete test conversation sessions
    await prisma.conversationSession.deleteMany({
      where: {
        customer_phone: TEST_CUSTOMER_PHONE
      }
    });

    // Delete test webhook events
    await prisma.webhookEvent.deleteMany({
      where: {
        event_key: { startsWith: 'evt_stage7_' }
      }
    });
  } catch (err) {
    console.warn('[CLEANUP] Warning during cleanup:', err.message);
  }
}

async function runStage7Tests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 7: RENDER PRODUCTION READINESS AUDIT    ');
  console.log('============================================================\n');

  let serverInstance = null;

  try {
    // Ensure clean slate
    await cleanupTestData();

    // Start Express test server on TEST_PORT
    await new Promise((resolve, reject) => {
      serverInstance = app.listen(TEST_PORT, '127.0.0.1', () => {
        console.log(`[TEST SERVER] Listening on http://127.0.0.1:${TEST_PORT}`);
        resolve();
      });
      serverInstance.on('error', reject);
    });

    // =========================================================================
    // TEST GROUP 1: Background Worker Lifecycle & Batch Dispatch
    // =========================================================================
    console.log('\n--- TEST GROUP 1: Render Background Worker Lifecycle ---');

    const worker = new NotificationWorker({
      pollIntervalMs: 200,
      batchSize: 5,
      workerId: 'render_test_worker_1'
    });

    assert(worker.workerId === 'render_test_worker_1', 'Worker: Correctly initialized with custom workerId');
    assert(worker.pollIntervalMs === 200, 'Worker: Configured with custom poll interval');
    assert(worker.batchSize === 5, 'Worker: Configured with custom batch size');
    assert(worker.isRunning === false, 'Worker: Not running initially');

    // Create a pending outbox message
    const msgId = crypto.randomUUID();
    await prisma.outboxMessage.create({
      data: {
        id: msgId,
        restaurant_id: TEST_TENANT_ID,
        recipient_phone: TEST_CUSTOMER_PHONE,
        message_type: 'CUSTOMER_TEST_DISPATCH',
        payload: { text: 'Test Render dispatch' },
        idempotency_key: `test_dispatch_${msgId}`,
        status: 'PENDING'
      }
    });

    // Execute single cycle with mock custom sender
    let mockSenderCalled = false;
    const mockSender = async (msg) => {
      mockSenderCalled = true;
      return { success: true, messageId: 'meta_wamid_test_stage7', isTimeout: false, isRetryable: false };
    };

    const cycleResult = await worker.processCycle(mockSender);
    assert(cycleResult.processedCount >= 1, 'Worker: Successfully claimed and processed outbox message');
    assert(mockSenderCalled === true, 'Worker: Custom sender function was invoked');

    const updatedMsg = await prisma.outboxMessage.findUnique({ where: { id: msgId } });
    assert(updatedMsg.status === 'ACCEPTED', 'Worker: Dispatched message transitioned to ACCEPTED status');
    assert(updatedMsg.attempts === 1, 'Worker: Incremented attempt counter to 1');

    // Test start/stop lifecycle
    worker.start(mockSender);
    assert(worker.isRunning === true, 'Worker: isRunning is true after worker.start()');
    await new Promise(r => setTimeout(r, 300));
    await worker.stop();
    assert(worker.isRunning === false, 'Worker: isRunning is false after worker.stop()');

    // =========================================================================
    // TEST GROUP 2: Distributed Fencing & Multi-Worker Concurrency Defense
    // =========================================================================
    console.log('\n--- TEST GROUP 2: Distributed Fencing & Concurrency Defense ---');

    const concurrentBatchCount = 6;
    const batchMessageIds = [];

    for (let i = 0; i < concurrentBatchCount; i++) {
      const bMsgId = crypto.randomUUID();
      batchMessageIds.push(bMsgId);
      await prisma.outboxMessage.create({
        data: {
          id: bMsgId,
          restaurant_id: TEST_TENANT_ID,
          recipient_phone: TEST_CUSTOMER_PHONE,
          message_type: 'CONCURRENT_TEST',
          payload: { itemIndex: i },
          idempotency_key: `concurrent_test_${bMsgId}`,
          status: 'PENDING'
        }
      });
    }

    const workerAlpha = new NotificationWorker({ batchSize: 10, workerId: 'render_worker_alpha' });
    const workerBeta = new NotificationWorker({ batchSize: 10, workerId: 'render_worker_beta' });

    const processedByAlpha = [];
    const processedByBeta = [];

    const senderAlpha = async (msg) => {
      processedByAlpha.push(msg.id);
      await new Promise(r => setTimeout(r, 20)); // Simulated network latency
      return { success: true, messageId: `alpha_${msg.id}` };
    };

    const senderBeta = async (msg) => {
      processedByBeta.push(msg.id);
      await new Promise(r => setTimeout(r, 20)); // Simulated network latency
      return { success: true, messageId: `beta_${msg.id}` };
    };

    // Run both workers simultaneously
    await Promise.all([
      workerAlpha.processCycle(senderAlpha),
      workerBeta.processCycle(senderBeta)
    ]);

    const allProcessed = [...processedByAlpha, ...processedByBeta];
    const uniqueProcessed = new Set(allProcessed);

    assert(allProcessed.length === uniqueProcessed.size, 'Concurrency: Zero duplicate dispatches across concurrent Render workers');
    assert(
      batchMessageIds.every(id => uniqueProcessed.has(id)),
      'Concurrency: All batch messages successfully claimed and processed'
    );

    // Stale Worker Fencing test: Worker with invalid leaseToken cannot write
    const fenceTestId = crypto.randomUUID();
    await prisma.outboxMessage.create({
      data: {
        id: fenceTestId,
        restaurant_id: TEST_TENANT_ID,
        recipient_phone: TEST_CUSTOMER_PHONE,
        message_type: 'FENCE_TEST',
        payload: { test: 'fence' },
        idempotency_key: `fence_test_${fenceTestId}`,
        status: 'PENDING'
      }
    });

    // Claim legally with worker Gamma
    const claimedList = await prisma.$transaction(tx =>
      claimPendingOutboxMessages(tx, { limit: 1, workerId: 'worker_gamma' })
    );
    const claimedItem = claimedList.find(m => m.id === fenceTestId);
    assert(claimedItem !== undefined, 'Fencing: Message claimed with active lease');

    // Attempt update with forged/stale leaseToken
    const forgedToken = crypto.randomUUID();
    const forgedResult = await updateOutboxResult({
      id: claimedItem.id,
      leaseToken: forgedToken,
      dispatchResult: { success: true, messageId: 'forged_send' },
      attempts: claimedItem.attempts
    });

    assert(forgedResult.updated === false && forgedResult.reason === 'FENCED_OUT', 'Fencing: Stale worker update safely rejected due to mismatched lease token');

    // Confirm row status is still PENDING with original active lease
    const checkMsg = await prisma.outboxMessage.findUnique({ where: { id: fenceTestId } });
    assert(checkMsg.status === 'PENDING' && checkMsg.payload?.lease?.lease_token === claimedItem.leaseToken, 'Fencing: Row remains locked under original lease in database');

    // Release cleanly with valid token
    await updateOutboxResult({
      id: claimedItem.id,
      leaseToken: claimedItem.leaseToken,
      dispatchResult: { success: true, messageId: 'valid_gamma_send' },
      attempts: claimedItem.attempts
    });

    // =========================================================================
    // TEST GROUP 3: Automated Session Cleanup Job (ST7-02)
    // =========================================================================
    console.log('\n--- TEST GROUP 3: Automated Session Cleanup Job (ST7-02) ---');

    const activeSessionPhone = '+919876500078';
    const expiredSessionPhone = '+919876500079';

    // Active session: expires in 1 hour
    await prisma.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TEST_TENANT_ID,
          customer_phone: activeSessionPhone
        }
      },
      update: {
        current_step: 'AWAITING_ADDRESS',
        expires_at: new Date(Date.now() + 60 * 60 * 1000)
      },
      create: {
        restaurant_id: TEST_TENANT_ID,
        customer_phone: activeSessionPhone,
        current_step: 'AWAITING_ADDRESS',
        expires_at: new Date(Date.now() + 60 * 60 * 1000)
      }
    });

    // Expired session: expired 10 minutes ago
    await prisma.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TEST_TENANT_ID,
          customer_phone: expiredSessionPhone
        }
      },
      update: {
        current_step: 'ORDER_REVIEW',
        expires_at: new Date(Date.now() - 10 * 60 * 1000)
      },
      create: {
        restaurant_id: TEST_TENANT_ID,
        customer_phone: expiredSessionPhone,
        current_step: 'ORDER_REVIEW',
        expires_at: new Date(Date.now() - 10 * 60 * 1000)
      }
    });

    const cleanupResult = await cleanupExpiredSessions();
    assert(cleanupResult.cleanedCount >= 1, 'Session Cleanup: Expired session purged successfully');

    const expiredAfter = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TEST_TENANT_ID,
          customer_phone: expiredSessionPhone
        }
      }
    });
    assert(expiredAfter === null, 'Session Cleanup: Expired session record no longer exists in DB');

    const activeAfter = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TEST_TENANT_ID,
          customer_phone: activeSessionPhone
        }
      }
    });
    assert(activeAfter !== null, 'Session Cleanup: Active non-expired session was preserved');

    // Clean up active session
    await prisma.conversationSession.delete({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TEST_TENANT_ID,
          customer_phone: activeSessionPhone
        }
      }
    });

    // =========================================================================
    // TEST GROUP 4: 30-Minute Order Timeout Auto-Expiry (ST7-03)
    // =========================================================================
    console.log('\n--- TEST GROUP 4: 30-Minute Order Timeout Auto-Expiry (ST7-03) ---');

    const pastDate35Min = new Date(Date.now() - 35 * 60 * 1000);
    const recentDate5Min = new Date(Date.now() - 5 * 60 * 1000);
    const pastDate40Min = new Date(Date.now() - 40 * 60 * 1000);

    // Order 1: Candidate for expiry (35 minutes old, PENDING_RESTAURANT_CONFIRMATION)
    const candidateOrder = await prisma.order.create({
      data: {
        restaurant_id: TEST_TENANT_ID,
        customer_phone: TEST_CUSTOMER_PHONE,
        order_reference: 'RP-EXP-001',
        status: 'PENDING_RESTAURANT_CONFIRMATION',
        order_type: 'DELIVERY',
        address_snapshot: '123 Expiry Street',
        items: [{ id: 'item_1', name: 'Pizza', quantity: 1, price: 10 }],
        total_amount: 10,
        currency: 'INR',
        confirmation_token: 'token_exp_001',
        created_at: pastDate35Min
      }
    });

    // Order 2: Recent order (5 minutes old, PENDING_RESTAURANT_CONFIRMATION) -> should NOT expire
    const recentOrder = await prisma.order.create({
      data: {
        restaurant_id: TEST_TENANT_ID,
        customer_phone: TEST_CUSTOMER_PHONE,
        order_reference: 'RP-ACT-002',
        status: 'PENDING_RESTAURANT_CONFIRMATION',
        order_type: 'DELIVERY',
        address_snapshot: '456 Active Street',
        items: [{ id: 'item_2', name: 'Pasta', quantity: 1, price: 12 }],
        total_amount: 12,
        currency: 'INR',
        confirmation_token: 'token_act_002',
        created_at: recentDate5Min
      }
    });

    // Order 3: Already accepted (40 minutes old) -> should NOT expire
    const acceptedOrder = await prisma.order.create({
      data: {
        restaurant_id: TEST_TENANT_ID,
        customer_phone: TEST_CUSTOMER_PHONE,
        order_reference: 'RP-ACC-003',
        status: 'ACCEPTED',
        order_type: 'TAKEAWAY',
        items: [{ id: 'item_3', name: 'Burger', quantity: 1, price: 8 }],
        total_amount: 8,
        currency: 'INR',
        confirmation_token: 'token_acc_003',
        created_at: pastDate40Min
      }
    });

    // Run timeout job
    const timeoutResult = await expireUnacknowledgedOrders({ timeoutMinutes: 30 });
    assert(timeoutResult.expiredCount >= 1, 'Order Timeout: Expired at least one unacknowledged order');

    const refreshedCandidate = await prisma.order.findUnique({ where: { id: candidateOrder.id } });
    assert(refreshedCandidate.status === 'EXPIRED', 'Order Timeout: 35-min pending order transitioned to EXPIRED');
    assert(refreshedCandidate.decision_at !== null, 'Order Timeout: decision_at timestamp populated');

    const refreshedRecent = await prisma.order.findUnique({ where: { id: recentOrder.id } });
    assert(refreshedRecent.status === 'PENDING_RESTAURANT_CONFIRMATION', 'Order Timeout: 5-min order remains PENDING');

    const refreshedAccepted = await prisma.order.findUnique({ where: { id: acceptedOrder.id } });
    assert(refreshedAccepted.status === 'ACCEPTED', 'Order Timeout: Previously ACCEPTED order untouched');

    // Verify customer notification outbox row created atomically
    const customerExpiredOutbox = await prisma.outboxMessage.findFirst({
      where: {
        restaurant_id: TEST_TENANT_ID,
        idempotency_key: `order_expired_${candidateOrder.id}`
      }
    });
    assert(customerExpiredOutbox !== null, 'Order Timeout: Customer notification outbox record created');
    assert(customerExpiredOutbox.message_type === 'CUSTOMER_ORDER_EXPIRED', 'Order Timeout: Outbox message type is CUSTOMER_ORDER_EXPIRED');
    assert(customerExpiredOutbox.status === 'PENDING', 'Order Timeout: Outbox message status is PENDING');

    // Verify order notification tracking record
    const notificationAudit = await prisma.orderNotification.findFirst({
      where: {
        order_id: candidateOrder.id,
        notification_type: 'CUSTOMER_ORDER_EXPIRED'
      }
    });
    assert(notificationAudit !== null, 'Order Timeout: OrderNotification tracking entry created');
    assert(notificationAudit.delivery_status === 'PENDING', 'Order Timeout: Notification tracking delivery_status is PENDING');

    // Idempotency check: Re-run should expire 0
    const rerunResult = await expireUnacknowledgedOrders({ timeoutMinutes: 30 });
    const rerunCandidate = rerunResult.expiredOrders.find(o => o.id === candidateOrder.id);
    assert(rerunCandidate === undefined, 'Order Timeout: Idempotent re-run does not re-expire candidate order');

    // =========================================================================
    // TEST GROUP 5: Web Service Reverse Proxy & Edge Router Compatibility
    // =========================================================================
    console.log('\n--- TEST GROUP 5: Reverse Proxy & Edge Router Compatibility ---');

    // Verify app trust proxy setting
    const trustProxySetting = app.get('trust proxy');
    assert(
      trustProxySetting === 1 || trustProxySetting === true,
      `Proxy Trust: Express app trust proxy is properly configured (${trustProxySetting})`
    );

    // Simulated Render Edge Router request with HTTPS forwarding headers
    const proxyHeaders = {
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-For': '198.51.100.42, 10.0.0.1',
      'X-Forwarded-Host': 'api.restopro.app'
    };

    const healthCheckRes = await sendHttpRequest({
      path: '/health',
      method: 'GET',
      headers: proxyHeaders
    });

    assert(healthCheckRes.statusCode === 200, 'Render Router: GET /health returns HTTP 200 behind reverse proxy');
    assert(healthCheckRes.body.status === 'ok', 'Render Router: Health endpoint reports status "ok"');
    assert(healthCheckRes.body.service === 'RESTOPRO-WhatsApp-Backend', 'Render Router: Health reports correct service name');

    // Security headers test
    assert(healthCheckRes.headers['x-content-type-options'] === 'nosniff', 'Security Header: X-Content-Type-Options is nosniff');
    assert(healthCheckRes.headers['x-frame-options'] === 'DENY', 'Security Header: X-Frame-Options is DENY');
    assert(healthCheckRes.headers['x-powered-by'] === undefined, 'Security Header: X-Powered-By is suppressed');

    // Database Readiness check test
    const readinessRes = await sendHttpRequest({
      path: '/health/ready',
      method: 'GET',
      headers: proxyHeaders
    });

    assert(readinessRes.statusCode === 200, 'Render Router: GET /health/ready returns HTTP 200 on connected DB');
    assert(readinessRes.body.status === 'ready', 'Render Router: Readiness status reports "ready"');
    assert(readinessRes.body.database === 'connected', 'Render Router: Readiness database reports "connected"');

    // Test webhook signature verification through proxy headers
    const webhookPayload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '1234567890', phone_number_id: TEST_PHONE_ID },
            messages: [{
              from: TEST_CUSTOMER_PHONE.replace('+', ''),
              id: 'evt_stage7_proxy_test',
              timestamp: `${Math.floor(Date.now() / 1000)}`,
              text: { body: 'Hello behind Render proxy' },
              type: 'text'
            }]
          },
          field: 'messages'
        }]
      }]
    };

    const rawBodyBuffer = Buffer.from(JSON.stringify(webhookPayload), 'utf8');
    const validHmac = crypto.createHmac('sha256', config.meta.appSecret).update(rawBodyBuffer).digest('hex');

    const webhookRes = await sendHttpRequest({
      path: '/api/webhook',
      method: 'POST',
      headers: {
        ...proxyHeaders,
        'X-Hub-Signature-256': `sha256=${validHmac}`
      },
      body: JSON.stringify(webhookPayload)
    });

    assert(webhookRes.statusCode === 200, 'Render Proxy Webhook: Successfully processed signed webhook behind proxy');

    // =========================================================================
    // TEST GROUP 6: Render Blueprint & Configuration Validation
    // =========================================================================
    console.log('\n--- TEST GROUP 6: Render Blueprint & Script Validation ---');

    const blueprintPath = path.resolve(__dirname, '../deployment/render.yaml');
    const blueprintExists = fs.existsSync(blueprintPath);
    assert(blueprintExists === true, 'Blueprint: deployment/render.yaml exists');

    if (blueprintExists) {
      const blueprintContent = fs.readFileSync(blueprintPath, 'utf8');
      assert(blueprintContent.includes('name: restopro-api'), 'Blueprint: Defines restopro-api web service');
      assert(blueprintContent.includes('type: web'), 'Blueprint: Service type is web');
      assert(blueprintContent.includes('preDeployCommand: npx prisma migrate deploy'), 'Blueprint: Configures automated migration preDeployCommand');
      assert(blueprintContent.includes('healthCheckPath: /health'), 'Blueprint: Configures /health check path');
      assert(blueprintContent.includes('name: restopro-worker'), 'Blueprint: Defines restopro-worker background worker');
      assert(blueprintContent.includes('type: worker'), 'Blueprint: Worker type is worker');
      assert(blueprintContent.includes('startCommand: node src/jobs/notification-worker.js'), 'Blueprint: Worker runs notification-worker.js');
      assert(blueprintContent.includes('name: restopro-postgres'), 'Blueprint: Defines restopro-postgres database');
      assert(blueprintContent.includes('plan: starter'), 'Blueprint: Database uses Starter plan (prevents 30-day deletion)');
    }

    const backupScriptPath = path.resolve(__dirname, '../scripts/backup-db.sh');
    const backupScriptExists = fs.existsSync(backupScriptPath);
    assert(backupScriptExists === true, 'Backup Script: scripts/backup-db.sh exists');

    if (backupScriptExists) {
      const backupScriptContent = fs.readFileSync(backupScriptPath, 'utf8');
      assert(backupScriptContent.includes('pg_dump'), 'Backup Script: Uses pg_dump utility');
      assert(backupScriptContent.includes('--format=c'), 'Backup Script: Uses custom archive format (-Fc)');
      assert(backupScriptContent.includes('RETENTION_DAYS'), 'Backup Script: Configures backup retention pruning');
    }

    // =========================================================================
    // TEST GROUP 7: State Recovery & Transactional Resilience (ST7-04 & ST7-05)
    // =========================================================================
    console.log('\n--- TEST GROUP 7: State Recovery & Fault Resilience ---');

    // Test ST7-04: Session state preserved across server restart
    const resilientCustomerPhone = '+919876500099';
    await prisma.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TEST_TENANT_ID,
          customer_phone: resilientCustomerPhone
        }
      },
      update: {
        current_step: 'FULFILMENT_SELECTED',
        state: {
          cart: { total: 45, items: [{ name: 'Pizza', qty: 2 }] },
          fulfilment: 'DELIVERY',
          address: '42 Wallaby Way, Sydney'
        },
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000)
      },
      create: {
        restaurant_id: TEST_TENANT_ID,
        customer_phone: resilientCustomerPhone,
        current_step: 'FULFILMENT_SELECTED',
        state: {
          cart: { total: 45, items: [{ name: 'Pizza', qty: 2 }] },
          fulfilment: 'DELIVERY',
          address: '42 Wallaby Way, Sydney'
        },
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000)
      }
    });

    // Simulate server reboot by closing and recreating listening server
    await new Promise(resolve => serverInstance.close(resolve));
    serverInstance = await new Promise((resolve, reject) => {
      const s = app.listen(TEST_PORT, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });

    // Verify session survives reboot intact
    const sessionAfterReboot = await prisma.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TEST_TENANT_ID,
          customer_phone: resilientCustomerPhone
        }
      }
    });
    assert(sessionAfterReboot !== null, 'State Recovery: Customer conversation session persists across server restart');
    assert(sessionAfterReboot.current_step === 'FULFILMENT_SELECTED', 'State Recovery: Session step intact after restart');
    assert(sessionAfterReboot.state.fulfilment === 'DELIVERY', 'State Recovery: Session metadata fully preserved');

    // Clean up resilient session
    await prisma.conversationSession.delete({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: TEST_TENANT_ID,
          customer_phone: resilientCustomerPhone
        }
      }
    });

    // Test ST7-05: Database rollback guarantee
    let rollbackSuccess = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.outboxMessage.create({
          data: {
            restaurant_id: TEST_TENANT_ID,
            recipient_phone: TEST_CUSTOMER_PHONE,
            message_type: 'TEST_ROLLBACK',
            payload: { willFail: true },
            idempotency_key: 'test_rollback_key',
            status: 'PENDING'
          }
        });
        // Deliberately throw an error to trigger transaction rollback
        throw new Error('Simulated Database Outage during transaction');
      });
    } catch (e) {
      if (e.message.includes('Simulated Database Outage')) {
        rollbackSuccess = true;
      }
    }

    assert(rollbackSuccess === true, 'Fault Resilience: Transaction error cleanly intercepted');

    const rollbackCheck = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: 'test_rollback_key' }
    });
    assert(rollbackCheck === null, 'Fault Resilience: Transaction rollback cleanly discarded partial record');

  } catch (err) {
    console.error('Fatal error during Stage 7 test suite execution:', err);
    failedTests++;
  } finally {
    console.log('\n--- Cleaning up Stage 7 test artifacts ---');
    await cleanupTestData();

    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
    }
  }

  console.log('\n============================================================');
  console.log(`   STAGE 7 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runStage7Tests();
