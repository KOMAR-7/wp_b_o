/**
 * RESTOPRO — Central WhatsApp Business Account Management Service
 * R6.5 & R6.8 Multi-Account Central WhatsApp Architecture Implementation
 *
 * Implements:
 * - Multi-account support with explicit restaurant-to-central-account mappings
 * - Secure Central WhatsApp credential storage with AES-256-GCM encryption
 * - Account lifecycle: Create, List, View, Update, Test Connection, Activate, Deactivate, Safe Delete
 * - Safe sanitization preventing credential exposure in logs and API responses
 * - Dynamic central credential resolution (Restaurant-mapped account -> Global active -> Environment fallback)
 */
const prisma = require('../config/database');
const config = require('../config/env');
const logger = require('../utils/logger');
const { encryptToken, decryptToken } = require('../utils/crypto');
const { verifyMetaWhatsAppToken } = require('./whatsapp.service');

/**
 * Validates that an access token string meets Meta WhatsApp Cloud API standards.
 * @param {string} token
 * @returns {boolean}
 */
function isValidTokenFormat(token) {
  if (!token || typeof token !== 'string') return false;
  const trimmed = token.trim().replace(/^["']|["']$/g, '');
  return (
    trimmed.startsWith('EAA') ||
    trimmed.startsWith('mock_') ||
    trimmed.startsWith('EAAB')
  );
}

/**
 * Sanitizes a CentralWhatsAppAccount record by removing encrypted ciphertext.
 * @param {Object} account
 * @returns {Object|null}
 */
function sanitizeCentralAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    account_name: account.account_name || 'Central WhatsApp Account',
    description: account.description || null,
    phone_number_id: account.phone_number_id,
    waba_id: account.waba_id,
    display_phone_number: account.display_phone_number || null,
    is_active: account.is_active,
    verification_status: account.verification_status || 'UNVERIFIED',
    last_tested_at: account.last_tested_at || null,
    verification_error: account.verification_error || null,
    deleted_at: account.deleted_at || null,
    has_token: Boolean(account.access_token_encrypted),
    templates: (account.templates && typeof account.templates === 'object') ? account.templates : {},
    assigned_restaurants_count: (typeof account._count?.restaurants === 'number')
      ? account._count.restaurants
      : (Array.isArray(account.restaurants) ? account.restaurants.length : 0),
    created_at: account.created_at,
    updated_at: account.updated_at
  };
}

/**
 * Lists all registered Central WhatsApp accounts with pagination and filters.
 *
 * @param {Object} [options]
 * @param {boolean} [options.includeDeleted=false]
 * @param {string} [options.status] - 'ACTIVE' | 'INACTIVE'
 * @param {string} [options.search]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<Array<Object>>}
 */
async function listCentralAccounts({
  includeDeleted = false,
  status = null,
  search = null,
  db = prisma
} = {}) {
  const where = {};

  if (!includeDeleted) {
    where.deleted_at = null;
  }

  if (status === 'ACTIVE') {
    where.is_active = true;
  } else if (status === 'INACTIVE') {
    where.is_active = false;
  }

  if (search && typeof search === 'string' && search.trim()) {
    const q = search.trim();
    where.OR = [
      { account_name: { contains: q, mode: 'insensitive' } },
      { display_phone_number: { contains: q, mode: 'insensitive' } },
      { phone_number_id: { contains: q, mode: 'insensitive' } },
      { waba_id: { contains: q, mode: 'insensitive' } }
    ];
  }

  const accounts = await db.centralWhatsAppAccount.findMany({
    where,
    include: {
      _count: {
        select: { restaurants: true }
      }
    },
    orderBy: { created_at: 'desc' }
  });

  return accounts.map(sanitizeCentralAccount);
}

/**
 * Retrieves the currently active Central WhatsApp account from PostgreSQL.
 * @param {Object} [db=prisma]
 * @returns {Promise<Object|null>}
 */
async function getActiveCentralAccount(db = prisma) {
  return db.centralWhatsAppAccount.findFirst({
    where: { is_active: true, deleted_at: null },
    include: {
      _count: {
        select: { restaurants: true }
      }
    }
  });
}

/**
 * Retrieves a Central WhatsApp account by ID.
 * @param {string} id
 * @param {Object} [db=prisma]
 * @returns {Promise<Object|null>}
 */
async function getCentralAccountById(id, db = prisma) {
  if (!id || typeof id !== 'string') return null;
  return db.centralWhatsAppAccount.findUnique({
    where: { id },
    include: {
      _count: {
        select: { restaurants: true }
      },
      restaurants: {
        select: {
          id: true,
          name: true,
          phone_number_id: true,
          owner_name: true,
          owner_phone: true,
          is_active: true,
          tenant_status: true
        }
      }
    }
  });
}

