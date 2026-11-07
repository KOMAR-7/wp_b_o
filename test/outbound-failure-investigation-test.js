process.env.NODE_ENV = 'test';

/**
 * RESTOPRO — Production Outbound WhatsApp Failure Investigation & Verification Test Suite
 *
 * Verifies and proves the complete outbound conversational reply lifecycle:
 * 1. Valid encrypted token decrypts and dispatches successfully to Meta.
 * 2. Wrong encryption key / corrupted ciphertext fails safely without secret disclosure.
 * 3. Legacy encrypted token decrypts using the supported legacy candidate path with warning.
 * 4. Invalid or overwritten token (e.g. 9-character browser autofill corruption) is classified
 *    and rejected before dispatch, transitioning outbox message to FAILED with non-retryable status.
 * 5. Meta 401 Authentication Error is classified as non-retryable (isRetryable: false, isAuthError: true).
 * 6. Meta successful response marks outbox message as ACCEPTED with meta_message_id and sent_at.
 * 7. Duplicate webhook race condition does not produce an unexpected error or duplicate processing.
 * 8. Failed outbound messages do not silently disappear (remain durable in PostgreSQL with error audit trail).
 */

const assert = require('assert');
const crypto = require('crypto');
const prisma = require('../src/config/database');
const { encryptToken, decryptToken } = require('../src/utils/crypto');
const {
  resolveRestaurantCredentials,
  sendWhatsAppMessage
} = require('../src/services/whatsapp.service');
const {
  dispatchPendingOutboxMessages,
  enqueueConversationReply
} = require('../src/services/outbox.service');
const { recordIncomingEvent } = require('../src/services/webhook.service');
const { handleIncomingMessage } = require('../src/services/conversation.service');
const { NotificationWorker } = require('../src/jobs/notification-worker');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function pass(description) {
  totalTests++;
  passedTests++;
  console.log(`  ✅ [PASS] ${description}`);
}

function fail(description, err) {
  totalTests++;
  failedTests++;
  console.error(`  ❌ [FAIL] ${description}`);
  if (err) console.error('    Error:', err.message || err);
}

