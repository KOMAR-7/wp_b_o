/**
 * RESTOPRO — Cryptographic Token Encryption Utility
 * Provides authenticated AES-256-GCM encryption and decryption for sensitive tenant credentials.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits
const PREFIX = 'enc:v1:';

/**
 * Derives a consistent 256-bit encryption key from environment configuration.
 * @returns {Buffer} 32-byte encryption key
 */
function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.META_APP_SECRET || 'restopro_default_secure_token_secret_key_2026';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plaintext credential string using AES-256-GCM.
 * @param {string} plaintext - Raw credential to encrypt
 * @returns {string} Formatted ciphertext: enc:v1:<iv_hex>:<tag_hex>:<cipher_hex>
 */
function encryptToken(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('Plaintext credential must be a non-empty string');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted token.
 * Passes through mock or unencrypted tokens safely.
 * @param {string} ciphertext - Stored credential string
 * @returns {string} Decrypted plaintext credential
 */
function decryptToken(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    return '';
  }

  // Pass through mock or unencrypted legacy tokens
  if (!ciphertext.startsWith(PREFIX)) {
    return ciphertext;
  }

  try {
    const parts = ciphertext.slice(PREFIX.length).split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted token format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');

    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error(`Failed to decrypt credential: ${err.message}`);
  }
}

module.exports = {
  encryptToken,
  decryptToken
};
