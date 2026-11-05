# RESTOPRO — Stage 4.4: Fulfilment Selection & Order Review Implementation Results

**Document Version:** 1.0.0  
**Implementation Date:** 2026-11-05  
**Status:** Implemented, Tested & Verified  
**Target Sub-Phase:** Stage 4.4 (Single Restaurant Customer Ordering Engine — Fulfilment, Review & Customer Confirmation)  

---

## 1. Executive Summary

Stage 4.4 completes the ordering engine lifecycle for RESTOPRO customers. Following cart submission (Stage 4.1), conversational state machine orchestration (Stage 4.2), and address capture (Stage 4.3), Stage 4.4 implements:

1. **Fulfilment Selection (`ST4-11`):** Dynamic presentation and deterministic handling of `DELIVERY` vs. `TAKEAWAY`. `DELIVERY` strictly enforces completed address presence; `TAKEAWAY` cleanly bypasses address validation without inventing fabricated pickup locations.
2. **Deterministic Order Review (`ST4-12`):** Constructs an itemized WhatsApp order summary recalculating totals exclusively in integer paise/cents (never trusting client-supplied numbers). Emits interactive `[Confirm Order]`, `[Cancel Order]`, and `[Change Address]` buttons.
3. **Change Address & Token Invalidation:** When a customer requests an address change from the review screen, the session returns to address collection and immediately generates a fresh confirmation token, permanently invalidating the previous token against replay attacks.
4. **Atomic Customer Order Confirmation (`ST4-13`):** Persists the confirmed order to PostgreSQL with initial status `PENDING_RESTAURANT_CONFIRMATION` inside an atomic transaction. Employs cryptographically secure `RP-YYMMDD-XXXX` reference generation with targeted collision retries.
5. **Database-Backed Idempotency Guard:** Uses the database-unique `confirmation_token` column on `orders`. Any repeated tap or network retry safely returns the existing order with zero duplicate row creation.
6. **Order Cancellation Handler (`ST4-14`):** Resets conversation session state to `IDLE` on customer cancellation, creating zero rows in `orders`.

> [!IMPORTANT]
> **Strict Phase Boundary Adherence:** Customer confirmation places the order into `PENDING_RESTAURANT_CONFIRMATION`. Orders are **never** automatically marked as `ACCEPTED`. Restaurant owner notifications, Accept/Reject interactive buttons, and restaurant decision processing belong exclusively to **Stage 5**.

---

## 2. State Machine Transitions & Interaction Flow

```mermaid
flowchart TD
    Consent["Step: AWAITING_SAVE_CONSENT (Stage 4.3)"] --> OrderTypeStep["Step: AWAITING_ORDER_TYPE<br/>Prompt: [Delivery] or [Takeaway]"]
    
    OrderTypeStep -->|BTN_ORDER_DELIVERY| CheckAddress{"Is address completed in session?"}
    CheckAddress -->|No| RepromptAddr["Reject & Reprompt: Address Required"]
    CheckAddress -->|Yes| ReviewDelivery["Build Delivery Summary<br/>Set orderType = DELIVERY"]
    
    OrderTypeStep -->|BTN_ORDER_TAKEAWAY| ReviewTakeaway["Build Takeaway Summary<br/>(addressSnapshot: null)<br/>Set orderType = TAKEAWAY"]
    
    ReviewDelivery --> ReviewStep["Step: AWAITING_CONFIRMATION<br/>Buttons: [Confirm Order] / [Cancel Order] / [Change Address]"]
    ReviewTakeaway --> ReviewStepTakeaway["Step: AWAITING_CONFIRMATION<br/>Buttons: [Confirm Order] / [Cancel Order]"]
    
    ReviewStep -->|BTN_CHANGE_ADDRESS| InvalidateToken["Generate Fresh confirmationToken<br/>(Old token invalidated)"]
    InvalidateToken --> ReturnAddr["Return to AWAITING_ADDRESS_CHOICE or AWAITING_ADDRESS_INPUT"]
    
    ReviewStep -->|BTN_CANCEL_ORDER| CancelOrder["Reset Session to IDLE<br/>Zero rows created in orders"]
    ReviewStepTakeaway -->|BTN_CANCEL_ORDER| CancelOrder
    
    ReviewStep -->|BTN_CONFIRM_ORDER:token| ConfirmAtomic{"Check orders for confirmation_token"}
    ReviewStepTakeaway -->|BTN_CONFIRM_ORDER:token| ConfirmAtomic
    
    ConfirmAtomic -->|Token Found (Replay/Retry)| ReturnExisting["Return Existing Order (Zero Duplicates)"]
    ConfirmAtomic -->|Token Not Found| CreateOrder["Atomically create Order with RP-YYMMDD-XXXX<br/>status: PENDING_RESTAURANT_CONFIRMATION<br/>Reset session to IDLE"]
```

