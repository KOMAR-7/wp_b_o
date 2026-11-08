/**
 * RESTOPRO — Super Admin Central WhatsApp Management Routes
 * Mount points:
 * - /api/admin/central-account   (Singular / Legacy backward-compatible)
 * - /api/admin/central-accounts  (Plural / Multi-account management)
 */
const express = require('express');
const router = express.Router();

const {
  handleListCentralAccounts,
  handleGetCentralAccountById,
  handleGetCentralAccount,
  handleCreateCentralAccount,
  handleCreateCentralAccountPlural,
  handleUpdateCentralAccount,
  handleUpdateCentralAccountById,
  handleTestAccountConnectionById,
  handleTestConnection,
  handleActivateCentralAccount,
  handleDeactivateCentralAccount,
  handleDeleteCentralAccount,
  handleGetAssignedRestaurants,
  handleGetUnassignedRestaurants,
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

// Root collection GET: Return all accounts if /central-accounts or ?all=true; else active account for legacy
router.get('/', (req, res, next) => {
  if (req.baseUrl === '/api/admin/central-accounts' || req.query.all === 'true') {
    return handleListCentralAccounts(req, res, next);
  }
  return handleGetCentralAccount(req, res, next);
});

// Root collection POST: Multi-account if /central-accounts; single-active defense if legacy /central-account
router.post('/', (req, res, next) => {
  if (req.baseUrl === '/api/admin/central-accounts') {
    return handleCreateCentralAccountPlural(req, res, next);
  }
  return handleCreateCentralAccount(req, res, next);
});

// Root PATCH: Update active account (Legacy)
router.patch('/', handleUpdateCentralAccount);

// Test connection on active central account (Legacy)
router.post('/test-connection', centralConnectionTestRateLimiter, handleTestConnection);

// Unassigned restaurants lookup
router.get('/unassigned-restaurants', handleGetUnassignedRestaurants);

// Template management endpoints (Shared)
router.get('/templates', handleGetTemplates);
router.get('/templates/definitions', handleGetTemplateDefinitions);
router.post('/templates/submit', handleSubmitTemplatesToMeta);
router.post('/templates/verify-meta', handleVerifyTemplatesWithMeta);
router.patch('/templates/:templateName', handleUpdateTemplate);

// Specific account ID operations
router.get('/:id', handleGetCentralAccountById);
router.patch('/:id', handleUpdateCentralAccountById);
router.put('/:id', handleUpdateCentralAccountById);
router.delete('/:id', handleDeleteCentralAccount);
router.post('/:id/test-connection', centralConnectionTestRateLimiter, handleTestAccountConnectionById);
router.post('/:id/activate', handleActivateCentralAccount);
router.post('/:id/deactivate', handleDeactivateCentralAccount);
router.get('/:id/restaurants', handleGetAssignedRestaurants);

module.exports = router;
