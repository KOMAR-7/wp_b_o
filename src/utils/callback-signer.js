/**
 * RESTOPRO — Tamper-Resistant Owner Callback Signer
 * Stage 11.1 Security Hardening
 *
 * Provides HMAC-SHA256 signed, time-bounded callback identifiers for owner Accept/Reject actions.
 * Protects against callback parameter tampering, UUID enumeration, and replay of stale decisions.
 */
const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_TTL_SECONDS = 48 * 60 * 60; // 48 hours decision window
const SIG_LENGTH_HEX = 32; // 16 bytes (128 bits) hex representation

/**
 * Derives dedicated HMAC signing secret for owner callbacks.
 * Isolates signing key from META_APP_SECRET and ENCRYPTION_KEY.
 * @returns {Buffer} 32-byte secret key
 */
function getSigningSecret() {
  const rawSecret = (process.env.OWNER_CALLBACK_SECRET && process.env.OWNER_CALLBACK_SECRET.trim())
    || 'restopro_owner_callback_hmac_signing_key_2026';
  return crypto.createHash('sha256').update(rawSecret).digest();
}

/**
 * Computes timing-safe HMAC signature for callback action.
 * Payload: v1:<ACTION>:<ORDER_ID>:<EXPIRES_AT>
 */
function computeSignature(action, orderId, expiresAt) {
  const payload = `v1:${action.toUpperCase()}:${orderId}:${expiresAt}`;
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('hex')
    .slice(0, SIG_LENGTH_HEX);
}

/**
 * Generates an HMAC-signed owner callback identifier.
 * Format: OWNER_<ACTION>:<ORDER_ID>:sig:v1:<EXPIRES_AT>:<SIGNATURE>
 * Length is ~99 chars (well within WhatsApp button ID limit of 256 chars).
 * Starts with OWNER_ACCEPT: or OWNER_REJECT: for backward-compatible button ID matching.
 *
 * @param {Object} params
 * @param {string} params.orderId - UUID of the target order
 * @param {'ACCEPT'|'REJECT'} params.action - Action to perform
 * @param {number} [params.ttlSeconds=172800] - Expiry TTL in seconds (default 48h)
 * @returns {string} Signed callback identifier
 */
function generateSignedOwnerCallback({ orderId, action, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!orderId || typeof orderId !== 'string') {
    throw new Error('[SIGNER ERROR] Missing orderId for signed callback generation');
  }
  if (!action || typeof action !== 'string') {
    throw new Error('[SIGNER ERROR] Missing action for signed callback generation');
  }

  const cleanAction = action.trim().toUpperCase();
  if (cleanAction !== 'ACCEPT' && cleanAction !== 'REJECT') {
    throw new Error(`[SIGNER ERROR] Invalid action "${cleanAction}". Must be ACCEPT or REJECT.`);
  }

  const ttl = typeof ttlSeconds === 'number' ? ttlSeconds : DEFAULT_TTL_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const signature = computeSignature(cleanAction, orderId.trim(), expiresAt);

  return `OWNER_${cleanAction}:${orderId.trim()}:sig:v1:${expiresAt}:${signature}`;
}

/**
 * Verifies an incoming owner action callback payload.
 * Validates HMAC signature with constant-time comparison and enforces expiration.
 * Supports both modern signed format and legacy unsigned format with `isLegacy: true` flag for backward compatibility.
 *
 * @param {string} callbackPayload - Incoming button reply ID or payload
 * @returns {{valid: boolean, isLegacy?: boolean, action?: string, orderId?: string, expiresAt?: number, code?: string, error?: string}}
 */
function verifySignedOwnerCallback(callbackPayload) {
  if (!callbackPayload || typeof callbackPayload !== 'string') {
    return {
      valid: false,
      code: 'MALFORMED_OWNER_PAYLOAD',
      error: 'Owner action payload must be a non-empty string.'
    };
  }

  const trimmed = callbackPayload.trim();

  // 1a. Signed Format A: OWNER_<ACTION>:<ORDER_ID>:sig:v1:<EXPIRES_AT>:<SIGNATURE>
  const matchA = trimmed.match(/^OWNER_(ACCEPT|REJECT):([a-f0-9-]{36}):sig:v1:(\d+):([a-f0-9]{32})$/i);
  // 1b. Signed Format B: OWNER_SIG:v1:<ACTION>:<ORDER_ID>:<EXPIRES_AT>:<SIGNATURE>
  const matchB = !matchA ? trimmed.match(/^OWNER_SIG:v1:(ACCEPT|REJECT):([a-f0-9-]{36}):(\d+):([a-f0-9]{32})$/i) : null;

  const signedMatch = matchA || matchB;
  if (signedMatch) {
    const action = signedMatch[1].toUpperCase();
    const orderId = signedMatch[2].toLowerCase();
    const expiresAt = parseInt(signedMatch[3], 10);
    const receivedSig = signedMatch[4];

    // Expiry check
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds > expiresAt) {
      logger.warn('Owner action callback rejected: signature has expired', {
        orderId,
        action,
        expiresAt,
        nowSeconds
      });
      return {
        valid: false,
        code: 'EXPIRED_CALLBACK',
        error: 'Order action link has expired. Orders must be decided within the active decision window.'
      };
    }

    // Signature verification
    const expectedSig = computeSignature(action, orderId, expiresAt);
    const isValid = crypto.timingSafeEqual(
      Buffer.from(receivedSig, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );

    if (!isValid) {
      logger.warn('Owner action callback rejected: HMAC signature mismatch (tampered payload)', {
        orderId,
        action
      });
      return {
        valid: false,
        code: 'TAMPERED_CALLBACK',
        error: 'Owner action callback failed cryptographic signature verification.'
      };
    }

    return {
      valid: true,
      isLegacy: false,
      action,
      orderId,
      expiresAt
    };
  }

  // 2. Legacy Unsigned Format: OWNER_ACCEPT:<UUID> or OWNER_REJECT:<UUID>
  const legacyPrefixMatch = trimmed.match(/^OWNER_(ACCEPT|REJECT):(.*)$/i);
  if (legacyPrefixMatch) {
    const action = legacyPrefixMatch[1].toUpperCase();
    const rawOrderId = legacyPrefixMatch[2].trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawOrderId)) {
      return {
        valid: false,
        code: 'INVALID_ORDER_ID',
        error: `Invalid order ID "${rawOrderId}". Must be a valid UUID.`
      };
    }
    return {
      valid: true,
      isLegacy: true,
      action,
      orderId: rawOrderId.toLowerCase(),
      expiresAt: null
    };
  }

  return {
    valid: false,
    code: 'UNRECOGNIZED_OWNER_ACTION',
    error: 'Payload is not a recognized or validly signed owner action format.'
  };
}

module.exports = {
  generateSignedOwnerCallback,
  verifySignedOwnerCallback
};
