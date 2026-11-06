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
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
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

// Export for testing and management
function resetRateLimiter() {
  attemptsStore.clear();
}

module.exports = {
  adminLoginRateLimiter,
  resetRateLimiter,
  MAX_ATTEMPTS,
  WINDOW_MS
};
