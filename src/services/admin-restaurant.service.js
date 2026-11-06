/**
 * RESTOPRO — Super Admin Restaurant Management Service
 * Handles tenant onboarding, metadata updates, status transitions, and metric calculations.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { encryptToken } = require('../utils/crypto');

/**
 * Sanitizes restaurant object to ensure sensitive credentials are never leaked.
 * @param {Object} restaurant
 * @returns {Object} Public administrative restaurant view
 */
function sanitizeRestaurant(restaurant) {
  if (!restaurant) return null;
  const { access_token_encrypted, ...safe } = restaurant;
  return safe;
}

/**
 * Lists restaurants with pagination, search, status filtering, and sorting.
 */
async function listRestaurants({
  page = 1,
  limit = 10,
  search = '',
  status = '',
  isActive,
  sortBy = 'created_at',
  sortOrder = 'desc'
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const skip = (pageNum - 1) * limitNum;

  const where = {};

  if (search && typeof search === 'string' && search.trim().length > 0) {
    const q = search.trim();
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { phone_number_id: { contains: q, mode: 'insensitive' } },
      { owner_name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { owner_phone: { contains: q, mode: 'insensitive' } }
    ];
  }

  if (status && typeof status === 'string' && status.trim().length > 0) {
    where.tenant_status = status.trim().toUpperCase();
  }

  if (isActive !== undefined && isActive !== '') {
    where.is_active = isActive === 'true' || isActive === true;
  }

  const validSortFields = ['created_at', 'name', 'tenant_status', 'updated_at'];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at';
  const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc';

  const [total, items] = await Promise.all([
    prisma.restaurant.count({ where }),
    prisma.restaurant.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { [sortField]: sortDirection },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          take: 1,
          orderBy: { end_date: 'desc' }
        }
      }
    })
  ]);

  const sanitized = items.map((r) => {
    const activeSub = r.subscriptions && r.subscriptions[0] ? r.subscriptions[0] : null;
    const base = sanitizeRestaurant(r);
    return {
      ...base,
      current_subscription: activeSub ? {
        id: activeSub.id,
        plan_name: activeSub.plan_name,
        amount: Number(activeSub.amount),
        currency: activeSub.currency,
        start_date: activeSub.start_date,
        end_date: activeSub.end_date,
        status: activeSub.status
      } : null
    };
  });

  return {
    restaurants: sanitized,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1
    }
  };
}

/**
 * Creates and onboards a new restaurant client manually.
 */
