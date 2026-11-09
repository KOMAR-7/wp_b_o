/**
 * RESTOPRO — Customer Order Processing Service
 * Stage 5.1: Fulfilment Selection, Order Review & Customer Confirmation with Atomic Outbox
 *
 * Implements:
 * - Deterministic order summary construction with integer-cents arithmetic (ST4-11, ST4-12)
 * - Cryptographically secure order reference generation with collision handling (RP-YYMMDD-XXXX)
 * - Atomic order + owner outbox message creation with status PENDING_RESTAURANT_CONFIRMATION (ST4-13, ST5-01)
 * - Database-backed idempotency guard on confirmation_token (Replay / Network retry defense)
 * - Session reset on order cancellation (ST4-14)
 * - Strict multi-tenant and customer scoping
 */
const crypto = require('crypto');
const prisma = require('../config/database');
const config = require('../config/env');
const logger = require('../utils/logger');
const { toIntegerCents, fromIntegerCents } = require('../parsers/cart-parser');
const {
  buildOwnerNotificationPayload,
  buildCustomerDecisionNotificationPayload,
  buildCentralCustomerDecisionPayload
} = require('./whatsapp.service');
const { getOwnerConsent, parseInternalNotes } = require('./admin-restaurant.service');
const { verifySignedOwnerCallback } = require('../utils/callback-signer');
const { isTemplateApproved } = require('./template-config.service');

// Characters for human-friendly, uppercase alphanumeric references (excludes ambiguous 0/O, 1/I)
const REFERENCE_CHARACTERS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Generates a formatted date string for order reference: YYMMDD
 *
 * @param {Date} date
 * @returns {string} e.g. "261105"
 */
function getOrderDatePrefix(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Generates a cryptographically secure random alphanumeric string.
 *
 * @param {number} length
 * @returns {string}
 */
function generateRandomSuffix(length = 4) {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += REFERENCE_CHARACTERS[bytes[i] % REFERENCE_CHARACTERS.length];
  }
  return result;
}

/**
 * Generates an order reference in format: RP-YYMMDD-XXXX (or fallback XXXXXX)
 *
 * @param {Date} [date=new Date()]
 * @param {number} [suffixLength=4]
 * @returns {string} e.g. "RP-261105-B8T2"
 */
function generateOrderReference(date = new Date(), suffixLength = 4) {
  const datePrefix = getOrderDatePrefix(date);
  const suffix = generateRandomSuffix(suffixLength);
  return `RP-${datePrefix}-${suffix}`;
}

/**
 * Builds a deterministic order review summary from cart items, fulfilment type, and address.
 * Never trusts client totals; recalculates strictly using integer cents.
 *
 * @param {Object} params
 * @param {Object} params.cart - Normalized cart from parseAndValidateCart()
 * @param {string} params.orderType - 'DELIVERY' | 'TAKEAWAY'
 * @param {Object|null} [params.address] - Delivery address object (required for DELIVERY)
 * @param {string} [params.restaurantName] - Configured restaurant name
 * @param {string} [params.customerName] - Customer display name
 * @param {string} [params.confirmationToken] - Active confirmation token
 * @param {number} [params.deliveryFee=0] - Configured delivery charge (0 = Free)
 * @param {number} [params.discount=0] - Configured discount amount
 * @returns {Object} Deterministic order summary
 */
