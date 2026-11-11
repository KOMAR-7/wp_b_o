/**
 * RESTOPRO — Customer Conversation State Engine
 * Stage 4.4: Fulfilment Selection, Order Review & Customer Confirmation
 *
 * Implements deterministic finite state machine (FSM) for WhatsApp customer ordering:
 * - Scoped saved address lookup and reuse (ST4-07)
 * - Text address validation with minimum length defense (ST4-08)
 * - WhatsApp location pin parsing with 0.0 preservation & building/room collection (ST4-09)
 * - Explicit customer consent flow & duplicate prevention (ST4-10)
 * - Fulfilment type selection (Delivery vs. Takeaway) (ST4-11)
 * - Itemized order summary review with integer-cents arithmetic (ST4-12)
 * - Atomic customer confirmation with idempotency guard on confirmation_token (ST4-13)
 * - Order cancellation and Change Address token invalidation (ST4-14)
 * - Zero AI/NLP; strictly validates inputs against current step whitelist.
 * - Enforces 2-hour inactivity TTL, max 2 unsupported reminders (Decision D-06),
 *   and cart replacement / confirmation token regeneration (Decision D-01).
 */
const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { parseAndValidateCart, parseAndValidateCartAsync } = require('../parsers/cart-parser');
const { decryptToken } = require('../utils/crypto');
const { safeParseCoordinate } = require('../parsers/webhook-parser');
const {
  validateTextAddress,
  validateCoordinates,
  validateBuildingName,
  validateRoomNumber,
  combineAddressComponents,
  normalizeAddress,
  findCustomerSavedAddresses,
  findSavedAddressById,
  saveConsentedAddress
} = require('./address.service');
const {
  buildOrderSummary,
  confirmCustomerOrder,
  cancelCustomerOrder
} = require('./order.service');

// 2 hours inactivity TTL in milliseconds
const INACTIVITY_TTL_MS = 2 * 60 * 60 * 1000;

// Maximum consecutive unsupported message reminders before going quiet (Decision D-06)
const MAX_CONSECUTIVE_REMINDERS = 2;

// Recognized greeting keywords for initial conversational entry
const GREETING_KEYWORDS = new Set([
  'hi', 'hello', 'hey', 'start', 'menu', 'order', 'namaste', 'hola', 'restart'
]);

/**
 * Generates a stable, high-entropy confirmation action token.
 * Every cart submission or cart modification generates a fresh token,
 * automatically invalidating any prior tokens.
 *
 * @returns {string} e.g. "conf_8c30a442-dfae-4bd5-8f43-89ea3b9e4a3b"
 */
function generateConfirmationToken() {
  return `conf_${crypto.randomUUID()}`;
}

/**
 * Calculates session expiration date based on current time + 2-hour TTL.
 *
 * @returns {Date}
 */
function calculateSessionExpiry() {
  return new Date(Date.now() + INACTIVITY_TTL_MS);
}

/**
 * Ingests, validates, and persists a catalogue order cart into the customer's
 * conversation session within an atomic database transaction.
 *
 * @param {string} restaurantId - Verified restaurant tenant UUID
 * @param {string} customerPhone - Customer WhatsApp sender phone number
 * @param {Object} rawOrderPayload - Incoming order payload from WhatsApp message
 * @param {string|null} [senderName=null] - Customer profile name from Meta webhook
 * @returns {Promise<{success: boolean, session?: Object, cart?: Object, confirmationToken?: string, code?: string, error?: string, action?: Object}>}
 */
async function processIncomingCart(restaurantId, customerPhone, rawOrderPayload, senderName = null) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[TENANT ERROR] processIncomingCart requires valid restaurantId');
  }

  if (!customerPhone || typeof customerPhone !== 'string') {
    throw new Error('[SESSION ERROR] processIncomingCart requires valid customerPhone');
  }

  // 1. Defensively validate and normalize the incoming cart payload with catalogue resolution
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, internal_notes: true, name: true, access_token_encrypted: true }
  });

  let accessToken = null;
  if (restaurant?.access_token_encrypted) {
    try {
      accessToken = decryptToken(restaurant.access_token_encrypted);
    } catch (_) {}
  }

  const validation = await parseAndValidateCartAsync(rawOrderPayload, {
    restaurantId,
    internalNotes: restaurant?.internal_notes,
    accessToken
  });
  if (!validation.isValid) {
    logger.warn('Cart validation rejected incoming catalogue payload', {
      restaurantId,
      customerPhone,
      code: validation.code,
      error: validation.error
    });
    return {
      success: false,
      code: validation.code,
      error: validation.error
    };
  }

  const normalizedCart = validation.cart;
  const freshConfirmationToken = generateConfirmationToken();
  const expiresAt = calculateSessionExpiry();

  // 2. Determine next step based on saved addresses
  const savedAddresses = await findCustomerSavedAddresses(restaurantId, customerPhone);
  const hasSaved = savedAddresses && savedAddresses.length > 0;
  const nextStep = hasSaved
    ? 'AWAITING_ADDRESS_CHOICE'
    : 'AWAITING_ADDRESS_INPUT';

  // 3. Atomically update or create conversation session
  const session = await prisma.$transaction(async (tx) => {
    const existingSession = await tx.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restaurantId,
          customer_phone: customerPhone
        }
      }
    });

    const isExpired = existingSession && existingSession.expires_at && new Date(existingSession.expires_at) < new Date();
    const previousState = (!isExpired && existingSession?.state && typeof existingSession.state === 'object')
      ? existingSession.state
      : {};

    const resolvedCustomerName = senderName || previousState.customerName || null;

    // Invalidate previous confirmation token and replace cart entirely
    const updatedState = {
      ...previousState,
      cart: normalizedCart,
      confirmationToken: freshConfirmationToken,
      customerName: resolvedCustomerName,
      address: null,
      addressSaved: false,
      unsupportedCount: 0,
      cartUpdatedAt: new Date().toISOString()
    };

    return tx.conversationSession.upsert({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restaurantId,
          customer_phone: customerPhone
        }
      },
      update: {
        current_step: nextStep,
        state: updatedState,
        expires_at: expiresAt
      },
      create: {
        restaurant_id: restaurantId,
        customer_phone: customerPhone,
        current_step: nextStep,
        state: updatedState,
        expires_at: expiresAt
      }
    });
  });

  logger.info('Customer cart updated in conversation session', {
    restaurantId,
    customerPhone,
    nextStep,
    itemCount: normalizedCart.itemCount,
    subtotal: normalizedCart.subtotal,
    confirmationToken: freshConfirmationToken
  });

  const displayCustomerName = senderName || session.state?.customerName || null;

  return {
    success: true,
    session,
    cart: normalizedCart,
    confirmationToken: freshConfirmationToken,
    nextStep,
    action: {
      type: hasSaved ? 'PROMPT_ADDRESS_CHOICE' : 'PROMPT_ADDRESS_COLLECTION',
      nextStep,
      customerName: displayCustomerName,
      itemCount: normalizedCart.itemCount,
      subtotal: normalizedCart.subtotal,
      savedAddresses: hasSaved ? savedAddresses.map(a => ({ id: a.id, address: a.address, label: a.label })) : []
    }
  };
}

