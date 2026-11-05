/**
 * RESTOPRO — Webhook Integration & Cryptographic Test Suite
 * Executes end-to-end local tests against the Express application.
 */
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = require('../src/app');
const config = require('../src/config/env');
const { parseWebhookPayload } = require('../src/parsers/webhook-parser');

const TEST_PORT = 3999;
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

    if (body) {
      req.write(body);
    }
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

async function runTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — STAGE 1: WEBHOOK & SECURITY TEST SUITE       ');
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

  // Start test server
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`Test server running on port ${TEST_PORT}\n`);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------
    // TEST GROUP 1: Health Check
    // -------------------------------------------------------------
    console.log('--- TEST GROUP 1: Health & Baseline Endpoints ---');
    {
      const res = await makeRequest({ method: 'GET', path: '/health' });
      assert(res.statusCode === 200, 'GET /health returns HTTP 200');
      const data = JSON.parse(res.body);
      assert(data.status === 'ok', 'GET /health body contains status: ok');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Meta Webhook Challenge Handshake (GET)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Meta GET Challenge Verification ---');
    {
      // Valid handshake
      const challengeStr = 'challenge_test_nonce_98765';
      const validQuery = `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.meta.verifyToken)}&hub.challenge=${challengeStr}`;
      const res = await makeRequest({ method: 'GET', path: `/api/webhook${validQuery}` });
      assert(res.statusCode === 200, 'Valid verify token returns HTTP 200');
      assert(res.body === challengeStr, 'Valid handshake returns exact challenge string');
    }

    {
      // Invalid token
      const invalidQuery = `?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=12345`;
      const res = await makeRequest({ method: 'GET', path: `/api/webhook${invalidQuery}` });
      assert(res.statusCode === 403, 'Invalid verify token returns HTTP 403 Forbidden');
    }

    {
      // Missing parameters
      const res = await makeRequest({ method: 'GET', path: '/api/webhook' });
      assert(res.statusCode === 400, 'Missing hub parameters returns HTTP 400 Bad Request');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: POST HMAC-SHA256 Signature Verification
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: POST HMAC-SHA256 Signature Security ---');
    const samplePayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

    {
      // Valid signature
      const signature = computeSignature(samplePayload, config.meta.appSecret);
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': signature
        },
        body: samplePayload
      });
      assert(res.statusCode === 200, 'Valid HMAC signature returns HTTP 200');
      assert(res.body === 'EVENT_RECEIVED', 'Valid POST returns EVENT_RECEIVED');
    }

    {
      // Forged / invalid signature
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': 'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        },
        body: samplePayload
      });
      assert(res.statusCode === 403, 'Forged HMAC signature is rejected with HTTP 403 Forbidden');
    }

    {
      // Tampered payload body with original signature
      const originalSignature = computeSignature(samplePayload, config.meta.appSecret);
      const tamperedPayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ tampered: true }] });
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': originalSignature
        },
        body: tamperedPayload
      });
      assert(res.statusCode === 403, 'Tampered body with original signature is rejected with HTTP 403 Forbidden');
    }

    {
      // Missing signature header
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: { 'Content-Type': 'application/json' },
        body: samplePayload
      });
      assert(res.statusCode === 401, 'Missing signature header returns HTTP 401 Unauthorized');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Payload Parsing & Event Extraction
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Payload Parsing on Real Meta Structures ---');
    const payloadsDir = path.resolve(__dirname, '../docs/test-payloads');

    // 4.1 Text Message
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '01-text-message.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '01-text-message parses exactly 1 event');
      assert(parsed[0].messageType === 'text', '01-text-message messageType is text');
      assert(parsed[0].text === 'Hi', '01-text-message text body is "Hi"');
      assert(parsed[0].senderPhone === '919876543210', '01-text-message sender phone extracted correctly');
      assert(parsed[0].phoneNumberId === '109876543210123', '01-text-message recipient phoneNumberId extracted');
    }

    // 4.2 Native Catalog Order / Cart
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '02-catalog-order.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '02-catalog-order parses exactly 1 event');
      assert(parsed[0].messageType === 'order', '02-catalog-order messageType is order');
      assert(parsed[0].order.catalogId === '987654321098765', '02-catalog-order catalogId extracted');
      assert(parsed[0].order.itemCount === 2, '02-catalog-order item count is 2');
      assert(parsed[0].order.calculatedSubtotal === 560, '02-catalog-order subtotal calculated accurately (2*240 + 1*80 = 560)');
      assert(parsed[0].order.items[0].productRetailerId === 'SKU_CHKN_BIRYANI_01', '02-catalog-order item 1 SKU extracted');
      assert(parsed[0].order.items[0].quantity === 2, '02-catalog-order item 1 quantity extracted');
    }

    // 4.3 Location Message
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '03-location-message.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '03-location-message parses exactly 1 event');
      assert(parsed[0].messageType === 'location', '03-location-message messageType is location');
      assert(parsed[0].location.latitude === 19.1363257, '03-location-message latitude extracted');
      assert(parsed[0].location.longitude === 72.8276601, '03-location-message longitude extracted');
      assert(parsed[0].location.address.includes('Andheri West'), '03-location-message address string extracted');
    }

    // 4.4 Template Quick Reply Button Tap
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '04-template-button-reply.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '04-template-button-reply parses exactly 1 event');
      assert(parsed[0].messageType === 'button', '04-template-button-reply messageType is button');
      assert(parsed[0].buttonReply.payload === 'ORDER_ACCEPT_RP1024', '04-template-button-reply payload extracted');
      assert(parsed[0].buttonReply.text === 'Accept Order', '04-template-button-reply text extracted');
    }

    // 4.5 Interactive Button Reply
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '05-interactive-button-reply.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '05-interactive-button-reply parses exactly 1 event');
      assert(parsed[0].messageType === 'interactive', '05-interactive-button-reply messageType is interactive');
      assert(parsed[0].interactiveReply.id === 'BTN_CONFIRM_ORDER', '05-interactive-button-reply button id extracted');
    }

    // 4.6 Status Delivery Receipt
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '06-delivery-status-receipt.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '06-delivery-status-receipt parses status receipt');
      assert(parsed[0].category === 'STATUS_RECEIPT', '06-delivery-status-receipt category is STATUS_RECEIPT');
      assert(parsed[0].status === 'delivered', '06-delivery-status-receipt status is delivered');
    }

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n============================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