/**
 * Creates and securely stores a new Central WhatsApp account.
 * Supports multi-account registration and optional single active enforcement.
 *
 * @param {Object} params
 * @param {string} [params.accountName='Central WhatsApp Account']
 * @param {string} [params.description]
 * @param {string} params.phoneNumberId - Meta Phone Number ID (XYZ)
 * @param {string} params.wabaId - Meta WhatsApp Business Account ID
 * @param {string} params.accessToken - Plaintext Meta System User Access Token
 * @param {string} [params.displayPhoneNumber] - Formatted public phone number
 * @param {boolean} [params.isActive=true] - Whether to activate immediately
 * @param {boolean} [params.enforceSingleActive=false] - For legacy endpoints enforcing 1 active
 * @param {Object} [params.templates={}]
 * @param {Object} [params.db=prisma]
 * @returns {Promise<Object>} Sanitized created account
 */
async function createCentralAccount({
  accountName = 'Central WhatsApp Account',
  description = null,
  phoneNumberId,
  wabaId,
  accessToken,
  displayPhoneNumber = null,
  isActive = true,
  enforceSingleActive = true,
  templates = {},
  db = prisma
}) {
  if (!phoneNumberId || typeof phoneNumberId !== 'string' || !phoneNumberId.trim()) {
    const err = new Error('[CENTRAL ACCOUNT ERROR] Missing required phoneNumberId.');
    err.code = 'INVALID_PHONE_NUMBER_ID';
    throw err;
  }

  if (!wabaId || typeof wabaId !== 'string' || !wabaId.trim()) {
    const err = new Error('[CENTRAL ACCOUNT ERROR] Missing required wabaId.');
    err.code = 'INVALID_WABA_ID';
    throw err;
  }

  if (!accessToken || typeof accessToken !== 'string' || !accessToken.trim()) {
    const err = new Error('[CENTRAL ACCOUNT ERROR] Missing required accessToken.');
    err.code = 'INVALID_ACCESS_TOKEN';
    throw err;
  }

  const cleanToken = accessToken.trim().replace(/^["']|["']$/g, '');
  if (!isValidTokenFormat(cleanToken)) {
    logger.warn('Central access token rejected: missing required EAA prefix', {
      phoneNumberId: phoneNumberId.trim()
    });
    const err = new Error('[CENTRAL ACCOUNT ERROR] Invalid WhatsApp access token format. Access tokens must begin with "EAA".');
    err.code = 'INVALID_TOKEN_PREFIX';
    throw err;
  }

  const cleanPhoneId = phoneNumberId.trim();
  const cleanWabaId = wabaId.trim();
  const cleanDisplay = displayPhoneNumber ? displayPhoneNumber.trim() : null;
  const cleanName = (accountName && typeof accountName === 'string' && accountName.trim())
    ? accountName.trim()
    : 'Central WhatsApp Account';

  // Check duplicate phone_number_id among non-deleted accounts
  const existingWithPhone = await db.centralWhatsAppAccount.findFirst({
    where: { phone_number_id: cleanPhoneId, deleted_at: null }
  });
  if (existingWithPhone) {
    const error = new Error(`[CENTRAL ACCOUNT ERROR] A Central WhatsApp account with phone_number_id "${cleanPhoneId}" already exists.`);
    error.code = 'DUPLICATE_PHONE_NUMBER_ID';
    throw error;
  }

  // Legacy single active account enforcement if requested
  if (isActive && enforceSingleActive) {
    const existingActive = await getActiveCentralAccount(db);
    if (existingActive) {
      logger.warn('Attempted to create active Central WhatsApp account while another is already active', {
        existingActiveId: existingActive.id,
        newPhoneNumberId: cleanPhoneId
      });
      const err = new Error(`[CENTRAL ACCOUNT ERROR] An active Central WhatsApp account already exists (ID: ${existingActive.id}). Deactivate it before activating a new account.`);
      err.code = 'SINGLE_ACTIVE_ACCOUNT_EXISTS';
      throw err;
    }
  }

  // Encrypt token strictly using authenticated AES-256-GCM
  const encryptedToken = encryptToken(cleanToken);

  try {
    const created = await db.centralWhatsAppAccount.create({
      data: {
        account_name: cleanName,
        description: description ? description.trim() : null,
        phone_number_id: cleanPhoneId,
        waba_id: cleanWabaId,
        display_phone_number: cleanDisplay,
        access_token_encrypted: encryptedToken,
        templates: templates || {},
        verification_status: 'UNVERIFIED',
        is_active: Boolean(isActive)
      }
    });

    logger.info('Central WhatsApp account created successfully', {
      accountId: created.id,
      accountName: created.account_name,
      phoneNumberId: created.phone_number_id,
      isActive: created.is_active
    });

    return sanitizeCentralAccount(created);
  } catch (err) {
    if (err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target)
        ? err.meta.target.join(',')
        : String(err.meta?.target || '');

      if (target.includes('single_active') || target.includes('is_active')) {
        const error = new Error('[CENTRAL ACCOUNT ERROR] Database rejected concurrent activation: An active Central WhatsApp account already exists.');
        error.code = 'SINGLE_ACTIVE_ACCOUNT_EXISTS';
        throw error;
      }

      if (target.includes('phone_number_id')) {
        const error = new Error(`[CENTRAL ACCOUNT ERROR] A Central WhatsApp account with phone_number_id "${cleanPhoneId}" already exists.`);
        error.code = 'DUPLICATE_PHONE_NUMBER_ID';
        throw error;
      }
    }
    throw err;
  }
}

/**
 * Resolves verified Central WhatsApp credentials.
 * Dynamic resolution hierarchy:
 * 1. Explicit centralAccountId (if provided)
 * 2. Restaurant-assigned CentralWhatsAppAccount (if restaurantId provided)
 * 3. Any active CentralWhatsAppAccount in PostgreSQL (fallback)
 * 4. Environment configuration fallback (CENTRAL_PHONE_NUMBER_ID & CENTRAL_ACCESS_TOKEN)
 *
 * @param {Object} [options]
 * @param {string} [options.restaurantId]
 * @param {string} [options.centralAccountId]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<{phoneNumberId: string, wabaId: string, accessToken: string, displayPhoneNumber: string|null, source: string, accountId: string|null}>}
 */
async function resolveCentralCredentials({
  restaurantId = null,
  centralAccountId = null,
  db = prisma
} = {}) {
  // Strategy 1: Explicit centralAccountId provided
  if (centralAccountId && typeof centralAccountId === 'string') {
    const account = await db.centralWhatsAppAccount.findUnique({
      where: { id: centralAccountId }
    });
    if (!account || account.deleted_at) {
      const err = new Error(`[CENTRAL CREDENTIAL ERROR] Central WhatsApp account "${centralAccountId}" not found or deleted.`);
      err.code = 'ACCOUNT_NOT_FOUND';
      throw err;
    }
    if (!account.is_active) {
      const err = new Error(`[CENTRAL CREDENTIAL ERROR] Central WhatsApp account "${centralAccountId}" is inactive.`);
      err.code = 'ASSIGNED_ACCOUNT_INACTIVE';
      throw err;
    }
    const decryptedToken = decryptToken(account.access_token_encrypted);
    return {
      phoneNumberId: account.phone_number_id,
      wabaId: account.waba_id,
      accessToken: decryptedToken.trim(),
      displayPhoneNumber: account.display_phone_number || null,
      source: 'DATABASE_SPECIFIC',
      accountId: account.id
    };
  }

  // Strategy 2: Restaurant-mapped Central Account
  if (restaurantId && typeof restaurantId === 'string') {
    const restaurant = await db.restaurant.findUnique({
      where: { id: restaurantId },
      include: { central_account: true }
    });

    if (restaurant && restaurant.central_account) {
      const centralAcct = restaurant.central_account;
      if (centralAcct.deleted_at || !centralAcct.is_active) {
        logger.warn('Restaurant assigned Central WhatsApp account is inactive or deleted', {
          restaurantId,
          centralAccountId: centralAcct.id
        });
        const err = new Error('[CENTRAL CREDENTIAL ERROR] Assigned Central WhatsApp account is inactive or disabled.');
        err.code = 'ASSIGNED_ACCOUNT_INACTIVE';
        throw err;
      }

      const decryptedToken = decryptToken(centralAcct.access_token_encrypted);
      const cleanToken = decryptedToken ? decryptedToken.trim() : '';

      if (!isValidTokenFormat(cleanToken)) {
        const err = new Error('[CENTRAL CREDENTIAL ERROR] Assigned Central WhatsApp account has invalid token format.');
        err.code = 'INVALID_TOKEN_FORMAT';
        throw err;
      }

      return {
        phoneNumberId: centralAcct.phone_number_id,
        wabaId: centralAcct.waba_id,
        accessToken: cleanToken,
        displayPhoneNumber: centralAcct.display_phone_number || null,
        source: 'DATABASE_ASSIGNED',
        accountId: centralAcct.id
      };
    }
  }

  // Strategy 3: Global Active CentralWhatsAppAccount in PostgreSQL
  const activeAccount = await getActiveCentralAccount(db);
  if (activeAccount) {
    try {
      const decryptedToken = decryptToken(activeAccount.access_token_encrypted);
      const cleanToken = decryptedToken ? decryptedToken.trim() : '';

      if (!isValidTokenFormat(cleanToken)) {
        logger.warn('Decrypted Central WhatsApp token has invalid format', {
          accountId: activeAccount.id,
          phoneNumberId: activeAccount.phone_number_id
        });
        const err = new Error('[CENTRAL CREDENTIAL ERROR] Central WhatsApp account has an invalid token format. Access tokens must begin with "EAA".');
        err.code = 'INVALID_TOKEN_FORMAT';
        throw err;
      }

      return {
        phoneNumberId: activeAccount.phone_number_id,
        wabaId: activeAccount.waba_id,
        accessToken: cleanToken,
        displayPhoneNumber: activeAccount.display_phone_number || null,
        source: 'DATABASE',
        accountId: activeAccount.id
      };
    } catch (decryptErr) {
      logger.error('Failed to decrypt Central WhatsApp access token', {
        accountId: activeAccount.id,
        error: decryptErr.message
      });
      const err = new Error(`[CENTRAL CREDENTIAL ERROR] Failed to decrypt Central WhatsApp access token: ${decryptErr.message}`);
      err.code = 'TOKEN_DECRYPTION_FAILED';
      throw err;
    }
  }

  // Strategy 4: Fallback to environment variables
  const envPhone = (config.central?.phoneNumberId || process.env.CENTRAL_PHONE_NUMBER_ID || '').trim();
  const envToken = (config.central?.accessToken || process.env.CENTRAL_ACCESS_TOKEN || '').trim();
  const envWaba = (config.central?.wabaId || process.env.CENTRAL_WABA_ID || '').trim();

  if (envPhone && envToken) {
    if (!isValidTokenFormat(envToken)) {
      logger.warn('Environment CENTRAL_ACCESS_TOKEN has invalid format', { phoneNumberId: envPhone });
      const err = new Error('[CENTRAL CREDENTIAL ERROR] Environment CENTRAL_ACCESS_TOKEN has an invalid format. Access tokens must begin with "EAA".');
      err.code = 'INVALID_TOKEN_FORMAT';
      throw err;
    }

    return {
      phoneNumberId: envPhone,
      wabaId: envWaba,
      accessToken: envToken,
      displayPhoneNumber: null,
      source: 'ENVIRONMENT',
      accountId: null
    };
  }

  logger.warn('Central WhatsApp credentials requested but neither database nor environment configuration was found');
  const err = new Error('[CENTRAL CREDENTIAL ERROR] No active Central WhatsApp account found in database or environment. Please configure a Central WhatsApp account.');
  err.code = 'MISSING_CENTRAL_CREDENTIALS';
  throw err;
}

/**
 * Updates an existing Central WhatsApp account.
 * Encrypts new accessToken if provided. Leaves existing token intact if blank.
 *
 * @param {string} id
 * @param {Object} data
 * @param {Object} [db=prisma]
 * @returns {Promise<Object>} Sanitized updated account
 */
async function updateCentralAccount(id, data, db = prisma) {
  if (!id || typeof id !== 'string') {
    throw new Error('[CENTRAL ACCOUNT ERROR] Missing account id for update.');
  }

  const existing = await getCentralAccountById(id, db);
  if (!existing || existing.deleted_at) {
    const err = new Error(`[CENTRAL ACCOUNT ERROR] Central WhatsApp account with ID "${id}" not found.`);
    err.code = 'ACCOUNT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const updateData = {};

  if (data.accountName !== undefined) {
    const cleanName = String(data.accountName).trim();
    if (cleanName.length > 0) {
      updateData.account_name = cleanName;
    }
  }

  if (data.description !== undefined) {
    updateData.description = data.description ? String(data.description).trim() : null;
  }

  if (data.phoneNumberId !== undefined) {
    const cleanPhoneId = String(data.phoneNumberId).trim();
    if (!cleanPhoneId) {
      throw new Error('[CENTRAL ACCOUNT ERROR] Invalid phoneNumberId.');
    }
    // Check duplicate phone number if changing
    if (cleanPhoneId !== existing.phone_number_id) {
      const duplicate = await db.centralWhatsAppAccount.findFirst({
        where: { phone_number_id: cleanPhoneId, id: { not: id }, deleted_at: null }
      });
      if (duplicate) {
        const error = new Error(`[CENTRAL ACCOUNT ERROR] A Central WhatsApp account with phone_number_id "${cleanPhoneId}" already exists.`);
        error.code = 'DUPLICATE_PHONE_NUMBER_ID';
        error.statusCode = 409;
        throw error;
      }
      updateData.phone_number_id = cleanPhoneId;
    }
  }

  if (data.wabaId !== undefined) {
    const cleanWaba = String(data.wabaId).trim();
    if (!cleanWaba) {
      throw new Error('[CENTRAL ACCOUNT ERROR] Invalid wabaId.');
    }
    updateData.waba_id = cleanWaba;
  }

  if (data.displayPhoneNumber !== undefined) {
    updateData.display_phone_number = data.displayPhoneNumber ? String(data.displayPhoneNumber).trim() : null;
  }

  if (data.accessToken !== undefined && data.accessToken !== null) {
    const cleanToken = String(data.accessToken).trim().replace(/^["']|["']$/g, '');
    if (cleanToken.length > 0) {
      if (!isValidTokenFormat(cleanToken)) {
        const err = new Error('[CENTRAL ACCOUNT ERROR] Invalid WhatsApp access token format. Access tokens must begin with "EAA".');
        err.code = 'INVALID_TOKEN_PREFIX';
        err.statusCode = 400;
        throw err;
      }
      updateData.access_token_encrypted = encryptToken(cleanToken);
    }
  }

  if (data.templates !== undefined && typeof data.templates === 'object') {
    updateData.templates = data.templates;
  }

  if (data.verificationStatus !== undefined) {
    updateData.verification_status = data.verificationStatus;
  }

  if (data.verificationError !== undefined) {
    updateData.verification_error = data.verificationError;
  }

  if (data.lastTestedAt !== undefined) {
    updateData.last_tested_at = data.lastTestedAt;
  }

  if (data.isActive !== undefined) {
    const targetActive = Boolean(data.isActive);
    if (targetActive && !existing.is_active && data.enforceSingleActive) {
      const otherActive = await db.centralWhatsAppAccount.findFirst({
        where: {
          is_active: true,
          id: { not: id },
          deleted_at: null
        }
      });
      if (otherActive) {
        const err = new Error(`[CENTRAL ACCOUNT ERROR] Cannot activate account: Another Central WhatsApp account is already active (ID: ${otherActive.id}).`);
        err.code = 'SINGLE_ACTIVE_ACCOUNT_EXISTS';
        err.statusCode = 409;
        throw err;
      }
    }
    updateData.is_active = targetActive;
  }

  try {
    const updated = await db.centralWhatsAppAccount.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { restaurants: true } }
      }
    });

    logger.info('Central WhatsApp account updated successfully', {
      accountId: updated.id,
      phoneNumberId: updated.phone_number_id,
      isActive: updated.is_active
    });

    return sanitizeCentralAccount(updated);
  } catch (err) {
    if (err.code === 'P2002') {
      const error = new Error('[CENTRAL ACCOUNT ERROR] Database constraint collision during account update.');
      error.code = 'CONSTRAINT_COLLISION';
      throw error;
    }
    throw err;
  }
}

