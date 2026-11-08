/**
 * RESTOPRO — Super Admin Restaurant Management Routes
 * Mount point: /api/admin/restaurants
 */
const express = require('express');
const router = express.Router();

const {
  handleListRestaurants,
  handleCreateRestaurant,
  handleGetRestaurantById,
  handleUpdateRestaurant,
  handleUpdateRestaurantStatus,
  handleRetryOutbox
} = require('../controllers/admin-restaurant.controller');
const {
  handleGetUnassignedRestaurants,
  handleAssignRestaurant,
  handleUnassignRestaurant
} = require('../controllers/admin-central-account.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');

// All restaurant management routes strictly require Super Admin authentication
router.use(requireSuperAdminAuth);

// GET /api/admin/restaurants/unassigned-central-account — List restaurants without central account
router.get('/unassigned-central-account', handleGetUnassignedRestaurants);

// GET /api/admin/restaurants — List restaurants with pagination, search & filters
router.get('/', handleListRestaurants);

// POST /api/admin/restaurants — Manually register/onboard new restaurant
router.post('/', handleCreateRestaurant);

// PUT /api/admin/restaurants/:restaurantId/central-account — Assign restaurant to central account
router.put('/:restaurantId/central-account', handleAssignRestaurant);

// DELETE /api/admin/restaurants/:restaurantId/central-account — Remove central account assignment
router.delete('/:restaurantId/central-account', handleUnassignRestaurant);

// GET /api/admin/restaurants/:id — Get full restaurant profile, subscriptions & payments
router.get('/:id', handleGetRestaurantById);

// PUT /api/admin/restaurants/:id — Update restaurant profile fields
router.put('/:id', handleUpdateRestaurant);

// PATCH /api/admin/restaurants/:id/status — Activate, suspend, onboard, or offboard restaurant
router.patch('/:id/status', handleUpdateRestaurantStatus);

// POST /api/admin/restaurants/:id/retry-outbox — Retry eligible failed outbox messages after credential fix
router.post('/:id/retry-outbox', handleRetryOutbox);

module.exports = router;

