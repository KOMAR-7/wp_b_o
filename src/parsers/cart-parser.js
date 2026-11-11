/**
 * RESTOPRO — WhatsApp Catalogue Cart Parser & Defensive Validator
 * Stage 4.1: Cart Processing Engine
 *
 * Implements strict, defensive validation of Meta WhatsApp `type: "order"` payloads.
 * Uses integer-cents arithmetic for decimal safety (no floating-point rounding errors).
 * Rejects corrupt or malformed cart data without silent coercion.
 */

const { resolveMenuItemName, resolveMenuItemNameAsync } = require('../services/catalog.service');

class CartValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CartValidationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Converts a monetary amount to integer cents/paise to avoid IEEE 754 floating-point errors.
 * e.g., 240.50 -> 24050, "15.99" -> 1599.
 *
 * @param {number|string} amount
 * @returns {number} Integer cents
 */
function toIntegerCents(amount) {
  if (typeof amount === 'number') {
    if (isNaN(amount) || !isFinite(amount)) {
      throw new Error('Non-finite numeric amount');
    }
    return Math.round(amount * 100);
  }

  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (!trimmed || isNaN(Number(trimmed))) {
      throw new Error(`Non-numeric amount string: "${amount}"`);
    }
    const parsed = parseFloat(trimmed);
    if (!isFinite(parsed)) {
      throw new Error(`Non-finite amount string: "${amount}"`);
    }
    return Math.round(parsed * 100);
  }

  throw new Error(`Unsupported amount type: ${typeof amount}`);
}

/**
 * Converts integer cents back to formatted decimal currency number (2 decimal places).
 * e.g., 24050 -> 240.50
 *
 * @param {number} cents
 * @returns {number}
 */
function fromIntegerCents(cents) {
  return Number((cents / 100).toFixed(2));
}

/**
 * Validates whether a value is a valid strictly positive integer.
 * e.g., 1, 2, 99 are valid. 0, -1, 1.5, "abc", NaN are invalid.
 *
 * @param {*} val
 * @returns {boolean}
 */
function isPositiveInteger(val) {
  if (typeof val === 'number') {
    return Number.isInteger(val) && val > 0;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Must be digits only and > 0
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      return parsed > 0;
    }
    return false;
  }
  return false;
}

/**
 * Parses, validates, and normalizes an incoming WhatsApp catalogue order object.
 *
 * Expected Meta payload structure:
 * {
 *   catalog_id: "...",
 *   text: "optional customer note",
 *   product_items: [
 *     {
 *       product_retailer_id: "SKU_123",
 *       quantity: 2,
 *       item_price: 240.00,
 *       currency: "INR"
 *     }
 *   ]
 * }
 *
 * @param {Object} rawOrder - Raw `order` object from Meta WhatsApp message
 * @param {Object} [options={}] - Optional resolution options (restaurantId, internalNotes, menuResolver, strictResolution)
 * @returns {{isValid: boolean, cart?: Object, error?: string, code?: string, details?: Object}}
 */