let _testHttpClient = null;

function setTestHttpClient(client) {
  _testHttpClient = client;
}

/**
 * Tests connection to Meta WhatsApp Cloud API for a specific Central WhatsApp account.
 *
 * @param {string} id
 * @param {Object} [options]
 * @param {Object} [options.httpClient]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<Object>} Sanitized test outcome
 */
async function testCentralAccountConnection(id, { httpClient = null, db = prisma } = {}) {
  const account = await db.centralWhatsAppAccount.findUnique({
    where: { id }
  });

  if (!account || account.deleted_at) {
    const err = new Error(`Central WhatsApp account with ID "${id}" not found.`);
    err.code = 'ACCOUNT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  let decryptedToken;
  try {
    decryptedToken = decryptToken(account.access_token_encrypted);
  } catch (decErr) {
    await db.centralWhatsAppAccount.update({
      where: { id },
      data: {
        verification_status: 'DISCONNECTED',
        last_tested_at: new Date(),
        verification_error: 'Token decryption failed'
      }
    });
    return {
      success: false,
      status: 'DISCONNECTED',
      verified: false,
      error: 'Token decryption failed: ' + decErr.message
    };
  }

  const verification = await verifyMetaWhatsAppToken({
    phoneNumberId: account.phone_number_id,
    accessToken: decryptedToken,
    httpClient: httpClient || _testHttpClient
  });

  const now = new Date();
  if (verification.valid) {
    await db.centralWhatsAppAccount.update({
      where: { id },
      data: {
        verification_status: 'CONNECTED',
        last_tested_at: now,
        verification_error: null,
        display_phone_number: verification.displayPhoneNumber || account.display_phone_number
      }
    });

    return {
      success: true,
      status: 'CONNECTED',
      verified: true,
      phoneNumberId: account.phone_number_id,
      verifiedName: verification.verifiedName || null,
      displayPhoneNumber: verification.displayPhoneNumber || account.display_phone_number || null,
      qualityRating: verification.qualityRating || null,
      lastTestedAt: now
    };
  }

  await db.centralWhatsAppAccount.update({
    where: { id },
    data: {
      verification_status: 'DISCONNECTED',
      last_tested_at: now,
      verification_error: verification.error || 'Connection failed'
    }
  });

  return {
    success: false,
    status: 'DISCONNECTED',
    verified: false,
    phoneNumberId: account.phone_number_id,
    error: verification.error || 'Token verification failed against Meta API',
    metaErrorCode: verification.errorCode || null,
    statusCode: verification.statusCode || null,
    lastTestedAt: now
  };
}

/**
 * Activates a Central WhatsApp account.
 *
 * @param {string} id
 * @param {Object} [options]
 * @param {boolean} [options.enforceSingleActive=false]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<Object>}
 */
async function activateCentralAccount(id, { enforceSingleActive = false, db = prisma } = {}) {
  const account = await db.centralWhatsAppAccount.findUnique({
    where: { id }
  });

  if (!account || account.deleted_at) {
    const err = new Error(`Central WhatsApp account with ID "${id}" not found.`);
    err.code = 'ACCOUNT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  return updateCentralAccount(id, { isActive: true, enforceSingleActive }, db);
}

/**
 * Deactivates an active Central WhatsApp account.
 * Checks assigned restaurants and warns administrator.
 *
 * @param {string} id
 * @param {Object} [db=prisma]
 * @returns {Promise<Object>}
 */
async function deactivateCentralAccount(id, db = prisma) {
  const account = await db.centralWhatsAppAccount.findUnique({
    where: { id }
  });

  if (!account || account.deleted_at) {
    const err = new Error(`Central WhatsApp account with ID "${id}" not found.`);
    err.code = 'ACCOUNT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const assignedActiveCount = await db.restaurant.count({
    where: { central_account_id: id, is_active: true }
  });

  const updated = await updateCentralAccount(id, { isActive: false }, db);

  return {
    ...updated,
    warning: assignedActiveCount > 0
      ? `Account deactivated, but ${assignedActiveCount} active restaurant(s) are currently assigned to it. Customer notifications for these restaurants may be delayed.`
      : null
  };
}

/**
 * Safely deletes a Central WhatsApp account with complete dependency validation.
 *
 * Safety Invariants:
 * 1. Blocks deletion if any restaurants are currently assigned.
 * 2. Blocks deletion if pending/in-flight outbox notifications exist.
 * 3. Soft deletes if historical references exist.
 * 4. Permanently deletes only if unreferenced.
 *
 * @param {string} id
 * @param {Object} [options]
 * @param {boolean} [options.force=false]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<{success: boolean, id: string, softDeleted: boolean}>}
 */
async function deleteCentralAccount(id, { force = false, db = prisma } = {}) {
  const account = await db.centralWhatsAppAccount.findUnique({
    where: { id },
    include: {
      restaurants: { select: { id: true, name: true } }
    }
  });

  if (!account || account.deleted_at) {
    const err = new Error(`Central WhatsApp account with ID "${id}" not found.`);
    err.code = 'ACCOUNT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  // Safety Check 1: Assigned Restaurants
  if (account.restaurants && account.restaurants.length > 0) {
    const names = account.restaurants.map(r => r.name).slice(0, 3).join(', ');
    const count = account.restaurants.length;
    const err = new Error(`Cannot delete Central WhatsApp account: ${count} restaurant(s) are assigned (${names}${count > 3 ? '...' : ''}). Reassign or unassign these restaurants first.`);
    err.code = 'ASSIGNED_RESTAURANTS_EXIST';
    err.statusCode = 400;
    throw err;
  }

  // Safety Check 2: Pending Outbox Messages in CENTRAL channel
  const pendingOutboxCount = await db.outboxMessage.count({
    where: {
      sender_channel: 'CENTRAL',
      status: { in: ['PENDING', 'UNCERTAIN_DISPATCH'] }
    }
  });

  if (pendingOutboxCount > 0 && !force) {
    const err = new Error(`Cannot delete Central WhatsApp account: ${pendingOutboxCount} pending Central outbox message(s) are in queue.`);
    err.code = 'PENDING_DISPATCHES_EXIST';
    err.statusCode = 400;
    throw err;
  }

  // Check if historical outbox or audit log records reference this account
  const totalOutboxCount = await db.outboxMessage.count({
    where: { sender_channel: 'CENTRAL' }
  });

  if (totalOutboxCount > 0) {
    // Soft deletion: Preserve historical reference integrity
    await db.centralWhatsAppAccount.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        is_active: false
      }
    });

    logger.info('Central WhatsApp account soft-deleted to preserve historical dispatch records', {
      accountId: id,
      totalOutboxCount
    });

    return {
      success: true,
      id,
      softDeleted: true,
      message: 'Account soft-deleted safely. Historical dispatch records preserved.'
    };
  }

  // Permanent deletion if completely unreferenced
  await db.centralWhatsAppAccount.delete({
    where: { id }
  });

  logger.info('Central WhatsApp account permanently deleted (no references existed)', { accountId: id });

  return {
    success: true,
    id,
    softDeleted: false,
    message: 'Account permanently deleted.'
  };
}