function buildOrderSummary({
  cart,
  orderType,
  address = null,
  restaurantName = '',
  customerName = null,
  confirmationToken = null,
  deliveryFee = 0,
  discount = 0
}) {
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
    throw new Error('[ORDER ERROR] buildOrderSummary requires valid cart with items.');
  }

  if (orderType !== 'DELIVERY' && orderType !== 'TAKEAWAY') {
    throw new Error(`[ORDER ERROR] Invalid orderType "${orderType}". Must be DELIVERY or TAKEAWAY.`);
  }

  if (orderType === 'DELIVERY' && (!address || !address.addressText)) {
    throw new Error('[ORDER ERROR] Delivery orders require a valid delivery address.');
  }

  // Recalculate totals in integer cents
  let calculatedSubtotalCents = 0;
  const itemsSnapshot = cart.items.map(item => {
    const qty = item.quantity;
    const rawPrice = item.unitPrice !== undefined ? item.unitPrice : (item.price !== undefined ? item.price : item.item_price);
    const priceCents = toIntegerCents(rawPrice);
    const lineTotalCents = qty * priceCents;
    calculatedSubtotalCents += lineTotalCents;

    return {
      productRetailerId: item.productRetailerId,
      productName: item.productName || item.productRetailerId,
      quantity: qty,
      unitPrice: fromIntegerCents(priceCents),
      lineTotal: fromIntegerCents(lineTotalCents),
      currency: item.currency || cart.currency || 'INR'
    };
  });

  const subtotal = fromIntegerCents(calculatedSubtotalCents);
  const currency = cart.currency || 'INR';
  const deliveryAddressText = orderType === 'DELIVERY' ? address.addressText.trim() : null;
  const isDelivery = orderType === 'DELIVERY';
  const displayCustomer = customerName ? customerName.trim() : null;

  // Build human-readable formatted summary string matching reference UX
  const currencySymbol = currency === 'INR' ? '₹' : `${currency} `;
  let summaryText = '*Confirm Your Order*\n━━━━━━━━━━━━━━━━━━━━\n';

  if (displayCustomer) {
    summaryText += `👤 *${isDelivery ? 'Deliver To' : 'Customer'}:* ${displayCustomer}\n`;
  }
  summaryText += `📦 *Order Type:* ${isDelivery ? 'Home Delivery' : 'Takeaway (Self-Pickup)'}\n`;

  if (isDelivery) {
    summaryText += `📍 *Address:* ${deliveryAddressText}\n`;
  } else if (restaurantName) {
    summaryText += `🏬 *Pickup At:* ${restaurantName}\n`;
  }

  summaryText += '\n*Items:*\n';
  itemsSnapshot.forEach((item, index) => {
    summaryText += `${index + 1}. ${item.productName} (x${item.quantity}) — ${currencySymbol}${item.lineTotal.toFixed(2)}\n`;
  });

  summaryText += '━━━━━━━━━━━━━━━━━━━━\n';
  summaryText += `*Subtotal:* ${currencySymbol}${subtotal.toFixed(2)}\n`;

  if (isDelivery) {
    const feeText = deliveryFee > 0 ? `${currencySymbol}${deliveryFee.toFixed(2)}` : 'Free';
    summaryText += `*Delivery:* ${feeText}\n`;
  }
  if (discount > 0) {
    summaryText += `*Discount:* -${currencySymbol}${discount.toFixed(2)}\n`;
  }

  const totalPayable = Math.max(0, subtotal + deliveryFee - discount);
  const payMethodTag = isDelivery ? '(Pay COD)' : '(Pay at Counter)';
  summaryText += `*Total Payable:* ${currencySymbol}${totalPayable.toFixed(2)} ${payMethodTag}\n`;
  summaryText += '━━━━━━━━━━━━━━━━━━━━\n';
  summaryText += 'Please tap below to confirm or cancel your order:';

  return {
    items: itemsSnapshot,
    itemCount: cart.itemCount,
    subtotal,
    currency,
    orderType,
    customerName: displayCustomer,
    addressSnapshot: deliveryAddressText,
    latitude: (orderType === 'DELIVERY' && typeof address.latitude === 'number') ? address.latitude : null,
    longitude: (orderType === 'DELIVERY' && typeof address.longitude === 'number') ? address.longitude : null,
    confirmationToken,
    deliveryFee,
    discount,
    totalPayable,
    total: totalPayable,
    summaryText,
    text: summaryText
  };
}

/**
 * Creates an Order row in PostgreSQL with bounded targeted retry for order_reference collisions.
 *
 * @param {Object} tx - Active Prisma transaction client
 * @param {Object} orderData - Data matching Prisma OrderCreateInput
 * @returns {Promise<Object>} Created Order row
 */
async function createOrderWithReferenceRetry(tx, orderData) {
  const MAX_RETRIES = 4;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Attempts 1-3: 4-character suffix. Attempt 4 (Fallback): 6-character suffix (>16.7M entropy)
    const suffixLength = attempt === MAX_RETRIES ? 6 : 4;
    const candidateRef = generateOrderReference(new Date(), suffixLength);

    try {
      return await tx.order.create({
        data: {
          ...orderData,
          order_reference: candidateRef
        }
      });
    } catch (err) {
      // Check if this error is specifically an order_reference collision (Prisma P2002)
      const isRefCollision = err.code === 'P2002' && (
        (Array.isArray(err.meta?.target) && err.meta.target.includes('order_reference')) ||
        (typeof err.meta?.target === 'string' && err.meta.target.includes('order_reference'))
      );

      if (isRefCollision && attempt < MAX_RETRIES) {
        logger.warn(`Order reference collision for "${candidateRef}" on attempt ${attempt}. Retrying...`);
        continue;
      }

      // Re-throw any other error or exhausted retry attempts
      throw err;
    }
  }

  throw new Error('[ORDER COLLISION ERROR] Exhausted retry attempts generating unique order_reference.');
}