async function createRestaurant(data, adminId) {
  const {
    name,
    owner_name,
    owner_phone,
    email,
    contact_number,
    address,
    internal_notes,
    phone_number_id,
    waba_id,
    access_token,
    tenant_status = 'ACTIVE'
  } = data;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    const err = new Error('Restaurant name is required');
    err.statusCode = 400;
    throw err;
  }

  if (!owner_phone || typeof owner_phone !== 'string' || owner_phone.trim().length === 0) {
    const err = new Error('Owner phone number is required');
    err.statusCode = 400;
    throw err;
  }

  if (!phone_number_id || typeof phone_number_id !== 'string') {
    const err = new Error('Meta phone_number_id is required');
    err.statusCode = 400;
    throw err;
  }

  const cleanPhoneId = phone_number_id.trim();
  if (!/^\d{8,64}$/.test(cleanPhoneId)) {
    const err = new Error('Invalid phone_number_id format: must contain 8-64 numeric digits');
    err.statusCode = 400;
    throw err;
  }

  if (!waba_id || typeof waba_id !== 'string') {
    const err = new Error('Meta waba_id is required');
    err.statusCode = 400;
    throw err;
  }

  const cleanWabaId = waba_id.trim();
  if (!/^\d{8,64}$/.test(cleanWabaId)) {
    const err = new Error('Invalid waba_id format: must contain 8-64 numeric digits');
    err.statusCode = 400;
    throw err;
  }

  // Check uniqueness of phone_number_id
  const existing = await prisma.restaurant.findUnique({
    where: { phone_number_id: cleanPhoneId }
  });

  if (existing) {
    const err = new Error(`Restaurant with phone_number_id "${cleanPhoneId}" already exists`);
    err.statusCode = 409;
    throw err;
  }

  // Encrypt access token safely
  let encryptedToken;
  if (access_token && typeof access_token === 'string' && access_token.trim().length > 0) {
    encryptedToken = encryptToken(access_token.trim());
  } else {
    encryptedToken = encryptToken('mock_access_token');
  }

  const normalizedStatus = ['ACTIVE', 'SUSPENDED', 'ONBOARDING', 'OFFBOARDED'].includes(tenant_status)
    ? tenant_status
    : 'ACTIVE';

  const isActive = normalizedStatus === 'ACTIVE';

  const created = await prisma.$transaction(async (tx) => {
    const restaurant = await tx.restaurant.create({
      data: {
        name: name.trim(),
        owner_name: owner_name ? owner_name.trim() : null,
        owner_phone: owner_phone.trim(),
        email: email && typeof email === 'string' ? email.trim().toLowerCase() : null,
        contact_number: contact_number ? contact_number.trim() : null,
        address: address ? address.trim() : null,
        internal_notes: internal_notes ? internal_notes.trim() : null,
        phone_number_id: cleanPhoneId,
        waba_id: cleanWabaId,
        access_token_encrypted: encryptedToken,
        tenant_status: normalizedStatus,
        is_active: isActive
      }
    });

    await tx.auditLog.create({
      data: {
        admin_user_id: adminId || null,
        action: 'RESTAURANT_ONBOARDED',
        entity_type: 'Restaurant',
        entity_id: restaurant.id,
        metadata: {
          restaurantName: restaurant.name,
          phoneNumberId: restaurant.phone_number_id,
          wabaId: restaurant.waba_id,
          tenantStatus: restaurant.tenant_status
        }
      }
    });

    return restaurant;
  });

  logger.info('Restaurant onboarded successfully by admin', {
    restaurantId: created.id,
    name: created.name,
    phone_number_id: created.phone_number_id
  });

  return sanitizeRestaurant(created);
}

/**
 * Retrieves full restaurant profile, subscriptions, payments, and financial summary.
 */