function parseAndValidateCart(rawOrder, options = {}) {
  if (!rawOrder || typeof rawOrder !== 'object') {
    return {
      isValid: false,
      code: 'MALFORMED_ORDER_OBJECT',
      error: 'Order payload must be a non-null object'
    };
  }

  const catalogId = typeof rawOrder.catalog_id === 'string' && rawOrder.catalog_id.trim()
    ? rawOrder.catalog_id.trim()
    : null;

  const customerNote = typeof rawOrder.text === 'string'
    ? rawOrder.text.trim()
    : '';

  const rawItems = rawOrder.product_items;

  // 1. Validate cart items array exists and is not empty
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return {
      isValid: false,
      code: 'CART_EMPTY',
      error: 'Cart contains no items. At least one item is required.'
    };
  }

  let cartSubtotalCents = 0;
  let totalItemCount = 0;
  let primaryCurrency = null;
  const normalizedItems = [];

  for (let index = 0; index < rawItems.length; index++) {
    const item = rawItems[index];

    if (!item || typeof item !== 'object') {
      return {
        isValid: false,
        code: 'MALFORMED_ITEM',
        error: `Item at index ${index} is not an object`
      };
    }

    // 2. Validate product_retailer_id
    const retailerId = typeof item.product_retailer_id === 'string'
      ? item.product_retailer_id.trim()
      : '';

    if (!retailerId) {
      return {
        isValid: false,
        code: 'MISSING_PRODUCT_ID',
        error: `Item at index ${index} is missing a valid product_retailer_id`
      };
    }

    // 3. Strict Quantity Validation: Positive integer only (no decimals, zero, or negatives)
    if (!isPositiveInteger(item.quantity)) {
      return {
        isValid: false,
        code: 'INVALID_QUANTITY',
        error: `Item "${retailerId}" has invalid quantity: ${JSON.stringify(item.quantity)}. Quantity must be a positive integer.`
      };
    }
    const quantity = typeof item.quantity === 'number'
      ? item.quantity
      : parseInt(item.quantity.trim(), 10);

    // 4. Strict Price Validation: Valid non-negative finite number (0.00 is allowed, negatives are rejected)
    let unitPriceCents;
    try {
      unitPriceCents = toIntegerCents(item.item_price);
      if (unitPriceCents < 0) {
        return {
          isValid: false,
          code: 'NEGATIVE_PRICE',
          error: `Item "${retailerId}" has negative price: ${item.item_price}. Prices cannot be negative.`
        };
      }
    } catch (priceErr) {
      return {
        isValid: false,
        code: 'INVALID_PRICE',
        error: `Item "${retailerId}" has invalid price: ${JSON.stringify(item.item_price)}. ${priceErr.message}`
      };
    }

    // 5. Strict Currency Validation & Consistency
    const currencyStr = typeof item.currency === 'string'
      ? item.currency.trim().toUpperCase()
      : '';

    if (!currencyStr || currencyStr.length !== 3) {
      return {
        isValid: false,
        code: 'INVALID_CURRENCY',
        error: `Item "${retailerId}" is missing a valid 3-letter ISO currency code`
      };
    }

    if (!primaryCurrency) {
      primaryCurrency = currencyStr;
    } else if (currencyStr !== primaryCurrency) {
      return {
        isValid: false,
        code: 'CURRENCY_MISMATCH',
        error: `Currency conflict detected: Cart uses "${primaryCurrency}", but item "${retailerId}" specified "${currencyStr}". All items must share identical currency.`
      };
    }

    // 6. Decimal-Safe Line Total Arithmetic
    const lineTotalCents = unitPriceCents * quantity;
    cartSubtotalCents += lineTotalCents;
    totalItemCount += quantity;

    // 7. Menu Item Resolution: Resolve genuine menu item name using catalog service
    let resolvedName = null;
    let isResolved = false;

    if (typeof options.menuResolver === 'function') {
      const res = options.menuResolver({
        restaurantId: options.restaurantId,
        catalogId,
        productRetailerId: retailerId,
        rawItem: item,
        internalNotes: options.internalNotes
      });
      if (res && res.name) {
        resolvedName = res.name;
        isResolved = Boolean(res.isResolved);
      }
    } else {
      const res = resolveMenuItemName({
        restaurantId: options.restaurantId,
        catalogId,
        productRetailerId: retailerId,
        rawItem: item,
        internalNotes: options.internalNotes
      });
      if (res && res.name) {
        resolvedName = res.name;
        isResolved = Boolean(res.isResolved);
      }
    }

    if (!resolvedName) {
      const candidatePayloadName = item.name || item.title || item.product_name || item.productName;
      if (
        typeof candidatePayloadName === 'string' &&
        candidatePayloadName.trim() &&
        candidatePayloadName.trim().toLowerCase() !== retailerId.toLowerCase() &&
        !candidatePayloadName.trim().toLowerCase().startsWith('item (') &&
        candidatePayloadName.trim().toLowerCase() !== 'item'
      ) {
        resolvedName = candidatePayloadName.trim();
        isResolved = true;
      }
    }

    if (!isResolved && options.strictResolution) {
      return {
        isValid: false,
        code: 'UNRESOLVED_CATALOG_ITEM',
        error: `Could not resolve menu item name for catalogue ID "${retailerId}". Unmatched catalogue items are rejected.`,
        unresolvedRetailerIds: [retailerId]
      };
    }

    // Never generate "Item (SKU)" or leak raw SKU into productName when scoped to a restaurant
    const displayName = resolvedName || (options.restaurantId ? null : retailerId);

    normalizedItems.push({
      productRetailerId: retailerId,
      productName: displayName,
      isResolved,
      quantity,
      unitPrice: fromIntegerCents(unitPriceCents),
      currency: currencyStr,
      subtotal: fromIntegerCents(lineTotalCents)
    });
  }

  // 8. Construct Normalized Cart Envelope
  const normalizedCart = {
    catalogId,
    customerNote,
    currency: primaryCurrency,
    itemCount: totalItemCount,
    distinctItemCount: normalizedItems.length,
    subtotal: fromIntegerCents(cartSubtotalCents),
    items: normalizedItems,
    rawOrderSnapshot: rawOrder // Untrusted submitted snapshot preserved for audit
  };

  return {
    isValid: true,
    cart: normalizedCart
  };
}