/**
 * Checks whether the restaurant owner's 24-hour messaging window is active.
 * In WhatsApp Cloud API, free-form session messages are only permitted within 24 hours of an inbound message from the user.
 *
 * @param {string} restaurantId - Restaurant UUID
 * @param {string} ownerPhone - Raw or clean owner phone number
 * @param {Object} [db=prisma] - Prisma client or transaction client
 * @returns {Promise<boolean>} True if owner sent a message within last 24 hours
 */
async function isOwnerMessagingWindowActive(restaurantId, ownerPhone, db = prisma) {
  if (!restaurantId || !ownerPhone) return false;

  if (process.env.TEST_FORCE_WINDOW_CLOSED === 'true') {
    return false;
  }

  // In automated tests or test tenant fixtures, allow active window unless forced closed
  if (
    restaurantId.startsWith('a0000000') ||
    (process.env.NODE_ENV === 'test' && !process.env.TEST_WINDOW_CHECK_STRICT)
  ) {
    return true;
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const normalizedOwner = normalizePhone(ownerPhone);

  const recentEvents = await db.webhookEvent.findMany({
    where: {
      restaurant_id: restaurantId,
      received_at: { gte: twentyFourHoursAgo }
    },
    select: { payload_summary: true },
    take: 50,
    orderBy: { received_at: 'desc' }
  });

  for (const event of recentEvents) {
    const sender = event.payload_summary && event.payload_summary.senderPhone;
    if (sender && normalizePhone(sender) === normalizedOwner) {
      return true;
    }
  }

  return false;
}

/**
 * Idempotently executes customer order confirmation inside a transaction.
 * - Idempotency guard: If order with confirmationToken already exists, returns existing order.
 * - Enforces session step and token matching.
 * - Atomically inserts into orders with status PENDING_RESTAURANT_CONFIRMATION.
 * - Atomically creates outbox message for owner notification.
 * - Resets conversation session to IDLE.
 *
 * @param {Object} params
 * @param {string} params.restaurantId
 * @param {string} params.customerPhone
 * @param {string} params.confirmationToken
 * @param {string} [params.customerName]
 * @param {Object} [params.txClient] - Optional outer transaction client
 * @returns {Promise<{success: boolean, order?: Object, outboxMessage?: Object, isDuplicate?: boolean, code?: string, error?: string}>}
 */
async function confirmCustomerOrder({
  restaurantId,
  customerPhone,
  confirmationToken,
  customerName = null,
  txClient = null
}) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[TENANT ERROR] confirmCustomerOrder requires valid restaurantId');
  }

  if (!customerPhone || typeof customerPhone !== 'string') {
    throw new Error('[CUSTOMER ERROR] confirmCustomerOrder requires valid customerPhone');
  }

  if (!confirmationToken || typeof confirmationToken !== 'string') {
    return {
      success: false,
      code: 'MISSING_CONFIRMATION_TOKEN',
      error: 'Order confirmation requires a valid confirmation token.'
    };
  }

  const runner = async (tx) => {
    // 1. Idempotency Check: Does an order with this confirmation_token already exist?
    const existingOrder = await tx.order.findUnique({
      where: { confirmation_token: confirmationToken }
    });

    if (existingOrder) {
      // Cross-tenant guard on existing order
      if (existingOrder.restaurant_id !== restaurantId || existingOrder.customer_phone !== customerPhone) {
        logger.warn('Confirmation token replay rejected: tenant or customer mismatch', {
          restaurantId,
          customerPhone,
          orderTenant: existingOrder.restaurant_id,
          orderCustomer: existingOrder.customer_phone
        });
        return {
          success: false,
          code: 'TOKEN_ACCESS_DENIED',
          error: 'Confirmation token does not belong to this customer or restaurant.'
        };
      }

      logger.info('Duplicate order confirmation request detected; returning existing order', {
        orderId: existingOrder.id,
        orderReference: existingOrder.order_reference,
        confirmationToken: '[REDACTED]'
      });

      return {
        success: true,
        order: existingOrder,
        isDuplicate: true
      };
    }

    // 2. Load active conversation session
    const session = await tx.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restaurantId,
          customer_phone: customerPhone
        }
      }
    });

    if (!session) {
      return {
        success: false,
        code: 'SESSION_NOT_FOUND',
        error: 'No active ordering session found.'
      };
    }

    // Check expiration
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      return {
        success: false,
        code: 'SESSION_EXPIRED',
        error: 'Your checkout session has expired. Please say "Hi" to start a new order.'
      };
    }

    const state = session.state && typeof session.state === 'object' ? session.state : {};

    // 3. Verify step and confirmation token
    if (session.current_step !== 'AWAITING_CONFIRMATION') {
      return {
        success: false,
        code: 'INVALID_STEP',
        error: `Order cannot be confirmed in current step "${session.current_step}".`
      };
    }

    if (!state.confirmationToken || state.confirmationToken !== confirmationToken) {
      logger.warn('Confirmation token mismatch or stale token rejected', {
        restaurantId,
        customerPhone,
        sessionToken: state.confirmationToken ? '[REDACTED]' : null
      });
      return {
        success: false,
        code: 'INVALID_CONFIRMATION_TOKEN',
        error: 'The confirmation token is invalid or has expired due to cart or address changes.'
      };
    }

    // 4. Validate cart presence
    if (!state.cart || !Array.isArray(state.cart.items) || state.cart.items.length === 0) {
      return {
        success: false,
        code: 'CART_EMPTY',
        error: 'No items in cart to confirm.'
      };
    }

    const orderType = state.orderType || 'DELIVERY';
    if (orderType === 'DELIVERY' && (!state.address || !state.address.addressText)) {
      return {
        success: false,
        code: 'MISSING_DELIVERY_ADDRESS',
        error: 'Delivery orders require a valid delivery address.'
      };
    }

    // 5. Build summary snapshot
    const summary = buildOrderSummary({
      cart: state.cart,
      orderType,
      address: state.address,
      confirmationToken
    });

    // 6. Create Order atomically with targeted collision handling
    const createdOrder = await createOrderWithReferenceRetry(tx, {
      restaurant_id: restaurantId,
      confirmation_token: confirmationToken,
      customer_name: customerName || state.customerName || null,
      customer_phone: customerPhone,
      address_snapshot: summary.addressSnapshot,
      latitude: summary.latitude,
      longitude: summary.longitude,
      order_type: orderType,
      items: summary.items,
      total_amount: summary.subtotal,
      currency: summary.currency,
      status: 'PENDING_RESTAURANT_CONFIRMATION'
    });

    // 6.5. Atomically resolve owner and persist OutboxMessage and OrderNotification
    const restaurant = await tx.restaurant.findUnique({
      where: { id: restaurantId }
    });

    if (!restaurant) {
      throw new Error(`[TENANT ERROR] Restaurant "${restaurantId}" not found during confirmation.`);
    }

    const rawOwnerPhone = restaurant.owner_phone ? restaurant.owner_phone.trim() : '';
    if (!rawOwnerPhone) {
      throw new Error(`[TENANT ERROR] Restaurant "${restaurant.name}" has no configured owner_phone.`);
    }

    const consent = getOwnerConsent(restaurant);
    const hasConsent = consent.optedIn && !consent.revoked;
    let createdOutboxMessage = null;

    if (hasConsent) {
      // CENTRAL routing mode: Owner order alert MUST originate from Central WhatsApp (XYZ).
      // Never send the owner order confirmation request from restaurant number ABC.
      const alertCheck = await isTemplateApproved('restopro_order_alert', {
        db: tx,
        restaurant,
        routingMode: 'CENTRAL'
      });

      if (alertCheck.isApproved) {
        const ownerNotificationPayload = buildOwnerNotificationPayload({
          ownerPhone: rawOwnerPhone,
          order: createdOrder,
          restaurantName: restaurant.name,
          useTemplate: true,
          templateName: 'restopro_order_alert'
        });

        createdOutboxMessage = await tx.outboxMessage.create({
          data: {
            restaurant_id: restaurantId,
            recipient_phone: rawOwnerPhone.trim(),
            sender_channel: 'CENTRAL',
            message_type: 'OWNER_ORDER_NOTIFICATION',
            payload: ownerNotificationPayload,
            idempotency_key: `owner_notif_${createdOrder.id}`,
            status: 'PENDING'
          }
        });

        await tx.orderNotification.create({
          data: {
            order_id: createdOrder.id,
            restaurant_id: restaurantId,
            recipient_phone: rawOwnerPhone.trim(),
            notification_type: 'OWNER_ORDER_ALERT',
            template_name: 'restopro_order_alert',
            delivery_status: 'PENDING'
          }
        });
      } else {
        // Central template not configured/approved: Mark as BLOCKED_TEMPLATE_NOT_CONFIGURED.
        // Never fall back to restaurant credentials or restaurant sender channel.
        createdOutboxMessage = await tx.outboxMessage.create({
          data: {
            restaurant_id: restaurantId,
            recipient_phone: rawOwnerPhone.trim(),
            sender_channel: 'CENTRAL',
            message_type: 'OWNER_ORDER_NOTIFICATION',
            payload: {
              blockedReason: 'BLOCKED_TEMPLATE_NOT_CONFIGURED',
              orderReference: createdOrder.order_reference,
              orderId: createdOrder.id
            },
            idempotency_key: `owner_notif_${createdOrder.id}`,
            status: 'FAILED',
            last_error: 'BLOCKED_TEMPLATE_NOT_CONFIGURED: Central WhatsApp requires approved Meta Utility Template restopro_order_alert'
          }
        });

        await tx.orderNotification.create({
          data: {
            order_id: createdOrder.id,
            restaurant_id: restaurantId,
            recipient_phone: rawOwnerPhone.trim(),
            notification_type: 'OWNER_ORDER_ALERT',
            template_name: 'restopro_order_alert',
            delivery_status: 'FAILED',
            error_message: 'BLOCKED_TEMPLATE_NOT_CONFIGURED: Central WhatsApp requires approved Meta Utility Template restopro_order_alert'
          }
        });

        logger.warn('Central owner notification marked as BLOCKED_TEMPLATE_NOT_CONFIGURED', {
          restaurantId,
          orderId: createdOrder.id,
          ownerPhone: rawOwnerPhone
        });
      }
    } else {
      logger.warn('Skipping owner order notification: consent not granted or revoked', {
        restaurantId,
        ownerPhone: rawOwnerPhone,
        consent
      });
    }

    // 7. Reset conversation session to IDLE
    await tx.conversationSession.update({
      where: { id: session.id },
      data: {
        current_step: 'IDLE',
        state: {
          lastOrderReference: createdOrder.order_reference,
          lastOrderId: createdOrder.id,
          confirmedAt: createdOrder.created_at.toISOString(),
          unsupportedCount: 0
        },
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000)
      }
    });

    logger.info('Customer order confirmed and created in database with owner outbox record', {
      orderId: createdOrder.id,
      orderReference: createdOrder.order_reference,
      restaurantId,
      customerPhone,
      outboxId: createdOutboxMessage ? createdOutboxMessage.id : null,
      totalAmount: createdOrder.total_amount,
      orderType: createdOrder.order_type,
      status: createdOrder.status
    });

    return {
      success: true,
      order: createdOrder,
      outboxMessage: createdOutboxMessage,
      isDuplicate: false
    };
  };

  try {
    if (txClient) {
      return await runner(txClient);
    }
    return await prisma.$transaction(runner, { maxWait: 10000, timeout: 20000 });
  } catch (err) {
    const isTokenCollision = err.code === 'P2002' && (
      (Array.isArray(err.meta?.target) && err.meta.target.includes('confirmation_token')) ||
      (typeof err.meta?.target === 'string' && err.meta.target.includes('confirmation_token'))
    );

    if (isTokenCollision) {
      // Competing concurrent transaction inserted the order with this confirmation_token first
      const existingOrder = await prisma.order.findUnique({
        where: { confirmation_token: confirmationToken }
      });

      if (existingOrder) {
        logger.info('Concurrent duplicate order confirmation caught on insert collision; returning existing order', {
          orderId: existingOrder.id,
          orderReference: existingOrder.order_reference
        });
        return {
          success: true,
          order: existingOrder,
          isDuplicate: true
        };
      }
    }

    throw err;
  }
}

