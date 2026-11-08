/**
 * RESTOPRO — Super Admin Central WhatsApp Management Routes
 * Mount point: /api/admin/central-account
 */
const express = require('express');
const router = express.Router();

const {
  handleGetCentralAccount,
  handleCreateCentralAccount,
  handleUpdateCentralAccount,
  handleTestConnection,
  handleGetTemplates,
  handleGetTemplateDefinitions,
  handleUpdateTemplate,
  handleVerifyTemplatesWithMeta,
  handleSubmitTemplatesToMeta
} = require('../controllers/admin-central-account.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');
const { centralConnectionTestRateLimiter } = require('../middleware/adminRateLimiter');

// All central account routes strictly require Super Admin authentication
router.use(requireSuperAdminAuth);

// GET /api/admin/central-account — Get active central account configuration & health
router.get('/', handleGetCentralAccount);

// POST /api/admin/central-account — Onboard/register new Central WhatsApp account
router.post('/', handleCreateCentralAccount);

// PATCH /api/admin/central-account — Update/rotate credentials for Central WhatsApp account
router.patch('/', handleUpdateCentralAccount);

// POST /api/admin/central-account/test-connection — Test Meta API connectivity (Rate Limited)
router.post('/test-connection', centralConnectionTestRateLimiter, handleTestConnection);

// GET /api/admin/central-account/templates — Get individual status for the 3 templates
router.get('/templates', handleGetTemplates);

// GET /api/admin/central-account/templates/definitions — Get copy-ready Meta template definitions
router.get('/templates/definitions', handleGetTemplateDefinitions);

// POST /api/admin/central-account/templates/submit — Submit template(s) directly to Meta Graph API
router.post('/templates/submit', handleSubmitTemplatesToMeta);

// POST /api/admin/central-account/templates/verify-meta — Query Meta Graph API directly for template approval
router.post('/templates/verify-meta', handleVerifyTemplatesWithMeta);

// PATCH /api/admin/central-account/templates/:templateName — Update individual template approval
router.patch('/templates/:templateName', handleUpdateTemplate);

module.exports = router;

