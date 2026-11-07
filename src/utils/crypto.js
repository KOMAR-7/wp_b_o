/**
 * RESTOPRO — Cryptographic Token Encryption Utility
 * Stage 11.1 Security Hardening
 *
 * Provides authenticated AES-256-GCM encryption and decryption for sensitive tenant credentials.
 * - Primary Encryption: Strictly requires ENCRYPTION_KEY. Fallback keys are never used for new encryptions.
 * - Decryption: Attempts primary ENCRYPTION_KEY first, followed by legacy candidate keys with warning logs
 *   to ensure smooth backward-compatible key transitions without breaking existing database credentials.
 */
const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits
const PREFIX = 'enc:v1:';

/**
 * Resolves the primary encryption key derived strictly from ENCRYPTION_KEY.
 * Throws an explicit error if missing, refusing to encrypt using fallback or legacy secrets.
 * @returns {Buffer} 32-byte AES-256 key
 */
function getPrimaryEncryptionKey() {
  const secret = process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.trim();
  if (!secret) {
    throw new Error('[CRYPTO ERROR] ENCRYPTION_KEY environment variable is required to encrypt credentials. Refusing to encrypt using fallback keys.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Resolves legacy candidate keys for backward-compatible decryption of pre-existing records.
 * Never used for new encryptions.
 * @returns {Array<{key: Buffer, label: string}>}
 */
function getLegacyCandidateKeys() {
  const candidates = [];
  if (process.env.META_APP_SECRET && process.env.META_APP_SECRET.trim()) {
    candidates.push({
      key: crypto.createHash('sha256').update(process.env.META_APP_SECRET.trim()).digest(),
      label: 'META_APP_SECRET'
    });
  }
  candidates.push({
    key: crypto.createHash('sha256').update('restopro_default_secure_token_secret_key_2026').digest(),
    label: 'DEFAULT_FALLBACK'
  });

  return candidates;
}

/**
 * Encrypts a plaintext credential string using AES-256-GCM.
 * Strictly uses primary ENCRYPTION_KEY.
 *
 * @param {string} plaintext - Raw credential to encrypt
 * @returns {string} Formatted ciphertext: enc:v1:<iv_hex>:<tag_hex>:<cipher_hex>
 */
function encryptToken(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('Plaintext credential must be a non-empty string');
  }

  const cleanPlaintext = plaintext.trim();
  const key = getPrimaryEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(cleanPlaintext, 'utf8'),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Deciphers a ciphertext buffer using a specific key buffer.
 */
function decipherWithKey(key, iv, tag, encrypted) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);

  let decryptedStr = decrypted.toString('utf8').trim();
  // Safely strip enclosing single or double quotes if present
  if ((decryptedStr.startsWith('"') && decryptedStr.endsWith('"')) ||
      (decryptedStr.startsWith("'") && decryptedStr.endsWith("'"))) {
    decryptedStr = decryptedStr.slice(1, -1).trim();
  }
  return decryptedStr;
}

/**
 * Decrypts an AES-256-GCM encrypted token.
 * Passes through mock or unencrypted tokens safely.
 *
 * Precedence:
 * 1. Primary ENCRYPTION_KEY (if configured)
 * 2. Legacy candidate keys (META_APP_SECRET, fallback) with a warning log for auditability.
 *
 * @param {string} ciphertext - Stored credential string
 * @returns {string} Decrypted plaintext credential
 */
function decryptToken(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    return '';
  }

  // Pass through mock or unencrypted legacy tokens
  if (!ciphertext.startsWith(PREFIX)) {
    return ciphertext.trim();
  }

  const parts = ciphertext.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');

  let lastError = null;

  // 1. Attempt decryption with primary ENCRYPTION_KEY if configured
  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.trim()) {
    try {
      const primaryKey = getPrimaryEncryptionKey();
      return decipherWithKey(primaryKey, iv, tag, encrypted);
    } catch (err) {
      lastError = err;
      // Fall through to legacy candidates to handle key transitions
    }
  }

  // 2. Attempt decryption with legacy candidate keys for backward compatibility
  const legacyCandidates = getLegacyCandidateKeys();
  for (const { key, label } of legacyCandidates) {
    try {
      const decrypted = decipherWithKey(key, iv, tag, encrypted);
      logger.warn('Token decrypted using legacy fallback key. Re-encryption with ENCRYPTION_KEY is required.', {
        legacyKeySource: label
      });
      return decrypted;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Failed to decrypt credential: ${lastError ? lastError.message : 'Authentication tag mismatch'}`);
}

module.exports = {
  encryptToken,
  decryptToken,
  getPrimaryEncryptionKey,
  getLegacyCandidateKeys
};