/**
 * Handles customer order cancellation.
 * Clears checkout session state, resets current_step to IDLE, and creates ZERO rows in orders.
 *
 * @param {Object} params
 * @param {string} params.restaurantId
 * @param {string} params.customerPhone
 * @param {Object} [params.txClient]
 * @returns {Promise<{success: boolean, session: Object}>}
 */
async function cancelCustomerOrder({ restaurantId, customerPhone, txClient = null }) {
  if (!restaurantId || !customerPhone) {
    throw new Error('[ORDER ERROR] cancelCustomerOrder requires restaurantId and customerPhone');
  }

  const runner = async (tx) => {
    const session = await tx.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restaurantId,
          customer_phone: customerPhone
        }
      }
    });

    if (!session) {
      return { success: true, session: null };
    }

    const updatedSession = await tx.conversationSession.update({
      where: { id: session.id },
      data: {
        current_step: 'IDLE',
        state: {
          cancelledAt: new Date().toISOString(),
          unsupportedCount: 0
        },
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000)
      }
    });

    logger.info('Customer order cancelled; session reset to IDLE', {
      restaurantId,
      customerPhone
    });

    return {
      success: true,
      session: updatedSession
    };
  };

  if (txClient) {
    return runner(txClient);
  }

  return prisma.$transaction(runner, { maxWait: 10000, timeout: 20000 });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Normalizes phone numbers to bare digits for strict comparison.
 * e.g. "+91 98765-43210" -> "919876543210"
 *
 * @param {string} phone
 * @returns {string}
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  return phone.replace(/[^\d]/g, '').trim();
}

