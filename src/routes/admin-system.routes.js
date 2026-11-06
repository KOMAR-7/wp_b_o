/**
 * RESTOPRO — Super Admin System & Database Overview Routes
 * Mount point: /api/admin/system
 */
const express = require('express');
const router = express.Router();

const { handleGetDatabaseOverview } = require('../controllers/admin-dashboard.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');

router.use(requireSuperAdminAuth);

// GET /api/admin/system/database — Safe operational database & system status
router.get('/database', handleGetDatabaseOverview);

module.exports = router;