/**
 * Determines whether a given phone_number_id belongs to ANY active Central WhatsApp account.
 *
 * @param {string} phoneNumberId
 * @param {Object} [db=prisma]
 * @returns {Promise<boolean>}
 */
async function isCentralPhoneNumberId(phoneNumberId, db = prisma) {
  if (!phoneNumberId || typeof phoneNumberId !== 'string') return false;
  const cleanId = phoneNumberId.trim();

  try {
    const match = await db.centralWhatsAppAccount.findFirst({
      where: {
        phone_number_id: cleanId,
        is_active: true,
        deleted_at: null
      }
    });
    if (match) {
      return true;
    }
  } catch (err) {
    logger.warn('Failed to query Central WhatsApp accounts in isCentralPhoneNumberId', { error: err.message });
  }

  const envCentralId = (config.central?.phoneNumberId || process.env.CENTRAL_PHONE_NUMBER_ID || '').trim();
  if (envCentralId && envCentralId === cleanId) {
    return true;
  }

  return false;
}

// -----------------------------------------------------------------------------
// RESTAURANT MAPPING UTILITIES
// -----------------------------------------------------------------------------

/**
 * Returns all restaurants assigned to a specific Central WhatsApp account.
 * @param {string} centralAccountId
 * @param {Object} [db=prisma]
 * @returns {Promise<Array<Object>>}
 */