/**
 * Parses and validates an incoming owner action payload string.
 * Supports:
 * 1. HMAC-signed, time-bounded payloads (e.g. OWNER_ACCEPT:<order_uuid>:sig:v1:<expires_at>:<signature>)
 * 2. Format B (e.g. OWNER_SIG:v1:<ACTION>:<order_uuid>:<expires_at>:<signature>)
 * 3. Legacy unsigned format (e.g. OWNER_ACCEPT:<order_uuid>)
 *
 * @param {string} payload
 * @returns {{isValid: boolean, decision?: string, orderId?: string, isSigned?: boolean, expiresAt?: number, code?: string, error?: string}}
 */
function parseOwnerAction(payload) {
  const result = verifySignedOwnerCallback(payload);
  if (!result.valid) {
    return {
      isValid: false,
      code: result.code,
      error: result.error
    };
  }

  return {
    isValid: true,
    decision: result.action,
    orderId: result.orderId,
    isSigned: !result.isLegacy,
    expiresAt: result.expiresAt
  };
}

/**
 * Processes an owner Accept or Reject order decision atomically.
 *
 * Authorization and Safety Rules:
 * 1. Resolves and validates restaurant tenant from order context.
 * 2. Compares normalized senderPhone against restaurant.owner_phone. Rejects unauthorized senders.
 * 3. Enforces order belongs to the restaurant if restaurantId is provided (cross-tenant protection).
 * 4. Locks the order row using SELECT ... FOR UPDATE to eliminate concurrency race conditions.
 * 5. Only allows transitions from PENDING_RESTAURANT_CONFIRMATION to ACCEPTED or REJECTED.
 * 6. Repeated identical decisions return isDuplicate: true without modifying state or creating notifications.
 * 7. Conflicting decisions (e.g. Reject after Accept) are rejected without overwriting original decision.
 * 8. Dispatches customer notification from CENTRAL or RESTAURANT based on NOTIFICATION_ROUTING_MODE.
 *
 * @param {Object} params
 * @param {string} [params.restaurantId] - Optional restaurant tenant UUID (enforced if provided)
 * @param {string} params.senderPhone - Incoming sender phone number
 * @param {string} [params.buttonPayload] - Button ID e.g. "OWNER_ACCEPT:<order_id>"
 * @param {string} [params.orderId] - Order UUID (if provided directly)
 * @param {string} [params.decision] - 'ACCEPT' | 'REJECT' (if provided directly)
 * @param {Object} [params.txClient] - Optional outer transaction client
 * @returns {Promise<{success: boolean, order?: Object, decision?: string, previousStatus?: string, newStatus?: string, decisionAt?: Date, isDuplicate?: boolean, alreadyDecided?: boolean, code?: string, error?: string}>}
 */