---

## 3. Subsystem Implementation Details

### 3.1 Fulfilment Selection Engine (`ST4-11`)

- **Interactive Whitelist Validation:** In `AWAITING_ORDER_TYPE`, only `BTN_ORDER_DELIVERY` and `BTN_ORDER_TAKEAWAY` are accepted by [`validateActionForStep()`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/conversation.service.js#L196-L245).
- **Delivery Guard:**
  ```javascript
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
  ```
- **Takeaway Policy:** Allows orders to proceed with `address = null`. Formats summary with restaurant commercial name (`restaurant.name`) for pickup notice without fabricating street addresses.

### 3.2 Deterministic Order Review Summary (`ST4-12`)

Implemented in [`src/services/order.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/order.service.js):
- **Integer Paise/Cents Recalculation:**
  Uses `toIntegerCents()` and `fromIntegerCents()` to compute line totals:
  $$\text{subtotalCents} = \sum_{i} (\text{quantity}_i \times \text{unitPriceCents}_i)$$
  Ensuring $0.1 + 0.2$ floating-point errors cannot corrupt billing totals.
- **Embedded Confirmation Token:**
  The active `confirmationToken` (e.g. `conf_8c30a442-dfae-4bd5-8f43-89ea3b9e4a3b`) is embedded directly into the button payload:
  `BTN_CONFIRM_ORDER:conf_8c30a442-dfae-4bd5-8f43-89ea3b9e4a3b`.

### 3.3 Change Address & Token Invalidation

- **Security Rule:** Any customer-initiated address change from the review screen triggers:
  ```javascript
  const freshToken = generateConfirmationToken();
  ```
  The session state replaces `confirmationToken` with `freshToken` and nullifies `state.address`.
- **Replay Protection:** If the customer attempts to send a previously displayed confirmation button (containing the stale token), `validateActionForStep()` immediately rejects it with `INVALID_CONFIRMATION_TOKEN`.

### 3.4 Cryptographically Secure Reference Generation & Targeted Collision Retries

- **Format:** `RP-YYMMDD-XXXX` (Prefix + Date + 4-char uppercase alphanumeric from charset `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` having $>1\,\text{million}$ combinations/day).
- **Targeted Prisma P2002 Collision Handling:**
  ```javascript
  async function createOrderWithReferenceRetry(tx, orderData) {
    const MAX_RETRIES = 4;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const suffixLength = attempt === MAX_RETRIES ? 6 : 4;
      const candidateRef = generateOrderReference(new Date(), suffixLength);
      try {
        return await tx.order.create({
          data: { ...orderData, order_reference: candidateRef }
        });
      } catch (err) {
        const isRefCollision = err.code === 'P2002' && (
          (Array.isArray(err.meta?.target) && err.meta.target.includes('order_reference')) ||
          (typeof err.meta?.target === 'string' && err.meta.target.includes('order_reference'))
        );
        if (isRefCollision && attempt < MAX_RETRIES) continue;
        throw err;
      }
    }
  }
  ```

### 3.5 Idempotency Guard on `orders.confirmation_token` (`ST4-13`)

- **Early Webhook Interception & Transaction Guard:**
  Before evaluating step state, the system checks if an order with `confirmation_token` already exists in PostgreSQL:
  ```javascript
  const existingOrder = await tx.order.findUnique({
    where: { confirmation_token: confirmationToken }
  });
  if (existingOrder) {
    return { success: true, order: existingOrder, isDuplicate: true };
  }
  ```
- **Database Unique Constraint:** PostgreSQL `orders_confirmation_token_key` physically blocks concurrent duplicate inserts at the engine level.

### 3.6 Order Cancellation (`ST4-14`)

- Tapping `BTN_CANCEL_ORDER` resets `conversation_sessions.current_step` to `IDLE`, sets `state = { cancelledAt, unsupportedCount: 0 }`, and creates exactly 0 rows in the `orders` table.

---

## 4. Database Schema Compatibility

- **Status:** The schema prerequisite added in Stage 4.0 (`orders.confirmation_token VARCHAR(128) UNIQUE`) fully satisfied all requirements.
- **Database Migrations:** **0 (Zero database schema changes required).**

---

## 5. Automated Verification & Test Results

A dedicated automated test suite was implemented in [`test/stage4-fulfilment-review-test.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/test/stage4-fulfilment-review-test.js) covering all 15 functional scenarios.

