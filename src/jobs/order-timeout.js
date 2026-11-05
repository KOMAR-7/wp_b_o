/**
 * RESTOPRO — 30-Minute Order Timeout Auto-Expiry Job
 * Stage 7: Expires unacknowledged pending orders and alerts customers
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');

const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * Builds customer notification text for an expired order.
 */
function buildOrderExpiredCustomerPayload({ order, restaurantName = '' }) {
  const cleanPhone = (order.customer_phone || '').replace(/[^\d]/g, '');
  const prefix = restaurantName ? `*${restaurantName}*` : 'The restaurant';

  const bodyText = `Order Update for *${order.order_reference}*\n\n` +
    `We're sorry, but ${prefix} was unable to confirm your order within ${DEFAULT_TIMEOUT_MINUTES} minutes.\n` +
    `Your order has been automatically cancelled and you have not been charged.\n\n` +
    `We apologize for the inconvenience and hope to serve you another time!`;

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'text',
    text: {
      preview_url: false,
      body: bodyText
    }
  };
}

/**
 * Finds and marks unacknowledged pending orders as EXPIRED after timeoutMinutes.
 * Atomically creates customer notification outbox record.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMinutes=30]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<{expiredCount: number, expiredOrders: Array}>}
 */
async function expireUnacknowledgedOrders({
  timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
  db = prisma
} = {}) {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  // Find candidate orders
  const candidateOrders = await db.order.findMany({
    where: {
      status: 'PENDING_RESTAURANT_CONFIRMATION',
      created_at: { lt: cutoffTime }
    },
    include: {
      restaurant: true
    },
    take: 50
  });

  if (candidateOrders.length === 0) {
    return { expiredCount: 0, expiredOrders: [] };
  }

  const expiredOrders = [];

  for (const candidate of candidateOrders) {
    try {
      const outcome = await db.$transaction(async (tx) => {
        // Lock row to ensure no concurrent owner decision is in flight
        const rows = await tx.$queryRaw`
          SELECT id, restaurant_id, order_reference, customer_phone, status
          FROM orders
          WHERE id = ${candidate.id}::uuid AND status = 'PENDING_RESTAURANT_CONFIRMATION'
          FOR UPDATE;
        `;

        if (!rows || rows.length === 0) {
          // Already transitioned concurrently
          return null;
        }

        const now = new Date();
        const updatedOrder = await tx.order.update({
          where: { id: candidate.id },
          data: {
            status: 'EXPIRED',
            decision_at: now
          }
        });

        const customerPayload = buildOrderExpiredCustomerPayload({
          order: candidate,
          restaurantName: candidate.restaurant?.name || ''
        });

        const cleanCustomerPhone = (candidate.customer_phone || '').replace(/[^\d]/g, '');

        // Persist outbox notification for customer
        await tx.outboxMessage.create({
          data: {
            restaurant_id: candidate.restaurant_id,
            recipient_phone: cleanCustomerPhone,
            message_type: 'CUSTOMER_ORDER_EXPIRED',
            payload: customerPayload,
            idempotency_key: `order_expired_${candidate.id}`,
            status: 'PENDING'
          }
        });

        // Record notification tracking audit entry
        await tx.orderNotification.create({
          data: {
            order_id: candidate.id,
            restaurant_id: candidate.restaurant_id,
            recipient_phone: cleanCustomerPhone,
            notification_type: 'CUSTOMER_ORDER_EXPIRED',
            delivery_status: 'PENDING'
          }
        });

        return updatedOrder;
      });

      if (outcome) {
        logger.info('Order automatically expired due to 30-min owner inactivity', {
          orderId: candidate.id,
          orderReference: candidate.order_reference,
          restaurantId: candidate.restaurant_id
        });
        expiredOrders.push(outcome);
      }
    } catch (err) {
      logger.error('Failed to expire order', {
        orderId: candidate.id,
        error: err.message
      });
    }
  }

  return {
    expiredCount: expiredOrders.length,
    expiredOrders
  };
}

if (require.main === module) {
  expireUnacknowledgedOrders()
    .then(({ expiredCount }) => {
      console.log(`[ORDER TIMEOUT] Done. Expired ${expiredCount} unacknowledged orders.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[ORDER TIMEOUT] Error:', err);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_TIMEOUT_MINUTES,
  buildOrderExpiredCustomerPayload,
  expireUnacknowledgedOrders
};
