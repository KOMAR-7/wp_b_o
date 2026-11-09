/**
 * RESTOPRO — Super Admin Authentication Controller
 * Handles HTTP endpoints for login, logout, and profile retrieval.
 */
const { loginAdmin, logoutAdmin, sanitizeAdmin } = require('../services/admin-auth.service');
const { extractToken } = require('../middleware/requireSuperAdminAuth');
const logger = require('../utils/logger');

/**
 * POST /api/admin/auth/login
 * Authenticates Super Admin credentials and establishes a session.
 */
async function handleAdminLogin(req, res) {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    const ipAddress = req.headers['cf-connecting-ip'] ||
      (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
      req.ip ||
      req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const host = req.headers['host'];
    const referer = req.headers['referer'] || req.headers['origin'];

    const { token, admin } = await loginAdmin({
      email,
      password,
      ipAddress,
      userAgent,
      host,
      referer
    });

    // Set secure HTTP-only cookie
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('admin_session', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      path: '/'
    });

    return res.status(200).json({
      success: true,
      token,
      admin
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Unexpected error during admin login', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

/**
 * POST /api/admin/auth/logout
 * Revokes the active admin session and clears session cookies.
 */
async function handleAdminLogout(req, res) {
  try {
    const token = req.rawAdminToken || extractToken(req);

    if (token) {
      await logoutAdmin(token);
    }

    const isProduction = process.env.NODE_ENV === 'production';
    res.clearCookie('admin_session', {
      path: '/',
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax'
    });

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    logger.error('Error during admin logout handler', { error: err.message });
    return res.status(500).json({ error: 'Internal server error during logout' });
  }
}

/**
 * GET /api/admin/auth/me
 * Returns the currently authenticated Super Admin profile.
 */
async function handleGetAdminMe(req, res) {
  try {
    const profile = req.adminProfile || sanitizeAdmin(req.admin);
    return res.status(200).json({
      admin: profile
    });
  } catch (err) {
    logger.error('Error retrieving admin profile', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  handleAdminLogin,
  handleAdminLogout,
  handleGetAdminMe
};