async function getRestaurantById(id) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Valid restaurant ID is required');
    err.statusCode = 400;
    throw err;
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id },
    include: {
      subscriptions: {
        orderBy: { created_at: 'desc' }
      },
      payments: {
        orderBy: { payment_date: 'desc' },
        include: {
          subscription: {
            select: { id: true, plan_name: true }
          },
          recorded_by: {
            select: { id: true, name: true, email: true }
          },
          reversals: true
        }
      }
    }
  });

  if (!restaurant) {
    const err = new Error(`Restaurant with ID "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // Calculate financials
  let totalPaymentsRecorded = 0;
  for (const payment of restaurant.payments) {
    if (payment.status === 'RECORDED') {
      totalPaymentsRecorded += Number(payment.amount);
    }
  }

  const activeSub = restaurant.subscriptions.find((s) => s.status === 'ACTIVE') || restaurant.subscriptions[0] || null;

  let outstandingBalance = 0;
  if (activeSub) {
    const subAmount = Number(activeSub.amount);
    const paymentsForSub = restaurant.payments
      .filter((p) => p.subscription_id === activeSub.id && p.status === 'RECORDED')
      .reduce((sum, p) => sum + Number(p.amount), 0);
    outstandingBalance = Math.max(0, subAmount - paymentsForSub);
  }

  const base = sanitizeRestaurant(restaurant);

  return {
    ...base,
    total_recorded_payments: totalPaymentsRecorded,
    outstanding_balance: outstandingBalance,
    current_subscription: activeSub ? {
      ...activeSub,
      amount: Number(activeSub.amount)
    } : null,
    subscriptions: restaurant.subscriptions.map((s) => ({
      ...s,
      amount: Number(s.amount)
    })),
    payments: restaurant.payments.map((p) => ({
      ...p,
      amount: Number(p.amount)
    }))
  };
}

/**
 * Updates a restaurant's profile information.
 */
async function updateRestaurant(id, updates, adminId) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Valid restaurant ID is required');
    err.statusCode = 400;
    throw err;
  }

  const existing = await prisma.restaurant.findUnique({ where: { id } });
  if (!existing) {
    const err = new Error(`Restaurant with ID "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const updateData = {};

  if (updates.name !== undefined) updateData.name = updates.name.trim();
  if (updates.owner_name !== undefined) updateData.owner_name = updates.owner_name ? updates.owner_name.trim() : null;
  if (updates.owner_phone !== undefined) updateData.owner_phone = updates.owner_phone.trim();
  if (updates.email !== undefined) updateData.email = updates.email ? updates.email.trim().toLowerCase() : null;
  if (updates.contact_number !== undefined) updateData.contact_number = updates.contact_number ? updates.contact_number.trim() : null;
  if (updates.address !== undefined) updateData.address = updates.address ? updates.address.trim() : null;
  if (updates.internal_notes !== undefined) updateData.internal_notes = updates.internal_notes ? updates.internal_notes.trim() : null;

  if (updates.phone_number_id !== undefined && updates.phone_number_id.trim() !== existing.phone_number_id) {
    const newPhoneId = updates.phone_number_id.trim();
    if (!/^\d{8,64}$/.test(newPhoneId)) {
      const err = new Error('Invalid phone_number_id format: must contain 8-64 numeric digits');
      err.statusCode = 400;
      throw err;
    }
    const duplicate = await prisma.restaurant.findUnique({ where: { phone_number_id: newPhoneId } });
    if (duplicate) {
      const err = new Error(`Phone Number ID "${newPhoneId}" is already registered to another restaurant`);
      err.statusCode = 409;
      throw err;
    }
    updateData.phone_number_id = newPhoneId;
  }

  if (updates.waba_id !== undefined) {
    const newWabaId = updates.waba_id.trim();
    if (!/^\d{8,64}$/.test(newWabaId)) {
      const err = new Error('Invalid waba_id format: must contain 8-64 numeric digits');
      err.statusCode = 400;
      throw err;
    }
    updateData.waba_id = newWabaId;
  }

  if (updates.access_token && typeof updates.access_token === 'string' && updates.access_token.trim().length > 0) {
    updateData.access_token_encrypted = encryptToken(updates.access_token.trim());
  }

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.restaurant.update({
      where: { id },
      data: updateData
    });

    await tx.auditLog.create({
      data: {
        admin_user_id: adminId || null,
        action: 'RESTAURANT_UPDATED',
        entity_type: 'Restaurant',
        entity_id: id,
        metadata: {
          updatedFields: Object.keys(updateData)
        }
      }
    });

    return res;
  });

  logger.info('Restaurant profile updated by admin', { restaurantId: id });
  return sanitizeRestaurant(updated);
}

/**
 * Transitions restaurant status (ACTIVE, SUSPENDED, ONBOARDING, OFFBOARDED).
 * Synchronizes tenant_status with is_active flag.
 */
async function updateRestaurantStatus(id, newStatus, adminId) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Valid restaurant ID is required');
    err.statusCode = 400;
    throw err;
  }

  const validStatuses = ['ACTIVE', 'SUSPENDED', 'ONBOARDING', 'OFFBOARDED'];
  const normalized = typeof newStatus === 'string' ? newStatus.trim().toUpperCase() : '';

  if (!validStatuses.includes(normalized)) {
    const err = new Error(`Invalid status "${newStatus}". Must be one of: ${validStatuses.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const existing = await prisma.restaurant.findUnique({ where: { id } });
  if (!existing) {
    const err = new Error(`Restaurant with ID "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // Invariant: ACTIVE -> is_active = true; SUSPENDED/ONBOARDING/OFFBOARDED -> is_active = false
  const isActive = normalized === 'ACTIVE';

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.restaurant.update({
      where: { id },
      data: {
        tenant_status: normalized,
        is_active: isActive
      }
    });

    await tx.auditLog.create({
      data: {
        admin_user_id: adminId || null,
        action: 'RESTAURANT_STATUS_CHANGED',
        entity_type: 'Restaurant',
        entity_id: id,
        metadata: {
          previousStatus: existing.tenant_status,
          newStatus: normalized,
          isActive
        }
      }
    });

    return res;
  });

  logger.info('Restaurant status transitioned by admin', {
    restaurantId: id,
    previousStatus: existing.tenant_status,
    newStatus: normalized,
    is_active: isActive
  });

  return sanitizeRestaurant(updated);
}

module.exports = {
  listRestaurants,
  createRestaurant,
  getRestaurantById,
  updateRestaurant,
  updateRestaurantStatus,
  sanitizeRestaurant
};

