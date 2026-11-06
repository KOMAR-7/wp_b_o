/**
 * RESTOPRO — Stage 9.1: Super Admin Database Foundation & Authentication Test Suite
 *
 * Verifies:
 * 1. Password hashing (scrypt) & constant-time verification
 * 2. Super Admin login, session creation, and error handling
 * 3. Deactivated / unauthorized role rejection
 * 4. Login rate limiting (max 5 failed attempts -> HTTP 429)
 * 5. Session validation & revocation via logout
 * 6. Protection against information leakage (no password hashes exposed)
 * 7. Absence of public admin registration routes (HTTP 404)
 * 8. Database schema: Subscriptions, Payments, AuditLogs, and Restaurant extensions
 */

const http = require('http');
const prisma = require('../src/config/database');
const app = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/utils/password');
const { resetRateLimiter } = require('../src/middleware/adminRateLimiter');

const TEST_PORT = 4996;
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

async function runStage9Tests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 9.1: SUPER ADMIN AUTH & DB TEST SUITE  ');
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

  // Tracking resources for cleanup
  const testAdminIds = [];
  const testRestaurantIds = [];
  const testSubscriptionIds = [];
  const testPaymentIds = [];
  const testAuditLogIds = [];

  try {
    // -------------------------------------------------------------
    // TEST GROUP 1: Password Utility & Hashing Robustness
    // -------------------------------------------------------------
    console.log('--- TEST GROUP 1: Password Utility & Hashing Robustness ---');
    {
      const rawPassword = 'SuperSecretAdminPassword123!';
      const hash = await hashPassword(rawPassword);

      assert(typeof hash === 'string' && hash.startsWith('scrypt:'), 'Generates valid scrypt formatted hash');
      assert(hash.split(':').length === 3, 'Hash contains algorithm, salt, and key components');

      const isValid = await verifyPassword(rawPassword, hash);
      assert(isValid === true, 'Correct password verifies successfully');

      const isInvalid = await verifyPassword('WrongPassword!', hash);
      assert(isInvalid === false, 'Incorrect password fails verification');

      const emptyVerify = await verifyPassword('', hash);
      assert(emptyVerify === false, 'Empty password fails verification safely');

      const badHashVerify = await verifyPassword(rawPassword, 'invalid_hash_string');
      assert(badHashVerify === false, 'Malformed hash string fails verification safely without crashing');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Super Admin Provisioning & Authentication
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Super Admin Provisioning & Authentication ---');

    const testAdminEmail = `test_admin_${Date.now()}@restopro.internal`;
    const testAdminPassword = 'StrongPassword987#';
    const testAdminHash = await hashPassword(testAdminPassword);

    // Create test active super admin
    const activeAdmin = await prisma.adminUser.create({
      data: {
        name: 'Platform Test Admin',
        email: testAdminEmail,
        password_hash: testAdminHash,
        role: 'SUPER_ADMIN',
        is_active: true
      }
    });
    testAdminIds.push(activeAdmin.id);

    // Create test inactive admin
    const inactiveAdminEmail = `inactive_admin_${Date.now()}@restopro.internal`;
    const inactiveAdmin = await prisma.adminUser.create({
      data: {
        name: 'Inactive Admin',
        email: inactiveAdminEmail,
        password_hash: testAdminHash,
        role: 'SUPER_ADMIN',
        is_active: false
      }
    });
    testAdminIds.push(inactiveAdmin.id);

    // Create non-super-admin user (e.g. VIEWER)
    const viewerAdminEmail = `viewer_${Date.now()}@restopro.internal`;
    const viewerAdmin = await prisma.adminUser.create({
      data: {
        name: 'Viewer User',
        email: viewerAdminEmail,
        password_hash: testAdminHash,
        role: 'VIEWER',
        is_active: true
      }
    });
    testAdminIds.push(viewerAdmin.id);

    let activeSessionToken = null;

    // Test 2.1: Successful login
    {
      resetRateLimiter();
      const res = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/login',
        body: {
          email: testAdminEmail,
          password: testAdminPassword
        }
      });

      assert(res.statusCode === 200, 'Successful login returns HTTP 200');
      assert(res.body.success === true, 'Response indicates success');
      assert(typeof res.body.token === 'string' && res.body.token.length >= 32, 'Returns high-entropy session token');
      assert(res.body.admin.email === testAdminEmail, 'Returns matching admin email');
      assert(res.body.admin.role === 'SUPER_ADMIN', 'Returns SUPER_ADMIN role');
      assert(res.body.admin.password_hash === undefined, 'Security: password_hash is not returned in response');
      assert(res.body.admin.passwordHash === undefined, 'Security: passwordHash is not returned in response');

      // Check cookie
      const setCookie = res.headers['set-cookie'];
      assert(Array.isArray(setCookie) && setCookie.some(c => c.includes('admin_session=') && c.includes('HttpOnly')), 'Sets HttpOnly admin_session cookie');

      activeSessionToken = res.body.token;
    }

    // Test 2.2: Login with wrong password
    {
      const res = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/login',
        body: {
          email: testAdminEmail,
          password: 'IncorrectPassword123'
        }
      });

      assert(res.statusCode === 401, 'Wrong password returns HTTP 401');
      assert(res.body.error === 'Invalid email or password', 'Returns generic credential error');
    }

    // Test 2.3: Login with non-existent email
    {
      const res = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/login',
        body: {
          email: 'nonexistent_admin@restopro.internal',
          password: 'SomePassword123!'
        }
      });

      assert(res.statusCode === 401, 'Non-existent email returns HTTP 401');
      assert(res.body.error === 'Invalid email or password', 'Returns identical generic error to prevent user enumeration');
    }

    // Test 2.4: Login with inactive admin
    {
      const res = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/login',
        body: {
          email: inactiveAdminEmail,
          password: testAdminPassword
        }
      });

      assert(res.statusCode === 401, 'Inactive admin login is rejected with HTTP 401');
    }

    // Test 2.5: Login with insufficient role
    {
      const res = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/login',
        body: {
          email: viewerAdminEmail,
          password: testAdminPassword
        }
      });

      assert(res.statusCode === 401, 'Non-SUPER_ADMIN login is rejected with HTTP 401');
    }

    // Test 2.6: Login rate limiting (5 attempts threshold)
    {
      resetRateLimiter();
      for (let i = 0; i < 5; i++) {
        await httpRequest({
          method: 'POST',
          path: '/api/admin/auth/login',
          body: { email: testAdminEmail, password: 'wrong' }
        });
      }

      // 6th attempt should trigger 429
      const rateLimitedRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/login',
        body: { email: testAdminEmail, password: 'wrong' }
      });

      assert(rateLimitedRes.statusCode === 429, 'Excessive failed login attempts triggers HTTP 429 Too Many Requests');
      assert(rateLimitedRes.body.error.includes('Too many login attempts'), 'Returns rate limit warning message');

      // Reset for further tests
      resetRateLimiter();
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: Protected Admin Routes & Session Revocation
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Protected Admin Routes & Session Revocation ---');

    // Test 3.1: GET /api/admin/auth/me without token
    {
      const res = await httpRequest({
        method: 'GET',
        path: '/api/admin/auth/me'
      });

      assert(res.statusCode === 401, 'Unauthenticated GET /api/admin/auth/me returns HTTP 401');
    }

    // Test 3.2: GET /api/admin/auth/me with invalid Bearer token
    {
      const res = await httpRequest({
        method: 'GET',
        path: '/api/admin/auth/me',
        headers: { Authorization: 'Bearer invalid_session_token_12345' }
      });

      assert(res.statusCode === 401, 'Invalid Bearer token returns HTTP 401');
    }

    // Test 3.3: GET /api/admin/auth/me with valid Bearer token
    {
      const res = await httpRequest({
        method: 'GET',
        path: '/api/admin/auth/me',
        headers: { Authorization: `Bearer ${activeSessionToken}` }
      });

      assert(res.statusCode === 200, 'Valid Bearer token returns HTTP 200');
      assert(res.body.admin && res.body.admin.email === testAdminEmail, 'Returns authenticated admin profile');
      assert(res.body.admin.role === 'SUPER_ADMIN', 'Profile indicates SUPER_ADMIN role');
      assert(res.body.admin.isActive === true, 'Profile indicates active status');
      assert(res.body.admin.password_hash === undefined, 'Password hash is strictly omitted from profile');
    }

    // Test 3.4: GET /api/admin/auth/me with Cookie
    {
      const res = await httpRequest({
        method: 'GET',
        path: '/api/admin/auth/me',
        headers: { Cookie: `admin_session=${activeSessionToken}` }
      });

      assert(res.statusCode === 200, 'Cookie-based session returns HTTP 200');
      assert(res.body.admin && res.body.admin.email === testAdminEmail, 'Cookie authentication resolves correct admin');
    }

    // Test 3.5: POST /api/admin/auth/logout revokes session
    {
      const logoutRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/logout',
        headers: { Authorization: `Bearer ${activeSessionToken}` }
      });

      assert(logoutRes.statusCode === 200, 'Logout returns HTTP 200');
      assert(logoutRes.body.success === true, 'Logout confirms success');

      // Subsequent access with revoked token must fail
      const postLogoutRes = await httpRequest({
        method: 'GET',
        path: '/api/admin/auth/me',
        headers: { Authorization: `Bearer ${activeSessionToken}` }
      });

      assert(postLogoutRes.statusCode === 401, 'Revoked session token returns HTTP 401 on subsequent requests');
    }

    // Test 3.6: Verify strictly NO public registration route exists
    {
      const registerRes = await httpRequest({
        method: 'POST',
        path: '/api/admin/auth/register',
        body: { email: 'hacker@malicious.com', password: 'Password123' }
      });

      assert(registerRes.statusCode === 404, 'Security Invariant: POST /api/admin/auth/register returns HTTP 404 (no public registration)');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Database Models & Relationship Integrity
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Database Models & Relationship Integrity ---');

    // Test 4.1: Restaurant Metadata Extensions
    const uniquePhoneId = `stage9_${Date.now()}`.substring(0, 30);
    const testRestaurant = await prisma.restaurant.create({
      data: {
        name: 'The Royal Bistro (Admin Test)',
        phone_number_id: uniquePhoneId,
        waba_id: 'WABA_STAGE9_TEST',
        owner_phone: '+919876599999',
        access_token_encrypted: 'mock_token_stage9',
        is_active: true,
        // New Stage 9 fields
        owner_name: 'Rajesh Sharma',
        email: 'rajesh@royalbistro.internal',
        contact_number: '+919876599999',
        address: '123 MG Road, Bengaluru, Karnataka 560001',
        internal_notes: 'Priority pilot partner with 3 outlets.',
        tenant_status: 'ACTIVE'
      }
    });
    testRestaurantIds.push(testRestaurant.id);

    assert(testRestaurant.owner_name === 'Rajesh Sharma', 'Restaurant persists owner_name');
    assert(testRestaurant.email === 'rajesh@royalbistro.internal', 'Restaurant persists email');
    assert(testRestaurant.tenant_status === 'ACTIVE', 'Restaurant defaults/persists tenant_status ACTIVE');
    assert(testRestaurant.is_active === true, 'Preserves backward-compatible is_active flag');

    // Test 4.2: Subscriptions (Multiple historical subscriptions per restaurant)
    const sub1 = await prisma.subscription.create({
      data: {
        restaurant_id: testRestaurant.id,
        plan_name: 'Annual WhatsApp Automation - Year 1',
        amount: 15000.00,
        currency: 'INR',
        start_date: new Date('2025-01-01T00:00:00Z'),
        end_date: new Date('2025-12-31T23:59:59Z'),
        status: 'EXPIRED',
        notes: 'Initial onboarding plan'
      }
    });
    testSubscriptionIds.push(sub1.id);

    const sub2 = await prisma.subscription.create({
      data: {
        restaurant_id: testRestaurant.id,
        plan_name: 'Annual WhatsApp Automation - Year 2 Renewal',
        amount: 18000.00,
        currency: 'INR',
        start_date: new Date('2026-01-01T00:00:00Z'),
        end_date: new Date('2026-12-31T23:59:59Z'),
        status: 'ACTIVE',
        notes: 'Year 2 renewal'
      }
    });
    testSubscriptionIds.push(sub2.id);

    const restaurantWithSubs = await prisma.restaurant.findUnique({
      where: { id: testRestaurant.id },
      include: { subscriptions: true }
    });

    assert(restaurantWithSubs.subscriptions.length === 2, 'Restaurant maintains multiple historical subscriptions');
    assert(restaurantWithSubs.subscriptions.some(s => s.status === 'EXPIRED'), 'Contains expired subscription');
    assert(restaurantWithSubs.subscriptions.some(s => s.status === 'ACTIVE'), 'Contains active subscription');

    // Test 4.3: Payments (Multiple partial payments per subscription)
    const payment1 = await prisma.payment.create({
      data: {
        restaurant_id: testRestaurant.id,
        subscription_id: sub2.id,
        amount: 10000.00,
        currency: 'INR',
        payment_mode: 'BANK_TRANSFER',
        transaction_reference: 'NEFT_TXN_001_PARTIAL',
        status: 'RECORDED',
        notes: 'First installment for Year 2',
        recorded_by_admin_id: activeAdmin.id
      }
    });
    testPaymentIds.push(payment1.id);

    const payment2 = await prisma.payment.create({
      data: {
        restaurant_id: testRestaurant.id,
        subscription_id: sub2.id,
        amount: 8000.00,
        currency: 'INR',
        payment_mode: 'UPI',
        transaction_reference: 'UPI_TXN_002_FINAL',
        status: 'RECORDED',
        notes: 'Final installment for Year 2',
        recorded_by_admin_id: activeAdmin.id
      }
    });
    testPaymentIds.push(payment2.id);

    // Test 4.4: Standalone Payment (not tied to subscription)
    const standalonePayment = await prisma.payment.create({
      data: {
        restaurant_id: testRestaurant.id,
        subscription_id: null,
        amount: 2500.00,
        currency: 'INR',
        payment_mode: 'UPI',
        transaction_reference: 'UPI_SETUP_FEE_001',
        status: 'RECORDED',
        notes: 'One-time onboarding menu digitization fee',
        recorded_by_admin_id: activeAdmin.id
      }
    });
    testPaymentIds.push(standalonePayment.id);

    const subWithPayments = await prisma.subscription.findUnique({
      where: { id: sub2.id },
      include: { payments: true }
    });

    assert(subWithPayments.payments.length === 2, 'Subscription correctly tracks multiple partial payments');
    assert(standalonePayment.subscription_id === null, 'Supports standalone payment without subscription');

    // Test 4.5: Payment Reversal tracking
    const reversalPayment = await prisma.payment.create({
      data: {
        restaurant_id: testRestaurant.id,
        subscription_id: sub2.id,
        amount: 8000.00,
        currency: 'INR',
        payment_mode: 'BANK_TRANSFER',
        transaction_reference: 'REV_UPI_TXN_002',
        status: 'REVERSED',
        notes: 'Chargeback reversal for UPI_TXN_002',
        recorded_by_admin_id: activeAdmin.id,
        original_payment_id: payment2.id
      }
    });
    testPaymentIds.push(reversalPayment.id);

    const originalWithReversal = await prisma.payment.findUnique({
      where: { id: payment2.id },
      include: { reversals: true }
    });

    assert(originalWithReversal.reversals.length === 1, 'Original payment links to reversal record');
    assert(originalWithReversal.reversals[0].id === reversalPayment.id, 'Reversal tracks correct original payment ID');

    // Test 4.6: AuditLog Recording
    const auditRecord = await prisma.auditLog.create({
      data: {
        admin_user_id: activeAdmin.id,
        action: 'SUBSCRIPTION_RENEWAL_APPROVED',
        entity_type: 'Subscription',
        entity_id: sub2.id,
        metadata: {
          planName: sub2.plan_name,
          totalAmount: 18000.00,
          approvedBy: activeAdmin.name
        }
      }
    });
    testAuditLogIds.push(auditRecord.id);

    const fetchedAudit = await prisma.auditLog.findUnique({
      where: { id: auditRecord.id },
      include: { admin_user: true }
    });

    assert(fetchedAudit !== null, 'AuditLog record successfully persisted');
    assert(fetchedAudit.admin_user && fetchedAudit.admin_user.id === activeAdmin.id, 'AuditLog relates to AdminUser');
    assert(fetchedAudit.metadata.planName === sub2.plan_name, 'AuditLog stores and returns arbitrary JSON metadata');

  } catch (err) {
    console.error('Unhandled test failure:', err);
    failed++;
  } finally {
    // Clean up test data
    console.log('\n--- CLEANUP: Removing Test Records ---');
    try {
      if (testPaymentIds.length > 0) {
        await prisma.payment.deleteMany({ where: { id: { in: testPaymentIds } } }).catch(() => {});
      }
      if (testSubscriptionIds.length > 0) {
        await prisma.subscription.deleteMany({ where: { id: { in: testSubscriptionIds } } }).catch(() => {});
      }
      if (testRestaurantIds.length > 0) {
        await prisma.restaurant.deleteMany({ where: { id: { in: testRestaurantIds } } }).catch(() => {});
      }
      if (testAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { id: { in: testAuditLogIds } } }).catch(() => {});
      }
      if (testAdminIds.length > 0) {
        await prisma.adminSession.deleteMany({ where: { admin_id: { in: testAdminIds } } }).catch(() => {});
        await prisma.auditLog.deleteMany({ where: { admin_user_id: { in: testAdminIds } } }).catch(() => {});
        await prisma.adminUser.deleteMany({ where: { id: { in: testAdminIds } } }).catch(() => {});
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
  console.log(`   STAGE 9.1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runStage9Tests();
}

module.exports = { runStage9Tests };