/**
 * Extracts action identifiers from interactive button or list replies.
 *
 * @param {Object} event - Normalized webhook event
 * @returns {{buttonId: string|null, listId: string|null}}
 */
function extractInteractiveIds(event) {
  let buttonId = null;
  let listId = null;

  if (event.messageType === 'button' && event.buttonReply?.payload) {
    buttonId = event.buttonReply.payload.trim();
  } else if (event.messageType === 'interactive' && event.interactiveReply) {
    if (event.interactiveReply.subType === 'button_reply' && event.interactiveReply.id) {
      buttonId = event.interactiveReply.id.trim();
    } else if (event.interactiveReply.subType === 'list_reply' && event.interactiveReply.id) {
      listId = event.interactiveReply.id.trim();
    }
  }

  return { buttonId, listId };
}

/**
 * Validates whether a button or list ID is valid for the current conversation step.
 * Never trusts customer-supplied IDs without verifying step context.
 *
 * @param {string} currentStep
 * @param {string|null} buttonId
 * @param {string|null} listId
 * @param {Object} state
 * @returns {boolean}
 */
function validateActionForStep(currentStep, buttonId, listId, state) {
  // BTN_CANCEL_ORDER is universally allowed across all active ordering steps
  if (buttonId === 'BTN_CANCEL_ORDER' || listId === 'BTN_CANCEL_ORDER') {
    const cancellableSteps = new Set([
      'AWAITING_ADDRESS_CHOICE',
      'AWAITING_ADDRESS_INPUT',
      'AWAITING_LOCATION',
      'AWAITING_LOCATION_DETAILS',
      'AWAITING_MANUAL_ROOM',
      'AWAITING_MANUAL_BUILDING',
      'AWAITING_MANUAL_STREET',
      'AWAITING_MANUAL_AREA',
      'AWAITING_SAVE_CONSENT',
      'AWAITING_ORDER_TYPE',
      'AWAITING_CONFIRMATION',
      'AWAITING_BUILDING_NAME',
      'AWAITING_ROOM_NUMBER'
    ]);
    return cancellableSteps.has(currentStep);
  }

  if (buttonId) {
    switch (currentStep) {
      case 'AWAITING_ADDRESS_CHOICE':
      case 'AWAITING_ADDRESS_INPUT':
        return (
          buttonId === 'BTN_SHARE_LOCATION' ||
          buttonId === 'BTN_ENTER_MANUAL_ADDRESS' ||
          buttonId === 'BTN_ENTER_NEW_ADDRESS' ||
          buttonId === 'BTN_USE_SAVED_ADDRESS' ||
          buttonId.startsWith('BTN_USE_SAVED_ADDRESS:')
        );

      case 'AWAITING_LOCATION':
        return buttonId === 'BTN_ENTER_MANUAL_ADDRESS';

      case 'AWAITING_LOCATION_DETAILS':
      case 'AWAITING_MANUAL_ROOM':
      case 'AWAITING_MANUAL_BUILDING':
      case 'AWAITING_MANUAL_STREET':
      case 'AWAITING_MANUAL_AREA':
        return buttonId === 'BTN_CANCEL_ORDER';

      case 'AWAITING_SAVE_CONSENT':
        return (
          buttonId === 'BTN_CONSENT_YES' ||
          buttonId === 'BTN_CONSENT_NO' ||
          buttonId === 'BTN_SAVE_ADDRESS' ||
          buttonId === 'BTN_USE_ONCE' ||
          buttonId === 'BTN_SAVE_YES' ||
          buttonId === 'BTN_SAVE_NO' ||
          buttonId === 'BTN_YES' ||
          buttonId === 'BTN_NO'
        );

      case 'AWAITING_ORDER_TYPE':
        return buttonId === 'BTN_ORDER_DELIVERY' || buttonId === 'BTN_ORDER_TAKEAWAY';

      case 'AWAITING_CONFIRMATION':
        if (buttonId === 'BTN_CHANGE_ADDRESS') {
          return true;
        }
        if (buttonId.startsWith('BTN_CONFIRM_ORDER:')) {
          const token = buttonId.slice('BTN_CONFIRM_ORDER:'.length).trim();
          return Boolean(token && state?.confirmationToken && token === state.confirmationToken);
        }
        return false;

      default:
        return false;
    }
  }

  if (listId) {
    switch (currentStep) {
      case 'AWAITING_ADDRESS_CHOICE':
      case 'AWAITING_ADDRESS_INPUT':
        return (
          listId.startsWith('ADDR_SAVED_') ||
          listId === 'BTN_SHARE_LOCATION' ||
          listId === 'BTN_ENTER_MANUAL_ADDRESS' ||
          listId === 'BTN_ENTER_NEW_ADDRESS'
        );
      default:
        return false;
    }
  }

  return false;
}

/**
 * Master Conversation Message Handler
 * Evaluates incoming message against active session step and transitions state deterministically.
 *
 * @param {string} restaurantId - Verified tenant UUID
 * @param {string} customerPhone - Customer phone string
 * @param {Object} event - Normalized webhook event
 * @returns {Promise<{success: boolean, session?: Object, action?: Object, code?: string, error?: string, order?: Object, isDuplicate?: boolean}>}
 */
