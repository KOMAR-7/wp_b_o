/**
 * RESTOPRO — Super Admin Audit Log Routes
 * Mount point: /api/admin/audit-logs
 */
const express = require('express');
const router = express.Router();

const { handleListAuditLogs } = require('../controllers/admin-dashboard.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');

router.use(requireSuperAdminAuth);

// GET /api/admin/audit-logs — Paginated, append-only administrative audit trails
router.get('/', handleListAuditLogs);

module.exports = router;
