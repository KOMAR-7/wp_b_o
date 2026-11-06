/**
 * RESTOPRO — Super Admin Subscription Management Routes
 * Mount point: /api/admin/subscriptions
 */
const express = require('express');
const router = express.Router();

const {
  handleListSubscriptions,
  handleCreateSubscription,
  handleGetSubscriptionById,
  handleUpdateSubscription,
  handleUpdateSubscriptionStatus
} = require('../controllers/admin-subscription.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');

// All subscription routes strictly require Super Admin authentication
router.use(requireSuperAdminAuth);

// GET /api/admin/subscriptions — List subscriptions with filters
router.get('/', handleListSubscriptions);

// POST /api/admin/subscriptions — Create or renew subscription
router.post('/', handleCreateSubscription);

// GET /api/admin/subscriptions/:id — Get subscription details & payments
router.get('/:id', handleGetSubscriptionById);

// PUT /api/admin/subscriptions/:id — Update subscription details
router.put('/:id', handleUpdateSubscription);

// PATCH /api/admin/subscriptions/:id/status — Transition subscription status
router.patch('/:id/status', handleUpdateSubscriptionStatus);

module.exports = router;

