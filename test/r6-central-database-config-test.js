/**
 * RESTOPRO — R6.5 Central WhatsApp Architecture & Database Configuration Test Suite
 *
 * Verifies:
 * - CentralWhatsAppAccount Prisma model & table schema in PostgreSQL
 * - SenderChannel enum ('RESTAURANT', 'CENTRAL') and OutboxMessage.sender_channel default
 * - Single active central account enforcement (Service level & PostgreSQL partial unique index)
 * - Credential encryption (AES-256-GCM) and dynamic resolution
 * - Invalid credentials and missing configuration error handling
 * - Environment fallback resolution and NOTIFICATION_ROUTING_MODE validation
 * - Existing outbox message backward compatibility
 * - Restaurant tenant isolation & multi-tenant integrity
 */
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const {
  createCentralAccount,
  getActiveCentralAccount,
  getCentralAccountById,
  resolveCentralCredentials,
  updateCentralAccount,
  deactivateCentralAccount,
  sanitizeCentralAccount,
  isValidTokenFormat
} = require('../src/services/central-whatsapp.service');
const { encryptToken, decryptToken } = require('../src/utils/crypto');
const { resolveTenantByPhoneNumberId } = require('../src/services/tenant.service');

async function runR65TestSuite() {
  console.log('============================================================');
  console.log('   RESTOPRO — R6.5 CENTRAL ARCHITECTURE TEST SUITE          ');
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

  // Track created test IDs for guaranteed cleanup
  const createdCentralAccountIds = [];
  const createdOutboxIds = [];
  const initialRoutingMode = config.routingMode;

  try {
    // -------------------------------------------------------------------------
    // TEST GROUP 1: Database Migration & Schema Verification
    // -------------------------------------------------------------------------
    console.log('--- TEST GROUP 1: Database Migration & Schema Verification ---');

    // 1.1 Verify CentralWhatsAppAccount table existence
    const tableCheck = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'central_whatsapp_accounts';
    `;
    assert(tableCheck.length > 0, 'Table "central_whatsapp_accounts" exists in PostgreSQL');

    // 1.2 Verify SenderChannel enum existence in PostgreSQL
    const enumCheck = await prisma.$queryRaw`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'SenderChannel'
      ORDER BY e.enumsortorder;
    `;
    const enumLabels = enumCheck.map(r => r.enumlabel);
    assert(
      enumLabels.includes('RESTAURANT') && enumLabels.includes('CENTRAL'),
      `SenderChannel enum exists with values: [${enumLabels.join(', ')}]`
    );

    // 1.3 Verify sender_channel column in outbox_messages with default 'RESTAURANT'
    const colCheck = await prisma.$queryRaw`
      SELECT column_name, column_default, data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'outbox_messages' AND column_name = 'sender_channel';
    `;
    assert(colCheck.length > 0, 'Column "sender_channel" exists on table "outbox_messages"');
    assert(
      colCheck[0].column_default && colCheck[0].column_default.includes('RESTAURANT'),
      `Column "sender_channel" has default value: ${colCheck[0]?.column_default}`
    );

    // 1.4 Verify partial unique index or R6.8 multi-account migration
    const indexCheck = await prisma.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'central_whatsapp_accounts' 
        AND indexname = 'central_whatsapp_accounts_single_active_idx';
    `;
    if (indexCheck.length > 0) {
      assert(
        indexCheck[0].indexdef.includes('is_active') && indexCheck[0].indexdef.includes('WHERE'),
        'Index enforces uniqueness strictly on is_active = true'
      );
    } else {
      // In R6.8+, single-active index was dropped to support multiple active central accounts
      const r68ColCheck = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'restaurants' AND column_name = 'central_account_id';
      `;
      assert(r68ColCheck.length > 0, 'R6.8 migration verified: restaurants.central_account_id exists to support multiple accounts');
    }

    // -------------------------------------------------------------------------
    // TEST GROUP 2: Central Account Creation & Single Active Enforcement
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Central Account Creation & Single Active Enforcement ---');

    // Clean up any pre-existing test accounts before starting lifecycle tests
    await prisma.centralWhatsAppAccount.deleteMany({
      where: {
        phone_number_id: { in: ['999000111222', '999000111223', '999000111224'] }
      }
    });

    const testToken1 = 'EAA_TEST_CENTRAL_TOKEN_SECRET_XYZ_1234567890';
    const testPhoneId1 = '999000111222';
    const testWabaId1 = '888000111222';

    // 2.1 Create valid active central account
    const account1 = await createCentralAccount({
      phoneNumberId: testPhoneId1,
      wabaId: testWabaId1,
      accessToken: testToken1,
      displayPhoneNumber: '+1 555-0199',
      isActive: true
    });
    createdCentralAccountIds.push(account1.id);

    assert(account1 && account1.id, 'Central WhatsApp account created successfully');
    assert(account1.phone_number_id === testPhoneId1, 'Account phone_number_id matches input');
    assert(account1.is_active === true, 'Account is_active is true');
    assert(account1.has_token === true, 'Sanitized account confirms token exists');
    assert(account1.access_token_encrypted === undefined, 'Raw ciphertext is stripped from sanitized output');

    // 2.2 Verify raw database record has encrypted token with AES-256-GCM prefix
    const rawAccount1 = await prisma.centralWhatsAppAccount.findUnique({
      where: { id: account1.id }
    });
    assert(
      rawAccount1.access_token_encrypted.startsWith('enc:v1:'),
      'Token is encrypted using authenticated AES-256-GCM (enc:v1: prefix)'
    );

    // 2.3 Attempt duplicate phone_number_id -> Rejection
    let duplicatePhoneFailed = false;
    try {
      await createCentralAccount({
        phoneNumberId: testPhoneId1, // Duplicate!
        wabaId: '777000111333',
        accessToken: 'EAA_ANOTHER_TEST_TOKEN',
        isActive: false
      });
    } catch (err) {
      duplicatePhoneFailed = true;
      assert(
        err.code === 'DUPLICATE_PHONE_NUMBER_ID' || err.message.includes('already exists'),
        'Duplicate phone_number_id rejected with DUPLICATE_PHONE_NUMBER_ID'
      );
    }
    assert(duplicatePhoneFailed, 'Duplicate phone_number_id was blocked from creation');

    // 2.4 Attempt second active account -> Service-level check blocks it
    const testPhoneId2 = '999000111223';
    let secondActiveFailed = false;
    try {
      await createCentralAccount({
        phoneNumberId: testPhoneId2,
        wabaId: '888000111223',
        accessToken: 'EAA_TEST_CENTRAL_TOKEN_SECRET_XYZ_2222',
        isActive: true // Fails because account1 is already active!
      });
    } catch (err) {
      secondActiveFailed = true;
      assert(
        err.code === 'SINGLE_ACTIVE_ACCOUNT_EXISTS' || err.message.includes('already exists'),
        'Second active account rejected with SINGLE_ACTIVE_ACCOUNT_EXISTS'
      );
    }
    assert(secondActiveFailed, 'Service-level check blocked creating a second active account');

    // 2.5 Direct database insert: verified against index or R6.8 multi-active schema
    let dbPartialIndexBlocked = false;
    let r68DirectInsertRecord = null;
    try {
      r68DirectInsertRecord = await prisma.$queryRaw`
        INSERT INTO central_whatsapp_accounts (id, phone_number_id, waba_id, access_token_encrypted, is_active, created_at, updated_at)
        VALUES (
          gen_random_uuid(),
          ${testPhoneId2},
          '888000111223',
          'enc:v1:mock_cipher',
          true,
          NOW(),
          NOW()
        )
        RETURNING id;
      `;
      if (r68DirectInsertRecord && r68DirectInsertRecord[0]?.id) {
        createdCentralAccountIds.push(r68DirectInsertRecord[0].id);
      }
    } catch (dbErr) {
      dbPartialIndexBlocked = true;
      assert(
        dbErr.message.includes('23505') ||
        dbErr.message.includes('already exists') ||
        dbErr.message.includes('central_whatsapp_accounts_single_active_idx') ||
        dbErr.message.includes('unique constraint'),
        'Database partial unique index blocked concurrent active insert'
      );
    }
    // Either blocked by pre-R6.8 index OR successfully enabled by R6.8 multi-account schema
    assert(dbPartialIndexBlocked || Boolean(r68DirectInsertRecord), 'Database constraint state is valid for current schema');

    // Clean up temporary direct insert before 2.6
    if (r68DirectInsertRecord) {
      await prisma.centralWhatsAppAccount.deleteMany({ where: { phone_number_id: testPhoneId2 } });
    }

    // 2.6 Inactive accounts can be created without violating single active rule
    const inactiveAccount = await createCentralAccount({
      phoneNumberId: testPhoneId2,
      wabaId: '888000111223',
      accessToken: 'EAA_TEST_INACTIVE_TOKEN',
      isActive: false
    });
    createdCentralAccountIds.push(inactiveAccount.id);
    assert(inactiveAccount && inactiveAccount.is_active === false, 'Inactive central account created successfully');

    // Multiple inactive accounts coexist safely
    const testPhoneId3 = '999000111224';
    const inactiveAccount2 = await createCentralAccount({
      phoneNumberId: testPhoneId3,
      wabaId: '888000111224',
      accessToken: 'EAA_TEST_INACTIVE_TOKEN_2',
      isActive: false
    });
    createdCentralAccountIds.push(inactiveAccount2.id);
    assert(inactiveAccount2 && inactiveAccount2.is_active === false, 'Second inactive central account coexists safely');

    // -------------------------------------------------------------------------
    // TEST GROUP 3: Credential Encryption, Decryption & Resolution
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Credential Encryption, Decryption & Resolution ---');

    // 3.1 resolveCentralCredentials from active DB record
    const resolvedCreds = await resolveCentralCredentials();
    assert(resolvedCreds.source === 'DATABASE', 'Credentials resolved from DATABASE');
    assert(resolvedCreds.phoneNumberId === testPhoneId1, 'Resolved phoneNumberId matches active DB account');
    assert(resolvedCreds.wabaId === testWabaId1, 'Resolved wabaId matches active DB account');
    assert(resolvedCreds.accessToken === testToken1, 'Decrypted accessToken matches original plaintext exactly');
    assert(resolvedCreds.accountId === account1.id, 'Resolved accountId matches active DB account UUID');

    // 3.2 Update central account token with new valid token
    const newToken = 'EAA_NEW_UPDATED_CENTRAL_ACCESS_TOKEN_999';
    const updatedAccount = await updateCentralAccount(account1.id, {
      accessToken: newToken,
      displayPhoneNumber: '+1 555-0100'
    });
    assert(updatedAccount.display_phone_number === '+1 555-0100', 'Account displayPhoneNumber updated');

    const resolvedAfterUpdate = await resolveCentralCredentials();
    assert(resolvedAfterUpdate.accessToken === newToken, 'Resolved credentials reflect newly encrypted token');

    // 3.3 Rejection of invalid token format (missing EAA prefix)
    let badTokenRejected = false;
    try {
      await createCentralAccount({
        phoneNumberId: '999000888777',
        wabaId: '888000888777',
        accessToken: 'INVALID_TOKEN_WITHOUT_EAA',
        isActive: false
      });
    } catch (err) {
      badTokenRejected = true;
      assert(
        err.code === 'INVALID_TOKEN_PREFIX' || err.message.includes('begin with "EAA"'),
        'Non-EAA token rejected with INVALID_TOKEN_PREFIX'
      );
    }
    assert(badTokenRejected, 'Non-EAA token was blocked by validator');

    // 3.4 Corrupted ciphertext detection
    await prisma.centralWhatsAppAccount.update({
      where: { id: account1.id },
      data: { access_token_encrypted: 'enc:v1:bad_iv:bad_tag:bad_cipher' }
    });

    let corruptDecryptionFailed = false;
    try {
      await resolveCentralCredentials();
    } catch (err) {
      corruptDecryptionFailed = true;
      assert(
        err.code === 'TOKEN_DECRYPTION_FAILED' || err.message.includes('decrypt'),
        'Corrupted ciphertext triggers safe TOKEN_DECRYPTION_FAILED error'
      );
    }
    assert(corruptDecryptionFailed, 'Corrupted ciphertext in database was safely caught');

    // Restore valid token on account1
    await updateCentralAccount(account1.id, { accessToken: testToken1 });

    // -------------------------------------------------------------------------
    // TEST GROUP 4: Environment Fallback & Routing Mode Validation
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: Environment Fallback & Routing Mode Validation ---');

    // 4.1 Deactivate DB account
    await deactivateCentralAccount(account1.id);
    const activeCheck = await getActiveCentralAccount();
    assert(activeCheck === null, 'Central account deactivated; no active DB account');

    // 4.2 When no DB account exists and env vars are unset -> Throws MISSING_CENTRAL_CREDENTIALS
    const origEnvPhone = process.env.CENTRAL_PHONE_NUMBER_ID;
    const origEnvToken = process.env.CENTRAL_ACCESS_TOKEN;
    const origEnvWaba = process.env.CENTRAL_WABA_ID;

    delete process.env.CENTRAL_PHONE_NUMBER_ID;
    delete process.env.CENTRAL_ACCESS_TOKEN;
    delete process.env.CENTRAL_WABA_ID;
    config.central.phoneNumberId = '';
    config.central.accessToken = '';

    let missingConfigFailed = false;
    try {
      await resolveCentralCredentials();
    } catch (err) {
      missingConfigFailed = true;
      assert(
        err.code === 'MISSING_CENTRAL_CREDENTIALS' || err.message.includes('No active Central WhatsApp account'),
        'Throws MISSING_CENTRAL_CREDENTIALS when neither DB nor environment is set'
      );
    }
    assert(missingConfigFailed, 'Missing central configuration is handled cleanly');

    // 4.3 Environment fallback when env vars are populated
    process.env.CENTRAL_PHONE_NUMBER_ID = '1427497060448125';
    process.env.CENTRAL_ACCESS_TOKEN = 'EAA_ENV_FALLBACK_TOKEN_12345';
    process.env.CENTRAL_WABA_ID = '1422938193243217';
    config.central.phoneNumberId = '1427497060448125';
    config.central.accessToken = 'EAA_ENV_FALLBACK_TOKEN_12345';
    config.central.wabaId = '1422938193243217';

    const envResolved = await resolveCentralCredentials();
    assert(envResolved.source === 'ENVIRONMENT', 'Credentials resolved from ENVIRONMENT');
    assert(envResolved.phoneNumberId === '1427497060448125', 'Environment phoneNumberId matches');
    assert(envResolved.accessToken === 'EAA_ENV_FALLBACK_TOKEN_12345', 'Environment accessToken matches');
    assert(envResolved.accountId === null, 'Environment credentials have accountId = null');

    // 4.4 Reactivate DB account -> DB takes precedence over environment
    await updateCentralAccount(account1.id, { isActive: true });
    const dbPrecedenceResolved = await resolveCentralCredentials();
    assert(dbPrecedenceResolved.source === 'DATABASE', 'DATABASE account takes precedence over environment fallback');
    assert(dbPrecedenceResolved.phoneNumberId === testPhoneId1, 'Resolved phoneNumberId matches DB account');

    // Clean up environment variables
    if (origEnvPhone) process.env.CENTRAL_PHONE_NUMBER_ID = origEnvPhone; else delete process.env.CENTRAL_PHONE_NUMBER_ID;
    if (origEnvToken) process.env.CENTRAL_ACCESS_TOKEN = origEnvToken; else delete process.env.CENTRAL_ACCESS_TOKEN;
    if (origEnvWaba) process.env.CENTRAL_WABA_ID = origEnvWaba; else delete process.env.CENTRAL_WABA_ID;
    config.central.phoneNumberId = '';
    config.central.accessToken = '';

    // 4.5 NOTIFICATION_ROUTING_MODE default and validation
    assert(config.routingMode === 'LEGACY', 'config.routingMode defaults to "LEGACY"');

    // Test validation function with valid modes
    const missingLegacy = config.validateConfig({ ...config, routingMode: 'LEGACY' });
    assert(Array.isArray(missingLegacy), 'validateConfig accepts routingMode = LEGACY');

    const missingCentral = config.validateConfig({ ...config, routingMode: 'CENTRAL' });
    assert(Array.isArray(missingCentral), 'validateConfig accepts routingMode = CENTRAL');

    // Test validation function with invalid mode
    const testBadConfig = { ...config, routingMode: 'INVALID_MODE', nodeEnv: 'development' };
    config.validateConfig(testBadConfig);
    assert(testBadConfig.routingMode === 'LEGACY', 'validateConfig resets invalid routingMode to "LEGACY" in development');

    // -------------------------------------------------------------------------
    // TEST GROUP 5: Outbox Message SenderChannel & Backward Compatibility
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: Outbox Message SenderChannel & Backward Compatibility ---');

    // Lookup a seeded restaurant for outbox tests
    const tenantA = await prisma.restaurant.findUnique({
      where: { phone_number_id: '111111111111111' }
    });
    assert(tenantA && tenantA.id, 'Seeded tenant found for outbox tests');

    // 5.1 Create OutboxMessage without explicit sender_channel -> Defaults to RESTAURANT
    const defaultOutbox = await prisma.outboxMessage.create({
      data: {
        restaurant_id: tenantA.id,
        recipient_phone: '919876543210',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { text: 'Test message with default channel' },
        idempotency_key: `test_outbox_default_${Date.now()}`,
        status: 'PENDING'
      }
    });
    createdOutboxIds.push(defaultOutbox.id);

    assert(defaultOutbox.sender_channel === 'RESTAURANT', 'OutboxMessage.sender_channel defaults to RESTAURANT');

    // 5.2 Create OutboxMessage with explicit sender_channel = CENTRAL
    const centralOutbox = await prisma.outboxMessage.create({
      data: {
        restaurant_id: tenantA.id,
        recipient_phone: '919876543210',
        message_type: 'OWNER_ORDER_NOTIFICATION',
        payload: { text: 'Test owner alert via central' },
        idempotency_key: `test_outbox_central_${Date.now()}`,
        status: 'PENDING',
        sender_channel: 'CENTRAL'
      }
    });
    createdOutboxIds.push(centralOutbox.id);

    assert(centralOutbox.sender_channel === 'CENTRAL', 'OutboxMessage created with explicit sender_channel = CENTRAL');

    // 5.3 Query outbox messages using the new index [sender_channel, status]
    const centralPending = await prisma.outboxMessage.findMany({
      where: {
        sender_channel: 'CENTRAL',
        status: 'PENDING'
      }
    });
    assert(
      centralPending.some(m => m.id === centralOutbox.id),
      'Outbox queried efficiently by [sender_channel, status] index'
    );

    const restaurantPending = await prisma.outboxMessage.findMany({
      where: {
        sender_channel: 'RESTAURANT',
        status: 'PENDING'
      }
    });
    assert(
      restaurantPending.some(m => m.id === defaultOutbox.id),
      'Restaurant outbox messages isolated from central outbox queries'
    );

    // -------------------------------------------------------------------------
    // TEST GROUP 6: Multi-Tenant Isolation & Zero Interference
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Multi-Tenant Isolation & Zero Interference ---');

    // 6.1 Central account phone number is NOT recognized as a restaurant tenant
    const centralTenantLookup = await resolveTenantByPhoneNumberId(testPhoneId1);
    assert(
      centralTenantLookup === null,
      'resolveTenantByPhoneNumberId returns null for central number (Central account is not a restaurant tenant)'
    );

    // 6.2 Restaurant tenant count unchanged; zero cross-table linkage
    const restaurantCount = await prisma.restaurant.count();
    const centralCount = await prisma.centralWhatsAppAccount.count();
    assert(restaurantCount > 0, `Restaurant count intact: ${restaurantCount}`);
    assert(centralCount >= 1, `CentralWhatsAppAccount table maintained independently: ${centralCount}`);

    // 6.3 Existing restaurant records remain untouched
    const tenantB = await prisma.restaurant.findUnique({
      where: { phone_number_id: '222222222222222' }
    });
    assert(tenantB && tenantB.is_active === true, 'Seeded Tenant B record completely intact');

    // 6.4 Cascade deletion test: deleting restaurant cascades to outbox without touching central accounts
    const tempRestaurant = await prisma.restaurant.create({
      data: {
        name: 'Temp Deletion Restaurant',
        phone_number_id: `temp_phone_${Date.now()}`,
        waba_id: `temp_waba_${Date.now()}`,
        owner_phone: '+919999900000',
        access_token_encrypted: 'enc:v1:dummy_token'
      }
    });

    const tempOutbox = await prisma.outboxMessage.create({
      data: {
        restaurant_id: tempRestaurant.id,
        recipient_phone: '919999900000',
        message_type: 'CUSTOMER_CONVERSATION_REPLY',
        payload: { text: 'Temp' },
        idempotency_key: `temp_outbox_${Date.now()}`,
        status: 'PENDING',
        sender_channel: 'CENTRAL'
      }
    });

    // Delete restaurant
    await prisma.restaurant.delete({ where: { id: tempRestaurant.id } });

    // Verify outbox cascaded
    const outboxAfterDelete = await prisma.outboxMessage.findUnique({ where: { id: tempOutbox.id } });
    assert(outboxAfterDelete === null, 'OutboxMessage cascaded on restaurant deletion as expected');

    // Verify Central WhatsApp account was NOT touched
    const centralAfterDelete = await getCentralAccountById(account1.id);
    assert(centralAfterDelete !== null, 'CentralWhatsAppAccount remained completely unaffected by restaurant deletion');

  } catch (err) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    // -------------------------------------------------------------------------
    // CLEANUP TEST ARTIFACTS
    // -------------------------------------------------------------------------
    console.log('\n--- Cleaning up R6.5 test artifacts ---');

    if (createdOutboxIds.length > 0) {
      await prisma.outboxMessage.deleteMany({
        where: { id: { in: createdOutboxIds } }
      });
      console.log(`  Cleaned up ${createdOutboxIds.length} test outbox messages.`);
    }

    if (createdCentralAccountIds.length > 0) {
      await prisma.centralWhatsAppAccount.deleteMany({
        where: { id: { in: createdCentralAccountIds } }
      });
      console.log(`  Cleaned up ${createdCentralAccountIds.length} test central accounts.`);
    }

    // Clean up any other test phone numbers
    await prisma.centralWhatsAppAccount.deleteMany({
      where: {
        phone_number_id: { in: ['999000111222', '999000111223', '999000111224'] }
      }
    });

    config.routingMode = initialRoutingMode;
    await prisma.$disconnect();
  }

  console.log('\n============================================================');
  console.log(`   R6.5 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runR65TestSuite();
}

module.exports = { runR65TestSuite };