### Execution Log Preview:

```
============================================================
   RESTOPRO — STAGE 4.4: FULFILMENT & ORDER REVIEW TEST    
============================================================

--- TEST GROUP 1: Fulfilment Selection — Delivery vs Takeaway (ST4-11) ---
  ✅ [PASS] BTN_ORDER_DELIVERY transitions to AWAITING_CONFIRMATION
  ✅ [PASS] Session state stores orderType = DELIVERY
  ✅ [PASS] Action prompts for order confirmation
  ✅ [PASS] Order summary reflects DELIVERY
  ✅ [PASS] Delivery summary includes address snapshot
  ✅ [PASS] Delivery summary provides BTN_CHANGE_ADDRESS button
  ✅ [PASS] BTN_ORDER_TAKEAWAY succeeds without delivery address
  ✅ [PASS] Session state stores orderType = TAKEAWAY
  ✅ [PASS] Takeaway summary has null address snapshot
  ✅ [PASS] Summary text notes Takeaway (Self-Pickup)
  ✅ [PASS] Takeaway summary does NOT provide BTN_CHANGE_ADDRESS button
  ✅ [PASS] Delivery without address is rejected; stays in AWAITING_ORDER_TYPE
  ✅ [PASS] Contextual reprompt issued for missing address
  ✅ [PASS] Reprompt message specifies delivery address requirement

--- TEST GROUP 2: Order Review & Price Calculations (ST4-12) ---
  ✅ [PASS] Subtotal correctly calculated with zero floating-point drift (680.97)
  ✅ [PASS] Summary contains exactly 2 item snapshots
  ✅ [PASS] Line total 1 is exactly 599.97
  ✅ [PASS] Line total 2 is exactly 81.00
  ✅ [PASS] Currency is INR
  ✅ [PASS] Summary text renders correct subtotal
  ✅ [PASS] BTN_CHANGE_ADDRESS returns session to address collection
  ✅ [PASS] Previous confirmation token is completely invalidated
  ✅ [PASS] Previous address cleared from session state
  ✅ [PASS] Stale confirmation token rejected; order not created

--- TEST GROUP 3: Customer Order Confirmation Handler (ST4-13) ---
  ✅ [PASS] Order confirmation returns success
  ✅ [PASS] Order object returned in response
  ✅ [PASS] Order status is strictly PENDING_RESTAURANT_CONFIRMATION
  ✅ [PASS] Order records confirmation_token
  ✅ [PASS] Order scoped to Tenant A
  ✅ [PASS] Order scoped to customer phone
  ✅ [PASS] Order total_amount matches subtotal (540.00)
  ✅ [PASS] Order currency is INR
  ✅ [PASS] Order type is DELIVERY
  ✅ [PASS] Order reference matches RP- prefix
  ✅ [PASS] Action type is ORDER_CONFIRMED
  ✅ [PASS] Conversation session reset to IDLE after order confirmation
  ✅ [PASS] Session records lastOrderReference
  ✅ [PASS] Replay confirmation returns success
  ✅ [PASS] Response marks isDuplicate = true
  ✅ [PASS] Returns same order reference on replay
  ✅ [PASS] Exactly 1 row exists in orders table for confirmation_token (Zero Duplicates)

--- TEST GROUP 4: Customer Order Cancellation (ST4-14) ---
  ✅ [PASS] Cancellation returns success
  ✅ [PASS] Action type is ORDER_CANCELLED
  ✅ [PASS] Action indicates nextStep IDLE
  ✅ [PASS] Session current_step reset to IDLE in database
  ✅ [PASS] Session state records cancelledAt timestamp
  ✅ [PASS] Zero rows created in orders table on cancellation

--- TEST GROUP 5: Order Reference Collision Resilience ---
  ✅ [PASS] Order reference has 3 dash-separated parts
  ✅ [PASS] Prefix is RP
  ✅ [PASS] Date part has 6 characters (YYMMDD)
  ✅ [PASS] Suffix has 4 characters
  ✅ [PASS] createOrderWithReferenceRetry assigns unique reference

--- TEST GROUP 6: Multi-Tenant & Cross-Customer Isolation ---
  ✅ [PASS] Cross-tenant confirmation rejected
  ✅ [PASS] Zero orders created at Tenant B for Tenant A token

--- TEST GROUP 7: Webhook Pipeline Integration (HTTP POST) ---
  ✅ [PASS] HTTP POST confirm button returns HTTP 200
  ✅ [PASS] Confirm webhookEvent marked COMPLETED in database
  ✅ [PASS] Order record created via webhook HTTP POST pipeline
  ✅ [PASS] Order status is PENDING_RESTAURANT_CONFIRMATION via webhook

============================================================
   STAGE 4.4 TEST RESULTS: 58 PASSED, 0 FAILED
============================================================
```

