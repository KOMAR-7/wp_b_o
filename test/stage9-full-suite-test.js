/**
 * RESTOPRO — Stage 9 Complete Super Admin Integration & Security Test Suite
 * Covers Stages 9.2 through 9.7:
 * - Restaurant Management CRUD, Uniqueness, Token Encryption, Status Invariants
 * - Subscription Management, Overlap Prevention, Balance Calculations
 * - Manual Payment Recording, Partial Payments, Idempotent Reversals
 * - Dashboard Aggregation, Recent Activity, System Diagnostics
 * - Frontend Static Asset & Single Page Serving
 * - Security Guards & Audit Trail Verification
 */

const http = require('http');
const prisma = require('../src/config/database');
const app = require('../src/app');
const { hashPassword } = require('../src/utils/password');
const { decryptToken } = require('../src/utils/crypto');
const { resolveTenantByPhoneNumberId } = require('../src/services/tenant.service');

const TEST_PORT = 4994;
let serverInstance;

function httpRequest({ method = 'GET', path = '/', headers = {}, body = null }) {
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

async function runStage9FullSuiteTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 9: COMPLETE SUPER ADMIN TEST SUITE     ');
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

  // Start HTTP test server
  await new Promise((resolve) => {
    serverInstance = app.listen(TEST_PORT, '127.0.0.1', resolve);
  });
  console.log(`[TEST SERVER] Listening on http://127.0.0.1:${TEST_PORT}\n`);

  // Track created entities for reliable cleanup
  const createdAdminIds = [];
  const createdRestaurantIds = [];
  const createdSubscriptionIds = [];
  const createdPaymentIds = [];
  const createdAuditLogIds = [];

  try {
    // -------------------------------------------------------------
    // PREPARATION: Provision Test Super Admin
    // -------------------------------------------------------------
    const adminEmail = `full_admin_${Date.now()}@restopro.internal`;
    const adminPassword = 'AdminSecret987!';
    const passwordHash = await hashPassword(adminPassword);

    const testAdmin = await prisma.adminUser.create({
      data: {
        name: 'Master Super Admin',
        email: adminEmail,
        password_hash: passwordHash,
        role: 'SUPER_ADMIN',
        is_active: true
      }
    });
    createdAdminIds.push(testAdmin.id);

    // Authenticate and obtain session token
    const loginRes = await httpRequest({
      method: 'POST',
      path: '/api/admin/auth/login',
      body: { email: adminEmail, password: adminPassword }
    });

    assert(loginRes.statusCode === 200, 'Admin login succeeded');
    const authToken = loginRes.body.token;
    const authHeaders = {
      Authorization: `Bearer ${authToken}`,
      'X-Requested-With': 'XMLHttpRequest'
    };

    // -------------------------------------------------------------
    // TEST GROUP 1: Authentication Guard on All Endpoints
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: Authentication Guard on All Endpoints ---');
    const protectedRoutes = [
      { method: 'GET', path: '/api/admin/restaurants' },
      { method: 'POST', path: '/api/admin/restaurants' },
      { method: 'GET', path: '/api/admin/subscriptions' },
      { method: 'POST', path: '/api/admin/subscriptions' },
      { method: 'GET', path: '/api/admin/payments' },
      { method: 'POST', path: '/api/admin/payments' },
      { method: 'GET', path: '/api/admin/dashboard/stats' },
      { method: 'GET', path: '/api/admin/dashboard/activity' },
      { method: 'GET', path: '/api/admin/system/database' },
      { method: 'GET', path: '/api/admin/audit-logs' }
    ];

    for (const route of protectedRoutes) {
      const res = await httpRequest({ method: route.method, path: route.path });
      assert(res.statusCode === 401, `Unauthenticated ${route.method} ${route.path} rejected with HTTP 401`);
    }

    // Invalid session token test
    const badTokenRes = await httpRequest({
      method: 'GET',
      path: '/api/admin/restaurants',
      headers: { Authorization: 'Bearer bad_token_12345' }
    });
    assert(badTokenRes.statusCode === 401, 'Invalid session token returns HTTP 401');

    // -------------------------------------------------------------
    // TEST GROUP 2: Frontend Static Asset & SPA Serving
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Frontend Static Asset & SPA Serving ---');
    {
      const adminHtmlRes = await httpRequest({ method: 'GET', path: '/admin' });
      assert(adminHtmlRes.statusCode === 200, 'GET /admin returns HTTP 200');
      assert(typeof adminHtmlRes.body === 'string' && adminHtmlRes.body.includes('Super Admin Portal'), 'GET /admin serves portal HTML');

      const adminCssRes = await httpRequest({ method: 'GET', path: '/admin/styles.css' });
      assert(adminCssRes.statusCode === 200, 'GET /admin/styles.css returns HTTP 200 stylesheet');

      const adminJsRes = await httpRequest({ method: 'GET', path: '/admin/app.js' });
      assert(adminJsRes.statusCode === 200, 'GET /admin/app.js returns HTTP 200 client script');

      // Verify no public registration route
      const noRegRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/register',
        body: { email: 'fake@hacker.io', password: 'test' }
      });
      assert(noRegRes.statusCode === 404, 'Security Invariant: POST /api/admin/auth/register returns HTTP 404');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: Restaurant Management (Stage 9.2)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Restaurant Management (Stage 9.2) ---');

    const phoneIdA = `9200000000000001${Date.now()}`.substring(0, 20);
    const wabaIdA = `9200000000000002${Date.now()}`.substring(0, 20);
    let createdRestaurantId = null;

    // 3.1: Create Restaurant with access token
    {
      const rawAccessToken = 'EAABtestAccessTokenString123456';
      const createRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/restaurants',
        headers: authHeaders,
        body: {
          name: 'The Grand Curry House',
          owner_name: 'Vikram Seth',
          owner_phone: '+919876500001',
          email: 'vikram@grandcurry.in',
          contact_number: '+919811100001',
          address: '42 Commercial Street, Bengaluru',
          internal_notes: 'VIP customer onboarded manually',
          phone_number_id: phoneIdA,
          waba_id: wabaIdA,
          access_token: rawAccessToken,
          tenant_status: 'ACTIVE'
        }
      });

      assert(createRes.statusCode === 201, 'Create restaurant returns HTTP 201');
      assert(createRes.body.restaurant.name === 'The Grand Curry House', 'Persists restaurant name');
      assert(createRes.body.restaurant.is_active === true, 'ACTIVE status sets is_active = true');
      assert(createRes.body.restaurant.access_token_encrypted === undefined, 'Security: encrypted access token is never in response');
      assert(createRes.body.restaurant.access_token === undefined, 'Security: plaintext access token is never in response');

      createdRestaurantId = createRes.body.restaurant.id;
      createdRestaurantIds.push(createdRestaurantId);

      // Verify token in database is encrypted with AES-256-GCM
      const dbRow = await prisma.restaurant.findUnique({ where: { id: createdRestaurantId } });
      assert(dbRow.access_token_encrypted.startsWith('enc:v1:'), 'Access token is securely encrypted in PostgreSQL');
      const decrypted = decryptToken(dbRow.access_token_encrypted);
      assert(decrypted === rawAccessToken, 'Token correctly decrypts back to original value');
    }

    // 3.2: Duplicate phone_number_id rejected with 409
    {
      const dupeRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/restaurants',
        headers: authHeaders,
        body: {
          name: 'Duplicate Phone Restaurant',
          owner_phone: '+919876500002',
          phone_number_id: phoneIdA,
          waba_id: '920000000000000300'
        }
      });

      assert(dupeRes.statusCode === 409, 'Duplicate phone_number_id returns HTTP 409 Conflict');
      assert(dupeRes.body.error.includes('already exists'), 'Returns duplicate error message');
    }

    // 3.3: Invalid phone_number_id format rejected with 400
    {
      const invalidPhoneRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/restaurants',
        headers: authHeaders,
        body: {
          name: 'Invalid Phone Restaurant',
          owner_phone: '+919876500003',
          phone_number_id: 'abc_not_digits',
          waba_id: '920000000000000300'
        }
      });

      assert(invalidPhoneRes.statusCode === 400, 'Non-numeric phone_number_id rejected with HTTP 400');
    }

    // 3.4: List restaurants with pagination and search
    {
      const listRes = await httpRequest({
        method: 'GET',
        path: `/api/admin/restaurants?search=Curry&page=1&limit=5`,
        headers: authHeaders
      });

      assert(listRes.statusCode === 200, 'List restaurants returns HTTP 200');
      assert(Array.isArray(listRes.body.restaurants), 'Returns restaurants array');
      assert(listRes.body.restaurants.some((r) => r.id === createdRestaurantId), 'Search finds newly created restaurant');
      assert(listRes.body.pagination.page === 1, 'Pagination reports correct page');
    }

    // 3.5: Update restaurant profile
    {
      const updateRes = await httpRequest({
        method: 'PUT',
        path: `/api/admin/restaurants/${createdRestaurantId}`,
        headers: authHeaders,
        body: {
          name: 'The Grand Curry House (Flagship)',
          owner_name: 'Vikram Seth & Partners'
        }
      });

      assert(updateRes.statusCode === 200, 'Update restaurant returns HTTP 200');
      assert(updateRes.body.restaurant.name === 'The Grand Curry House (Flagship)', 'Name updated');
      assert(updateRes.body.restaurant.owner_name === 'Vikram Seth & Partners', 'Owner name updated');
    }

    // 3.6: Status transition and tenant resolution invariant
    {
      // A: Suspend restaurant
      const suspendRes = await httpRequest({
        method: 'PATCH',
        path: `/api/admin/restaurants/${createdRestaurantId}/status`,
        headers: authHeaders,
        body: { status: 'SUSPENDED' }
      });

      assert(suspendRes.statusCode === 200, 'Suspend restaurant returns HTTP 200');
      assert(suspendRes.body.restaurant.tenant_status === 'SUSPENDED', 'Tenant status is SUSPENDED');
      assert(suspendRes.body.restaurant.is_active === false, 'Tenant suspension synchronizes is_active = false');

      // Verify webhook tenant resolver drops suspended restaurant
      const resolvedSuspended = await resolveTenantByPhoneNumberId(phoneIdA);
      assert(resolvedSuspended === null, 'Tenant resolution rejects suspended restaurant (Zero webhook leakage)');

      // B: Reactivate restaurant
      const reactivateRes = await httpRequest({
        method: 'PATCH',
        path: `/api/admin/restaurants/${createdRestaurantId}/status`,
        headers: authHeaders,
        body: { status: 'ACTIVE' }
      });

      assert(reactivateRes.statusCode === 200, 'Reactivate restaurant returns HTTP 200');
      assert(reactivateRes.body.restaurant.tenant_status === 'ACTIVE', 'Tenant status is ACTIVE');
      assert(reactivateRes.body.restaurant.is_active === true, 'Tenant reactivation synchronizes is_active = true');

      // Verify webhook tenant resolver accepts active restaurant
      const resolvedActive = await resolveTenantByPhoneNumberId(phoneIdA);
      assert(resolvedActive !== null && resolvedActive.id === createdRestaurantId, 'Tenant resolution succeeds for active restaurant');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Subscription Management (Stage 9.3)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Subscription Management (Stage 9.3) ---');

    let activeSubId = null;

    // 4.1: Create yearly active subscription
    {
      const startDate = new Date();
      const endDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

      const subRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/subscriptions',
        headers: authHeaders,
        body: {
          restaurant_id: createdRestaurantId,
          plan_name: 'Yearly WhatsApp Automation Tier 1',
          amount: 24000.00,
          currency: 'INR',
          start_date: startDate.toISOString(),
          end_date: endDate.toISOString(),
          status: 'ACTIVE',
          notes: 'Standard annual contract'
        }
      });

      assert(subRes.statusCode === 201, 'Create subscription returns HTTP 201');
      assert(subRes.body.subscription.amount === 24000, 'Persists subscription amount');
      assert(subRes.body.subscription.remaining_days >= 364, 'Remaining days calculated accurately');
      assert(subRes.body.subscription.outstanding_balance === 24000, 'Initial outstanding balance equals full amount');

      activeSubId = subRes.body.subscription.id;
      createdSubscriptionIds.push(activeSubId);
    }

    // 4.2: Prevent overlapping active subscription
    {
      const overlapRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/subscriptions',
        headers: authHeaders,
        body: {
          restaurant_id: createdRestaurantId,
          plan_name: 'Conflicting Overlapping Active Plan',
          amount: 30000.00,
          start_date: new Date().toISOString(),
          end_date: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
          status: 'ACTIVE'
        }
      });

      assert(overlapRes.statusCode === 400, 'Overlapping active subscription is safely rejected with HTTP 400');
      assert(overlapRes.body.error.includes('already has an active subscription'), 'Explains overlap error message');
    }

    // 4.3: Invalid date range rejected (start >= end)
    {
      const invalidDateRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/subscriptions',
        headers: authHeaders,
        body: {
          restaurant_id: createdRestaurantId,
          plan_name: 'Invalid Date Plan',
          amount: 5000.00,
          start_date: '2026-12-31',
          end_date: '2026-01-01',
          status: 'PENDING'
        }
      });

      assert(invalidDateRes.statusCode === 400, 'Invalid date range (start >= end) rejected with HTTP 400');
    }

    // -------------------------------------------------------------
    // TEST GROUP 5: Manual Payment Management (Stage 9.4)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Manual Payment Management (Stage 9.4) ---');

    let payment1Id = null;
    let payment2Id = null;

    // 5.1: Record partial payment 1 (10,000 INR)
    {
      const pay1Res = await httpRequest({
        method: 'POST',
        path: '/api/admin/payments',
        headers: authHeaders,
        body: {
          restaurant_id: createdRestaurantId,
          subscription_id: activeSubId,
          amount: 10000.00,
          payment_mode: 'BANK_TRANSFER',
          transaction_reference: 'NEFT_RESTOPRO_1001',
          notes: 'First installment'
        }
      });

      assert(pay1Res.statusCode === 201, 'Record payment 1 returns HTTP 201');
      assert(pay1Res.body.payment.amount === 10000, 'Payment 1 amount is 10,000');
      assert(pay1Res.body.payment.status === 'RECORDED', 'Payment status is RECORDED');

      payment1Id = pay1Res.body.payment.id;
      createdPaymentIds.push(payment1Id);
    }

    // 5.2: Record partial payment 2 (14,000 INR)
    {
      const pay2Res = await httpRequest({
        method: 'POST',
        path: '/api/admin/payments',
        headers: authHeaders,
        body: {
          restaurant_id: createdRestaurantId,
          subscription_id: activeSubId,
          amount: 14000.00,
          payment_mode: 'UPI',
          transaction_reference: 'UPI_RESTOPRO_1002',
          notes: 'Second installment (full settlement)'
        }
      });

      assert(pay2Res.statusCode === 201, 'Record payment 2 returns HTTP 201');
      assert(pay2Res.body.payment.amount === 14000, 'Payment 2 amount is 14,000');

      payment2Id = pay2Res.body.payment.id;
      createdPaymentIds.push(payment2Id);
    }

    // 5.3: Verify subscription details after full settlement
    {
      const subDetailRes = await httpRequest({
        method: 'GET',
        path: `/api/admin/subscriptions/${activeSubId}`,
        headers: authHeaders
      });

      assert(subDetailRes.statusCode === 200, 'Get subscription detail returns HTTP 200');
      assert(subDetailRes.body.subscription.total_paid === 24000, 'Total paid on subscription equals 24,000');
      assert(subDetailRes.body.subscription.outstanding_balance === 0, 'Outstanding balance is 0 after full settlement');
    }

    // 5.4: Reject negative or zero payment amount
    {
      const badAmtRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/payments',
        headers: authHeaders,
        body: {
          restaurant_id: createdRestaurantId,
          amount: -500.00
        }
      });

      assert(badAmtRes.statusCode === 400, 'Negative payment amount rejected with HTTP 400');
    }

    // 5.5: Reject mismatched subscription and restaurant
    {
      const foreignPhoneId = `foreign_${Date.now()}`.substring(0, 20);
      const foreignRestaurant = await prisma.restaurant.create({
        data: {
          name: 'Foreign Bistro',
          phone_number_id: foreignPhoneId,
          waba_id: foreignPhoneId,
          owner_phone: '+919900000000',
          access_token_encrypted: 'mock',
          is_active: true
        }
      });
      createdRestaurantIds.push(foreignRestaurant.id);

      const mismatchRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/payments',
        headers: authHeaders,
        body: {
          restaurant_id: foreignRestaurant.id, // Mismatched restaurant!
          subscription_id: activeSubId,        // Belongs to createdRestaurantId
          amount: 5000.00
        }
      });

      assert(mismatchRes.statusCode === 400, 'Mismatched subscription/restaurant rejected with HTTP 400');
      assert(mismatchRes.body.error.includes('does not belong to'), 'Explains restaurant ownership violation');
    }

    // 5.6: Reverse payment 2 (14,000 INR)
    {
      const reverseRes = await httpRequest({
        method: 'PATCH',
        path: `/api/admin/payments/${payment2Id}/reverse`,
        headers: authHeaders,
        body: { reason: 'Customer requested refund due to duplicate UPI debit' }
      });

      assert(reverseRes.statusCode === 200, 'Reverse payment returns HTTP 200');
      assert(reverseRes.body.original.status === 'REVERSED', 'Original payment status updated to REVERSED');
      assert(reverseRes.body.reversal.status === 'REVERSED', 'Reversal entry created with status REVERSED');
      assert(reverseRes.body.reversal.original_payment_id === payment2Id, 'Reversal entry links to original payment ID');

      createdPaymentIds.push(reverseRes.body.reversal.id);

      // Verify outstanding balance restored after reversal
      const subAfterReversal = await httpRequest({
        method: 'GET',
        path: `/api/admin/subscriptions/${activeSubId}`,
        headers: authHeaders
      });

      assert(subAfterReversal.body.subscription.total_paid === 10000, 'Total paid excludes reversed payment (now 10,000)');
      assert(subAfterReversal.body.subscription.outstanding_balance === 14000, 'Outstanding balance restored to 14,000');
    }

    // 5.7: Duplicate reversal attempt rejected
    {
      const dupeRevRes = await httpRequest({
        method: 'PATCH',
        path: `/api/admin/payments/${payment2Id}/reverse`,
        headers: authHeaders,
        body: { reason: 'Duplicate reversal attempt' }
      });

      assert(dupeRevRes.statusCode === 400, 'Duplicate reversal attempt rejected with HTTP 400');
      assert(dupeRevRes.body.error.includes('already reversed') || dupeRevRes.body.error.includes('already has'), 'Explains duplicate reversal rejection');
    }

    // -------------------------------------------------------------
    // TEST GROUP 6: Dashboard Statistics, Diagnostics & Audit Logs (Stage 9.5)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Dashboard Statistics, Diagnostics & Audit Logs (Stage 9.5) ---');

    // 6.1: Dashboard stats accurately exclude reversed payments
    {
      const statsRes = await httpRequest({
        method: 'GET',
        path: '/api/admin/dashboard/stats',
        headers: authHeaders
      });

      assert(statsRes.statusCode === 200, 'Get dashboard stats returns HTTP 200');
      assert(statsRes.body.restaurants.total >= 1, 'Stats include onboarded restaurants');
      assert(statsRes.body.subscriptions.active >= 1, 'Stats include active subscriptions');
      assert(statsRes.body.financials.total_recorded_payments >= 10000, 'Total recorded payments calculated correctly');
      assert(statsRes.body.financials.total_reversed_payments >= 14000, 'Total reversed payments tracked accurately');
      assert(statsRes.body.financials.total_outstanding_balance >= 14000, 'Outstanding balance calculated accurately');
    }

    // 6.2: System & Database operational diagnostics (Zero secrets leaked)
    {
      const sysRes = await httpRequest({
        method: 'GET',
        path: '/api/admin/system/database',
        headers: authHeaders
      });

      assert(sysRes.statusCode === 200, 'Get database diagnostics returns HTTP 200');
      assert(sysRes.body.database.status === 'connected', 'Database reported as connected');
      assert(sysRes.body.database.provider === 'PostgreSQL', 'Provider reports PostgreSQL');
      assert(typeof sysRes.body.database.table_counts.restaurants === 'number', 'Table counts populated');
      assert(sysRes.body.database.url === undefined, 'Security: DATABASE_URL is strictly omitted');
      assert(sysRes.body.database.password === undefined, 'Security: Database password is omitted');
    }

    // 6.3: Audit logs listing and metadata preservation
    {
      const auditRes = await httpRequest({
        method: 'GET',
        path: '/api/admin/audit-logs?limit=5',
        headers: authHeaders
      });

      assert(auditRes.statusCode === 200, 'List audit logs returns HTTP 200');
      assert(Array.isArray(auditRes.body.audit_logs), 'Audit logs returns array');
      assert(auditRes.body.audit_logs.length > 0, 'Audit trail contains recorded actions');
      const sample = auditRes.body.audit_logs[0];
      assert(sample.action && sample.entity_type, 'Audit entry has action and entity type');
      assert(sample.admin_user !== undefined, 'Audit entry includes admin relationship');
    }

  } catch (err) {
    console.error('Unhandled test failure:', err);
    failed++;
  } finally {
    // Clean up all test data
    console.log('\n--- CLEANUP: Removing Stage 9 Test Artifacts ---');
    try {
      if (createdPaymentIds.length > 0) {
        await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } }).catch(() => {});
      }
      if (createdSubscriptionIds.length > 0) {
        await prisma.subscription.deleteMany({ where: { id: { in: createdSubscriptionIds } } }).catch(() => {});
      }
      if (createdRestaurantIds.length > 0) {
        // Delete dependent sessions/notifications if any before deleting restaurant
        await prisma.conversationSession.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } }).catch(() => {});
        await prisma.orderNotification.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } }).catch(() => {});
        await prisma.order.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } }).catch(() => {});
        await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } }).catch(() => {});
      }
      if (createdAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { id: { in: createdAuditLogIds } } }).catch(() => {});
      }
      if (createdAdminIds.length > 0) {
        await prisma.adminSession.deleteMany({ where: { admin_id: { in: createdAdminIds } } }).catch(() => {});
        await prisma.auditLog.deleteMany({ where: { admin_user_id: { in: createdAdminIds } } }).catch(() => {});
        await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminIds } } }).catch(() => {});
      }
      console.log('  Cleaned up all temporary test records.');
    } catch (cleanupErr) {
      console.warn('  Cleanup encountered non-fatal error:', cleanupErr.message);
    }

    if (serverInstance) {
      serverInstance.close();
    }
    await prisma.$disconnect().catch(() => {});
  }

  console.log('\n============================================================');
  console.log(`   STAGE 9 FULL SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runStage9FullSuiteTests();
}

module.exports = { runStage9FullSuiteTests };