async function getAssignedRestaurants(centralAccountId, db = prisma) {
  if (!centralAccountId || typeof centralAccountId !== 'string') {
    throw new Error('Missing centralAccountId');
  }

  return db.restaurant.findMany({
    where: { central_account_id: centralAccountId },
    select: {
      id: true,
      name: true,
      phone_number_id: true,
      waba_id: true,
      owner_name: true,
      owner_phone: true,
      is_active: true,
      tenant_status: true,
      created_at: true
    },
    orderBy: { name: 'asc' }
  });
}

/**
 * Returns all restaurants that currently do not have a Central WhatsApp account assigned.
 * @param {Object} [db=prisma]
 * @returns {Promise<Array<Object>>}
 */
async function getUnassignedRestaurants(db = prisma) {
  return db.restaurant.findMany({
    where: { central_account_id: null },
    select: {
      id: true,
      name: true,
      phone_number_id: true,
      waba_id: true,
      owner_name: true,
      owner_phone: true,
      is_active: true,
      tenant_status: true
    },
    orderBy: { name: 'asc' }
  });
}

/**
 * Assigns a restaurant to a Central WhatsApp account.
 *
 * @param {string} restaurantId
 * @param {string} centralAccountId
 * @param {Object} [options]
 * @param {string} [options.adminId]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<Object>}
 */
