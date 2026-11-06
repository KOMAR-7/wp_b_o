/**
 * RESTOPRO — Super Admin Password Hashing Utility
 * Uses Node.js native crypto.scrypt with cryptographically random salts
 * and constant-time equality checks for robust credential security.
 */
const crypto = require('crypto');

const KEY_LEN = 64;
const SALT_LEN = 16;
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024
};

/**
 * Hashes a plaintext password using crypto.scrypt.
 * @param {string} password - Plaintext password to hash
 * @returns {Promise<string>} Formatted hash: `scrypt:<salt>:<hash>`
 */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    if (!password || typeof password !== 'string') {
      return reject(new Error('Password must be a non-empty string'));
    }

    const salt = crypto.randomBytes(SALT_LEN);
    crypto.scrypt(password, salt, KEY_LEN, SCRYPT_OPTIONS, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Verifies a plaintext password against a stored scrypt hash in constant time.
 * @param {string} password - Plaintext password to verify
 * @param {string} storedHash - Formatted hash string
 * @returns {Promise<boolean>} True if password matches, false otherwise
 */
function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    if (!password || typeof password !== 'string' || !storedHash || typeof storedHash !== 'string') {
      return resolve(false);
    }

    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      return resolve(false);
    }

    const salt = Buffer.from(parts[1], 'hex');
    const originalHash = Buffer.from(parts[2], 'hex');

    if (salt.length !== SALT_LEN || originalHash.length !== KEY_LEN) {
      return resolve(false);
    }

    crypto.scrypt(password, salt, KEY_LEN, SCRYPT_OPTIONS, (err, derivedKey) => {
      if (err) return resolve(false);
      try {
        const match = crypto.timingSafeEqual(originalHash, derivedKey);
        resolve(match);
      } catch {
        resolve(false);
      }
    });
  });
}

module.exports = {
  hashPassword,
  verifyPassword
};
