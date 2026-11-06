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
  handleUpdateRestaurantStatus
} = require('../controllers/admin-restaurant.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');

// All restaurant management routes strictly require Super Admin authentication
router.use(requireSuperAdminAuth);

// GET /api/admin/restaurants — List restaurants with pagination, search & filters
router.get('/', handleListRestaurants);

// POST /api/admin/restaurants — Manually register/onboard new restaurant
router.post('/', handleCreateRestaurant);

// GET /api/admin/restaurants/:id — Get full restaurant profile, subscriptions & payments
router.get('/:id', handleGetRestaurantById);

// PUT /api/admin/restaurants/:id — Update restaurant profile fields
router.put('/:id', handleUpdateRestaurant);

// PATCH /api/admin/restaurants/:id/status — Activate, suspend, onboard, or offboard restaurant
router.patch('/:id/status', handleUpdateRestaurantStatus);

module.exports = router;
