/**
 * RESTOPRO — Super Admin Manual Payment Management Service
 * Handles recording offline client payments, partial installments, and reversal tracking.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');

/**
 * Lists recorded payments with filtering by restaurant, subscription, date range, and status.
 */
async function listPayments({
  restaurant_id,
  subscription_id,
  status,
  payment_mode,
  startDate,
  endDate,
  page = 1,
  limit = 10,
  sortBy = 'payment_date',
  sortOrder = 'desc'
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const skip = (pageNum - 1) * limitNum;

  const where = {};

  if (restaurant_id && typeof restaurant_id === 'string' && restaurant_id.trim().length > 0) {
    where.restaurant_id = restaurant_id.trim();
  }

  if (subscription_id && typeof subscription_id === 'string' && subscription_id.trim().length > 0) {
    where.subscription_id = subscription_id.trim();
  }

  if (status && typeof status === 'string' && status.trim().length > 0) {
    where.status = status.trim().toUpperCase();
  }

  if (payment_mode && typeof payment_mode === 'string' && payment_mode.trim().length > 0) {
    where.payment_mode = payment_mode.trim().toUpperCase();
  }

  if (startDate || endDate) {
    where.payment_date = {};
    if (startDate) where.payment_date.gte = new Date(startDate);
    if (endDate) where.payment_date.lte = new Date(endDate);
  }

  const validSortFields = ['payment_date', 'amount', 'created_at', 'status'];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'payment_date';
  const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc';

  const [total, items] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { [sortField]: sortDirection },
      include: {
        restaurant: {
          select: { id: true, name: true, phone_number_id: true }
        },
        subscription: {
          select: { id: true, plan_name: true, amount: true }
        },
        recorded_by: {
          select: { id: true, name: true, email: true }
        },
        reversals: {
          select: { id: true, payment_date: true, notes: true }
        },
        original_payment: {
          select: { id: true, transaction_reference: true, amount: true }
        }
      }
    })
  ]);

  const sanitized = items.map((p) => ({
    ...p,
    amount: Number(p.amount),
    subscription: p.subscription ? {
      ...p.subscription,
      amount: Number(p.subscription.amount)
    } : null,
    original_payment: p.original_payment ? {
      ...p.original_payment,
      amount: Number(p.original_payment.amount)
    } : null
  }));

  return {
    payments: sanitized,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1
    }
  };
}

/**
 * Manually records a client payment.
 */
async function recordPayment(data, adminId) {
  const {
    restaurant_id,
    subscription_id,
    amount,
    currency = 'INR',
    payment_date,
    payment_mode = 'BANK_TRANSFER',
    transaction_reference,
    notes
  } = data;

  if (!restaurant_id || typeof restaurant_id !== 'string') {
    const err = new Error('Valid restaurant_id is required');
    err.statusCode = 400;
    throw err;
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    const err = new Error('Payment amount must be a positive number strictly greater than 0');
    err.statusCode = 400;
    throw err;
  }

  const validModes = ['UPI', 'BANK_TRANSFER', 'CASH', 'OTHER'];
  const normalizedMode = validModes.includes(payment_mode) ? payment_mode : 'BANK_TRANSFER';

  // Verify restaurant exists
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurant_id }
  });

  if (!restaurant) {
    const err = new Error(`Restaurant with ID "${restaurant_id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // If subscription_id provided, verify ownership
  if (subscription_id && typeof subscription_id === 'string' && subscription_id.trim().length > 0) {
    const cleanSubId = subscription_id.trim();
    const subscription = await prisma.subscription.findUnique({
      where: { id: cleanSubId }
    });

    if (!subscription) {
      const err = new Error(`Subscription with ID "${cleanSubId}" not found`);
      err.statusCode = 404;
      throw err;
    }

    if (subscription.restaurant_id !== restaurant_id) {
      const err = new Error(`Subscription "${cleanSubId}" does not belong to restaurant "${restaurant_id}"`);
      err.statusCode = 400;
      throw err;
    }
  }

  const parsedDate = payment_date ? new Date(payment_date) : new Date();

  const created = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        restaurant_id,
        subscription_id: subscription_id && subscription_id.trim().length > 0 ? subscription_id.trim() : null,
        amount: numAmount,
        currency: (currency || 'INR').trim().toUpperCase(),
        payment_date: isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
        payment_mode: normalizedMode,
        transaction_reference: transaction_reference ? transaction_reference.trim() : null,
        status: 'RECORDED',
        notes: notes ? notes.trim() : null,
        recorded_by_admin_id: adminId || null
      },
      include: {
        restaurant: {
          select: { id: true, name: true, phone_number_id: true }
        },
        subscription: {
          select: { id: true, plan_name: true }
        },
        recorded_by: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    await tx.auditLog.create({
      data: {
        admin_user_id: adminId || null,
        action: 'PAYMENT_RECORDED',
        entity_type: 'Payment',
        entity_id: payment.id,
        metadata: {
          restaurantId: payment.restaurant_id,
          subscriptionId: payment.subscription_id,
          amount: Number(payment.amount),
          paymentMode: payment.payment_mode,
          transactionReference: payment.transaction_reference
        }
      }
    });

    return payment;
  });

  logger.info('Payment recorded successfully by admin', {
    paymentId: created.id,
    restaurantId: created.restaurant_id,
    amount: created.amount
  });

  return {
    ...created,
    amount: Number(created.amount)
  };
}

/**
 * Retrieves payment details with reversal history and recording admin.
 */
async function getPaymentById(id) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Valid payment ID is required');
    err.statusCode = 400;
    throw err;
  }

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      restaurant: {
        select: {
          id: true,
          name: true,
          phone_number_id: true,
          owner_name: true,
          owner_phone: true,
          email: true
        }
      },
      subscription: {
        select: {
          id: true,
          plan_name: true,
          amount: true,
          start_date: true,
          end_date: true,
          status: true
        }
      },
      recorded_by: {
        select: { id: true, name: true, email: true }
      },
      reversals: {
        include: {
          recorded_by: {
            select: { id: true, name: true, email: true }
          }
        }
      },
      original_payment: true
    }
  });

  if (!payment) {
    const err = new Error(`Payment with ID "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  return {
    ...payment,
    amount: Number(payment.amount),
    subscription: payment.subscription ? {
      ...payment.subscription,
      amount: Number(payment.subscription.amount)
    } : null,
    reversals: payment.reversals.map((r) => ({
      ...r,
      amount: Number(r.amount)
    })),
    original_payment: payment.original_payment ? {
      ...payment.original_payment,
      amount: Number(payment.original_payment.amount)
    } : null
  };
}