async function handleIncomingMessage(restaurantId, customerPhone, event) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[TENANT ERROR] handleIncomingMessage requires valid restaurantId');
  }

  if (!customerPhone || typeof customerPhone !== 'string') {
    throw new Error('[SESSION ERROR] handleIncomingMessage requires valid customerPhone');
  }

  // 1. If message is a catalogue order cart submission, route directly to processIncomingCart
  if (event.messageType === 'order') {
    return processIncomingCart(restaurantId, customerPhone, event.rawOrder || event.order, event.senderName);
  }

  const { buttonId, listId } = extractInteractiveIds(event);
  const textBody = typeof event.text === 'string' ? event.text.trim() : '';

  // 1.5. Idempotent Confirmation Replay Guard (Meta retry or customer repeated tap after order created)
  if (buttonId && buttonId.startsWith('BTN_CONFIRM_ORDER:')) {
    const replayToken = buttonId.slice('BTN_CONFIRM_ORDER:'.length).trim();
    const existingOrder = await prisma.order.findUnique({
      where: { confirmation_token: replayToken }
    });

    if (existingOrder && existingOrder.restaurant_id === restaurantId && existingOrder.customer_phone === customerPhone) {
      logger.info('Duplicate order confirmation request intercepted at entry; returning existing order', {
        orderId: existingOrder.id,
        orderReference: existingOrder.order_reference
      });
      return {
        success: true,
        order: existingOrder,
        isDuplicate: true,
        action: {
          type: 'ORDER_CONFIRMED',
          isDuplicate: true,
          orderReference: existingOrder.order_reference,
          status: existingOrder.status,
          totalAmount: existingOrder.total_amount,
          currency: existingOrder.currency,
          orderType: existingOrder.order_type,
          message: `Your order *${existingOrder.order_reference}* has already been confirmed and received by the restaurant!`
        }
      };
    }
  }

  // 2. Transactionally load or initialize session
  return prisma.$transaction(async (tx) => {
    let session = await tx.conversationSession.findUnique({
      where: {
        restaurant_id_customer_phone: {
          restaurant_id: restaurantId,
          customer_phone: customerPhone
        }
      }
    });

    const isExpired = session && session.expires_at && new Date(session.expires_at) < new Date();
    const currentState = (!isExpired && session?.state && typeof session.state === 'object')
      ? session.state
      : {};
    let currentStep = (!isExpired && session?.current_step)
      ? session.current_step
      : 'IDLE';

    const expiresAt = calculateSessionExpiry();

    // -------------------------------------------------------------
    // STATE: IDLE (No active order or expired session)
    // -------------------------------------------------------------
    if (currentStep === 'IDLE') {
      const isGreeting = GREETING_KEYWORDS.has(textBody.toLowerCase()) || textBody.length > 0;
      const senderName = event.senderName || currentState.customerName || null;
      const greetingName = senderName ? ` ${senderName}` : '';
      const restaurant = await tx.restaurant.findUnique({
        where: { id: restaurantId },
        select: { name: true }
      });
      const restaurantName = restaurant ? restaurant.name : 'our restaurant';

      if (isGreeting) {
        const nextStep = 'AWAITING_CART';
        const updatedState = {
          ...currentState,
          customerName: senderName,
          unsupportedCount: 0
        };

        const updatedSession = await tx.conversationSession.upsert({
          where: {
            restaurant_id_customer_phone: {
              restaurant_id: restaurantId,
              customer_phone: customerPhone
            }
          },
          update: {
            current_step: nextStep,
            state: updatedState,
            expires_at: expiresAt
          },
          create: {
            restaurant_id: restaurantId,
            customer_phone: customerPhone,
            current_step: nextStep,
            state: updatedState,
            expires_at: expiresAt
          }
        });

        return {
          success: true,
          session: updatedSession,
          action: {
            type: 'SEND_WELCOME_CATALOG',
            nextStep,
            customerName: senderName,
            message: `Hello${greetingName} 👋\n\nWelcome to ${restaurantName}!\n\nWhat would you like to enjoy today?`
          }
        };
      }

      // Any unexpected interactive button or location in IDLE routes to welcome catalog
      const nextStep = 'AWAITING_CART';
      const updatedSession = await tx.conversationSession.upsert({
        where: {
          restaurant_id_customer_phone: {
            restaurant_id: restaurantId,
            customer_phone: customerPhone
          }
        },
        update: {
          current_step: nextStep,
          state: { unsupportedCount: 0, customerName: senderName },
          expires_at: expiresAt
        },
        create: {
          restaurant_id: restaurantId,
          customer_phone: customerPhone,
          current_step: nextStep,
          state: { unsupportedCount: 0, customerName: senderName },
          expires_at: expiresAt
        }
      });

      return {
        success: true,
        session: updatedSession,
        action: {
          type: 'SEND_WELCOME_CATALOG',
          nextStep,
          customerName: senderName,
          message: `Hello${greetingName} 👋\n\nWelcome to ${restaurantName}!\n\nWhat would you like to enjoy today?`
        }
      };
    }

    // -------------------------------------------------------------
    // STATE: AWAITING_CART (Waiting for catalogue cart submission)
    // -------------------------------------------------------------
    if (currentStep === 'AWAITING_CART') {
      if (textBody) {
        // Customer sent free-form text or repeated greeting
        // Decision D-02: No free-form NLP edits. Contextual catalog redirect.
        const updatedSession = await tx.conversationSession.update({
          where: { id: session.id },
          data: {
            state: { ...currentState, unsupportedCount: 0 },
            expires_at: expiresAt
          }
        });

        return {
          success: true,
          session: updatedSession,
          action: {
            type: 'REDIRECT_TO_CATALOG',
            nextStep: 'AWAITING_CART',
            message: 'To select items or modify your order, please use our menu catalogue below.'
          }
        };
      }

      // Unsupported message type (button, list, image, audio, etc.) in AWAITING_CART
      const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
        ? currentState.unsupportedCount
        : 0;

      if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
        const newCount = currentUnsupported + 1;
        const updatedSession = await tx.conversationSession.update({
          where: { id: session.id },
          data: {
            state: { ...currentState, unsupportedCount: newCount },
            expires_at: expiresAt
          }
        });

        return {
          success: true,
          session: updatedSession,
          action: {
            type: 'CONTEXTUAL_REPROMPT',
            currentStep: 'AWAITING_CART',
            repromptCount: newCount,
            message: 'We didn\'t quite catch that. Please use our menu catalogue below to select your items.'
          }
        };
      }

      // Beyond retry limit: Silent fallback to prevent customer spam (Decision D-06)
      return {
        success: true,
        session,
        action: {
          type: 'SILENT_FALLBACK',
          currentStep: 'AWAITING_CART',
          repromptCount: currentUnsupported,
          message: 'Maximum consecutive reminders reached. Going quiet.'
        }
      };
    }

    // -------------------------------------------------------------
    // STATES: AWAITING_ADDRESS_CHOICE, AWAITING_SAVE_CONSENT, AWAITING_ORDER_TYPE, AWAITING_CONFIRMATION
    // -------------------------------------------------------------
    const hasInteractive = Boolean(buttonId || listId);

    if (hasInteractive) {
      const isValidAction = validateActionForStep(currentStep, buttonId, listId, currentState);

      if (!isValidAction) {
        // Invalid or stale button ID for this step -> reject without mutating state data
        logger.warn('Interactive action rejected: invalid for current step', {
          restaurantId,
          customerPhone,
          currentStep,
          buttonId,
          listId
        });

        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;

        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              state: { ...currentState, unsupportedCount: newCount },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: newCount,
              message: getContextualPromptForStep(currentStep)
            }
          };
        }

        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep,
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }

      // Universal Cancel Order Handler across any active ordering step
      if (buttonId === 'BTN_CANCEL_ORDER' || listId === 'BTN_CANCEL_ORDER') {
        const cancelResult = await cancelCustomerOrder({
          restaurantId,
          customerPhone,
          txClient: tx
        });

        return {
          success: true,
          session: cancelResult.session,
          action: {
            type: 'ORDER_CANCELLED',
            nextStep: 'IDLE',
            message: 'Your order has been cancelled. Send "Hi" whenever you would like to order again.'
          }
        };
      }

      // -------------------------------------------------------------
      // 1. STATE: AWAITING_ADDRESS_CHOICE & AWAITING_ADDRESS_INPUT (Interactive Action Handler)
      // -------------------------------------------------------------
      if (currentStep === 'AWAITING_ADDRESS_CHOICE' || currentStep === 'AWAITING_ADDRESS_INPUT') {
        // Location Request flow
        if (buttonId === 'BTN_SHARE_LOCATION' || listId === 'BTN_SHARE_LOCATION') {
          const nextStep = 'AWAITING_LOCATION';
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: { ...currentState, unsupportedCount: 0 },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_LOCATION_REQUEST',
              nextStep,
              message: 'Please share your current delivery location.'
            }
          };
        }

        // Customer with saved addresses requests to enter a new address -> show collection options
        if (buttonId === 'BTN_ENTER_NEW_ADDRESS' || listId === 'BTN_ENTER_NEW_ADDRESS') {
          const nextStep = 'AWAITING_ADDRESS_INPUT';
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: { ...currentState, unsupportedCount: 0 },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_ADDRESS_INPUT',
              nextStep,
              message: 'Please choose to share your location or enter your address manually:'
            }
          };
        }

        // Manual sequential address flow (Step 1: Room Number)
        if (buttonId === 'BTN_ENTER_MANUAL_ADDRESS' || listId === 'BTN_ENTER_MANUAL_ADDRESS') {
          const nextStep = 'AWAITING_MANUAL_ROOM';
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: { ...currentState, manualAddress: {}, unsupportedCount: 0 },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_MANUAL_ROOM',
              nextStep,
              message: 'Please enter your Room / Flat / House Number:'
            }
          };
        }

        const isUseSaved = buttonId === 'BTN_USE_SAVED_ADDRESS' ||
          buttonId?.startsWith('BTN_USE_SAVED_ADDRESS:') ||
          listId?.startsWith('ADDR_SAVED_');

        if (isUseSaved) {
          let addressId = null;
          if (buttonId && buttonId.startsWith('BTN_USE_SAVED_ADDRESS:')) {
            addressId = buttonId.slice('BTN_USE_SAVED_ADDRESS:'.length).trim();
          } else if (listId && listId.startsWith('ADDR_SAVED_')) {
            addressId = listId.slice('ADDR_SAVED_'.length).trim();
          }

          let savedAddr = null;
          if (addressId) {
            savedAddr = await findSavedAddressById(restaurantId, customerPhone, addressId);
          } else {
            const allSaved = await findCustomerSavedAddresses(restaurantId, customerPhone);
            savedAddr = allSaved.length > 0 ? allSaved[0] : null;
          }

          if (savedAddr) {
            const normalized = normalizeAddress({
              source: 'SAVED',
              addressText: savedAddr.address,
              latitude: savedAddr.latitude !== null ? Number(savedAddr.latitude) : null,
              longitude: savedAddr.longitude !== null ? Number(savedAddr.longitude) : null
            });

            const nextStep = 'AWAITING_ORDER_TYPE';
            const updatedState = {
              ...currentState,
              address: normalized,
              addressSaved: true,
              selectedSavedAddressId: savedAddr.id,
              unsupportedCount: 0
            };

            const updatedSession = await tx.conversationSession.update({
              where: { id: session.id },
              data: {
                current_step: nextStep,
                state: updatedState,
                expires_at: expiresAt
              }
            });

            return {
              success: true,
              session: updatedSession,
              action: {
                type: 'PROMPT_ORDER_TYPE',
                nextStep,
                address: normalized,
                message: `Saved address selected:\n📍 ${normalized.addressText}\n\nHow would you like to receive your order?`
              }
            };
          }

          // Address not found or tenant/customer mismatch
          logger.warn('Saved address selection rejected: not found or cross-tenant/customer mismatch', {
            restaurantId,
            customerPhone,
            addressId
          });

          return {
            success: true,
            session,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep: 'AWAITING_ADDRESS_CHOICE',
              message: 'The selected saved address could not be found. Please select an address or choose Enter Manually.'
            }
          };
        }
      }

      // If in AWAITING_LOCATION and user taps Enter Manually
      if (currentStep === 'AWAITING_LOCATION') {
        if (buttonId === 'BTN_ENTER_MANUAL_ADDRESS' || listId === 'BTN_ENTER_MANUAL_ADDRESS') {
          const nextStep = 'AWAITING_MANUAL_ROOM';
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: { ...currentState, manualAddress: {}, unsupportedCount: 0 },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_MANUAL_ROOM',
              nextStep,
              message: 'Please enter your Room / Flat / House Number:'
            }
          };
        }
      }

      // -------------------------------------------------------------
      // 2. STATE: AWAITING_SAVE_CONSENT (Interactive Action Handler)
      // -------------------------------------------------------------
      if (currentStep === 'AWAITING_SAVE_CONSENT') {
        if (
          buttonId === 'BTN_CONSENT_YES' ||
          buttonId === 'BTN_SAVE_ADDRESS' ||
          buttonId === 'BTN_SAVE_YES' ||
          buttonId === 'BTN_YES'
        ) {
          let savedRecord = null;
          let isDuplicate = false;

          if (currentState.address && currentState.address.addressText) {
            const saveRes = await saveConsentedAddress(
              restaurantId,
              customerPhone,
              currentState.address,
              'Default',
              tx
            );
            savedRecord = saveRes.savedAddress;
            isDuplicate = saveRes.isDuplicate;
          }

          const nextStep = 'AWAITING_ORDER_TYPE';
          const updatedState = {
            ...currentState,
            addressSaved: true,
            savedAddressId: savedRecord ? savedRecord.id : null,
            isDuplicateSavedAddress: isDuplicate,
            unsupportedCount: 0
          };

          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: updatedState,
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_ORDER_TYPE',
              nextStep,
              addressSaved: true,
              message: 'Address saved! 📍\n\nHow would you like to receive your order?'
            }
          };
        }

        if (
          buttonId === 'BTN_CONSENT_NO' ||
          buttonId === 'BTN_USE_ONCE' ||
          buttonId === 'BTN_SAVE_NO' ||
          buttonId === 'BTN_NO'
        ) {
          const nextStep = 'AWAITING_ORDER_TYPE';
          const updatedState = {
            ...currentState,
            addressSaved: false,
            unsupportedCount: 0
          };

          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: updatedState,
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_ORDER_TYPE',
              nextStep,
              addressSaved: false,
              message: 'How would you like to receive your order?'
            }
          };
        }
      }

      // -------------------------------------------------------------
      // 3. STATE: AWAITING_ORDER_TYPE (Fulfilment Selection)
      // -------------------------------------------------------------
      if (currentStep === 'AWAITING_ORDER_TYPE') {
        const restaurant = await tx.restaurant.findUnique({
          where: { id: restaurantId },
          select: { name: true }
        });
        const restaurantName = restaurant ? restaurant.name : '';

        // DELIVERY SELECTION
        if (buttonId === 'BTN_ORDER_DELIVERY') {
          // Delivery Guard: Requires completed address
          if (!currentState.address || !currentState.address.addressText) {
            logger.warn('Delivery selected without completed address', { restaurantId, customerPhone });
            return {
              success: true,
              session,
              action: {
                type: 'CONTEXTUAL_REPROMPT',
                currentStep: 'AWAITING_ORDER_TYPE',
                message: 'Delivery orders require a valid delivery address. Please enter your address first.'
              }
            };
          }

          const summary = buildOrderSummary({
            cart: currentState.cart,
            orderType: 'DELIVERY',
            address: currentState.address,
            restaurantName,
            customerName: currentState.customerName || event.senderName || null,
            confirmationToken: currentState.confirmationToken
          });

          const nextStep = 'AWAITING_CONFIRMATION';
          const updatedState = {
            ...currentState,
            orderType: 'DELIVERY',
            orderSummary: summary,
            unsupportedCount: 0
          };

          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: updatedState,
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_ORDER_CONFIRMATION',
              nextStep,
              orderType: 'DELIVERY',
              summary,
              confirmationToken: currentState.confirmationToken,
              message: summary.summaryText,
              buttons: [
                { id: `BTN_CONFIRM_ORDER:${currentState.confirmationToken}`, title: '✅ Confirm Order' },
                { id: 'BTN_CANCEL_ORDER', title: '❌ Cancel Order' },
                { id: 'BTN_CHANGE_ADDRESS', title: '📍 Change Address' }
              ]
            }
          };
        }

        // TAKEAWAY SELECTION
        if (buttonId === 'BTN_ORDER_TAKEAWAY') {
          // Takeaway does NOT require delivery address
          const summary = buildOrderSummary({
            cart: currentState.cart,
            orderType: 'TAKEAWAY',
            address: null,
            restaurantName,
            customerName: currentState.customerName || event.senderName || null,
            confirmationToken: currentState.confirmationToken
          });

          const nextStep = 'AWAITING_CONFIRMATION';
          const updatedState = {
            ...currentState,
            orderType: 'TAKEAWAY',
            orderSummary: summary,
            unsupportedCount: 0
          };

          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: updatedState,
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_ORDER_CONFIRMATION',
              nextStep,
              orderType: 'TAKEAWAY',
              summary,
              confirmationToken: currentState.confirmationToken,
              message: summary.summaryText,
              buttons: [
                { id: `BTN_CONFIRM_ORDER:${currentState.confirmationToken}`, title: '✅ Confirm Order' },
                { id: 'BTN_CANCEL_ORDER', title: '❌ Cancel Order' }
              ]
            }
          };
        }
      }

      // -------------------------------------------------------------
      // 4. STATE: AWAITING_CONFIRMATION (Order Review, Confirm, Cancel, Change Address)
      // -------------------------------------------------------------
      if (currentStep === 'AWAITING_CONFIRMATION') {
        // CONFIRM ORDER
        if (buttonId.startsWith('BTN_CONFIRM_ORDER:')) {
          const token = buttonId.slice('BTN_CONFIRM_ORDER:'.length).trim();

          const confirmResult = await confirmCustomerOrder({
            restaurantId,
            customerPhone,
            confirmationToken: token,
            customerName: currentState.customerName || event.senderName || null,
            txClient: tx
          });

          if (!confirmResult.success) {
            return {
              success: false,
              code: confirmResult.code,
              error: confirmResult.error,
              action: {
                type: 'CONTEXTUAL_REPROMPT',
                currentStep: 'AWAITING_CONFIRMATION',
                message: confirmResult.error
              }
            };
          }

          const order = confirmResult.order;
          const displayCust = currentState.customerName || event.senderName || '';
          const custGreeting = displayCust ? ` ${displayCust}` : '';

          return {
            success: true,
            order,
            isDuplicate: confirmResult.isDuplicate,
            action: {
              type: 'ORDER_CONFIRMED',
              isDuplicate: confirmResult.isDuplicate,
              orderReference: order.order_reference,
              status: order.status,
              totalAmount: order.total_amount,
              currency: order.currency,
              orderType: order.order_type,
              message: confirmResult.isDuplicate
                ? `Your order *${order.order_reference}* has already been confirmed and received by the restaurant!`
                : `Thank you${custGreeting}! Your order *${order.order_reference}* has been placed and is waiting for restaurant confirmation.`
            }
          };
        }

        // CANCEL ORDER
        if (buttonId === 'BTN_CANCEL_ORDER') {
          const cancelResult = await cancelCustomerOrder({
            restaurantId,
            customerPhone,
            txClient: tx
          });

          return {
            success: true,
            session: cancelResult.session,
            action: {
              type: 'ORDER_CANCELLED',
              nextStep: 'IDLE',
              message: 'Your order has been cancelled. Send "Hi" whenever you would like to order again.'
            }
          };
        }

        // CHANGE ADDRESS (Invalidates confirmation token)
        if (buttonId === 'BTN_CHANGE_ADDRESS') {
          const freshToken = generateConfirmationToken();
          const savedAddresses = await findCustomerSavedAddresses(restaurantId, customerPhone);
          const hasSaved = savedAddresses && savedAddresses.length > 0;
          const nextStep = hasSaved ? 'AWAITING_ADDRESS_CHOICE' : 'AWAITING_ADDRESS_INPUT';

          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: {
                ...currentState,
                confirmationToken: freshToken,
                address: null,
                addressSaved: false,
                unsupportedCount: 0
              },
              expires_at: expiresAt
            }
          });

          logger.info('Customer requested address change; confirmation token invalidated', {
            restaurantId,
            customerPhone,
            nextStep,
            freshToken: '[REDACTED]'
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: hasSaved ? 'PROMPT_ADDRESS_CHOICE' : 'PROMPT_ADDRESS_COLLECTION',
              nextStep,
              customerName: currentState.customerName || null,
              confirmationToken: freshToken,
              savedAddresses: hasSaved ? savedAddresses.map(a => ({ id: a.id, address: a.address, label: a.label })) : [],
              message: 'Please select or provide your new delivery address.'
            }
          };
        }
      }

      // Generic fallback for recognized actions in unspecified steps
      const updatedSession = await tx.conversationSession.update({
        where: { id: session.id },
        data: {
          state: { ...currentState, unsupportedCount: 0 },
          expires_at: expiresAt
        }
      });

      return {
        success: true,
        session: updatedSession,
        action: {
          type: 'VALID_INTERACTIVE_ACTION',
          currentStep,
          buttonId,
          listId
        }
      };
    }

    // -------------------------------------------------------------
    // STATES: AWAITING_ADDRESS_CHOICE, AWAITING_ADDRESS_INPUT, AWAITING_LOCATION
    // (Manual Text Address or WhatsApp Location Pin)
    // -------------------------------------------------------------
    if (
      currentStep === 'AWAITING_ADDRESS_CHOICE' ||
      currentStep === 'AWAITING_ADDRESS_INPUT' ||
      currentStep === 'AWAITING_LOCATION'
    ) {
      // 1. WhatsApp Location Pin
      if (event.messageType === 'location') {
        const rawLoc = event.location || {};

        // 1a. Reject Live Location Tracking Updates
        if (rawLoc.isLive) {
          const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
            ? currentState.unsupportedCount
            : 0;
          return {
            success: true,
            session,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: currentUnsupported,
              message: 'Live location tracking is not supported. Please share your current delivery location as a static pin.'
            }
          };
        }

        const coordCheck = validateCoordinates(rawLoc.latitude, rawLoc.longitude);

        if (coordCheck.isValid) {
          const tempLocation = {
            latitude: coordCheck.latitude,
            longitude: coordCheck.longitude,
            name: rawLoc.name || null,
            address: rawLoc.address || null
          };

          const nextStep = 'AWAITING_LOCATION_DETAILS';
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: {
                ...currentState,
                tempLocation,
                unsupportedCount: 0
              },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_LOCATION_DETAILS',
              nextStep,
              tempLocation,
              message: 'Please share your room/flat number and building name.'
            }
          };
        }

        // Invalid coordinates -> reprompt
        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;

        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              state: { ...currentState, unsupportedCount: newCount },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: newCount,
              message: coordCheck.error || 'The location coordinates received were invalid. Please share your WhatsApp location pin again or enter your full text address.'
            }
          };
        }

        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep,
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }

      // 2. Manual Text Address
      if (event.messageType === 'text' || textBody.length > 0) {
        const textCheck = validateTextAddress(textBody);

        if (textCheck.isValid) {
          const normalized = normalizeAddress({
            source: 'MANUAL',
            addressText: textCheck.addressText,
            latitude: null,
            longitude: null
          });

          const nextStep = 'AWAITING_SAVE_CONSENT';
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: {
                ...currentState,
                address: normalized,
                unsupportedCount: 0
              },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_SAVE_CONSENT',
              nextStep,
              address: normalized,
              message: `Address received! 📍\n\n${normalized.addressText}\n\nWould you like to save this address for future orders?`
            }
          };
        }

        // Address text too short or empty -> reprompt
        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;

        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              state: { ...currentState, unsupportedCount: newCount },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: newCount,
              message: textCheck.error || 'Please provide your full delivery address (minimum 10 characters) or share your location pin.'
            }
          };
        }

        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep,
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }
    }

    // -------------------------------------------------------------
    // STATE: AWAITING_LOCATION_DETAILS (Room & Building for Static Pin)
    // -------------------------------------------------------------
    if (currentStep === 'AWAITING_LOCATION_DETAILS') {
      if (event.messageType === 'location') {
        const rawLoc = event.location || {};
        if (rawLoc.isLive) {
          return {
            success: true,
            session,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              message: 'Live location tracking is not supported. Please share your current delivery location as a static pin.'
            }
          };
        }
        const coordCheck = validateCoordinates(rawLoc.latitude, rawLoc.longitude);
        if (coordCheck.isValid) {
          const tempLocation = {
            latitude: coordCheck.latitude,
            longitude: coordCheck.longitude,
            name: rawLoc.name || null,
            address: rawLoc.address || null
          };
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              state: { ...currentState, tempLocation, unsupportedCount: 0 },
              expires_at: expiresAt
            }
          });
          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_LOCATION_DETAILS',
              nextStep: 'AWAITING_LOCATION_DETAILS',
              tempLocation,
              message: 'Please share your room/flat number and building name.'
            }
          };
        }
      }

      if (event.messageType === 'text' || textBody.length > 0) {
        const details = textBody.trim();
        if (details.length >= 1) {
          const tempLoc = currentState.tempLocation || {};
          const lat = typeof tempLoc.latitude === 'number' ? tempLoc.latitude : null;
          const lng = typeof tempLoc.longitude === 'number' ? tempLoc.longitude : null;
          const formattedAddress = combineAddressComponents(details, tempLoc.name, tempLoc.address);

          const normalized = normalizeAddress({
            source: 'LOCATION_PIN',
            addressText: formattedAddress,
            roomAndBuilding: details,
            latitude: lat,
            longitude: lng
          });

          const nextStep = 'AWAITING_SAVE_CONSENT';
          const { tempLocation: _t, ...stateWithoutTemp } = currentState;
          const updatedState = {
            ...stateWithoutTemp,
            address: normalized,
            unsupportedCount: 0
          };

          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: updatedState,
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_SAVE_CONSENT',
              nextStep,
              address: normalized,
              message: `Address received! 📍\n\n${normalized.addressText}\n\nWould you like us to save this delivery address for your future orders?`
            }
          };
        }

        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;

        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              state: { ...currentState, unsupportedCount: newCount },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: newCount,
              message: 'Please share your room/flat number and building name.'
            }
          };
        }

        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep,
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }
    }

    // -------------------------------------------------------------
    // STATES: 4-Step Sequential Manual Address Collection
    // 1. Room/Flat -> 2. Building -> 3. Street -> 4. Area
    // -------------------------------------------------------------
    if (currentStep === 'AWAITING_MANUAL_ROOM') {
      if (event.messageType === 'text' || textBody.length > 0) {
        const room = textBody.trim();
        if (room.length >= 1) {
          const nextStep = 'AWAITING_MANUAL_BUILDING';
          const updatedState = {
            ...currentState,
            manualAddress: { ...(currentState.manualAddress || {}), room },
            unsupportedCount: 0
          };
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: { current_step: nextStep, state: updatedState, expires_at: expiresAt }
          });
          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_MANUAL_BUILDING',
              nextStep,
              message: 'Please enter your Building / Apartment Name:'
            }
          };
        }

        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;
        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: { state: { ...currentState, unsupportedCount: newCount }, expires_at: expiresAt }
          });
          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: newCount,
              message: 'Please enter your Room / Flat / House Number:'
            }
          };
        }
        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep,
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }
    }

    if (currentStep === 'AWAITING_MANUAL_BUILDING') {
      if (event.messageType === 'text' || textBody.length > 0) {
        const building = textBody.trim();
        if (building.length >= 1) {
          const nextStep = 'AWAITING_MANUAL_STREET';
          const updatedState = {
            ...currentState,
            manualAddress: { ...(currentState.manualAddress || {}), building },
            unsupportedCount: 0
          };
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: { current_step: nextStep, state: updatedState, expires_at: expiresAt }
          });
          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_MANUAL_STREET',
              nextStep,
              message: 'Please enter your Street / Road Name:'
            }
          };
        }

        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;
        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: { state: { ...currentState, unsupportedCount: newCount }, expires_at: expiresAt }
          });
          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: newCount,
              message: 'Please enter your Building / Apartment Name:'
            }
          };
        }
        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep,
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }
    }

    if (currentStep === 'AWAITING_MANUAL_STREET') {
      if (event.messageType === 'text' || textBody.length > 0) {
        const street = textBody.trim();
        if (street.length >= 1) {
          const nextStep = 'AWAITING_MANUAL_AREA';
          const updatedState = {
            ...currentState,
            manualAddress: { ...(currentState.manualAddress || {}), street },
            unsupportedCount: 0
          };
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: { current_step: nextStep, state: updatedState, expires_at: expiresAt }
          });
          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_MANUAL_AREA',
              nextStep,
              message: 'Please enter your Area / Locality:'
            }
          };
        }

        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;
        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: { state: { ...currentState, unsupportedCount: newCount }, expires_at: expiresAt }
          });
          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: newCount,
              message: 'Please enter your Street / Road Name:'
            }
          };
        }
        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep,
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }
    }

    if (currentStep === 'AWAITING_MANUAL_AREA') {
      if (event.messageType === 'text' || textBody.length > 0) {
        const area = textBody.trim();
        if (area.length >= 1) {
          const { room = '', building = '', street = '' } = currentState.manualAddress || {};
          const formattedAddress = combineAddressComponents(room, building, street, area);

          const normalized = normalizeAddress({
            source: 'MANUAL',
            addressText: formattedAddress,
            roomNumber: room,
            buildingName: building,
            street,
            area,
            latitude: null,
            longitude: null
          });

          const nextStep = 'AWAITING_SAVE_CONSENT';
          const { manualAddress: _m, ...stateWithoutManual } = currentState;
          const updatedState = {
            ...stateWithoutManual,
            address: normalized,
            unsupportedCount: 0
          };

          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: { current_step: nextStep, state: updatedState, expires_at: expiresAt }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_SAVE_CONSENT',
              nextStep,
              address: normalized,
              message: `Address received! 📍\n\n${formattedAddress}\n\nWould you like us to save this delivery address for your future orders?`
            }
          };
        }

        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;
        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: { state: { ...currentState, unsupportedCount: newCount }, expires_at: expiresAt }
          });
          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep,
              repromptCount: newCount,
              message: 'Please enter your Area / Locality:'
            }
          };
        }
        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep,
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }
    }

    // -------------------------------------------------------------
    // STATE: AWAITING_BUILDING_NAME (Location Pin Post-Processing)
    // -------------------------------------------------------------
    if (currentStep === 'AWAITING_BUILDING_NAME') {
      if (event.messageType === 'text' || textBody.length > 0) {
        const buildingCheck = validateBuildingName(textBody);

        if (buildingCheck.isValid) {
          const updatedTempLocation = {
            ...(currentState.tempLocation || {}),
            buildingName: buildingCheck.buildingName
          };

          const nextStep = 'AWAITING_ROOM_NUMBER';
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: {
                ...currentState,
                tempLocation: updatedTempLocation,
                unsupportedCount: 0
              },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_ROOM_NUMBER',
              nextStep,
              buildingName: buildingCheck.buildingName,
              message: `Building noted: ${buildingCheck.buildingName}. Please share your room, flat, or floor number.`
            }
          };
        }

        // Invalid building name
        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;

        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              state: { ...currentState, unsupportedCount: newCount },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep: 'AWAITING_BUILDING_NAME',
              repromptCount: newCount,
              message: buildingCheck.error || 'Please provide your building or apartment name (e.g. Sunrise Heights).'
            }
          };
        }

        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep: 'AWAITING_BUILDING_NAME',
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }
    }

    // -------------------------------------------------------------
    // STATE: AWAITING_ROOM_NUMBER (Location Pin Post-Processing)
    // -------------------------------------------------------------
    if (currentStep === 'AWAITING_ROOM_NUMBER') {
      if (event.messageType === 'text' || textBody.length > 0) {
        const roomCheck = validateRoomNumber(textBody);

        if (roomCheck.isValid) {
          const tempLoc = currentState.tempLocation || {};
          const buildingName = tempLoc.buildingName;
          const roomNumber = roomCheck.roomNumber;
          const latitude = tempLoc.latitude;
          const longitude = tempLoc.longitude;
          const extraArea = combineAddressComponents(tempLoc.name, tempLoc.address);

          const normalized = normalizeAddress({
            source: 'LOCATION_PIN',
            addressText: extraArea,
            buildingName,
            roomNumber,
            latitude,
            longitude
          });

          const nextStep = 'AWAITING_SAVE_CONSENT';
          const { tempLocation: _temp, ...stateWithoutTemp } = currentState;
          const updatedState = {
            ...stateWithoutTemp,
            address: normalized,
            unsupportedCount: 0
          };

          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              current_step: nextStep,
              state: updatedState,
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'PROMPT_SAVE_CONSENT',
              nextStep,
              address: normalized,
              message: `Delivery location confirmed:\n📍 ${normalized.addressText}\n\nWould you like to save this address for future orders? Tap Yes or No.`
            }
          };
        }

        // Invalid room number
        const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
          ? currentState.unsupportedCount
          : 0;

        if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
          const newCount = currentUnsupported + 1;
          const updatedSession = await tx.conversationSession.update({
            where: { id: session.id },
            data: {
              state: { ...currentState, unsupportedCount: newCount },
              expires_at: expiresAt
            }
          });

          return {
            success: true,
            session: updatedSession,
            action: {
              type: 'CONTEXTUAL_REPROMPT',
              currentStep: 'AWAITING_ROOM_NUMBER',
              repromptCount: newCount,
              message: roomCheck.error || 'Please provide your room, flat, or floor number (e.g. Flat 402 or 3rd Floor).'
            }
          };
        }

        return {
          success: true,
          session,
          action: {
            type: 'SILENT_FALLBACK',
            currentStep: 'AWAITING_ROOM_NUMBER',
            repromptCount: currentUnsupported,
            message: 'Maximum consecutive reminders reached. Going quiet.'
          }
        };
      }
    }

    // -------------------------------------------------------------
    // General Unsupported Input Handling (Max 2 Reminders & Silent Fallback)
    // -------------------------------------------------------------
    const currentUnsupported = (typeof currentState.unsupportedCount === 'number')
      ? currentState.unsupportedCount
      : 0;

    if (currentUnsupported < MAX_CONSECUTIVE_REMINDERS) {
      const newCount = currentUnsupported + 1;
      const updatedSession = await tx.conversationSession.update({
        where: { id: session.id },
        data: {
          state: { ...currentState, unsupportedCount: newCount },
          expires_at: expiresAt
        }
      });

      return {
        success: true,
        session: updatedSession,
        action: {
          type: 'CONTEXTUAL_REPROMPT',
          currentStep,
          repromptCount: newCount,
          message: getContextualPromptForStep(currentStep)
        }
      };
    }

    return {
      success: true,
      session,
      action: {
        type: 'SILENT_FALLBACK',
        currentStep,
        repromptCount: currentUnsupported,
        message: 'Maximum consecutive reminders reached. Going quiet.'
      }
    };
  });
}

