/**
 * RESTOPRO — Super Admin Login Rate Limiter Middleware
 * Protects admin login endpoints against brute-force attacks.
 * Tracks failed attempts per client IP within a sliding time window.
 */
const logger = require('../utils/logger');

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

// In-memory store: Map<ip, { count: number, resetAt: number }>
const attemptsStore = new Map();

// Periodic cleanup of expired records every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of attemptsStore.entries()) {
    if (now > record.resetAt) {
      attemptsStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

/**
 * Express middleware to enforce login rate limiting.
 */
function adminLoginRateLimiter(req, res, next) {
  const rawIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const clientIp = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : 'unknown';
  const now = Date.now();

  const record = attemptsStore.get(clientIp);

  if (record && now < record.resetAt) {
    if (record.count >= MAX_ATTEMPTS) {
      const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
      logger.warn('Admin login rate limit exceeded', { clientIp, attempts: record.count });
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({
        error: 'Too many login attempts. Please try again later.'
      });
    }
  }

  // Intercept response to count failed attempts
  const originalEnd = res.end;
  res.end = function (...args) {
    if (res.statusCode === 401 || res.statusCode === 400) {
      const current = attemptsStore.get(clientIp);
      if (!current || now >= current.resetAt) {
        attemptsStore.set(clientIp, { count: 1, resetAt: now + WINDOW_MS });
      } else {
        current.count += 1;
      }
    } else if (res.statusCode === 200) {
      // Clear failed attempts on successful login
      attemptsStore.delete(clientIp);
    }
    return originalEnd.apply(this, args);
  };

  next();
}

// Rate limiting for central connection tests (prevents Meta API exhaustion)
const connectionTestStore = new Map();
const CONNECTION_TEST_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_CONNECTION_TESTS = 15;

/**
 * Express middleware to enforce connection test rate limiting.
 */
function centralConnectionTestRateLimiter(req, res, next) {
  // In test mode, allow unless specifically testing rate limiter
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_CENTRAL_RATE_LIMIT) {
    return next();
  }

  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = connectionTestStore.get(clientIp);

  if (record && now < record.resetAt) {
    if (record.count >= MAX_CONNECTION_TESTS) {
      const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
      logger.warn('Central connection test rate limit exceeded', { clientIp, attempts: record.count });
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        error: 'Too many connection tests requested. Please wait before testing again.'
      });
    }
    record.count += 1;
  } else {
    connectionTestStore.set(clientIp, { count: 1, resetAt: now + CONNECTION_TEST_WINDOW_MS });
  }

  next();
}

// Export for testing and management
function resetRateLimiter() {
  attemptsStore.clear();
  connectionTestStore.clear();
}

module.exports = {
  adminLoginRateLimiter,
  centralConnectionTestRateLimiter,
  resetRateLimiter,
  MAX_ATTEMPTS,
  WINDOW_MS
};
