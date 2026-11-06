/**
 * RESTOPRO — Super Admin Authentication Routes
 * Mount point: /api/admin/auth
 *
 * NOTE: There is strictly NO public registration endpoint.
 * Super Admin accounts are provisioned exclusively via the CLI bootstrap script.
 */
const express = require('express');
const router = express.Router();

const {
  handleAdminLogin,
  handleAdminLogout,
  handleGetAdminMe
} = require('../controllers/admin-auth.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');
const { adminLoginRateLimiter } = require('../middleware/adminRateLimiter');

// POST /api/admin/auth/login — Authenticate Super Admin with rate limiting
router.post('/login', adminLoginRateLimiter, handleAdminLogin);

// POST /api/admin/auth/logout — Revoke current session
router.post('/logout', handleAdminLogout);

// GET /api/admin/auth/me — Retrieve authenticated Super Admin profile
router.get('/me', requireSuperAdminAuth, handleGetAdminMe);

module.exports = router;
