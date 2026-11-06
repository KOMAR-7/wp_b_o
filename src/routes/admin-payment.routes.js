/**
 * RESTOPRO — Super Admin Payment Management Routes
 * Mount point: /api/admin/payments
 */
const express = require('express');
const router = express.Router();

const {
  handleListPayments,
  handleRecordPayment,
  handleGetPaymentById,
  handleReversePayment
} = require('../controllers/admin-payment.controller');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');

// All payment routes strictly require Super Admin authentication
router.use(requireSuperAdminAuth);

// GET /api/admin/payments — List payments with filters
router.get('/', handleListPayments);

// POST /api/admin/payments — Record manual client payment
router.post('/', handleRecordPayment);

// GET /api/admin/payments/:id — Get payment details & reversal info
router.get('/:id', handleGetPaymentById);

// PATCH /api/admin/payments/:id/reverse — Reverse a recorded payment
router.patch('/:id/reverse', handleReversePayment);

module.exports = router;