async function assignRestaurantToCentralAccount(restaurantId, centralAccountId, { adminId = null, db = prisma } = {}) {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) {
    const err = new Error(`Restaurant with ID "${restaurantId}" not found.`);
    err.code = 'RESTAURANT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const centralAccount = await db.centralWhatsAppAccount.findUnique({
    where: { id: centralAccountId }
  });
  if (!centralAccount || centralAccount.deleted_at) {
    const err = new Error(`Central WhatsApp account with ID "${centralAccountId}" not found or deleted.`);
    err.code = 'CENTRAL_ACCOUNT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  if (!centralAccount.is_active) {
    const err = new Error('Cannot assign restaurant to an inactive Central WhatsApp account. Please activate the central account first.');
    err.code = 'CENTRAL_ACCOUNT_INACTIVE';
    err.statusCode = 400;
    throw err;
  }

  const updatedRestaurant = await db.restaurant.update({
    where: { id: restaurantId },
    data: { central_account_id: centralAccountId },
    select: {
      id: true,
      name: true,
      phone_number_id: true,
      central_account_id: true
    }
  });

  if (adminId) {
    await db.auditLog.create({
      data: {
        admin_user_id: adminId,
        action: 'RESTAURANT_CENTRAL_ACCOUNT_ASSIGNED',
        entity_type: 'Restaurant',
        entity_id: restaurantId,
        metadata: {
          restaurantName: restaurant.name,
          centralAccountId,
          centralAccountName: centralAccount.account_name,
          centralPhoneNumberId: centralAccount.phone_number_id
        }
      }
    }).catch(err => logger.warn('Failed to write audit log', { error: err.message }));
  }

  logger.info('Restaurant assigned to Central WhatsApp account', {
    restaurantId,
    centralAccountId,
    adminId
  });

  return updatedRestaurant;
}

