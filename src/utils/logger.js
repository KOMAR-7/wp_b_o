/**
 * RESTOPRO — Structured Logging Utility with PII and Secret Redaction
 */

const SENSITIVE_KEYS = [
  'token',
  'appsecret',
  'app_secret',
  'accesstoken',
  'access_token',
  'verifytoken',
  'verify_token',
  'authorization',
  'password',
  'secret',
  'signature',
  'x-hub-signature-256'
];

/**
 * Recursively redacts sensitive values from an object before logging.
 */
function sanitizeForLogging(obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return obj;

  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLogging(item, depth + 1));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some(k => lowerKey.includes(k))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeForLogging(value, depth + 1);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function formatLog(level, message, context = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...(Object.keys(context).length > 0 ? { context: sanitizeForLogging(context) } : {})
  };
  return JSON.stringify(logEntry);
}

const logger = {
  info: (message, context) => console.log(formatLog('info', message, context)),
  warn: (message, context) => console.warn(formatLog('warn', message, context)),
  error: (message, context) => console.error(formatLog('error', message, context)),
  debug: (message, context) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(formatLog('debug', message, context));
    }
  },
  // Exported helpers for testing & direct sanitization
  sanitizeForLogging,
  formatLog
};

module.exports = logger;
