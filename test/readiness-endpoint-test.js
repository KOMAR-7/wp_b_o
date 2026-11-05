/**
 * RESTOPRO — Database Readiness Endpoint Test Suite
 *
 * Tests:
 * 1. GET /health remains functional as shallow liveness probe (HTTP 200)
 * 2. GET /health/ready executes SELECT 1 and returns HTTP 200 {"status":"ready","database":"connected"}
 * 3. GET /health/ready returns HTTP 503 {"status":"error","database":"disconnected","error":"Database unavailable"} on DB failure
 * 4. Error response sanitization: zero credentials, database URLs, hosts or stack traces exposed
 * 5. GET /health/ready recovers to HTTP 200 when database connectivity is restored
 * 6. Standard security headers enforced on /health/ready
 */

const http = require('http');
const app = require('../src/app');
const prisma = require('../src/config/database');

const TEST_PORT = 4995;
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

function sendGetRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method: 'GET'
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
    req.end();
  });
}

async function runReadinessTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — DATABASE READINESS ENDPOINT TEST SUITE       ');
  console.log('============================================================\n');

  let serverInstance = null;

  try {
    // Start Express server on TEST_PORT
    await new Promise((resolve, reject) => {
      serverInstance = app.listen(TEST_PORT, '127.0.0.1', () => {
        console.log(`[TEST SERVER] Listening on http://127.0.0.1:${TEST_PORT}`);
        resolve();
      });
      serverInstance.on('error', reject);
    });

    // -------------------------------------------------------------------------
    // TEST GROUP 1: Liveness Endpoint Regression Check (/health)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 1: Liveness Endpoint Regression Check ---');

    const livenessRes = await sendGetRequest('/health');
    assert(livenessRes.statusCode === 200, 'Liveness: GET /health returns HTTP 200');
    assert(livenessRes.body.status === 'ok', 'Liveness: Status reports "ok"');
    assert(livenessRes.body.service === 'RESTOPRO-WhatsApp-Backend', 'Liveness: Correct service identifier');
    assert(typeof livenessRes.body.timestamp === 'string', 'Liveness: Timestamp present in response');

    // -------------------------------------------------------------------------
    // TEST GROUP 2: Database Readiness Success Case (/health/ready)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Database Readiness Probe — Success Case ---');

    const readinessRes = await sendGetRequest('/health/ready');
    assert(readinessRes.statusCode === 200, 'Readiness: GET /health/ready returns HTTP 200 on healthy database');
    assert(readinessRes.body.status === 'ready', 'Readiness: Body status is "ready"');
    assert(readinessRes.body.database === 'connected', 'Readiness: Body database is "connected"');
    assert(
      Object.keys(readinessRes.body).length === 2,
      'Readiness: Response body strictly contains only status and database keys'
    );

    // Security Headers on /health/ready
    assert(readinessRes.headers['x-content-type-options'] === 'nosniff', 'Security: X-Content-Type-Options is nosniff');
    assert(readinessRes.headers['x-frame-options'] === 'DENY', 'Security: X-Frame-Options is DENY');
    assert(readinessRes.headers['x-powered-by'] === undefined, 'Security: X-Powered-By header is suppressed');

    // -------------------------------------------------------------------------
    // TEST GROUP 3: Database Readiness Failure Case (/health/ready)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Database Readiness Probe — Failure Case ---');

    // Simulate database outage by temporarily stubbing $queryRaw to reject with realistic internal error
    const originalQueryRaw = prisma.$queryRaw;
    const simulatedInternalError = 'Connection refused at postgresql://restopro_user:super_secret_pw@dpg-c12345678-a.singapore-postgres.render.internal:5432/restopro';

    prisma.$queryRaw = async () => {
      const err = new Error(simulatedInternalError);
      err.code = 'P1001';
      err.clientVersion = '6.19.3';
      throw err;
    };

    const failureRes = await sendGetRequest('/health/ready');

    // Restore original query method immediately
    prisma.$queryRaw = originalQueryRaw;

    assert(failureRes.statusCode === 503, 'Failure Case: GET /health/ready returns HTTP 503 Service Unavailable');
    assert(failureRes.body.status === 'error', 'Failure Case: Body status is "error"');
    assert(failureRes.body.database === 'disconnected', 'Failure Case: Body database is "disconnected"');
    assert(failureRes.body.error === 'Database unavailable', 'Failure Case: Returns generic sanitized error message');

    // Information Disclosure Audit: Ensure NO sensitive details leak
    const rawResponseBody = failureRes.rawBody;
    assert(!rawResponseBody.includes('super_secret_pw'), 'Information Disclosure: Password not leaked in response');
    assert(!rawResponseBody.includes('dpg-c12345678-a'), 'Information Disclosure: Hostname not leaked in response');
    assert(!rawResponseBody.includes('postgresql://'), 'Information Disclosure: Connection string not leaked in response');
    assert(!rawResponseBody.includes('P1001'), 'Information Disclosure: Internal Prisma error code not leaked in response');
    assert(!rawResponseBody.includes('stack'), 'Information Disclosure: Stack trace not leaked in response');

    // -------------------------------------------------------------------------
    // TEST GROUP 4: Database Readiness Recovery
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Database Readiness Probe — Recovery ---');

    const recoveredRes = await sendGetRequest('/health/ready');
    assert(recoveredRes.statusCode === 200, 'Recovery: GET /health/ready returns HTTP 200 after connection restored');
    assert(recoveredRes.body.status === 'ready', 'Recovery: Body status is "ready"');
    assert(recoveredRes.body.database === 'connected', 'Recovery: Body database is "connected"');

  } catch (err) {
    console.error('Fatal error during readiness test execution:', err);
    failedTests++;
  } finally {
    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
    }
  }

  console.log('\n============================================================');
  console.log(`   READINESS ENDPOINT RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runReadinessTests();

