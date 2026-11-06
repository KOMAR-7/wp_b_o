/**
 * RESTOPRO — Super Admin Restaurant Management Controller
 */
const restaurantService = require('../services/admin-restaurant.service');
const logger = require('../utils/logger');

async function handleListRestaurants(req, res) {
  try {
    const result = await restaurantService.listRestaurants(req.query);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error listing restaurants', { error: err.message });
    return res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
}

async function handleCreateRestaurant(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const result = await restaurantService.createRestaurant(req.body, adminId);
    return res.status(201).json({
      success: true,
      restaurant: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error creating restaurant', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

async function handleGetRestaurantById(req, res) {
  try {
    const result = await restaurantService.getRestaurantById(req.params.id);
    return res.status(200).json({
      restaurant: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error retrieving restaurant', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

async function handleUpdateRestaurant(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const result = await restaurantService.updateRestaurant(req.params.id, req.body, adminId);
    return res.status(200).json({
      success: true,
      restaurant: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error updating restaurant', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

async function handleUpdateRestaurantStatus(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { status } = req.body || {};
    const result = await restaurantService.updateRestaurantStatus(req.params.id, status, adminId);
    return res.status(200).json({
      success: true,
      restaurant: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error updating restaurant status', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

module.exports = {
  handleListRestaurants,
  handleCreateRestaurant,
  handleGetRestaurantById,
  handleUpdateRestaurant,
  handleUpdateRestaurantStatus
};

