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
 * Derives consistent 256-bit encryption keys from environment configuration.
 * Supports primary key derivation and fallback candidates to handle key transitions smoothly.
 * @returns {Array<Buffer>} 32-byte encryption keys
 */
function getCandidateKeys() {
  const secrets = [];
  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.trim()) {
    secrets.push(process.env.ENCRYPTION_KEY.trim());
  }
  if (process.env.META_APP_SECRET && process.env.META_APP_SECRET.trim()) {
    secrets.push(process.env.META_APP_SECRET.trim());
  }
  secrets.push('restopro_default_secure_token_secret_key_2026');

  const unique = Array.from(new Set(secrets));
  return unique.map(s => crypto.createHash('sha256').update(s).digest());
}

function getEncryptionKey() {
  return getCandidateKeys()[0];
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

  const cleanPlaintext = plaintext.trim();
  const key = getEncryptionKey();
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
 * Decrypts an AES-256-GCM encrypted token.
 * Passes through mock or unencrypted tokens safely.
 * Attempts candidate keys in order of precedence for seamless key rotation.
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

  const candidateKeys = getCandidateKeys();
  let lastError = null;

  for (const key of candidateKeys) {
    try {
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
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Failed to decrypt credential: ${lastError ? lastError.message : 'Authentication tag mismatch'}`);
}

module.exports = {
  encryptToken,
  decryptToken
};

