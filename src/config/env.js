/**
 * RESTOPRO — Environment Configuration & Validation
 */
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  ownerCallbackSecret: process.env.OWNER_CALLBACK_SECRET || '',
  routingMode: (process.env.NOTIFICATION_ROUTING_MODE || 'LEGACY').toUpperCase().trim(),
  meta: {
    verifyToken: process.env.META_VERIFY_TOKEN || '',
    appSecret: process.env.META_APP_SECRET || '',
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
    accessToken: process.env.META_ACCESS_TOKEN || ''
  },
  central: {
    phoneNumberId: (process.env.CENTRAL_PHONE_NUMBER_ID || '').trim(),
    wabaId: (process.env.CENTRAL_WABA_ID || '').trim(),
    accessToken: (process.env.CENTRAL_ACCESS_TOKEN || '').trim()
  }
};

/**
 * Validates that critical environment variables exist.
 * Warns if secrets are missing during development.
 * Throws in production.
 */
function validateConfig(testConfig = config) {
  const missing = [];
  if (!testConfig.databaseUrl) missing.push('DATABASE_URL');
  if (!testConfig.meta.verifyToken) missing.push('META_VERIFY_TOKEN');
  if (!testConfig.meta.appSecret) missing.push('META_APP_SECRET');
  if (!testConfig.encryptionKey) missing.push('ENCRYPTION_KEY');

  // Validate notification routing mode
  const validModes = ['LEGACY', 'CENTRAL'];
  if (!validModes.includes(testConfig.routingMode)) {
    const errorMsg = `[CONFIG ERROR] Invalid NOTIFICATION_ROUTING_MODE "${testConfig.routingMode}". Allowed values: ${validModes.join(', ')}`;
    if (testConfig.nodeEnv === 'production') {
      throw new Error(errorMsg);
    } else {
      console.warn(`[CONFIG WARNING] ${errorMsg}. Defaulting to LEGACY.`);
      testConfig.routingMode = 'LEGACY';
    }
  }

  if (missing.length > 0) {
    if (testConfig.nodeEnv === 'production') {
      throw new Error(`[CONFIG ERROR] Missing required environment variables in production: ${missing.join(', ')}`);
    } else {
      console.warn(`[CONFIG WARNING] Missing configuration keys: ${missing.join(', ')}.`);
    }
  }
  return missing;
}

validateConfig();

config.validateConfig = validateConfig;

module.exports = config;
