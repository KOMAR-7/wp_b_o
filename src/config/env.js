/**
 * RESTOPRO — Environment Configuration & Validation
 */
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  meta: {
    verifyToken: process.env.META_VERIFY_TOKEN || '',
    appSecret: process.env.META_APP_SECRET || '',
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
    accessToken: process.env.META_ACCESS_TOKEN || ''
  }
};

/**
 * Validates that critical environment variables exist.
 * Warns if secrets are missing during development.
 */
function validateConfig() {
  const missing = [];
  if (!config.meta.verifyToken) missing.push('META_VERIFY_TOKEN');
  if (!config.meta.appSecret) missing.push('META_APP_SECRET');

  if (missing.length > 0) {
    if (config.nodeEnv === 'production') {
      throw new Error(`[CONFIG ERROR] Missing required environment variables in production: ${missing.join(', ')}`);
    } else {
      console.warn(`[CONFIG WARNING] Missing configuration keys for live Meta integration: ${missing.join(', ')}.`);
      console.warn('[CONFIG WARNING] Please update .env with your Meta App credentials to connect to real WhatsApp Cloud API.');
    }
  }
}

validateConfig();

module.exports = config;
