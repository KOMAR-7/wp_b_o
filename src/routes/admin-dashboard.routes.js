/**
 * RESTOPRO — Super Admin Dashboard Routes
 * Mount point: /api/admin/dashboard
 */
const express = require('express');
const router = express.Router();

const {
  handleGetDashboardStats,
  handleGetRecentActivity
} = require('../controllers/admin-dashboard.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');

router.use(requireSuperAdminAuth);

// GET /api/admin/dashboard/stats — Aggregated tenant, subscription, and financial metrics
router.get('/stats', handleGetDashboardStats);

// GET /api/admin/dashboard/activity — Recent administrative activity timeline
router.get('/activity', handleGetRecentActivity);

module.exports = router;
