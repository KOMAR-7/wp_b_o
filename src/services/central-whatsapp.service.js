/**
 * RESTOPRO — Central WhatsApp Business Account Management Service
 * R6.5 Central WhatsApp Architecture Implementation
 *
 * Implements:
 * - Secure Central WhatsApp credential storage and AES-256-GCM encryption
 * - Enforces single active central account at service and database level
 * - Dynamic central credential resolution (Database first, environment fallback)
 * - Safe sanitization preventing credential exposure in logs and API responses
 */
const prisma = require('../config/database');
const config = require('../config/env');
const logger = require('../utils/logger');
const { encryptToken, decryptToken } = require('../utils/crypto');

/**
 * Validates that an access token string meets Meta WhatsApp Cloud API standards.
 * @param {string} token
 * @returns {boolean}
 */
function isValidTokenFormat(token) {
  if (!token || typeof token !== 'string') return false;
  const trimmed = token.trim();
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
    phone_number_id: account.phone_number_id,
    waba_id: account.waba_id,
    display_phone_number: account.display_phone_number || null,
    is_active: account.is_active,
    has_token: Boolean(account.access_token_encrypted),
    templates: (account.templates && typeof account.templates === 'object') ? account.templates : {},
    created_at: account.created_at,
    updated_at: account.updated_at
  };
}

/**
 * Retrieves the currently active Central WhatsApp account from PostgreSQL.
 * @param {Object} [db=prisma]
 * @returns {Promise<Object|null>}
 */
async function getActiveCentralAccount(db = prisma) {
  return db.centralWhatsAppAccount.findFirst({
    where: { is_active: true }
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
    where: { id }
  });
}

/**
 * Creates and securely stores a new Central WhatsApp account.
 * Enforces single active account constraint.
 *
 * @param {Object} params
 * @param {string} params.phoneNumberId - Meta Phone Number ID (XYZ)
 * @param {string} params.wabaId - Meta WhatsApp Business Account ID
 * @param {string} params.accessToken - Plaintext Meta System User Access Token
 * @param {string} [params.displayPhoneNumber] - Formatted public phone number
 * @param {boolean} [params.isActive=true] - Whether to activate immediately
 * @param {Object} [params.db=prisma]
 * @returns {Promise<Object>} Sanitized created account
 */
