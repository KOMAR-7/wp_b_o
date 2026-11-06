/**
 * RESTOPRO — Super Admin Subscription Management Service
 * Handles yearly plans, renewals, multi-subscription tracking, and balance calculations.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');

/**
 * Calculates remaining days until a given end date.
 * @param {Date} endDate
 * @returns {number}
 */
function calculateRemainingDays(endDate) {
  const now = new Date();
  const end = new Date(endDate);
  const diffTime = end.getTime() - now.getTime();
  if (diffTime <= 0) return 0;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Lists subscriptions with search, restaurant filter, status filter, and metrics.
 */
async function listSubscriptions({
  restaurant_id,
  status,
  search = '',
  page = 1,
  limit = 10,
  sortBy = 'created_at',
  sortOrder = 'desc'
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const skip = (pageNum - 1) * limitNum;

  const where = {};

  if (restaurant_id && typeof restaurant_id === 'string' && restaurant_id.trim().length > 0) {
    where.restaurant_id = restaurant_id.trim();
  }

  if (status && typeof status === 'string' && status.trim().length > 0) {
    where.status = status.trim().toUpperCase();
  }

  if (search && typeof search === 'string' && search.trim().length > 0) {
    const q = search.trim();
    where.OR = [
      { plan_name: { contains: q, mode: 'insensitive' } },
      { restaurant: { name: { contains: q, mode: 'insensitive' } } },
      { restaurant: { phone_number_id: { contains: q, mode: 'insensitive' } } }
    ];
  }

  const validSortFields = ['created_at', 'start_date', 'end_date', 'amount', 'status'];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at';
  const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc';

  const [total, items] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { [sortField]: sortDirection },
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            phone_number_id: true,
            tenant_status: true,
            is_active: true
          }
        },
        payments: {
          where: { status: 'RECORDED' },
          select: { amount: true }
        }
      }
    })
  ]);

  const sanitized = items.map((sub) => {
    const totalPaid = sub.payments.reduce((acc, p) => acc + Number(p.amount), 0);
    const amount = Number(sub.amount);
    const outstanding = Math.max(0, amount - totalPaid);
    const remainingDays = calculateRemainingDays(sub.end_date);

    return {
      id: sub.id,
      restaurant_id: sub.restaurant_id,
      restaurant: sub.restaurant,
      plan_name: sub.plan_name,
      amount,
      currency: sub.currency,
      start_date: sub.start_date,
      end_date: sub.end_date,
      status: sub.status,
      notes: sub.notes,
      total_paid: totalPaid,
      outstanding_balance: outstanding,
      remaining_days: remainingDays,
      created_at: sub.created_at,
      updated_at: sub.updated_at
    };
  });

  return {
    subscriptions: sanitized,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1
    }
  };
}

/**
 * Creates a new subscription for a restaurant with overlap safety.
 */
