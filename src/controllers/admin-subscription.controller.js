/**
 * RESTOPRO — Super Admin Subscription Management Controller
 */
const subscriptionService = require('../services/admin-subscription.service');
const logger = require('../utils/logger');

async function handleListSubscriptions(req, res) {
  try {
    const result = await subscriptionService.listSubscriptions(req.query);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error listing subscriptions', { error: err.message });
    return res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
}

async function handleCreateSubscription(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const result = await subscriptionService.createSubscription(req.body, adminId);
    return res.status(201).json({
      success: true,
      subscription: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error creating subscription', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

async function handleGetSubscriptionById(req, res) {
  try {
    const result = await subscriptionService.getSubscriptionById(req.params.id);
    return res.status(200).json({
      subscription: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error retrieving subscription', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

async function handleUpdateSubscription(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const result = await subscriptionService.updateSubscription(req.params.id, req.body, adminId);
    return res.status(200).json({
      success: true,
      subscription: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error updating subscription', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

async function handleUpdateSubscriptionStatus(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { status } = req.body || {};
    const result = await subscriptionService.updateSubscriptionStatus(req.params.id, status, adminId);
    return res.status(200).json({
      success: true,
      subscription: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error updating subscription status', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

module.exports = {
  handleListSubscriptions,
  handleCreateSubscription,
  handleGetSubscriptionById,
  handleUpdateSubscription,
  handleUpdateSubscriptionStatus
};