/**
 * Reverses a recorded payment safely using self-referential tracking.
 */
async function reversePayment(id, { reason = '' }, adminId) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Valid payment ID is required');
    err.statusCode = 400;
    throw err;
  }

  const target = await prisma.payment.findUnique({
    where: { id }
  });

  if (!target) {
    const err = new Error(`Payment with ID "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  if (target.status === 'REVERSED') {
    const err = new Error('Payment is already reversed');
    err.statusCode = 400;
    throw err;
  }

  if (target.original_payment_id !== null) {
    const err = new Error('Cannot reverse a reversal transaction');
    err.statusCode = 400;
    throw err;
  }

  // Check if a reversal already exists for this payment
  const existingReversal = await prisma.payment.findFirst({
    where: { original_payment_id: id }
  });

  if (existingReversal) {
    const err = new Error(`Payment already has an associated reversal record (${existingReversal.id})`);
    err.statusCode = 400;
    throw err;
  }

  const result = await prisma.$transaction(async (tx) => {
    // 1. Mark original payment as REVERSED
    const updatedOriginal = await tx.payment.update({
      where: { id },
      data: { status: 'REVERSED' }
    });

    // 2. Create reversal entry
    const reversalRef = `REV-${target.transaction_reference || target.id.substring(0, 8)}`;
    const reversalPayment = await tx.payment.create({
      data: {
        restaurant_id: target.restaurant_id,
        subscription_id: target.subscription_id,
        amount: target.amount,
        currency: target.currency,
        payment_date: new Date(),
        payment_mode: target.payment_mode,
        transaction_reference: reversalRef,
        status: 'REVERSED',
        notes: reason && reason.trim().length > 0
          ? `Reversal: ${reason.trim()}`
          : 'Manual payment reversal by Super Admin',
        recorded_by_admin_id: adminId || null,
        original_payment_id: id
      }
    });

    // 3. Record audit log
    await tx.auditLog.create({
      data: {
        admin_user_id: adminId || null,
        action: 'PAYMENT_REVERSED',
        entity_type: 'Payment',
        entity_id: id,
        metadata: {
          originalPaymentId: id,
          reversalPaymentId: reversalPayment.id,
          amount: Number(target.amount),
          restaurantId: target.restaurant_id,
          reason: reason ? reason.trim() : null
        }
      }
    });

    return {
      original: updatedOriginal,
      reversal: reversalPayment
    };
  });

  logger.info('Payment reversed successfully by admin', {
    paymentId: id,
    reversalId: result.reversal.id,
    amount: target.amount
  });

  return {
    success: true,
    original: {
      ...result.original,
      amount: Number(result.original.amount)
    },
    reversal: {
      ...result.reversal,
      amount: Number(result.reversal.amount)
    }
  };
}

module.exports = {
  listPayments,
  recordPayment,
  getPaymentById,
  reversePayment
};
