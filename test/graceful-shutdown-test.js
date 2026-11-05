/**
 * RESTOPRO — Focused Automated Test for Graceful Shutdown Signal Handling
 * Executes the HTTP server and Prisma client in an isolated child process,
 * triggers signal handlers, and verifies clean disconnection.
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

async function testGracefulShutdown() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — GRACEFUL SHUTDOWN CHILD PROCESS TEST         ');
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

  const childScript = path.join(__dirname, 'helpers', 'test-shutdown-child.js');

  const child = spawn(process.execPath, [childScript], {
    env: {
      ...process.env,
      PORT: '3991',
      NODE_ENV: 'development'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (d) => {
    const s = d.toString();
    stdout += s;
    process.stdout.write(s);
  });

  child.stderr.on('data', (d) => {
    const s = d.toString();
    stderr += s;
    process.stderr.write(s);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });

  console.log('\n--- Evaluating Shutdown Assertions ---');

  // Assertion 1: Server started and responded to requests
  assert(stdout.includes('[CHILD_VERIFIED] Health check OK: 200'), 'Server was operational and handled incoming HTTP request');

  // Assertion 2: SIGTERM signal handler was triggered
  assert(stdout.includes('Received SIGTERM. Shutting down HTTP server gracefully'), 'SIGTERM signal event triggered gracefulShutdown handler');

  // Assertion 3: Server stopped accepting connections and closed
  assert(stdout.includes('HTTP server closed successfully'), 'HTTP server closed and stopped accepting new requests');

  // Assertion 4: Prisma disconnected cleanly
  assert(stdout.includes('Prisma database client disconnected cleanly'), 'Prisma client disconnected cleanly from PostgreSQL pool');

  // Assertion 5: Child process exited cleanly with code 0 (no hanging)
  assert(exitCode === 0, `Child process exited with status code 0 (actual: ${exitCode})`);

  // Assertion 6: Port 3991 is verified released (new connection is refused)
  let portReleased = false;
  try {
    await new Promise((resolve, reject) => {
      const req = http.get('http://localhost:3991/health', () => {
        reject(new Error('Server still responding after shutdown'));
      });
      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          portReleased = true;
          resolve();
        } else {
          reject(err);
        }
      });
    });
  } catch (err) {
    portReleased = false;
  }
  assert(portReleased, 'Server port was successfully released (new requests rejected with ECONNREFUSED)');

  console.log('\n============================================================');
  console.log(`   SHUTDOWN TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

testGracefulShutdown().catch((err) => {
  console.error('Fatal shutdown test failure:', err);
  process.exit(1);
});
