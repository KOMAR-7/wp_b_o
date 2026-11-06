/**
 * RESTOPRO — Super Admin Dashboard, Database Overview & Audit Log Service
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');

/**
 * Computes dashboard platform metrics and financial summaries.
 */
async function getDashboardStats() {
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [
    restaurantCounts,
    subscriptionCounts,
    expiringSoonCount,
    allPayments,
    activeSubscriptions
  ] = await Promise.all([
    // Group counts for restaurants by tenant_status
    prisma.restaurant.groupBy({
      by: ['tenant_status'],
      _count: { id: true }
    }),
    // Group counts for subscriptions by status
    prisma.subscription.groupBy({
      by: ['status'],
      _count: { id: true }
    }),
    // Expiring within 30 days
    prisma.subscription.count({
      where: {
        status: 'ACTIVE',
        end_date: {
          gte: now,
          lte: in30Days
        }
      }
    }),
    // Payments for financial calculations
    prisma.payment.findMany({
      select: {
        id: true,
        amount: true,
        status: true,
        subscription_id: true,
        original_payment_id: true
      }
    }),
    // Active subscriptions for outstanding balance calculation
    prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        amount: true,
        payments: {
          where: { status: 'RECORDED' },
          select: { amount: true }
        }
      }
    })
  ]);

  // Aggregate restaurant counts
  const restaurants = {
    total: 0,
    active: 0,
    suspended: 0,
    onboarding: 0,
    offboarded: 0
  };

  for (const group of restaurantCounts) {
    const count = group._count.id;
    restaurants.total += count;
    const statusKey = group.tenant_status.toLowerCase();
    if (restaurants[statusKey] !== undefined) {
      restaurants[statusKey] = count;
    }
  }

  // Aggregate subscription counts
  const subscriptions = {
    total: 0,
    active: 0,
    pending: 0,
    expired: 0,
    cancelled: 0,
    expiring_soon: expiringSoonCount
  };

  for (const group of subscriptionCounts) {
    const count = group._count.id;
    subscriptions.total += count;
    const statusKey = group.status.toLowerCase();
    if (subscriptions[statusKey] !== undefined) {
      subscriptions[statusKey] = count;
    }
  }

  // Financial calculations
  let totalValidPayments = 0;
  let totalReversedPayments = 0;
  let recordedPaymentCount = 0;
  let reversedPaymentCount = 0;

  for (const payment of allPayments) {
    const amt = Number(payment.amount);
    if (payment.status === 'RECORDED') {
      totalValidPayments += amt;
      recordedPaymentCount++;
    } else if (payment.status === 'REVERSED') {
      totalReversedPayments += amt;
      reversedPaymentCount++;
    }
  }

  // Active subscription value and outstanding balances
  let activeSubscriptionsValue = 0;
  let totalOutstandingBalance = 0;

  for (const sub of activeSubscriptions) {
    const subAmt = Number(sub.amount);
    activeSubscriptionsValue += subAmt;
    const paidForSub = sub.payments.reduce((acc, p) => acc + Number(p.amount), 0);
    totalOutstandingBalance += Math.max(0, subAmt - paidForSub);
  }

  return {
    restaurants,
    subscriptions,
    financials: {
      total_recorded_payments: totalValidPayments,
      recorded_payment_count: recordedPaymentCount,
      total_reversed_payments: totalReversedPayments,
      reversed_payment_count: reversedPaymentCount,
      active_subscriptions_value: activeSubscriptionsValue,
      total_outstanding_balance: totalOutstandingBalance,
      currency: 'INR'
    }
  };
}

/**
 * Returns recent platform activity timeline.
 */
async function getRecentActivity(limit = 15) {
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 15));

  const logs = await prisma.auditLog.findMany({
    take: limitNum,
    orderBy: { created_at: 'desc' },
    include: {
      admin_user: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  return {
    activities: logs.map((log) => ({
      id: log.id,
      action: log.action,
      entity_type: log.entity_type,
      entity_id: log.entity_id,
      admin: log.admin_user ? { name: log.admin_user.name, email: log.admin_user.email } : { name: 'System' },
      metadata: log.metadata,
      created_at: log.created_at
    }))
  };
}

/**
 * Returns safe system and database operational metrics.
 * Strictly avoids exposing passwords, connection strings, or raw SQL capabilities.
 */
async function getDatabaseOverview() {
  const startTime = Date.now();
  let dbStatus = 'disconnected';
  let latencyMs = 0;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'connected';
    latencyMs = Date.now() - startTime;
  } catch (err) {
    logger.error('Database overview health query failed', { error: err.message });
  }

  // Fetch safe entity counts
  const [
    restaurantCount,
    orderCount,
    webhookCount,
    outboxCount,
    sessionCount,
    subscriptionCount,
    paymentCount,
    auditLogCount
  ] = await Promise.all([
    prisma.restaurant.count().catch(() => 0),
    prisma.order.count().catch(() => 0),
    prisma.webhookEvent.count().catch(() => 0),
    prisma.outboxMessage.count().catch(() => 0),
    prisma.conversationSession.count().catch(() => 0),
    prisma.subscription.count().catch(() => 0),
    prisma.payment.count().catch(() => 0),
    prisma.auditLog.count().catch(() => 0)
  ]);

  let appliedMigrationsCount = 0;
  try {
    const migrations = await prisma.$queryRawUnsafe(
      'SELECT count(*) as count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;'
    );
    if (migrations && migrations[0]) {
      appliedMigrationsCount = parseInt(migrations[0].count, 10) || 0;
    }
  } catch (_) {
    // Migration table might not be queryable in all configurations
  }

  return {
    database: {
      status: dbStatus,
      provider: 'PostgreSQL',
      latency_ms: latencyMs,
      applied_migrations: appliedMigrationsCount,
      table_counts: {
        restaurants: restaurantCount,
        orders: orderCount,
        webhook_events: webhookCount,
        outbox_messages: outboxCount,
        conversation_sessions: sessionCount,
        subscriptions: subscriptionCount,
        payments: paymentCount,
        audit_logs: auditLogCount
      }
    },
    system: {
      node_version: process.version,
      platform: process.platform,
      uptime_seconds: Math.floor(process.uptime()),
      memory_usage: {
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      }
    }
  };
}

/**
 * Lists audit logs with pagination and filters. Append-only, no deletion.
 */
async function listAuditLogs({
  action,
  entity_type,
  admin_id,
  startDate,
  endDate,
  page = 1,
  limit = 20
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const where = {};

  if (action && typeof action === 'string' && action.trim().length > 0) {
    where.action = action.trim();
  }

  if (entity_type && typeof entity_type === 'string' && entity_type.trim().length > 0) {
    where.entity_type = entity_type.trim();
  }

  if (admin_id && typeof admin_id === 'string' && admin_id.trim().length > 0) {
    where.admin_user_id = admin_id.trim();
  }

  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) where.created_at.gte = new Date(startDate);
    if (endDate) where.created_at.lte = new Date(endDate);
  }

  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { created_at: 'desc' },
      include: {
        admin_user: {
          select: { id: true, name: true, email: true, role: true }
        }
      }
    })
  ]);

  return {
    audit_logs: items,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1
    }
  };
}

module.exports = {
  getDashboardStats,
  getRecentActivity,
  getDatabaseOverview,
  listAuditLogs
};