async function createSubscription(data, adminId) {
  const {
    restaurant_id,
    plan_name,
    amount,
    currency = 'INR',
    start_date,
    end_date,
    status = 'PENDING',
    notes
  } = data;

  if (!restaurant_id || typeof restaurant_id !== 'string') {
    const err = new Error('Valid restaurant_id is required');
    err.statusCode = 400;
    throw err;
  }

  if (!plan_name || typeof plan_name !== 'string' || plan_name.trim().length === 0) {
    const err = new Error('Plan name is required');
    err.statusCode = 400;
    throw err;
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount < 0) {
    const err = new Error('Amount must be a non-negative number');
    err.statusCode = 400;
    throw err;
  }

  if (!start_date || !end_date) {
    const err = new Error('Both start_date and end_date are required');
    err.statusCode = 400;
    throw err;
  }

  const parsedStart = new Date(start_date);
  const parsedEnd = new Date(end_date);

  if (isNaN(parsedStart.getTime()) || isNaN(parsedEnd.getTime())) {
    const err = new Error('Invalid date format for start_date or end_date');
    err.statusCode = 400;
    throw err;
  }

  if (parsedStart >= parsedEnd) {
    const err = new Error('start_date must be strictly before end_date');
    err.statusCode = 400;
    throw err;
  }

  const validStatuses = ['PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED'];
  const normalizedStatus = validStatuses.includes(status) ? status : 'PENDING';

  // Check restaurant exists
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurant_id }
  });

  if (!restaurant) {
    const err = new Error(`Restaurant with ID "${restaurant_id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // Prevent accidental overlapping active subscriptions
  if (normalizedStatus === 'ACTIVE') {
    const overlapping = await prisma.subscription.findFirst({
      where: {
        restaurant_id,
        status: 'ACTIVE',
        start_date: { lte: parsedEnd },
        end_date: { gte: parsedStart }
      }
    });

    if (overlapping) {
      const err = new Error(
        `Restaurant already has an active subscription ("${overlapping.plan_name}") spanning this period. Please expire or cancel the existing one before adding another active subscription.`
      );
      err.statusCode = 400;
      throw err;
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.create({
      data: {
        restaurant_id,
        plan_name: plan_name.trim(),
        amount: numAmount,
        currency: (currency || 'INR').trim().toUpperCase(),
        start_date: parsedStart,
        end_date: parsedEnd,
        status: normalizedStatus,
        notes: notes ? notes.trim() : null
      },
      include: {
        restaurant: {
          select: { id: true, name: true, phone_number_id: true }
        }
      }
    });

    await tx.auditLog.create({
      data: {
        admin_user_id: adminId || null,
        action: 'SUBSCRIPTION_CREATED',
        entity_type: 'Subscription',
        entity_id: sub.id,
        metadata: {
          restaurantId: sub.restaurant_id,
          restaurantName: sub.restaurant ? sub.restaurant.name : null,
          planName: sub.plan_name,
          amount: Number(sub.amount),
          status: sub.status,
          startDate: sub.start_date,
          endDate: sub.end_date
        }
      }
    });

    return sub;
  });

  logger.info('Subscription created successfully by admin', {
    subscriptionId: created.id,
    restaurantId: created.restaurant_id,
    planName: created.plan_name
  });

  return {
    ...created,
    amount: Number(created.amount),
    remaining_days: calculateRemainingDays(created.end_date),
    total_paid: 0,
    outstanding_balance: Number(created.amount)
  };
}

/**
 * Retrieves subscription details with associated payments and remaining balance.
 */
async function getSubscriptionById(id) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Valid subscription ID is required');
    err.statusCode = 400;
    throw err;
  }

  const sub = await prisma.subscription.findUnique({
    where: { id },
    include: {
      restaurant: {
        select: {
          id: true,
          name: true,
          phone_number_id: true,
          owner_name: true,
          owner_phone: true,
          email: true,
          tenant_status: true,
          is_active: true
        }
      },
      payments: {
        orderBy: { payment_date: 'desc' },
        include: {
          recorded_by: {
            select: { id: true, name: true, email: true }
          },
          reversals: true
        }
      }
    }
  });

  if (!sub) {
    const err = new Error(`Subscription with ID "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const validPayments = sub.payments.filter((p) => p.status === 'RECORDED');
  const totalPaid = validPayments.reduce((acc, p) => acc + Number(p.amount), 0);
  const amount = Number(sub.amount);
  const outstanding = Math.max(0, amount - totalPaid);
  const remainingDays = calculateRemainingDays(sub.end_date);

  return {
    ...sub,
    amount,
    total_paid: totalPaid,
    outstanding_balance: outstanding,
    remaining_days: remainingDays,
    payments: sub.payments.map((p) => ({
      ...p,
      amount: Number(p.amount)
    }))
  };
}

/**
 * Updates subscription details.
 */
async function updateSubscription(id, updates, adminId) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Valid subscription ID is required');
    err.statusCode = 400;
    throw err;
  }

  const existing = await prisma.subscription.findUnique({ where: { id } });
  if (!existing) {
    const err = new Error(`Subscription with ID "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const updateData = {};

  if (updates.plan_name !== undefined) updateData.plan_name = updates.plan_name.trim();
  if (updates.notes !== undefined) updateData.notes = updates.notes ? updates.notes.trim() : null;

  if (updates.amount !== undefined) {
    const numAmount = parseFloat(updates.amount);
    if (isNaN(numAmount) || numAmount < 0) {
      const err = new Error('Amount must be a non-negative number');
      err.statusCode = 400;
      throw err;
    }
    updateData.amount = numAmount;
  }

  const startDate = updates.start_date ? new Date(updates.start_date) : existing.start_date;
  const endDate = updates.end_date ? new Date(updates.end_date) : existing.end_date;

  if (updates.start_date || updates.end_date) {
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      const err = new Error('Invalid date format for start_date or end_date');
      err.statusCode = 400;
      throw err;
    }
    if (startDate >= endDate) {
      const err = new Error('start_date must be strictly before end_date');
      err.statusCode = 400;
      throw err;
    }
    if (updates.start_date) updateData.start_date = startDate;
    if (updates.end_date) updateData.end_date = endDate;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.subscription.update({
      where: { id },
      data: updateData
    });

    await tx.auditLog.create({
      data: {
        admin_user_id: adminId || null,
        action: 'SUBSCRIPTION_UPDATED',
        entity_type: 'Subscription',
        entity_id: id,
        metadata: {
          updatedFields: Object.keys(updateData)
        }
      }
    });

    return res;
  });

  return {
    ...updated,
    amount: Number(updated.amount),
    remaining_days: calculateRemainingDays(updated.end_date)
  };
}

/**
 * Transitions subscription status (PENDING, ACTIVE, EXPIRED, CANCELLED).
 */
async function updateSubscriptionStatus(id, newStatus, adminId) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Valid subscription ID is required');
    err.statusCode = 400;
    throw err;
  }

  const validStatuses = ['PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED'];
  const normalized = typeof newStatus === 'string' ? newStatus.trim().toUpperCase() : '';

  if (!validStatuses.includes(normalized)) {
    const err = new Error(`Invalid status "${newStatus}". Must be one of: ${validStatuses.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const existing = await prisma.subscription.findUnique({ where: { id } });
  if (!existing) {
    const err = new Error(`Subscription with ID "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // If activating, verify no existing overlapping active subscription
  if (normalized === 'ACTIVE') {
    const overlapping = await prisma.subscription.findFirst({
      where: {
        id: { not: id },
        restaurant_id: existing.restaurant_id,
        status: 'ACTIVE',
        start_date: { lte: existing.end_date },
        end_date: { gte: existing.start_date }
      }
    });

    if (overlapping) {
      const err = new Error(
        `Cannot activate subscription: restaurant already has an active subscription ("${overlapping.plan_name}") spanning this period.`
      );
      err.statusCode = 400;
      throw err;
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.subscription.update({
      where: { id },
      data: { status: normalized }
    });

    await tx.auditLog.create({
      data: {
        admin_user_id: adminId || null,
        action: 'SUBSCRIPTION_STATUS_CHANGED',
        entity_type: 'Subscription',
        entity_id: id,
        metadata: {
          previousStatus: existing.status,
          newStatus: normalized
        }
      }
    });

    return res;
  });

  logger.info('Subscription status transitioned by admin', {
    subscriptionId: id,
    previousStatus: existing.status,
    newStatus: normalized
  });

  return {
    ...updated,
    amount: Number(updated.amount),
    remaining_days: calculateRemainingDays(updated.end_date)
  };
}

module.exports = {
  listSubscriptions,
  createSubscription,
  getSubscriptionById,
  updateSubscription,
  updateSubscriptionStatus,
  calculateRemainingDays
};
