# RESTOPRO — Stage 4.1: Cart Processing Implementation Results

**Document Version:** 1.0.0  
**Status:** Complete & Fully Verified  
**Execution Date:** 2026-11-05  
**Component:** WhatsApp Catalogue Cart Parser & Conversation Session State Engine  
**Test Suite:** `test/stage4-cart-test.js` (88/88 Passing Assertions)  
**Total Regression Assertions:** 269/269 Passing Across 5 Test Suites  

---

## 1. Executive Summary

Stage 4.1 implements the **Defensive WhatsApp Catalogue Cart Processing Engine** for RESTOPRO. When a customer submits a shopping cart from a restaurant's native WhatsApp catalog (`type: "order"`), RESTOPRO parses, validates, and normalizes the payload using integer-cents arithmetic, stores the normalized cart in the customer's database-persisted conversation session, sets the next conversation step to address collection (`AWAITING_ADDRESS_CHOICE` or `AWAITING_ADDRESS_INPUT`), invalidates prior confirmation tokens, and applies the approved 2-hour inactivity TTL.

Corrupt, empty, or malformed carts are strictly rejected without silent coercion. Duplicate webhook deliveries are deduplicated prior to cart processing. Zero Order records are created in this phase.

---

## 2. Files Changed & Added

| File Path | Nature of Change | Description |
| :--- | :--- | :--- |
| `src/parsers/cart-parser.js` | **New File** | Dedicated catalogue cart parser, strict validator, and integer-cents monetary calculation engine. |
| `src/services/conversation.service.js` | **New File** | Conversation state machine managing atomic session updates, cart replacement, confirmation tokens, and 2-hour TTL. |
| `src/parsers/webhook-parser.js` | **Modified** | Attached `rawOrder: message.order` in `case 'order'` while maintaining 100% backward compatibility for Stage 1.5 tests. |
| `src/controllers/webhook.controller.js` | **Modified** | Routed `messageType === 'order'` events to `conversationService.processIncomingCart()`, recording `COMPLETED` on success or `FAILED` on invalid carts. |
| `package.json` | **Modified** | Added script `"test:stage4:cart": "node test/stage4-cart-test.js"`. |
| `test/stage4-cart-test.js` | **New File** | 88 focused test assertions covering validation rules, decimal safety, session state, isolation, and end-to-end webhook ingestion. |
| `docs/07-IMPLEMENTATION-CHECKLIST.md` | **Modified** | Marked `ST4-05` and `ST4-06` complete; left subsequent feature tasks strictly unchecked. |

---

## 3. Parser & Defensive Validation Behavior

The parser in `src/parsers/cart-parser.js` implements strict, zero-tolerance validation:

| Validation Rule | Error Code | Behavior |
| :--- | :--- | :--- |
| **Empty or Missing Cart** | `CART_EMPTY` | Rejects payload if `product_items` is missing, not an array, or empty (`length === 0`). |
| **Missing Product ID** | `MISSING_PRODUCT_ID` | Rejects item if `product_retailer_id` is missing or empty string. |
| **Zero or Negative Quantity** | `INVALID_QUANTITY` | **Never silently converted to 1.** Rejects $q \le 0$ or negative values ($q = -3$). |
| **Decimal Quantity** | `INVALID_QUANTITY` | Rejects fractional quantities (e.g. $q = 1.5$). Quantities must be positive integers. |
| **Non-Numeric Quantity** | `INVALID_QUANTITY` | Rejects strings that cannot be parsed as pure integer digits (e.g. `"two"`). |
| **Negative Price** | `NEGATIVE_PRICE` | **Never silently converted to 0.** Rejects prices $< 0.00$ (e.g. $-50.00$). |
| **Non-Numeric Price** | `INVALID_PRICE` | Rejects strings or values that evaluate to `NaN` or non-numeric (e.g. `"free"`). |
| **Zero Price (Free Items)** | *Accepted* | Valid non-negative monetary value ($0.00$). Line total and subtotal calculate to $0.00$. |
| **Mixed Currencies** | `CURRENCY_MISMATCH` | All items must share the identical 3-letter ISO currency code. Rejects conflicting currencies (e.g. INR vs USD). |
| **Missing Currency** | `INVALID_CURRENCY` | Rejects items missing a valid 3-letter uppercase currency code. |
| **SKU Display Fallback** | *Normalized* | When Meta omits human-readable product name, `product_retailer_id` is used as `productName`. |
| **Malformed Payload** | `MALFORMED_ORDER_OBJECT` | Safely rejects null, undefined, or non-object payloads. |

---

## 4. Monetary Calculation Approach (Decimal Safety)

JavaScript's IEEE 754 floating-point arithmetic introduces rounding drift (e.g., `0.1 + 0.2 = 0.30000000000000004` and `19.99 * 3 = 59.970000000000006`).

To eliminate floating-point imprecision:
1. All monetary values are immediately converted to **integer cents / paise**:
   ```javascript
   function toIntegerCents(amount) {
     const parsed = typeof amount === 'number' ? amount : parseFloat(amount);
     return Math.round(parsed * 100);
   }
   ```
2. Line totals are computed as integer multiplications:
   $$\text{lineTotalCents} = \text{unitPriceCents} \times \text{quantity}$$
3. Subtotals are accumulated strictly as integer sums:
   $$\text{subtotalCents} = \sum \text{lineTotalCents}$$
4. Cents are converted back to formatted two-decimal numbers only upon building the final envelope:
   ```javascript
   function fromIntegerCents(cents) {
     return Number((cents / 100).toFixed(2));
   }
   ```
Verified in **TC-414**: $3 \times 19.99 + 7 \times 9.99 = 129.90$ exactly.

---

## 5. Normalized Cart Structure