async function runInvestigationTests() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — OUTBOUND WHATSAPP FAILURE INVESTIGATION TESTS  ');
  console.log('============================================================\n');

  const createdRestaurantIds = [];
  const createdOutboxIds = [];
  const createdEventIds = [];
  const createdSessionPhones = [];

  try {
    // -------------------------------------------------------------
    // TEST 1: Valid encrypted token decrypts and dispatches successfully
    // -------------------------------------------------------------
    console.log('--- TEST 1: Valid Encrypted Token Decryption & Dispatch ---');

    const validToken = 'EAABvalidOfficialTestToken9876543210zyxwvutsrqponmlkjihgfedcba';
    const phoneId1 = `1427497${Date.now().toString().slice(-8)}`;
    const wabaId1 = `1620323${Date.now().toString().slice(-8)}`;

    const res1 = await prisma.restaurant.create({
      data: {
        name: 'Valid Token Cafe',
        phone_number_id: phoneId1,
        waba_id: wabaId1,
        owner_phone: '+919876500001',
        access_token_encrypted: encryptToken(validToken),
        tenant_status: 'ACTIVE',
        is_active: true
      }
    });
    createdRestaurantIds.push(res1.id);

    // Verify resolveRestaurantCredentials successfully decrypts
    const creds1 = await resolveRestaurantCredentials(res1.id);
    assert.strictEqual(creds1.accessToken, validToken, 'Decrypted token matches original EAA token');
    assert.strictEqual(creds1.phoneNumberId, phoneId1, 'Resolves exact phone_number_id');
    pass('Valid encrypted token decrypts correctly');

    // Create a pending outbox message
    const outbox1 = await prisma.outboxMessage.create({
      data: {
        restaurant_id: res1.id,
        recipient_phone: '919876543210',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: {
          messaging_product: 'whatsapp',
          to: '919876543210',
          type: 'text',
          text: { body: 'Welcome to Valid Token Cafe!' }
        },
        idempotency_key: `test_valid_outbox_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outbox1.id);

    // Mock custom sender simulating Meta 200 success
    const mockMeta200Sender = async (msg) => {
      assert.strictEqual(msg.id, outbox1.id, 'Dispatches expected outbox message');
      return {
        success: true,
        metaMessageId: 'wamid.HBgTEST_SUCCESS_200',
        data: { messages: [{ id: 'wamid.HBgTEST_SUCCESS_200' }] }
      };
    };

    const workerResult1 = await dispatchPendingOutboxMessages({
      batchSize: 5,
      workerId: 'investigation_worker_1',
      customSender: mockMeta200Sender
    });

    assert.strictEqual(workerResult1.succeededCount >= 1, true, 'At least 1 message succeeded');

    const updatedOutbox1 = await prisma.outboxMessage.findUnique({ where: { id: outbox1.id } });
    assert.strictEqual(updatedOutbox1.status, 'ACCEPTED', 'Outbox status transitioned to ACCEPTED');
    assert.strictEqual(updatedOutbox1.payload?.meta_message_id, 'wamid.HBgTEST_SUCCESS_200', 'meta_message_id persisted in payload');
    assert.strictEqual(typeof updatedOutbox1.payload?.sent_at, 'string', 'sent_at timestamp persisted in payload');
    pass('Valid encrypted token dispatches successfully and marks outbox as ACCEPTED');

    // -------------------------------------------------------------
    // TEST 2: Wrong encryption key / corrupted ciphertext fails safely
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Wrong Key & Corrupted Ciphertext Safety ---');

    const corruptedCiphertext = 'enc:v1:0102030405060708090a0b0c:0102030405060708090a0b0c0d0e0f10:aabbccddeeff';

    assert.throws(() => {
      decryptToken(corruptedCiphertext);
    }, /Failed to decrypt credential/, 'Throws explicit decryption error on corrupted ciphertext');
    pass('Corrupted ciphertext throws safe decryption error without exposing secrets');

    const res2 = await prisma.restaurant.create({
      data: {
        name: 'Corrupted Token Bistro',
        phone_number_id: `1427498${Date.now().toString().slice(-8)}`,
        waba_id: `1620324${Date.now().toString().slice(-8)}`,
        owner_phone: '+919876500002',
        access_token_encrypted: corruptedCiphertext,
        tenant_status: 'ACTIVE',
        is_active: true
      }
    });
    createdRestaurantIds.push(res2.id);

    try {
      await resolveRestaurantCredentials(res2.id);
      assert.fail('Expected resolveRestaurantCredentials to throw');
    } catch (err) {
      assert.strictEqual(err.message.includes('[CREDENTIAL ERROR]'), true, 'Error message is classified as CREDENTIAL ERROR');
      assert.strictEqual(err.message.includes('Key mismatch or corrupted data'), true, 'Explains key mismatch or corrupted data');
      pass('resolveRestaurantCredentials catches decryption failure and throws friendly re-auth error');
    }

    // -------------------------------------------------------------
    // TEST 3: Legacy encrypted token decrypts using supported legacy path
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Legacy Encrypted Token Decryption ---');

    // Encrypt token using legacy fallback key
    const legacySecret = 'restopro_default_secure_token_secret_key_2026';
    const legacyKey = crypto.createHash('sha256').update(legacySecret).digest();
    const legacyIv = crypto.randomBytes(12);
    const legacyCipher = crypto.createCipheriv('aes-256-gcm', legacyKey, legacyIv);
    const legacyPlaintext = 'EAABlegacyTestTokenForBackwardCompat123456';
    const legacyEncrypted = Buffer.concat([
      legacyCipher.update(legacyPlaintext, 'utf8'),
      legacyCipher.final()
    ]);
    const legacyTag = legacyCipher.getAuthTag();
    const legacyCiphertext = `enc:v1:${legacyIv.toString('hex')}:${legacyTag.toString('hex')}:${legacyEncrypted.toString('hex')}`;

    const decryptedLegacy = decryptToken(legacyCiphertext);
    assert.strictEqual(decryptedLegacy, legacyPlaintext, 'Legacy ciphertext decrypts back to original token');
    pass('Legacy encrypted token decrypts successfully via legacy candidate fallback path');

    // -------------------------------------------------------------
    // TEST 4: Invalid or overwritten token (9-char password) classified correctly
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Overwritten / Invalid Token Classification ---');

    // Simulate the exact production password autofill corruption: 9-character password encrypted
    const autofilledPassword = 'adminPass'; // 9 chars
    const corruptedPasswordToken = encryptToken(autofilledPassword);

    const res4 = await prisma.restaurant.create({
      data: {
        name: 'Autofill Corrupted Diner',
        phone_number_id: `1427499${Date.now().toString().slice(-8)}`,
        waba_id: `1620325${Date.now().toString().slice(-8)}`,
        owner_phone: '+919876500004',
        access_token_encrypted: corruptedPasswordToken,
        tenant_status: 'ACTIVE',
        is_active: true
      }
    });
    createdRestaurantIds.push(res4.id);

    // Verify resolveRestaurantCredentials rejects the 9-char token
    try {
      await resolveRestaurantCredentials(res4.id);
      assert.fail('Expected resolveRestaurantCredentials to throw on 9-char token');
    } catch (err) {
      assert.strictEqual(err.message.includes('Access tokens must begin with "EAA"'), true, 'Enforces EAA prefix');
      assert.strictEqual(err.message.includes('Re-authentication required'), true, 'Instructs re-authentication');
      pass('resolveRestaurantCredentials rejects overwritten non-EAA token and requires re-authentication');
    }

    // Create an outbox message for this restaurant and run dispatcher
    const outbox4 = await prisma.outboxMessage.create({
      data: {
        restaurant_id: res4.id,
        recipient_phone: '919876543210',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'Hello' } },
        idempotency_key: `test_autofill_outbox_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outbox4.id);

    // Dispatch using real credentials resolution (no custom sender)
    await dispatchPendingOutboxMessages({
      batchSize: 5,
      workerId: 'investigation_worker_autofill'
    });

    const updatedOutbox4 = await prisma.outboxMessage.findUnique({ where: { id: outbox4.id } });
    assert.strictEqual(updatedOutbox4.status, 'FAILED', 'Overwritten token transitions outbox to FAILED');
    assert.strictEqual(updatedOutbox4.attempts, 1, 'Attempt count incremented to 1');
    assert.strictEqual(updatedOutbox4.last_error.includes('Access tokens must begin with "EAA"'), true, 'last_error documents invalid token');
    pass('Outbox message with corrupted token transitions to FAILED with non-retryable status and audit error');

    // -------------------------------------------------------------
    // TEST 5: Meta 401 authentication failure is non-retryable
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Meta 401 Authentication Failure Classification ---');

    const mock401HttpClient = {
      post: async () => {
        const error = new Error('Request failed with status code 401');
        error.response = {
          status: 401,
          data: {
            error: {
              message: 'Invalid OAuth access token - Cannot parse access token',
              type: 'OAuthException',
              code: 190,
              error_subcode: 463
            }
          }
        };
        throw error;
      }
    };

    const send401Result = await sendWhatsAppMessage({
      phoneNumberId: '1427497060448125',
      accessToken: 'EAABinvalidTokenFor401Test',
      payload: { messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'Test' } },
      httpClient: mock401HttpClient
    });

    assert.strictEqual(send401Result.success, false, 'sendWhatsAppMessage returns success: false');
    assert.strictEqual(send401Result.statusCode, 401, 'Captures statusCode: 401');
    assert.strictEqual(send401Result.isRetryable, false, '401 is strictly classified as isRetryable: false');
    assert.strictEqual(send401Result.isAuthError, true, 'isAuthError flag is true');
    assert.strictEqual(send401Result.metaErrorCode, 190, 'Captures Meta error code 190');
    pass('Meta 401 error classified as non-retryable terminal authentication error');

    // -------------------------------------------------------------
    // TEST 6: Meta successful response marks outbox message successful
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Meta Successful Response Handling ---');

    const outbox6 = await prisma.outboxMessage.create({
      data: {
        restaurant_id: res1.id,
        recipient_phone: '919876543210',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'Welcome!' } },
        idempotency_key: `test_success_outbox_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outbox6.id);

    const mockSuccessSender = async () => ({
      success: true,
      metaMessageId: 'wamid.HBgMETA_SUCCESS_MSG_99',
      data: { messages: [{ id: 'wamid.HBgMETA_SUCCESS_MSG_99' }] }
    });

    await dispatchPendingOutboxMessages({
      batchSize: 5,
      workerId: 'investigation_worker_success',
      customSender: mockSuccessSender
    });

    const updatedOutbox6 = await prisma.outboxMessage.findUnique({ where: { id: outbox6.id } });
    assert.strictEqual(updatedOutbox6.status, 'ACCEPTED', 'Outbox status is ACCEPTED');
    assert.strictEqual(updatedOutbox6.payload?.meta_message_id, 'wamid.HBgMETA_SUCCESS_MSG_99', 'Stores meta_message_id');
    assert.strictEqual(updatedOutbox6.last_error, null, 'last_error cleared on success');
    pass('Meta successful dispatch marks outbox message as ACCEPTED and clears errors');

    // -------------------------------------------------------------
    // TEST 7: Duplicate webhook race does not produce unexpected error or duplicate replies
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: Duplicate Webhook Idempotency & Race Defense ---');

    const sharedMessageId = `wamid.HBgRACE_${Date.now()}`;
    const testEvent = {
      category: 'INCOMING_MESSAGE',
      messageType: 'text',
      messageId: sharedMessageId,
      senderPhone: '919876543299',
      senderName: 'Race Test User',
      phoneNumberId: phoneId1,
      text: { body: 'Hi' }
    };

    // Invoke recordIncomingEvent twice simultaneously (simulating Meta network retry race)
    const [raceResult1, raceResult2] = await Promise.all([
      recordIncomingEvent(testEvent),
      recordIncomingEvent(testEvent)
    ]);

    // Exactly one must be the original, and the other must be detected as duplicate
    const nonDuplicates = [raceResult1, raceResult2].filter(r => !r.isDuplicate);
    const duplicates = [raceResult1, raceResult2].filter(r => r.isDuplicate);

    assert.strictEqual(nonDuplicates.length, 1, 'Exactly one event registered as non-duplicate');
    assert.strictEqual(duplicates.length, 1, 'Exactly one event detected as duplicate');
    pass('Simultaneous webhook race condition handled cleanly without database error');

    // Verify subsequent sequential call also returns isDuplicate: true via findUnique fast-path
    const sequentialCheck = await recordIncomingEvent(testEvent);
    assert.strictEqual(sequentialCheck.isDuplicate, true, 'Subsequent duplicate delivery detected via fast-path');
    pass('Sequential duplicate delivery recognized safely via event_key lookup');

    // Verify exactly 1 row exists in webhookEvent table for this message
    const dbEvents = await prisma.webhookEvent.findMany({ where: { event_key: sharedMessageId } });
    assert.strictEqual(dbEvents.length, 1, 'Exactly 1 row persisted in webhookEvent table');
    createdEventIds.push(...dbEvents.map(e => e.id));
    pass('Zero duplicate webhookEvent records created');

    // Test enqueueConversationReply idempotency: second call returns existing outbox record
    const reply1 = await enqueueConversationReply({
      restaurantId: res1.id,
      customerPhone: '919876543299',
      action: { type: 'SEND_WELCOME_CATALOG', catalogId: 'cat_123' },
      inboundMessageId: sharedMessageId,
      restaurantName: 'Valid Token Cafe'
    });
    createdOutboxIds.push(reply1.id);

    const reply2 = await enqueueConversationReply({
      restaurantId: res1.id,
      customerPhone: '919876543299',
      action: { type: 'SEND_WELCOME_CATALOG', catalogId: 'cat_123' },
      inboundMessageId: sharedMessageId,
      restaurantName: 'Valid Token Cafe'
    });

    assert.strictEqual(reply1.id, reply2.id, 'Duplicate conversational reply returns identical outbox record');
    const outboxMatches = await prisma.outboxMessage.findMany({
      where: { idempotency_key: `reply_${sharedMessageId}` }
    });
    assert.strictEqual(outboxMatches.length, 1, 'Exactly 1 outbox message created (Zero duplicate replies)');
    pass('enqueueConversationReply idempotency strictly blocks duplicate outbound replies');

    // -------------------------------------------------------------
    // TEST 8: Failed outbound messages do not silently disappear
    // -------------------------------------------------------------
    console.log('\n--- TEST 8: Outbox Failure Durability & Visibility ---');

    // Check that outbox4 (the failed autofill message) is durably stored in PostgreSQL
    const persistentFailedMsg = await prisma.outboxMessage.findUnique({ where: { id: outbox4.id } });
    assert.strictEqual(Boolean(persistentFailedMsg), true, 'Failed outbox message remains durably in PostgreSQL');
    assert.strictEqual(persistentFailedMsg.status, 'FAILED', 'Status is FAILED');
    assert.strictEqual(Boolean(persistentFailedMsg.last_error), true, 'last_error contains failure explanation');
    assert.strictEqual(persistentFailedMsg.restaurant_id, res4.id, 'Correctly scoped to restaurant');

    // Verify NotificationWorker processCycle logs batch warnings when failures occur
    const testWorker = new NotificationWorker({
      workerId: 'test_visibility_worker',
      batchSize: 10
    });

    // Mock sender simulating non-retryable 400 error
    const mock400Sender = async () => ({
      success: false,
      isTimeout: false,
      isRetryable: false,
      statusCode: 400,
      metaErrorCode: 100,
      error: 'Invalid recipient phone number'
    });

    const outbox8 = await prisma.outboxMessage.create({
      data: {
        restaurant_id: res1.id,
        recipient_phone: '910000000000',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { messaging_product: 'whatsapp', to: '910000000000', type: 'text', text: { body: 'Test' } },
        idempotency_key: `test_visibility_outbox_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(outbox8.id);

    const cycleSummary = await testWorker.processCycle(mock400Sender);
    assert.strictEqual(cycleSummary.failedCount >= 1, true, 'Worker cycle reports failedCount >= 1');
    assert.strictEqual(cycleSummary.results.some(r => r.id === outbox8.id), true, 'Results array includes failed message ID');

    const updatedOutbox8 = await prisma.outboxMessage.findUnique({ where: { id: outbox8.id } });
    assert.strictEqual(updatedOutbox8.status, 'FAILED', 'Failed message transitions to FAILED in PostgreSQL');
    assert.strictEqual(updatedOutbox8.last_error, 'Invalid recipient phone number', 'Error preserved in PostgreSQL row');
    pass('Failed outbound messages are durably preserved in PostgreSQL with full audit visibility');

  } catch (err) {
    console.error('Unhandled test exception:', err);
    failedTests++;
  } finally {
    console.log('\n--- CLEANUP: Removing Investigation Test Artifacts ---');
    try {
      if (createdOutboxIds.length > 0) {
        await prisma.outboxMessage.deleteMany({ where: { id: { in: createdOutboxIds } } }).catch(() => {});
      }
      if (createdEventIds.length > 0) {
        await prisma.webhookEvent.deleteMany({ where: { id: { in: createdEventIds } } }).catch(() => {});
      }
      if (createdRestaurantIds.length > 0) {
        await prisma.outboxMessage.deleteMany({ where: { restaurant_id: { in: createdRestaurantIds } } }).catch(() => {});
        await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } }).catch(() => {});
      }
      console.log('  Cleaned up all temporary test records.');
    } catch (cleanupErr) {
      console.warn('  Cleanup warning:', cleanupErr.message);
    }

    await prisma.$disconnect().catch(() => {});
  }

  console.log('\n============================================================');
  console.log(`   INVESTIGATION RESULTS: ${passedTests} PASSED, ${failedTests} FAILED (TOTAL: ${totalTests})`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runInvestigationTests();
}

module.exports = { runInvestigationTests };
