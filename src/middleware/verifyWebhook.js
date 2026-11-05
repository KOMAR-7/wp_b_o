/**
 * RESTOPRO — Webhook Verification & Cryptographic Signature Middleware
 */
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Handles Meta Webhook Verification Challenge (HTTP GET).
 * Uses SHA-256 digest hashing before timingSafeEqual to eliminate length-leakage attacks
 * and guarantee identical buffer lengths.
 */
function verifyWebhookChallenge(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (!mode || !token) {
    logger.warn('Webhook verification failed: missing hub.mode or hub.verify_token', {
      query: req.query
    });
    return res.status(400).send('Missing verification parameters');
  }

  if (mode !== 'subscribe') {
    logger.warn(`Webhook verification failed: invalid mode '${mode}'`);
    return res.status(400).send('Invalid hub.mode');
  }

  const expectedToken = config.meta.verifyToken;
  if (!expectedToken) {
    logger.error('Webhook verification failed: META_VERIFY_TOKEN is not configured on server');
    return res.status(500).send('Server verify token unconfigured');
  }

  // Hash both strings to SHA-256 digests (always 32 bytes) for constant-time comparison
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest();
  const expectedHash = crypto.createHash('sha256').update(String(expectedToken)).digest();

  const isMatch = crypto.timingSafeEqual(tokenHash, expectedHash);

  if (isMatch) {
    logger.info('Meta webhook verification handshake successful');
    return res.status(200).send(challenge);
  } else {
    logger.warn('Webhook verification failed: token mismatch');
    return res.status(403).send('Verification token mismatch');
  }
}

/**
 * Validates Meta's HMAC-SHA256 signature on incoming webhook events (HTTP POST).
 * Header: x-hub-signature-256 = sha256=<64_hex_digits>
 */
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = config.meta.appSecret;

  if (!appSecret) {
    logger.error('Webhook signature verification failed: META_APP_SECRET is not configured on server');
    return res.status(500).json({ error: 'Server app secret unconfigured' });
  }

  if (!signature) {
    logger.warn('Webhook signature verification rejected: missing x-hub-signature-256 header');
    return res.status(401).json({ error: 'Missing x-hub-signature-256 header' });
  }

  const parts = signature.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    logger.warn('Webhook signature verification rejected: malformed signature format');
    return res.status(400).json({ error: 'Malformed signature header format' });
  }

  const receivedHash = parts[1];
  if (!HEX_64_REGEX.test(receivedHash)) {
    logger.warn('Webhook signature verification rejected: signature digest is not a valid 64-char hex string');
    return res.status(400).json({ error: 'Invalid signature digest format' });
  }

  const rawBody = req.rawBody;
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    logger.warn('Webhook signature verification rejected: missing or invalid request body buffer');
    return res.status(400).json({ error: 'Missing request body buffer' });
  }

  const computedHash = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const receivedBuffer = Buffer.from(receivedHash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');

  const isSignatureValid =
    receivedBuffer.length === computedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, computedBuffer);

  if (!isSignatureValid) {
    logger.warn('Webhook signature verification rejected: signature mismatch');
    return res.status(403).json({ error: 'Invalid webhook signature' });
  }

  next();
}

module.exports = {
  verifyWebhookChallenge,
  verifyWebhookSignature
};