/**
 * Removes central account assignment from a restaurant.
 *
 * @param {string} restaurantId
 * @param {Object} [options]
 * @param {string} [options.adminId]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<Object>}
 */
async function unassignRestaurantFromCentralAccount(restaurantId, { adminId = null, db = prisma } = {}) {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) {
    const err = new Error(`Restaurant with ID "${restaurantId}" not found.`);
    err.code = 'RESTAURANT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const previousCentralId = restaurant.central_account_id;

  const updated = await db.restaurant.update({
    where: { id: restaurantId },
    data: { central_account_id: null },
    select: {
      id: true,
      name: true,
      phone_number_id: true,
      central_account_id: true
    }
  });

  if (adminId) {
    await db.auditLog.create({
      data: {
        admin_user_id: adminId,
        action: 'RESTAURANT_CENTRAL_ACCOUNT_UNASSIGNED',
        entity_type: 'Restaurant',
        entity_id: restaurantId,
        metadata: {
          restaurantName: restaurant.name,
          previousCentralAccountId: previousCentralId
        }
      }
    }).catch(err => logger.warn('Failed to write audit log', { error: err.message }));
  }

  return updated;
}

let customCentralSenderForTesting = null;

function setCentralSenderForTesting(senderFn) {
  customCentralSenderForTesting = senderFn;
}