async function createCentralAccount({
  phoneNumberId,
  wabaId,
  accessToken,
  displayPhoneNumber = null,
  isActive = true,
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

  const cleanToken = accessToken.trim();
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

  // Enforce single active account rule before insert
  if (isActive) {
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
        phone_number_id: cleanPhoneId,
        waba_id: cleanWabaId,
        display_phone_number: cleanDisplay,
        access_token_encrypted: encryptedToken,
        templates: templates || {},
        is_active: Boolean(isActive)
      }
    });

    logger.info('Central WhatsApp account created successfully', {
      accountId: created.id,
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
 * Checks PostgreSQL active record first; falls back to environment configuration if configured.
 *
 * @param {Object} [db=prisma]
 * @returns {Promise<{phoneNumberId: string, wabaId: string, accessToken: string, displayPhoneNumber: string|null, source: 'DATABASE'|'ENVIRONMENT', accountId: string|null}>}
 */
async function resolveCentralCredentials(db = prisma) {
  // 1. Primary Resolution: Active CentralWhatsAppAccount in PostgreSQL
  const activeAccount = await getActiveCentralAccount(db);

  if (activeAccount) {
    try {
      const decryptedToken = decryptToken(activeAccount.access_token_encrypted);
      const cleanToken = decryptedToken ? decryptedToken.trim() : '';

      if (!isValidTokenFormat(cleanToken)) {
        logger.warn('Decrypted Central WhatsApp token has invalid format or missing EAA prefix', {
          accountId: activeAccount.id,
          phoneNumberId: activeAccount.phone_number_id
        });
        const err = new Error('[CENTRAL CREDENTIAL ERROR] Central WhatsApp account has an invalid token format. Access tokens must begin with "EAA". Re-authentication required.');
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
      const err = new Error(`[CENTRAL CREDENTIAL ERROR] Failed to decrypt Central WhatsApp access token: ${decryptErr.message}. Re-encryption or re-authentication required.`);
      err.code = 'TOKEN_DECRYPTION_FAILED';
      throw err;
    }
  }

  // 2. Secondary Resolution: Fallback to environment variables
  const envPhone = (config.central?.phoneNumberId || process.env.CENTRAL_PHONE_NUMBER_ID || '').trim();
  const envToken = (config.central?.accessToken || process.env.CENTRAL_ACCESS_TOKEN || '').trim();
  const envWaba = (config.central?.wabaId || process.env.CENTRAL_WABA_ID || '').trim();

  if (envPhone && envToken) {
    if (!isValidTokenFormat(envToken)) {
      logger.warn('Environment CENTRAL_ACCESS_TOKEN has invalid format or missing EAA prefix', {
        phoneNumberId: envPhone
      });
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

  // 3. Neither source available
  logger.warn('Central WhatsApp credentials requested but neither database nor environment configuration was found');
  const err = new Error('[CENTRAL CREDENTIAL ERROR] No active Central WhatsApp account found in database or environment. Please configure a Central WhatsApp account.');
  err.code = 'MISSING_CENTRAL_CREDENTIALS';
  throw err;
}

/**
 * Updates an existing Central WhatsApp account.
 * Encrypts new accessToken if provided. Enforces single active account rule on activation.
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
  if (!existing) {
    const err = new Error(`[CENTRAL ACCOUNT ERROR] Central WhatsApp account with ID "${id}" not found.`);
    err.code = 'ACCOUNT_NOT_FOUND';
    throw err;
  }

  const updateData = {};

  if (data.phoneNumberId !== undefined) {
    if (!data.phoneNumberId || typeof data.phoneNumberId !== 'string' || !data.phoneNumberId.trim()) {
      throw new Error('[CENTRAL ACCOUNT ERROR] Invalid phoneNumberId.');
    }
    updateData.phone_number_id = data.phoneNumberId.trim();
  }

  if (data.wabaId !== undefined) {
    if (!data.wabaId || typeof data.wabaId !== 'string' || !data.wabaId.trim()) {
      throw new Error('[CENTRAL ACCOUNT ERROR] Invalid wabaId.');
    }
    updateData.waba_id = data.wabaId.trim();
  }

  if (data.displayPhoneNumber !== undefined) {
    updateData.display_phone_number = data.displayPhoneNumber ? data.displayPhoneNumber.trim() : null;
  }

  if (data.accessToken !== undefined && data.accessToken !== null) {
    const cleanToken = String(data.accessToken).trim();
    if (cleanToken.length > 0) {
      if (!isValidTokenFormat(cleanToken)) {
        const err = new Error('[CENTRAL ACCOUNT ERROR] Invalid WhatsApp access token format. Access tokens must begin with "EAA".');
        err.code = 'INVALID_TOKEN_PREFIX';
        throw err;
      }
      updateData.access_token_encrypted = encryptToken(cleanToken);
    }
  }

  if (data.templates !== undefined && typeof data.templates === 'object') {
    updateData.templates = data.templates;
  }

  if (data.isActive !== undefined) {
    const targetActive = Boolean(data.isActive);
    if (targetActive && !existing.is_active) {
      // Activating this account: verify no other account is currently active
      const otherActive = await db.centralWhatsAppAccount.findFirst({
        where: {
          is_active: true,
          id: { not: id }
        }
      });
      if (otherActive) {
        const err = new Error(`[CENTRAL ACCOUNT ERROR] Cannot activate account: Another Central WhatsApp account is already active (ID: ${otherActive.id}).`);
        err.code = 'SINGLE_ACTIVE_ACCOUNT_EXISTS';
        throw err;
      }
    }
    updateData.is_active = targetActive;
  }

  try {
    const updated = await db.centralWhatsAppAccount.update({
      where: { id },
      data: updateData
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

/**
 * Deactivates an active Central WhatsApp account.
 * @param {string} id
 * @param {Object} [db=prisma]
 * @returns {Promise<Object>}
 */
async function deactivateCentralAccount(id, db = prisma) {
  return updateCentralAccount(id, { isActive: false }, db);
}

/**
 * Determines whether a given phone_number_id belongs to the configured or active Central WhatsApp account.
 * Checks active account in database first, then environment fallback.
 *
 * @param {string} phoneNumberId
 * @param {Object} [db=prisma]
 * @returns {Promise<boolean>}
 */
async function isCentralPhoneNumberId(phoneNumberId, db = prisma) {
  if (!phoneNumberId || typeof phoneNumberId !== 'string') return false;
  const cleanId = phoneNumberId.trim();

  // 1. Check active database account
  try {
    const activeAccount = await getActiveCentralAccount(db);
    if (activeAccount && activeAccount.phone_number_id === cleanId) {
      return true;
    }
  } catch (err) {
    logger.warn('Failed to query Central WhatsApp account in isCentralPhoneNumberId', { error: err.message });
  }

  // 2. Check environment configuration fallback
  const envCentralId = (config.central?.phoneNumberId || process.env.CENTRAL_PHONE_NUMBER_ID || '').trim();
  if (envCentralId && envCentralId === cleanId) {
    return true;
  }

  return false;
}

let customCentralSenderForTesting = null;

function setCentralSenderForTesting(senderFn) {
  customCentralSenderForTesting = senderFn;
}

/**
 * Handles incoming non-owner messages to the Central WhatsApp Business number.
 * Replies with a safe informational response, respecting Meta's messaging rules.
 * Because the user messaged Central, the 24-hour service window with Central is open.
 *
 * @param {Object} params
 * @param {string} params.senderPhone - Incoming sender phone number
 * @param {string} [params.messageId] - Incoming Meta message ID
 * @param {Function} [params.customSender] - Test sender hook
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
  getActiveCentralAccount,
  getCentralAccountById,
  resolveCentralCredentials,
  updateCentralAccount,
  deactivateCentralAccount,
  sanitizeCentralAccount,
  isValidTokenFormat,
  isCentralPhoneNumberId,
  handleCentralInformationalMessage,
  setCentralSenderForTesting
};

