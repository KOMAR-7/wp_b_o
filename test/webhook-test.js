/**
 * RESTOPRO — Stage 1.5: Comprehensive Webhook, Security & Parsing Audit Test Suite
 * Tests every edge case, security boundary, malformed input, and multi-event scenario.
 */
require('./load-test-env');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = require('../src/app');
const config = require('../src/config/env');
const { parseWebhookPayload, safeParseCoordinate } = require('../src/parsers/webhook-parser');
const logger = require('../src/utils/logger');

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
  console.log('   RESTOPRO — STAGE 1.5: COMPREHENSIVE AUDIT TEST SUITE    ');
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

  // -------------------------------------------------------------
  // TEST GROUP 1: Server Startup & Shutdown
  // -------------------------------------------------------------
  console.log('--- TEST GROUP 1: Server Startup & Baseline Endpoints ---');
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      assert(server.listening, 'Server successfully starts and listens on port');
      resolve();
    });
  });

  try {
    {
      const res = await makeRequest({ method: 'GET', path: '/health' });
      assert(res.statusCode === 200, 'GET /health returns HTTP 200');
      const data = JSON.parse(res.body);
      assert(data.status === 'ok', 'GET /health body contains status: ok');
      assert(data.service === 'RESTOPRO-WhatsApp-Backend', 'GET /health reports service name');
    }

    {
      const res = await makeRequest({ method: 'GET', path: '/' });
      assert(res.statusCode === 200, 'GET / root endpoint returns HTTP 200');
      const data = JSON.parse(res.body);
      assert(data.status === 'operational', 'Root body contains status: operational');
    }

    {
      const res = await makeRequest({ method: 'GET', path: '/non-existent-route' });
      assert(res.statusCode === 404, 'Unregistered route returns HTTP 404');
    }

    // -------------------------------------------------------------
    // TEST GROUP 2: Meta Webhook Challenge Handshake (GET)
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Meta GET Challenge Verification ---');
    {
      const challengeStr = 'challenge_test_nonce_98765';
      const validQuery = `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.meta.verifyToken)}&hub.challenge=${challengeStr}`;
      const res = await makeRequest({ method: 'GET', path: `/api/webhook${validQuery}` });
      assert(res.statusCode === 200, 'Valid verify token returns HTTP 200');
      assert(res.body === challengeStr, 'Valid handshake returns exact challenge string');
    }

    {
      const invalidQuery = `?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=12345`;
      const res = await makeRequest({ method: 'GET', path: `/api/webhook${invalidQuery}` });
      assert(res.statusCode === 403, 'Invalid verify token returns HTTP 403 Forbidden');
    }

    {
      const res = await makeRequest({ method: 'GET', path: '/api/webhook' });
      assert(res.statusCode === 400, 'Missing hub parameters returns HTTP 400 Bad Request');
    }

    {
      const res = await makeRequest({ method: 'GET', path: '/api/webhook?hub.mode=invalid_mode&hub.verify_token=test' });
      assert(res.statusCode === 400, 'Invalid hub.mode returns HTTP 400 Bad Request');
    }

    // -------------------------------------------------------------
    // TEST GROUP 3: POST HMAC-SHA256 Signature Verification & Malformed Formats
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: POST HMAC-SHA256 Signature Security ---');
    const samplePayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

    {
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
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: { 'Content-Type': 'application/json' },
        body: samplePayload
      });
      assert(res.statusCode === 401, 'Missing signature header returns HTTP 401 Unauthorized');
    }

    {
      // Malformed signature format (no '=')
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': 'invalid_format_without_equals'
        },
        body: samplePayload
      });
      assert(res.statusCode === 400, 'Malformed signature without = returns HTTP 400 Bad Request');
    }

    {
      // Malformed signature digest (non-hex characters)
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': 'sha256=not_a_hex_digest_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
        },
        body: samplePayload
      });
      assert(res.statusCode === 400, 'Non-hex signature digest returns HTTP 400 Bad Request');
    }

    {
      // Malformed signature digest (short length)
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': 'sha256=123456'
        },
        body: samplePayload
      });
      assert(res.statusCode === 400, 'Short signature digest returns HTTP 400 Bad Request');
    }

    // -------------------------------------------------------------
    // TEST GROUP 4: Malformed JSON Request Handling
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Malformed JSON Handling ---');
    {
      const malformedBody = '{"object": "whatsapp_business_account", "entry": [ broken json ';
      const signature = computeSignature(malformedBody, config.meta.appSecret);
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': signature
        },
        body: malformedBody
      });
      assert(res.statusCode === 400, 'Malformed JSON body returns HTTP 400 Bad Request');
      const data = JSON.parse(res.body);
      assert(data.error === 'Malformed JSON payload', 'Returns specific malformed JSON error message');
    }

    // -------------------------------------------------------------
    // TEST GROUP 5: Payload Parsing on Real Meta Structures
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Standard Payload Parsing ---');
    const payloadsDir = path.resolve(__dirname, '../docs/test-payloads');

    // 5.1 Text Message
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '01-text-message.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '01-text-message parses exactly 1 event');
      assert(parsed[0].messageType === 'text', '01-text-message messageType is text');
      assert(parsed[0].text === 'Hi', '01-text-message text body is "Hi"');
      assert(parsed[0].senderPhone === '919876543210', '01-text-message sender phone extracted correctly');
      assert(parsed[0].phoneNumberId === '109876543210123', '01-text-message recipient phoneNumberId extracted');
    }

    // 5.2 Native Catalog Order / Cart
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
      assert(parsed[0].order.currencyMismatch === false, '02-catalog-order has no currency mismatch');
    }

    // 5.3 Location Message
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '03-location-message.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '03-location-message parses exactly 1 event');
      assert(parsed[0].messageType === 'location', '03-location-message messageType is location');
      assert(parsed[0].location.latitude === 19.1363257, '03-location-message latitude extracted');
      assert(parsed[0].location.longitude === 72.8276601, '03-location-message longitude extracted');
      assert(parsed[0].location.address.includes('Andheri West'), '03-location-message address string extracted');
    }

    // 5.4 Template Quick Reply Button Tap
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '04-template-button-reply.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '04-template-button-reply parses exactly 1 event');
      assert(parsed[0].messageType === 'button', '04-template-button-reply messageType is button');
      assert(parsed[0].buttonReply.payload === 'ORDER_ACCEPT_RP1024', '04-template-button-reply payload extracted');
      assert(parsed[0].buttonReply.text === 'Accept Order', '04-template-button-reply text extracted');
    }

    // 5.5 Interactive Button Reply
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '05-interactive-button-reply.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '05-interactive-button-reply parses exactly 1 event');
      assert(parsed[0].messageType === 'interactive', '05-interactive-button-reply messageType is interactive');
      assert(parsed[0].interactiveReply.id === 'BTN_CONFIRM_ORDER', '05-interactive-button-reply button id extracted');
    }

    // 5.6 Status Delivery Receipt
    {
      const raw = JSON.parse(fs.readFileSync(path.join(payloadsDir, '06-delivery-status-receipt.json'), 'utf8'));
      const parsed = parseWebhookPayload(raw);
      assert(parsed.length === 1, '06-delivery-status-receipt parses status receipt');
      assert(parsed[0].category === 'STATUS_RECEIPT', '06-delivery-status-receipt category is STATUS_RECEIPT');
      assert(parsed[0].status === 'delivered', '06-delivery-status-receipt status is delivered');
    }

    // 5.7 Failed Status Webhook with Meta Error Code, Title & Details
    {
      const failedPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: '100293847561029',
          changes: [{
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550123456',
                phone_number_id: '109876543210123'
              },
              statuses: [{
                id: 'wamid.HBgTEST_FAIL_123',
                status: 'failed',
                timestamp: '1794131895',
                recipient_id: '919372015523',
                errors: [{
                  code: 131051,
                  title: 'Message failed to send',
                  message: 'Template dispatch failed (token EAAtestsecret123)',
                  error_data: {
                    details: 'Template hydration error: parameter count mismatch with token EAAsecrettoken'
                  },
                  href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes'
                }]
              }]
            }
          }]
        }]
      };

      const parsed = parseWebhookPayload(failedPayload);
      assert(parsed.length === 1, 'Failed status payload parses exactly 1 event');
      assert(parsed[0].category === 'STATUS_RECEIPT', 'Category is STATUS_RECEIPT');
      assert(parsed[0].status === 'failed', 'Status is failed');
      assert(parsed[0].recipientId === '919372015523', 'Recipient ID extracted');
      assert(Array.isArray(parsed[0].errors) && parsed[0].errors.length === 1, 'Errors extracted as array');
      assert(parsed[0].errors[0].code === 131051, 'Meta error code 131051 extracted');
      assert(parsed[0].errors[0].title === 'Message failed to send', 'Error title extracted');
      assert(parsed[0].errors[0].details.includes('parameter count mismatch'), 'Error details extracted from error_data.details');
      assert(parsed[0].errors[0].message.includes('[REDACTED_TOKEN]'), 'Access tokens in message are safely redacted');
      assert(!parsed[0].errors[0].message.includes('EAAtestsecret123'), 'Raw token not leaked in message');
      assert(parsed[0].errors[0].details.includes('[REDACTED_TOKEN]'), 'Access tokens in details are safely redacted');
      assert(!parsed[0].errors[0].details.includes('EAAsecrettoken'), 'Raw token not leaked in details');
    }

    // -------------------------------------------------------------
    // TEST GROUP 6: Complex Multi-Entry, Multi-Change & Multi-Message Payloads
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Multi-Entry, Multi-Change & Multi-Message Scenarios ---');
    {
      // Batch payload containing 2 entries, multiple changes, and 3 distinct messages
      const complexPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'ENTRY_1',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: 'PN_1', display_phone_number: '155501' },
                  messages: [
                    { from: 'USER_A', id: 'WAMID_1', timestamp: '1730000001', type: 'text', text: { body: 'First' } },
                    { from: 'USER_B', id: 'WAMID_2', timestamp: '1730000002', type: 'text', text: { body: 'Second' } }
                  ]
                }
              }
            ]
          },
          {
            id: 'ENTRY_2',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: 'PN_2', display_phone_number: '155502' },
                  messages: [
                    { from: 'USER_C', id: 'WAMID_3', timestamp: '1730000003', type: 'text', text: { body: 'Third' } }
                  ]
                }
              }
            ]
          }
        ]
      };

      const parsed = parseWebhookPayload(complexPayload);
      assert(parsed.length === 3, 'Multiple entries and multiple messages produce exactly 3 parsed events');
      assert(parsed[0].phoneNumberId === 'PN_1' && parsed[0].text === 'First', 'Message 1 parsed from Entry 1');
      assert(parsed[1].phoneNumberId === 'PN_1' && parsed[1].text === 'Second', 'Message 2 parsed from Entry 1');
      assert(parsed[2].phoneNumberId === 'PN_2' && parsed[2].text === 'Third', 'Message 3 parsed from Entry 2');
    }

    // -------------------------------------------------------------
    // TEST GROUP 7: Edge Cases, Defensive Parsing & Currency Mismatches
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Edge Cases & Defensive Numeric Handling ---');
    {
      // Missing metadata and unexpected message type
      const weirdPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    { from: 'USER_X', id: 'WAMID_X', type: 'unsupported_sticker_type', sticker: { id: 'stk_123' } }
                  ]
                }
              }
            ]
          }
        ]
      };

      const parsed = parseWebhookPayload(weirdPayload);
      assert(parsed.length === 1, 'Unexpected message type is captured without crashing');
      assert(parsed[0].phoneNumberId === null, 'Missing metadata safely defaults to null phoneNumberId');
      assert(parsed[0].unhandledType === 'unsupported_sticker_type', 'Identifies unhandled message type safely');
    }

    {
      // Coordinate edge cases: 0.0 latitude (equator) and string coordinates
      assert(safeParseCoordinate(0) === 0, 'safeParseCoordinate correctly preserves numeric 0');
      assert(safeParseCoordinate('0') === 0, 'safeParseCoordinate correctly preserves string "0"');
      assert(safeParseCoordinate('19.123') === 19.123, 'safeParseCoordinate parses string float');
      assert(safeParseCoordinate('invalid') === null, 'safeParseCoordinate returns null for non-numeric string');
      assert(safeParseCoordinate(null) === null, 'safeParseCoordinate returns null for null');
    }

    {
      // Defensive order handling: negative quantity, invalid price, currency mismatch
      const badOrderPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'PN_TEST' },
                  messages: [
                    {
                      from: 'USER_1',
                      id: 'WAMID_ORDER_ERR',
                      type: 'order',
                      order: {
                        catalog_id: 'CAT_1',
                        product_items: [
                          { product_retailer_id: 'ITEM_1', quantity: -5, item_price: -50, currency: 'INR' },
                          { product_retailer_id: 'ITEM_2', quantity: 'invalid', item_price: 'abc', currency: 'USD' }
                        ]
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      };

      const parsed = parseWebhookPayload(badOrderPayload);
      assert(parsed.length === 1, 'Malformed order parsed without NaN crashes');
      const order = parsed[0].order;
      assert(order.items[0].quantity === 1, 'Negative quantity safely normalized to 1');
      assert(order.items[0].unitPrice === 0, 'Negative price safely normalized to 0');
      assert(order.items[1].quantity === 1, 'Invalid quantity safely normalized to 1');
      assert(order.items[1].unitPrice === 0, 'Non-numeric price safely normalized to 0');
      assert(order.calculatedSubtotal === 0, 'Subtotal is a clean number (0), not NaN');
      assert(order.currencyMismatch === true, 'Conflicting currencies (INR vs USD) flagged as currencyMismatch');
    }

    // -------------------------------------------------------------
    // TEST GROUP 8: Logger Secret Redaction
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 8: Logger Secret Redaction ---');
    {
      const sensitiveContext = {
        normalField: 'visible_data',
        appSecret: 'super_secret_meta_key_12345',
        accessToken: 'EAABwz_secret_bearer_token',
        verify_token: 'my_secret_verify_token',
        authorization: 'Bearer secret_token',
        password: 'db_password_123',
        signature: 'sha256=secret_hash_value',
        nested: {
          secret_key: 'nested_secret',
          safe_val: 42
        },
        items: [
          { token: 'item_token_secret', name: 'safe_item' }
        ]
      };

      const sanitized = logger.sanitizeForLogging(sensitiveContext);
      assert(sanitized.normalField === 'visible_data', 'Non-sensitive field is preserved');
      assert(sanitized.appSecret === '[REDACTED]', 'appSecret is redacted');
      assert(sanitized.accessToken === '[REDACTED]', 'accessToken is redacted');
      assert(sanitized.verify_token === '[REDACTED]', 'verify_token is redacted');
      assert(sanitized.authorization === '[REDACTED]', 'authorization header is redacted');
      assert(sanitized.password === '[REDACTED]', 'password is redacted');
      assert(sanitized.signature === '[REDACTED]', 'signature is redacted');
      assert(sanitized.nested.secret_key === '[REDACTED]', 'Nested secret key is redacted');
      assert(sanitized.nested.safe_val === 42, 'Nested safe value is preserved');
      assert(sanitized.items[0].token === '[REDACTED]', 'Array item token is redacted');
      assert(sanitized.items[0].name === 'safe_item', 'Array item safe value is preserved');
    }

    // -------------------------------------------------------------
    // TEST GROUP 9: Environment Variable Validation
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 9: Environment Configuration Validation ---');
    {
      // Test missing keys detection
      const missingKeys = config.validateConfig({
        nodeEnv: 'development',
        meta: { verifyToken: '', appSecret: '' }
      });
      assert(missingKeys.includes('META_VERIFY_TOKEN'), 'Detects missing META_VERIFY_TOKEN');
      assert(missingKeys.includes('META_APP_SECRET'), 'Detects missing META_APP_SECRET');

      // Test production throw
      let threwInProd = false;
      try {
        config.validateConfig({
          nodeEnv: 'production',
          meta: { verifyToken: '', appSecret: '' }
        });
      } catch (err) {
        threwInProd = err.message.includes('[CONFIG ERROR]');
      }
      assert(threwInProd, 'Throws fatal error in production when secrets are missing');
    }

    // -------------------------------------------------------------
    // TEST GROUP 10: Asynchronous Webhook Error Resilience
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 10: Asynchronous Event Handling Resilience ---');
    {
      // Send a valid POST with an empty or non-message object, verify it returns 200 without hanging
      const nonMsgPayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [] }] });
      const signature = computeSignature(nonMsgPayload, config.meta.appSecret);
      const res = await makeRequest({
        method: 'POST',
        path: '/api/webhook',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': signature
        },
        body: nonMsgPayload
      });
      assert(res.statusCode === 200, 'Payload with empty changes acknowledges HTTP 200 cleanly');
      assert(res.body === 'EVENT_RECEIVED', 'Returns EVENT_RECEIVED');
    }

  } finally {
    // -------------------------------------------------------------
    // Server Shutdown Test
    // -------------------------------------------------------------
    await new Promise((resolve) => {
      server.close(() => {
        console.log('\n--- Server Shutdown ---');
        assert(!server.listening, 'Server terminates cleanly during shutdown');
        resolve();
      });
    });
  }

  console.log('\n============================================================');
  console.log(`   STAGE 1.5 AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal audit test error:', err);
  process.exit(1);
});
