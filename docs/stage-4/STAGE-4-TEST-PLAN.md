# RESTOPRO — Stage 4: Comprehensive Test Strategy & Test Plan

**Document Version:** 2.3.0  
**Status:** Approved for Implementation Planning / Pre-Code Gate  
**Scope:** Automated Verification of Stage 4.1 through 4.5  

---

## 1. Test Strategy Overview

The Stage 4 test suite validates the customer ordering conversation engine end-to-end, testing business logic, data sanitization, state machine determinism, multi-tenant boundaries, and edge cases.

To ensure zero dependencies on external Meta network connectivity during CI/automated testing, `src/services/whatsapp.service.js` supports a **mock dispatcher mode** (capturing outbound payloads in an in-memory queue for assertions), while receiving verified real-world incoming payloads from `docs/test-payloads/`.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   STAGE 4 AUTOMATED TEST MATRIX                        │
├──────────────────────────┬──────────────────────┬──────────────────────┤
│ Test Suite File          │ Target Phase         │ Planned Assertions   │
├──────────────────────────┼──────────────────────┼──────────────────────┤
│ stage4-cart-test.js      │ Stage 4.1 (Cart)     │ 25 Assertions        │
│ stage4-conversation.test │ Stage 4.2 & 4.4      │ 30 Assertions        │
│ stage4-address-test.js   │ Stage 4.3 (Address)  │ 20 Assertions        │
│ stage4-order-engine.test │ Stage 4.5 & Outbox   │ 35 Assertions        │
│ stage4-recovery-test.js  │ Lease & Outbox Queue │ 35 Assertions        │
├──────────────────────────┴──────────────────────┴──────────────────────┤
│ Total Planned Stage 4 Assertions:               │ 145 Assertions       │
└─────────────────────────────────────────────────┴──────────────────────┘
```

---

## 2. Test Case Inventory

### 2.1 Stage 4.1 — Cart & Payload Processing (`test/stage4-cart-test.js`)

| Test ID | Test Scenario | Input Data | Expected Behavior |
| :--- | :--- | :--- | :--- |
| **TC-401** | Valid single-item cart | 1 $\times$ Biryani @ ₹250 | Subtotal = ₹250.00, items count = 1, currency = INR. |
| **TC-402** | Valid multi-item cart | 2 $\times$ Biryani @ ₹240 + 1 $\times$ Coke @ ₹60 | Subtotal = ₹540.00, line totals computed accurately. |
| **TC-403** | Empty items array | `product_items: []` | Returns validation error; prompts customer to add items; no order state created. |
| **TC-404** | Invalid quantity ($q = 0$ or negative) | `quantity: -3` | **Strict Rejection:** Never silently coerced to 1. Cart is rejected; customer receives recovery prompt with `[View Catalogue]`. |
| **TC-405** | Non-numeric or negative unit price | `item_price: -50` / `"free"` | **Strict Rejection:** Never silently coerced to 0. Cart is rejected; customer receives recovery prompt. |
| **TC-406** | Currency mismatch | Item 1 INR, Item 2 USD | **Strict Rejection:** Flagged `currencyMismatch: true`; cart rejected with currency alert. |
| **TC-407** | Customer note preservation | `order.text: "Extra onions"` | Stored in session cart snapshot without truncation or injection. |
| **TC-408** | Duplicate cart webhook | Re-sending identical `wamid` | Safely dropped via `webhook_events` deduplication; returns HTTP 200 without recalculating or creating duplicate sessions. |

### 2.2 Stage 4.2 — Conversation State Machine (`test/stage4-conversation-test.js`)

| Test ID | Test Scenario | Precondition | Input Event | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **TC-409** | Initial greeting | No active session | Text: "Hi" | Creates session with `current_step: AWAITING_CART`; dispatches Welcome + Catalog prompt. |
| **TC-410** | Session state recovery | Active session in DB | Server process restarts | Resumed session reads previous `state` JSONB; does not restart from beginning. |
| **TC-411** | Inactivity session expiry | `expires_at` in the past | Customer sends "Hi" | Expired session is reset to `IDLE` then transitions to `AWAITING_CART` with clean state. |
| **TC-412** | Unexpected text during cart wait | `current_step: AWAITING_CART` | Text: "Can I get pasta?" | Courteous fallback: *"Please use our menu catalogue below to place your order."* State remains `AWAITING_CART`. |
| **TC-413** | Multiple concurrent greetings | No active session | 3 simultaneous "Hi" requests | Exactly 1 session created in `conversation_sessions` via DB upsert. |
| **TC-414** | Customer ordering at Tenant A & B | Shared customer phone | Simulates orders at Tenant A & B simultaneously | Two independent rows in `conversation_sessions`; zero state leakage. |

### 2.3 Stage 4.3 — Address Collection & Consent (`test/stage4-address-test.js`)

| Test ID | Test Scenario | Precondition | Input Data | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **TC-415** | Saved address detected | Customer has row in `saved_addresses` | Cart submitted | Prompt offers `[Use Saved Address: Flat 302...]` and `[Enter New Address]`. |
| **TC-416** | Customer selects saved address | State: `AWAITING_ADDRESS_CHOICE` | Button: `BTN_USE_SAVED_ADDRESS` | Address loaded into `selectedAddress`; transitions to `AWAITING_ORDER_TYPE`. |
| **TC-417** | Customer opts for new address | State: `AWAITING_ADDRESS_CHOICE` | Button: `BTN_ENTER_NEW_ADDRESS` | Transitions to `AWAITING_ADDRESS_INPUT`; prompts for text or GPS pin. |
| **TC-418** | Valid text address input | State: `AWAITING_ADDRESS_INPUT` | Text: "Flat 101, Lake View, Powai, Mumbai" | Validated ($\ge 10$ chars); transitions to `AWAITING_SAVE_CONSENT`. |
| **TC-419** | Text address too short | State: `AWAITING_ADDRESS_INPUT` | Text: "Mumbai" | Rejected ($< 10$ chars); courteous prompt asking for detailed address. State remains `AWAITING_ADDRESS_INPUT`. |
| **TC-420** | WhatsApp GPS location pin | State: `AWAITING_ADDRESS_INPUT` | Location: `lat: 19.12, lon: 72.84, address: "..."` | Coordinates parsed into decimal; transitions to `AWAITING_SAVE_CONSENT`. |
| **TC-421** | Valid equator/meridian zero coordinate | State: `AWAITING_ADDRESS_INPUT` | Location: `lat: 0.0, lon: 0.0` | `safeParseCoordinate()` preserves `0.0` without nullifying. |
| **TC-422** | Address saving consent: YES | State: `AWAITING_SAVE_CONSENT` | Button: `BTN_CONSENT_YES` | Row inserted into `saved_addresses` under `(restaurant_id, customer_phone)`. Transitions to `AWAITING_ORDER_TYPE`. |
| **TC-423** | Address saving consent: NO | State: `AWAITING_SAVE_CONSENT` | Button: `BTN_CONSENT_NO` | No row inserted into `saved_addresses`. Address used for current session only. Transitions to `AWAITING_ORDER_TYPE`. |
| **TC-424** | Cross-tenant address isolation | Customer has saved address at Restaurant A | Orders at Restaurant B | Restaurant B does NOT offer Restaurant A's saved address (query returns empty). |

### 2.4 Stage 4.4 — Delivery vs. Takeaway (`test/stage4-conversation-test.js`)

| Test ID | Test Scenario | Precondition | Input Data | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **TC-425** | Delivery selected with valid address | State: `AWAITING_ORDER_TYPE`, address present | Button: `BTN_ORDER_DELIVERY` | Sets `orderType = DELIVERY`; transitions to `AWAITING_CONFIRMATION`. |
| **TC-426** | Takeaway selected without address | State: `AWAITING_ORDER_TYPE`, no address | Button: `BTN_ORDER_TAKEAWAY` | Sets `orderType = TAKEAWAY`; transitions to `AWAITING_CONFIRMATION` without requiring address. |
| **TC-427** | Invalid selection input | State: `AWAITING_ORDER_TYPE` | Text: "maybe delivery" | Re-prompts with interactive buttons: `[🚚 Delivery]` and `[🥡 Takeaway]`. |

### 2.5 Stage 4.5 — Order Review, Stable Idempotency & Collision Defense (`test/stage4-order-engine-test.js`)

| Test ID | Test Scenario | Precondition | Input Data | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **TC-428** | Stable Confirmation Token Generation | State transitions to `AWAITING_CONFIRMATION` | Fulfillment selected | `confirmationToken` (`conf_<uuid>`) generated in session state; embedded into button ID `BTN_CONFIRM_ORDER:<token>`. |
| **TC-429** | Session Row-Locking & Confirmation | State: `AWAITING_CONFIRMATION` | Button: `BTN_CONFIRM_ORDER:<token>` | Executes `SELECT FOR UPDATE` on session row; inserts order with `confirmation_token`; resets session to `IDLE`. |
| **TC-430** | Duplicate confirmation retry (Safe Return) | Order already created with `confirmation_token` | Re-transmits `BTN_CONFIRM_ORDER:<token>` | **Idempotent Return:** Detects existing order via `confirmation_token`; returns existing order receipt; zero duplicate rows in `orders`. |
| **TC-431** | Concurrent confirmation storm | State: `AWAITING_CONFIRMATION` | 5 simultaneous confirm requests (`Promise.all`) | Row-locking serializes execution: exactly 1 order row created in `orders`; all 5 return confirmation receipt. |
| **TC-432** | Targeted order reference collision retry | Collision injected on `order_reference` | Candidate collision | Specifically catches `P2002` on `order_reference`, executes retry loop, successfully generates fresh reference. |
| **TC-433** | Unrelated P2002 non-retry guard | Injects foreign key / composite key collision | Candidate error | Verifies generator does NOT catch unrelated `P2002` errors; re-throws immediately. |
| **TC-434** | High-entropy 6-char fallback | Injects 3 consecutive collisions | Attempt 4 | Successfully falls back to 6-character hex suffix (`RP-YYMMDD-XXXXXX`). |
| **TC-435** | Customer cancellation | State: `AWAITING_CONFIRMATION` | Button: `BTN_CANCEL_ORDER` | Resets session to `IDLE`; sends cancellation receipt; zero rows inserted into `orders`. |

### 2.6 Distributed Webhook Recovery Leases & Outbox Reliability (`test/stage4-recovery-test.js`)

| Test ID | Test Scenario | Precondition | Input Data | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **TC-436** | Atomic Claim with Fencing Token | Event with status `RECEIVED` > 15s | Worker executes claim batch | Atomic update sets `claimed_by`, generates `lease_token`, sets `lease_expires_at = NOW() + 2 min`, increments `attempt_count`. |
| **TC-437** | Stale Lease Auto-Recovery | Event in `PROCESSING` with `lease_expires_at < NOW()` | Secondary worker executes claim | Stale lease claimed by secondary worker; new `lease_token` generated; executed to completion. |
| **TC-438** | CAS Fencing Token Ownership Validation | Worker A finishes task after lease expired | CAS update with stale `lease_token` | Update returns 0 rows; Worker A detects lease loss and cleanly aborts commit without corrupting state. |
| **TC-439** | Heartbeat Renewal Keeps Lease Active | Long-running task on Worker A | Heartbeat every 30s | `lease_expires_at` extended; Worker B cannot claim the event while Worker A is alive. |
| **TC-440** | Concurrent Worker Claim Race | 5 workers execute claim query simultaneously | 10 pending events in DB | `SKIP LOCKED` ensures each event claimed by exactly one worker; zero lock contention or duplicate claims. |
| **TC-441** | Normalized Replay: Text Message | Text event in `webhook_events` | State machine replay | Parses text under v1.0.0; executes greeting or address input cleanly. |
| **TC-442** | Normalized Replay: Native Catalog Cart | Cart event in `webhook_events` | State machine replay | Reconstructs full line items, subtotal, customer notes without data loss. |
| **TC-443** | Normalized Replay: Interactive Button | Button reply event in `webhook_events` | State machine replay | Resolves button action (`BTN_CONFIRM_ORDER`, `BTN_DELIVERY`) accurately. |
| **TC-444** | Normalized Replay: Location Pin | Location pin event in `webhook_events` | State machine replay | Reconstructs latitude, longitude, and address strings accurately. |
| **TC-445** | Normalized Replay: Delivery Status Receipt | Status receipt in `webhook_events` | Outbox reconciler | Updates outbox message to `DELIVERED` or `READ`. |
| **TC-446** | Multi-Message Webhook Decomposition | Payload with 3 messages & 2 statuses | Webhook ingestion | Decomposes into exactly 5 distinct `webhook_events` rows with unique `event_key`s sorted by timestamp. |
| **TC-447** | Outbound Timeout to UNCERTAIN_DISPATCH | Mock HTTP POST triggers `ETIMEDOUT` | Outbox dispatcher | Outbox message transitions to `UNCERTAIN_DISPATCH`; no immediate blind retry. |
| **TC-448** | Outbox Status Receipt Reconciliation | Outbox message in `UNCERTAIN_DISPATCH` | Incoming Meta status webhook with matching `wamid` | Message transitions to `DELIVERED`; links `meta_message_id`. |
| **TC-449** | Customer Activity Duplicate Suppression | Outbox message in `UNCERTAIN_DISPATCH` | Customer sends new message before retry timer | Outbox retry is cancelled; status updated to `SUPPRESSED_BY_CUSTOMER_ACTIVITY`. |
| **TC-450** | Bounded Fallback Retry on Receipt | Outbox receipt message in `UNCERTAIN_DISPATCH` for 60s | Reconciliation timer expires | Dispatches exactly 1 fallback retry (`attempt_count = 2`); transitions to `ACCEPTED` or `FAILED`. |
| **TC-451** | Automated 30-Day PII Purge Routine | Webhook events older than 30 days | Purge routine execution | Safely deletes events $> 30$ days; preserves newer events. |

---

## 3. Mocking & Test Execution Architecture

To run these tests autonomously without requiring external Meta API credentials or public tunnels:
1. **Mock Outbound Client (`MockWhatsAppService`):**
   * Implements identical methods as `WhatsAppService` (`sendTextMessage`, `sendCatalogPrompt`, `sendInteractiveButtons`).
   * Pushes dispatched messages to an in-memory array `sentMessages[]` for assertion verification.
   * Supports simulated timeouts (`ETIMEDOUT`), HTTP 504 errors, and HTTP 400 rejections to test outbox recovery deterministically.
2. **Deterministic Time / Clock Simulation:**
   * Test runner advances clock timestamps to test 2-hour session expiration, 2-minute lease TTLs, 30-second heartbeats, and 30-day PII purging deterministically.
3. **Database Isolation:**
   * All tests run against the local development database `restopro_dev` (or isolated test database), cleaning up created test rows in `afterEach` hooks.
