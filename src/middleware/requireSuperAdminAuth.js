/**
 * RESTOPRO — Super Admin Authentication Middleware
 * Enforces authenticated Super Admin session verification on protected routes.
 */
const { validateSession, sanitizeAdmin } = require('../services/admin-auth.service');
const logger = require('../utils/logger');

/**
 * Extracts session token from headers or cookies.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractToken(req) {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      return parts[1].trim();
    }
  }

  // 2. X-Admin-Token header
  const xAdminToken = req.headers['x-admin-token'];
  if (xAdminToken && typeof xAdminToken === 'string') {
    return xAdminToken.trim();
  }

  // 3. Cookie: admin_session=<token>
  const cookieHeader = req.headers['cookie'];
  if (cookieHeader && typeof cookieHeader === 'string') {
    const match = cookieHeader.match(/(?:^|;\s*)admin_session=([^;]+)/);
    if (match) {
      return decodeURIComponent(match[1]).trim();
    }
  }

  return null;
}

/**
 * Express middleware requiring a valid, active Super Admin session.
 */
async function requireSuperAdminAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized: Admin authentication required'
    });
  }

  try {
    const authResult = await validateSession(token);

    if (!authResult) {
      return res.status(401).json({
        error: 'Unauthorized: Invalid or expired session'
      });
    }

    const { session, admin } = authResult;

    if (!admin || !admin.is_active) {
      return res.status(401).json({
        error: 'Unauthorized: Admin account is inactive'
      });
    }

    if (admin.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        error: 'Forbidden: Super Admin privileges required'
      });
    }

    // Attach to request
    req.admin = admin;
    req.adminProfile = sanitizeAdmin(admin);
    req.adminSession = session;
    req.rawAdminToken = token;

    next();
  } catch (err) {
    logger.error('Error during super admin authentication check', { error: err.message });
    return res.status(500).json({
      error: 'Internal authentication error'
    });
  }
}

module.exports = {
  requireSuperAdminAuth,
  extractToken
};