```json
{
  "catalogId": "CAT_WH_01",
  "customerNote": "No cutlery needed",
  "currency": "INR",
  "itemCount": 3,
  "distinctItemCount": 2,
  "subtotal": 540.00,
  "items": [
    {
      "productRetailerId": "SKU_BIRYANI_01",
      "productName": "SKU_BIRYANI_01",
      "quantity": 2,
      "unitPrice": 240.00,
      "currency": "INR",
      "subtotal": 480.00
    },
    {
      "productRetailerId": "SKU_COKE_01",
      "productName": "SKU_COKE_01",
      "quantity": 1,
      "unitPrice": 60.00,
      "currency": "INR",
      "subtotal": 60.00
    }
  ],
  "rawOrderSnapshot": { ... }
}
```

---

## 6. Conversation Session Integration & Concurrency Behavior

### 6.1 Transactional Upsert & State Transitions
* Customer sessions are identified strictly by `(restaurant_id, customer_phone)`.
* Tenant is resolved **exclusively** from Meta's incoming `phone_number_id` via `resolveTenantByPhoneNumberId()`. The customer's phone number is never used for tenant lookup.
* **Next Conversation Step:**
  * Checks `saved_addresses` for `(restaurant_id, customer_phone)`.
  * If saved address exists: `current_step = 'AWAITING_ADDRESS_CHOICE'`.
  * If no saved address: `current_step = 'AWAITING_ADDRESS_INPUT'`.
* **Inactivity TTL:** `expires_at` is set to `NOW() + 2 hours` (`INACTIVITY_TTL_MS = 7,200,000`).
* **Expired Session Handling:** If a session's `expires_at` has passed, previous stale state is discarded, and the session is refreshed with the new cart.

### 6.2 Cart Replacement & Token Invalidation (Decision D-01)
* When a customer re-submits a cart (Cart B replaces Cart A), `session.state.cart` is completely overwritten with Cart B. Previous items are discarded.
* A fresh confirmation token `conf_${crypto.randomUUID()}` is generated and stored in `session.state.confirmationToken`.
* Any prior confirmation token is automatically overwritten and invalidated, preventing accidental confirmation of stale carts.

### 6.3 Concurrency & Deduplication Protection
* Webhook deduplication via `webhook_events.event_key` (`wamid`) prevents duplicate webhook requests from executing session cart updates.
* Session updates are executed within `prisma.$transaction`, serializing concurrent deliveries from the same customer without leaving partial cart state. Verified with 3 simultaneous updates via `Promise.all` (**TC-423**).

---

## 7. Master Test Results (269 / 269 Passed)

### Stage 4.1 Test Suite Breakdown (`test/stage4-cart-test.js`):
* **Group 1: Catalogue Cart Parser & Defensive Validation (14 scenarios / 37 assertions):**
  * Valid single-item & multi-item carts.
  * Empty cart rejection (`CART_EMPTY`).
  * Missing SKU rejection (`MISSING_PRODUCT_ID`).
  * Non-numeric, zero, negative, and decimal quantity rejection (`INVALID_QUANTITY`).
  * Non-numeric and negative price rejection (`INVALID_PRICE`, `NEGATIVE_PRICE`).
  * Zero-price acceptance as non-negative monetary value.
  * Mixed currency and missing currency rejection (`CURRENCY_MISMATCH`, `INVALID_CURRENCY`).
  * Decimal-safe subtotal arithmetic.
  * SKU fallback display name.
  * Malformed non-object order payloads.
* **Group 2: Conversation Session & Cart Integration (9 scenarios / 33 assertions):**
  * Initial cart session creation and step routing to `AWAITING_ADDRESS_INPUT`.
  * Complete cart replacement on resubmission.
  * Confirmation token regeneration and old token invalidation.
  * Multi-tenant session isolation (same customer at Tenant A & B).
  * Customer session isolation (Customer 1 & 2 at Tenant A).
  * 2-hour inactivity TTL calculation.
  * Expired session state reset.
  * Zero Order rows created.
  * Concurrent cart updates handling.
* **Group 3: End-to-End Webhook Pipeline (4 scenarios / 18 assertions):**
  * HTTP POST `/api/webhook` with HMAC verification and cart processing to HTTP 200.
  * Event marked `COMPLETED` in `webhook_events`.
  * Duplicate cart webhook dropped safely without reprocessing.
  * Multiple messages in one webhook payload decomposed and processed independently.
  * Malformed cart webhook persists as `FAILED` with error details, returning HTTP 200 to prevent Meta retry loops.

### Master Test Execution Summary:
| Test Suite Command | Target Scope | Passed | Failed |
| :--- | :--- | :--- | :--- |
| `npm run test:webhook` | Stage 1 & 1.5 Security & Webhooks | 86 | 0 |
| `npm run test:stage2` | Stage 2 & 3 Multi-Tenant DB | 59 | 0 |
| `npm run test:stage4:migration` | Stage 4.0 Schema Prerequisites | 30 | 0 |
| `npm run test:stage4:cart` | Stage 4.1 Cart Processing & Sessions | 88 | 0 |
| `npm run test:shutdown` | Stage 3 Signal & Shutdown Lifecycle | 6 | 0 |
| **Total Test Assertions** | **Complete RESTOPRO Backend** | **269** | **0** |

---

## 8. Known Limitations & Phase Boundaries

1. **No Outbound Messaging:** Dispatched carts update session state only; customer conversational replies (welcome messages, catalog prompts, address request buttons) are scheduled for Stage 4.2.
2. **Untrusted Pricing Snapshot:** Submitted cart prices reflect client-side catalog values. Authoritative restaurant approval occurs in Stage 5.
3. **No Address Capture:** Address parsing, GPS location pins, and consent flows begin in Stage 4.3.