/**
 * Returns contextual guidance text for each conversation step.
 *
 * @param {string} step
 * @returns {string}
 */
function getContextualPromptForStep(step) {
  switch (step) {
    case 'AWAITING_CART':
      return 'Please browse our menu catalogue to select your items.';
    case 'AWAITING_ADDRESS_CHOICE':
      return 'Please select a delivery address option: Saved Address, Share Location, Enter Manually, or Cancel Order.';
    case 'AWAITING_LOCATION':
      return 'Please share your current delivery location by tapping the button, or choose Enter Manually.';
    case 'AWAITING_LOCATION_DETAILS':
      return 'Please share your room/flat number and building name.';
    case 'AWAITING_MANUAL_ROOM':
      return 'Please enter your Room / Flat / House Number:';
    case 'AWAITING_MANUAL_BUILDING':
      return 'Please enter your Building / Apartment Name:';
    case 'AWAITING_MANUAL_STREET':
      return 'Please enter your Street / Road Name:';
    case 'AWAITING_MANUAL_AREA':
      return 'Please enter your Area / Locality:';
    case 'AWAITING_ADDRESS_INPUT':
      return 'Please provide your full delivery address (minimum 10 characters) or share your location pin.';
    case 'AWAITING_BUILDING_NAME':
      return 'Please share your building or complex name so our delivery person can locate you easily.';
    case 'AWAITING_ROOM_NUMBER':
      return 'Please share your room, flat, or floor number.';
    case 'AWAITING_SAVE_CONSENT':
      return 'Would you like us to save this delivery address for your future orders? Tap Yes or No.';
    case 'AWAITING_ORDER_TYPE':
      return 'Please select your order type: 🚚 Delivery or 🥡 Takeaway.';
    case 'AWAITING_CONFIRMATION':
      return 'Please review your order summary above and tap Confirm Order or Cancel Order.';
    default:
      return 'Please use the options above to continue.';
  }
}

module.exports = {
  handleIncomingMessage,
  processIncomingCart,
  validateActionForStep,
  generateConfirmationToken,
  calculateSessionExpiry,
  getContextualPromptForStep,
  INACTIVITY_TTL_MS,
  MAX_CONSECUTIVE_REMINDERS
};