/**
 * Asynchronously parses, validates, and normalizes an incoming WhatsApp catalogue order.
 * Enhances unresolved catalogue items using async Meta Graph API lookup when credentials are provided.
 *
 * @param {Object} rawOrder - Raw order payload
 * @param {Object} [options={}] - Validation options
 * @param {string} [options.restaurantId] - Restaurant UUID
 * @param {string} [options.internalNotes] - Restaurant internal_notes string
 * @param {string} [options.accessToken] - Decrypted Meta access token
 * @param {Function} [options.menuResolverAsync] - Optional custom async resolver
 * @returns {Promise<{isValid: boolean, cart?: Object, code?: string, error?: string}>}
 */
async function parseAndValidateCartAsync(rawOrder, options = {}) {
  // 1. Run structural & decimal validation
  const syncValidation = parseAndValidateCart(rawOrder, { ...options, strictResolution: false });
  if (!syncValidation.isValid) {
    return syncValidation;
  }

  const normalizedItems = [];
  const catalogId = syncValidation.cart.catalogId;

  // 2. Resolve items asynchronously
  for (let i = 0; i < syncValidation.cart.items.length; i++) {
    const item = syncValidation.cart.items[i];
    const rawItem = (syncValidation.cart.rawOrderSnapshot?.product_items || [])[i] || {};

    if (item.isResolved && item.productName) {
      normalizedItems.push(item);
      continue;
    }

    const retailerId = item.productRetailerId;
    let resolvedName = null;
    let isResolved = false;

    if (typeof options.menuResolverAsync === 'function') {
      const res = await options.menuResolverAsync({
        restaurantId: options.restaurantId,
        catalogId,
        productRetailerId: retailerId,
        rawItem,
        internalNotes: options.internalNotes,
        accessToken: options.accessToken,
        graphClient: options.graphClient
      });
      if (res && res.name) {
        resolvedName = res.name;
        isResolved = Boolean(res.isResolved);
      }
    } else {
      const res = await resolveMenuItemNameAsync({
        restaurantId: options.restaurantId,
        catalogId,
        productRetailerId: retailerId,
        rawItem,
        internalNotes: options.internalNotes,
        accessToken: options.accessToken,
        graphClient: options.graphClient
      });
      if (res && res.name) {
        resolvedName = res.name;
        isResolved = Boolean(res.isResolved);
      }
    }

    // Direct payload attribute fallback (item.name in rawItem)
    if (!resolvedName) {
      const candidatePayloadName = rawItem.name || rawItem.title || rawItem.product_name || rawItem.productName;
      if (
        typeof candidatePayloadName === 'string' &&
        candidatePayloadName.trim() &&
        candidatePayloadName.trim().toLowerCase() !== retailerId.toLowerCase() &&
        !candidatePayloadName.trim().toLowerCase().startsWith('item (') &&
        candidatePayloadName.trim().toLowerCase() !== 'item'
      ) {
        resolvedName = candidatePayloadName.trim();
        isResolved = true;
      }
    }

    // Never generate "Item (SKU)" or leak raw SKU into productName when scoped to a restaurant
    const displayName = resolvedName || (options.restaurantId ? null : retailerId);

    normalizedItems.push({
      ...item,
      productName: displayName,
      isResolved
    });
  }

  // 3. Strict resolution check: Fail closed if any item cannot be resolved against the catalogue
  const unresolvedItems = normalizedItems.filter(it => !it.isResolved || !it.productName);
  const strictMode = options.strictResolution !== undefined
    ? Boolean(options.strictResolution)
    : Boolean(options.restaurantId);

  if (strictMode && unresolvedItems.length > 0) {
    const unresolvedIds = unresolvedItems.map(u => u.productRetailerId);
    return {
      isValid: false,
      code: 'UNRESOLVED_CATALOG_ITEM',
      error: `Could not resolve catalogue product names for item(s): ${unresolvedIds.join(', ')}. Unverified catalogue items cannot be confirmed.`,
      unresolvedRetailerIds: unresolvedIds,
      cart: {
        ...syncValidation.cart,
        items: normalizedItems
      }
    };
  }

  return {
    isValid: true,
    cart: {
      ...syncValidation.cart,
      items: normalizedItems
    }
  };
}

module.exports = {
  CartValidationError,
  parseAndValidateCart,
  parseAndValidateCartAsync,
  toIntegerCents,
  fromIntegerCents,
  isPositiveInteger
};