/**
 * Handles incoming non-owner messages to the Central WhatsApp Business number.
 * Replies with a safe informational response, respecting Meta's messaging rules.
 *
 * @param {Object} params
 * @param {string} params.senderPhone
 * @param {string} [params.messageId]
 * @param {Function} [params.customSender]
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleCentralInformationalMessage({ senderPhone, messageId = null, customSender = null } = {}) {
  if (!senderPhone || typeof senderPhone !== 'string') {
    return { success: false, error: 'INVALID_SENDER_PHONE' };
  }

  const cleanPhone = senderPhone.replace(/[^\d]/g, '').trim();
  if (!cleanPhone) {
    return { success: false, error: 'INVALID_SENDER_PHONE' };
  }

  try {
    const creds = await resolveCentralCredentials();

    let payload;
    if (process.env.CENTRAL_INFO_TEMPLATE) {
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'template',
        template: {
          name: process.env.CENTRAL_INFO_TEMPLATE,
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'RestoPro Notification Service' }
              ]
            }
          ]
        }
      };
    } else {
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: {
          preview_url: false,
          body: 'This is an automated dispatch notification line for RestoPro. To browse menus and place an order, please message your restaurant directly.'
        }
      };
    }

    const sender = customSender || customCentralSenderForTesting;
    if (sender) {
      await sender({
        phoneNumberId: creds.phoneNumberId,
        accessToken: creds.accessToken,
        payload
      });
    } else {
      const { sendWhatsAppMessage } = require('./whatsapp.service');
      await sendWhatsAppMessage({
        phoneNumberId: creds.phoneNumberId,
        accessToken: creds.accessToken,
        payload
      });
    }

    logger.info('Sent informational reply from Central WhatsApp number', {
      recipientPhone: cleanPhone,
      inboundMessageId: messageId
    });

    return { success: true };
  } catch (err) {
    logger.warn('Failed to send informational reply from Central WhatsApp number', {
      recipientPhone: cleanPhone,
      error: err.message
    });
    return { success: false, error: err.message };
  }
}

module.exports = {
  createCentralAccount,
  listCentralAccounts,
  getActiveCentralAccount,
  getCentralAccountById,
  resolveCentralCredentials,
  updateCentralAccount,
  testCentralAccountConnection,
  activateCentralAccount,
  deactivateCentralAccount,
  deleteCentralAccount,
  sanitizeCentralAccount,
  isValidTokenFormat,
  isCentralPhoneNumberId,
  getAssignedRestaurants,
  getUnassignedRestaurants,
  assignRestaurantToCentralAccount,
  unassignRestaurantFromCentralAccount,
  handleCentralInformationalMessage,
  setCentralSenderForTesting,
  setTestHttpClient
};
