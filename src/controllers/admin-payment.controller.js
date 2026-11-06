/**
 * RESTOPRO — Super Admin Payment Management Controller
 */
const paymentService = require('../services/admin-payment.service');
const logger = require('../utils/logger');

async function handleListPayments(req, res) {
  try {
    const result = await paymentService.listPayments(req.query);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error listing payments', { error: err.message });
    return res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
}

async function handleRecordPayment(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const result = await paymentService.recordPayment(req.body, adminId);
    return res.status(201).json({
      success: true,
      payment: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error recording payment', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

async function handleGetPaymentById(req, res) {
  try {
    const result = await paymentService.getPaymentById(req.params.id);
    return res.status(200).json({
      payment: result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error retrieving payment', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

async function handleReversePayment(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { reason } = req.body || {};
    const result = await paymentService.reversePayment(req.params.id, { reason }, adminId);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error reversing payment', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: err.message });
  }
}

module.exports = {
  handleListPayments,
  handleRecordPayment,
  handleGetPaymentById,
  handleReversePayment
};
