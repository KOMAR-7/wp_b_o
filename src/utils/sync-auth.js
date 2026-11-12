/**
 * RESTOPRO — Restaurant Catalogue Synchronization Authentication
 * Provides tamper-proof HMAC-SHA256 sync tokens and timing-safe token verification.
 * Enforces strict restaurant-level tenant isolation.
 */
const crypto = require('crypto');
const config = require('../config/env');

/**
 * Derives the server secret for restaurant catalogue synchronization tokens.
 * Uses OWNER_CALLBACK_SECRET or ENCRYPTION_KEY.
 * @returns {Buffer}
 */
function getSyncSecret() {
  const raw = (config.ownerCallbackSecret || config.encryptionKey || 'restopro_sync_secret_key_2026').trim();
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Generates an authoritative, deterministic sync token for a given restaurant ID.
 * The token is unique to the restaurant and cannot be used for any other tenant.
 *
 * @param {string} restaurantId - Restaurant UUID
 * @returns {string} 64-character hex token
 */
function generateRestaurantSyncToken(restaurantId) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[SYNC AUTH] Missing or invalid restaurantId');
  }
  return crypto
    .createHmac('sha256', getSyncSecret())
    .update(`restopro:catalog:sync:${restaurantId.trim().toLowerCase()}`)
    .digest('hex');
}

/**
 * Validates a candidate sync token against the restaurant's authoritative sync token
 * or an explicitly configured custom sync token.
 * Uses timingSafeEqual to guard against timing analysis attacks.
 *
 * @param {string} restaurantId - Restaurant UUID
 * @param {string} candidateToken - Token provided by client / browser companion
 * @param {string} [customToken] - Optional custom sync token from restaurant metadata
 * @returns {boolean}
 */
function verifyRestaurantSyncToken(restaurantId, candidateToken, customToken = null) {
  if (!restaurantId || !candidateToken || typeof candidateToken !== 'string') {
    return false;
  }

  const expectedToken = generateRestaurantSyncToken(restaurantId);
  const trimmedCandidate = candidateToken.trim();

  // Primary check: Authoritative HMAC token
  if (trimmedCandidate.length === expectedToken.length) {
    try {
      const bufA = Buffer.from(trimmedCandidate.toLowerCase(), 'utf8');
      const bufB = Buffer.from(expectedToken.toLowerCase(), 'utf8');
      if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
        return true;
      }
    } catch (_) {}
  }

  // Secondary check: Stored custom sync token in internal_notes metadata
  if (customToken && typeof customToken === 'string') {
    const trimmedCustom = customToken.trim();
    if (trimmedCandidate.length === trimmedCustom.length) {
      try {
        const bufCandidate = Buffer.from(trimmedCandidate, 'utf8');
        const bufCustom = Buffer.from(trimmedCustom, 'utf8');
        if (bufCandidate.length === bufCustom.length && crypto.timingSafeEqual(bufCandidate, bufCustom)) {
          return true;
        }
      } catch (_) {}
    }
  }

  return false;
}

module.exports = {
  generateRestaurantSyncToken,
  verifyRestaurantSyncToken
};