---

## 6. Comprehensive Regression Suite Pass Rates

Across all stages implemented in RESTOPRO to date:

| Test Suite | Package Command | Scope | Assertions Passed | Status |
| :--- | :--- | :--- | :---: | :---: |
| Stage 1 & 1.5 Webhook Audit | `npm run test:webhook` | HMAC SHA-256 verification, Meta challenge, payload parser, secret redaction | **86 / 86** | PASSED |
| Stage 2 Multi-Tenant DB | `npm run test:stage2` | Tenant isolation, composite foreign keys, tenant query resolution | **59 / 59** | PASSED |
| Stage 4.0 Database Prerequisites | `npm run test:stage4:migration` | `orders.confirmation_token`, worker leases, `outbox_messages` | **30 / 30** | PASSED |
| Stage 4.1 Cart Processing | `npm run test:stage4:cart` | Decimal-safe integer-cents arithmetic, cart replacement, token regeneration | **88 / 88** | PASSED |
| Stage 4.2 Conversation State Engine | `npm run test:stage4:conversation` | Deterministic FSM, whitelist rejection, 2-reminder cap, silent fallback | **52 / 52** | PASSED |
| Stage 4.3 Address Collection & Consent | `npm run test:stage4:address` | Scoped saved address lookup, manual text validation, location pin pipeline | **116 / 116** | PASSED |
| Stage 4.4 Fulfilment & Order Review | `npm run test:stage4:fulfilment` | Delivery vs Takeaway, order summary, confirmation token idempotency, cancel | **58 / 58** | PASSED |
| Graceful Shutdown Child Process | `npm run test:shutdown` | Real SIGTERM signal handler, in-flight drain, Prisma pool disconnect | **6 / 6** | PASSED |
| **Total Active Verified Assertions** | | | **495 / 495** | **100% HEALTHY** |

---

## 7. Modified Files & Artifacts

- **Created Files:**
  - [`src/services/order.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/order.service.js) — Order summary builder, collision-resistant reference generator, idempotent confirmation handler, and cancellation service.
  - [`test/stage4-fulfilment-review-test.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/test/stage4-fulfilment-review-test.js) — Dedicated 58-assertion test suite.
  - [`docs/stage-4/STAGE-4.4-FULFILMENT-AND-ORDER-REVIEW-RESULTS.md`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/stage-4/STAGE-4.4-FULFILMENT-AND-ORDER-REVIEW-RESULTS.md) — Implementation and audit report.
- **Modified Files:**
  - [`src/services/conversation.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/conversation.service.js) — Integrated `AWAITING_ORDER_TYPE` fulfilment selection and `AWAITING_CONFIRMATION` review, confirmation, cancellation, and Change Address token invalidation.
  - [`package.json`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/package.json) — Registered `"test:stage4:fulfilment"` script.
  - [`docs/07-IMPLEMENTATION-CHECKLIST.md`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/07-IMPLEMENTATION-CHECKLIST.md) — Marked `ST4-11`, `ST4-12`, `ST4-13`, and `ST4-14` complete (`[x]`).
- **Database Migrations:** None required.
- **Known Limitations:**
  - Delivery fees are not calculated in this phase (fixed at ₹0.00 / subtotal = total); fee calculation rules can be attached during future enhancements.
  - Pickup instructions rely on configured `restaurant.name`; arbitrary custom pickup instructions are deferred to restaurant configuration.

---

*Stage 4.4 implementation is complete. Execution stops at the Stage 4 boundary. Stage 5 (Owner Notification & Decision Processing) has not been started.*