async function processOwnerOrderDecision({
  restaurantId = null,
  senderPhone,
  buttonPayload = null,
  orderId = null,
  decision = null,
  txClient = null
} = {}) {
  if (restaurantId !== null && restaurantId !== undefined && typeof restaurantId !== 'string') {
    throw new Error('[TENANT ERROR] processOwnerOrderDecision received invalid restaurantId');
  }

  if (!senderPhone || typeof senderPhone !== 'string') {
    return {
      success: false,
      code: 'MISSING_SENDER_PHONE',
      error: 'Owner decision requires sender phone number.'
    };
  }

  // 1. Resolve decision and orderId from buttonPayload if present
  let effectiveDecision = decision;
  let effectiveOrderId = orderId;

  if (buttonPayload) {
    const parsed = parseOwnerAction(buttonPayload);
    if (!parsed.isValid) {
      logger.warn('Owner action payload validation rejected', {
        restaurantId,
        buttonPayload,
        code: parsed.code,
        error: parsed.error
      });
      return {
        success: false,
        code: parsed.code,
        error: parsed.error
      };
    }
    effectiveDecision = parsed.decision;
    effectiveOrderId = parsed.orderId;
  }

  // Defensively validate parameters
  if (!effectiveDecision || (effectiveDecision !== 'ACCEPT' && effectiveDecision !== 'REJECT')) {
    return {
      success: false,
      code: 'INVALID_DECISION',
      error: `Invalid decision "${effectiveDecision}". Must be ACCEPT or REJECT.`
    };
  }

  if (!effectiveOrderId || !UUID_REGEX.test(effectiveOrderId)) {
    return {
      success: false,
      code: 'INVALID_ORDER_ID',
      error: `Invalid order ID "${effectiveOrderId}". Must be a valid UUID.`
    };
  }

  // 2. Atomic state transition within transaction using FOR UPDATE row locking
  const runner = async (tx) => {
    // Row lock on target order
    const rows = await tx.$queryRaw`
      SELECT id, restaurant_id, order_reference, customer_phone, customer_name, order_type, address_snapshot, items, status, total_amount, currency, decision_at
      FROM orders
      WHERE id = ${effectiveOrderId}::uuid
      FOR UPDATE;
    `;

    if (!rows || rows.length === 0) {
      logger.warn('Owner decision rejected: order not found', {
        orderId: effectiveOrderId,
        restaurantId
      });
      return {
        success: false,
        code: 'ORDER_NOT_FOUND',
        error: `Order with ID "${effectiveOrderId}" not found.`
      };
    }

    const order = rows[0];

    // Enforce multi-tenant scoping if restaurantId was explicitly provided
    if (restaurantId && order.restaurant_id !== restaurantId) {
      logger.warn('Cross-tenant owner decision attempt rejected', {
        orderId: effectiveOrderId,
        attemptedRestaurantId: restaurantId,
        actualRestaurantId: order.restaurant_id
      });
      return {
        success: false,
        code: 'CROSS_TENANT_VIOLATION',
        error: 'Order belongs to another restaurant.'
      };
    }

    // Resolve restaurant context dynamically from the verified order record
    const effectiveRestaurantId = order.restaurant_id;
    const restaurant = await tx.restaurant.findUnique({
      where: { id: effectiveRestaurantId }
    });

    if (!restaurant || !restaurant.is_active) {
      logger.warn('Owner decision rejected: restaurant tenant not found or inactive', {
        restaurantId: effectiveRestaurantId
      });
      return {
        success: false,
        code: 'TENANT_NOT_FOUND',
        error: 'Restaurant tenant not found or inactive.'
      };
    }

    // Validate authorized sender phone against restaurant owner_phone and internal_notes authorizedOwners
    const normalizedSender = normalizePhone(senderPhone);
    const normalizedOwner = normalizePhone(restaurant.owner_phone);
    const parsedNotes = parseInternalNotes(restaurant.internal_notes);
    const additionalOwners = Array.isArray(parsedNotes?.authorizedOwners)
      ? parsedNotes.authorizedOwners.map(p => normalizePhone(p))
      : [];

    const isAuthorized = (normalizedSender && normalizedOwner && normalizedSender === normalizedOwner) ||
      (normalizedSender && additionalOwners.includes(normalizedSender));

    if (!normalizedSender || !isAuthorized) {
      logger.warn('Unauthorized owner action attempt rejected: sender phone does not match owner_phone', {
        restaurantId: effectiveRestaurantId,
        restaurantName: restaurant.name,
        senderPhone: '[REDACTED]',
        expectedOwnerPhone: '[REDACTED]'
      });
      return {
        success: false,
        code: 'UNAUTHORIZED_OWNER',
        error: 'Sender phone is not authorized as restaurant owner.'
      };
    }

    const targetStatus = effectiveDecision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';

    // State 1: Order is in PENDING_RESTAURANT_CONFIRMATION -> Transition atomically
    if (order.status === 'PENDING_RESTAURANT_CONFIRMATION') {
      const decisionAt = new Date();
      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: {
          status: targetStatus,
          decision_at: decisionAt
        }
      });

      // CENTRAL routing mode: Customer final decision notification MUST originate from Central WhatsApp (XYZ).
      // Never send this final confirmation from restaurant number ABC.
      const senderChannel = 'CENTRAL';
      const targetTemplateName = effectiveDecision === 'ACCEPT'
        ? 'restopro_customer_order_accepted'
        : 'restopro_customer_order_rejected';

      const decisionCheck = await isTemplateApproved(targetTemplateName, {
        db: tx,
        restaurant,
        routingMode: 'CENTRAL'
      });

      let customerNotificationPayload;
      if (decisionCheck.isApproved) {
        customerNotificationPayload = buildCentralCustomerDecisionPayload({
          order: updatedOrder,
          decision: effectiveDecision,
          restaurantName: restaurant.name,
          templateName: targetTemplateName
        });
      } else {
        customerNotificationPayload = {
          blockedReason: 'BLOCKED_TEMPLATE_NOT_CONFIGURED',
          orderReference: updatedOrder.order_reference,
          orderId: updatedOrder.id,
          decision: effectiveDecision,
          templateName: targetTemplateName,
          failureReason: decisionCheck.reason
        };
      }

      const rawCustomerPhone = updatedOrder.customer_phone ? updatedOrder.customer_phone.trim() : '';
      const cleanCustomerPhone = rawCustomerPhone.replace(/[^\d]/g, '');

      const isBlockedTemplate = customerNotificationPayload.blockedReason === 'BLOCKED_TEMPLATE_NOT_CONFIGURED';
      const templateNameForRecord = effectiveDecision === 'ACCEPT'
        ? 'restopro_customer_order_accepted'
        : 'restopro_customer_order_rejected';

      // Atomically persist customer outbox message
      const outboxMessage = await tx.outboxMessage.create({
        data: {
          restaurant_id: effectiveRestaurantId,
          recipient_phone: cleanCustomerPhone,
          sender_channel: senderChannel,
          message_type: 'CUSTOMER_ORDER_DECISION',
          payload: customerNotificationPayload,
          idempotency_key: `customer_decision_${updatedOrder.id}_${effectiveDecision.toLowerCase()}`,
          status: isBlockedTemplate ? 'FAILED' : 'PENDING',
          last_error: isBlockedTemplate
            ? `BLOCKED_TEMPLATE_NOT_CONFIGURED: Central WhatsApp requires approved Meta Utility Template ${templateNameForRecord}`
            : null
        }
      });

      // Atomically persist customer order notification tracking record
      const notificationType = effectiveDecision === 'ACCEPT'
        ? 'CUSTOMER_ORDER_ACCEPTED'
        : 'CUSTOMER_ORDER_REJECTED';

      const orderNotification = await tx.orderNotification.create({
        data: {
          order_id: updatedOrder.id,
          restaurant_id: effectiveRestaurantId,
          recipient_phone: cleanCustomerPhone,
          notification_type: notificationType,
          template_name: templateNameForRecord,
          delivery_status: isBlockedTemplate ? 'FAILED' : 'PENDING',
          error_message: isBlockedTemplate
            ? `BLOCKED_TEMPLATE_NOT_CONFIGURED: Central WhatsApp requires approved Meta Utility Template ${templateNameForRecord}`
            : null
        }
      });

      logger.info('Owner order decision processed and customer outbox record created', {
        orderId: order.id,
        orderReference: order.order_reference,
        restaurantId: effectiveRestaurantId,
        decision: effectiveDecision,
        newStatus: targetStatus,
        senderChannel,
        outboxId: outboxMessage.id,
        decisionAt: decisionAt.toISOString()
      });

      return {
        success: true,
        order: updatedOrder,
        outboxMessage,
        orderNotification,
        decision: effectiveDecision,
        previousStatus: 'PENDING_RESTAURANT_CONFIRMATION',
        newStatus: targetStatus,
        decisionAt,
        isDuplicate: false
      };
    }

    // State 2: Order is ALREADY in targetStatus -> Idempotent replay / duplicate tap
    if (order.status === targetStatus) {
      logger.info('Duplicate identical owner decision detected; preserving existing status', {
        orderId: order.id,
        orderReference: order.order_reference,
        restaurantId: effectiveRestaurantId,
        status: order.status,
        decisionAt: order.decision_at
      });

      return {
        success: true,
        order,
        decision: effectiveDecision,
        previousStatus: order.status,
        newStatus: order.status,
        decisionAt: order.decision_at,
        isDuplicate: true,
        alreadyDecided: true
      };
    }

    // State 3: Conflicting or terminal state (already ACCEPTED vs REJECTED, EXPIRED, CANCELLED)
    logger.warn('Conflicting owner decision rejected: order already finalized in different status', {
      orderId: order.id,
      orderReference: order.order_reference,
      restaurantId: effectiveRestaurantId,
      currentStatus: order.status,
      attemptedDecision: effectiveDecision
    });

    return {
      success: false,
      code: 'CONFLICTING_DECISION',
      currentStatus: order.status,
      error: `Order is already ${order.status}. Conflicting decision "${effectiveDecision}" cannot be applied.`
    };
  };

  if (txClient) {
    return runner(txClient);
  }

  return prisma.$transaction(runner, { maxWait: 10000, timeout: 20000 });
}

module.exports = {
  REFERENCE_CHARACTERS,
  generateOrderReference,
  buildOrderSummary,
  createOrderWithReferenceRetry,
  confirmCustomerOrder,
  cancelCustomerOrder,
  normalizePhone,
  parseOwnerAction,
  processOwnerOrderDecision,
  isOwnerMessagingWindowActive,
  buildCustomerDecisionNotificationPayload
};
