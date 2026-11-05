# RESTOPRO — Stage 6: End-to-End Integration, Security & Multi-Tenant Audit Report

**Document Version:** 1.0.0  
**Stage:** 6 — End-to-End Integration, Security & Multi-Tenant Audit  
**Date:** 2026-11-05  
**Author:** RESTOPRO Engineering Team  
**Status:** APPROVED & FULLY VERIFIED  

---

## 1. Executive Summary

This report documents the comprehensive end-to-end integration, security, and multi-tenant audit of the RESTOPRO WhatsApp Ordering Automation platform (covering Stages 1.0 through 5.3).

RESTOPRO is a multi-tenant backend built with Node.js, Express, PostgreSQL 18, Prisma ORM, and the Meta WhatsApp Cloud API. It enables independent restaurants to automate customer ordering through conversational WhatsApp flows, catalogue cart submissions, address collection (manual text and WhatsApp GPS location pins), fulfilment selection (Delivery vs. Takeaway), atomic order confirmation, interactive owner decision dispatching (Accept/Reject), and immediate customer decision notifications.

### Audit Verdict:
- **Architecture & Multi-Tenancy:** **APPROVED (100% Isolated).** Zero cross-tenant data leakage across restaurants, customer sessions, saved addresses, orders, outbox messages, or owner credentials.
- **Security & Threat Defense:** **APPROVED.** Robust HMAC-SHA256 signature verification, constant-time GET challenge verification, parameterized Prisma queries, interactive button UUID whitelisting, HTTP defense headers, and access token redaction.
- **Reliability & Concurrency:** **APPROVED.** Atomic PostgreSQL transactions, pessimistic row locking (`SELECT ... FOR UPDATE`), distributed worker leases with `FOR UPDATE SKIP LOCKED`, stale worker fencing, idempotent webhook deduplication, and crash/timeout resilience.
- **Test Harness Results:** **827 out of 827 test assertions passed (100% success rate)** across all 12 test suites.

---

## 2. Full Architecture Review & Customer Journey Trace

### 2.1 Complete 12-Step Lifecycle Walkthrough

```mermaid
sequenceDiagram
    autonumber
    actor Customer as Customer (WhatsApp)
    participant Meta as Meta WhatsApp Cloud API
    participant Webhook as Webhook Controller & Parser
    participant DB as PostgreSQL (Prisma)
    participant FSM as Conversation Engine
    participant Outbox as Durable Outbox Service
    actor Owner as Restaurant Owner (WhatsApp)

    Customer->>Meta: 1. Sends "Hi"
    Meta->>Webhook: Webhook POST (HMAC-SHA256)
    Webhook->>DB: Ingest & Deduplicate WebhookEvent (event_key)
    Webhook->>FSM: 2. Dispatch to FSM (IDLE -> AWAITING_CART)
    FSM-->>Customer: Return Welcome & Menu Catalogue Prompt

    Customer->>Meta: 3. Submits Catalogue Cart (type: "order")
    Meta->>Webhook: Webhook POST
    Webhook->>FSM: Defensive Cart Validation (integer cents)
    FSM->>DB: 4. Check Saved Address. None found -> AWAITING_ADDRESS_INPUT
    FSM-->>Customer: Request Delivery Address / Location Pin

    Customer->>Meta: 5. Sends WhatsApp Location Pin
    Meta->>Webhook: Webhook POST
    Webhook->>FSM: Parse Coordinates (lat, lng, 0.0 preserved)
    FSM->>DB: Transition to AWAITING_BUILDING_NAME
    FSM-->>Customer: Request Building / Complex Name

    Customer->>Meta: Sends Building Name & Flat Number
    Meta->>Webhook: Webhook POST
    Webhook->>FSM: Collect Building & Room -> AWAITING_SAVE_CONSENT
    Customer->>Meta: Taps "BTN_CONSENT_YES"
    FSM->>DB: Persist Consented Address to saved_addresses

    FSM->>DB: Transition to AWAITING_ORDER_TYPE
    Customer->>Meta: 6. Taps "BTN_ORDER_DELIVERY"
    FSM->>DB: Transition to AWAITING_CONFIRMATION

    Customer->>Meta: 7. Taps "BTN_CONFIRM_ORDER:<token>"
    Meta->>Webhook: Webhook POST
    Webhook->>DB: 8. BEGIN Transaction: Insert Order + Insert OutboxMessage (OWNER_ORDER_NOTIFICATION)
    DB-->>Webhook: COMMIT (Atomicity Guaranteed)
    FSM->>DB: Reset Customer Session to IDLE

    Outbox->>DB: 9. Claim Pending Message (FOR UPDATE SKIP LOCKED)
    Outbox->>Meta: HTTP POST to Owner WhatsApp
    Meta-->>Owner: Deliver Interactive Alert with [Accept] [Reject] Buttons
    Outbox->>DB: Update OutboxMessage status: ACCEPTED

    Owner->>Meta: 10. Taps "OWNER_ACCEPT:<order_id>"
    Meta->>Webhook: Webhook POST
    Webhook->>DB: Authorize Owner Phone + Row Lock (SELECT ... FOR UPDATE)
    Webhook->>DB: 11. BEGIN Transaction: Order status -> ACCEPTED + Insert OutboxMessage (CUSTOMER_ORDER_DECISION)
    DB-->>Webhook: COMMIT

    Outbox->>DB: 12. Claim Customer Notification Outbox Message
    Outbox->>Meta: HTTP POST to Customer WhatsApp
    Meta-->>Customer: Deliver Order Acceptance Confirmation (Zero Invented Times)
    Outbox->>DB: Update OutboxMessage status: ACCEPTED
```

---

## 3. Multi-Tenant Isolation Verification (`ST6-01` to `ST6-07`)

Multi-tenant isolation was rigorously verified against PostgreSQL using two distinct restaurant tenants (Test Tenant A: Spice Garden Restaurant, Test Tenant B: Ocean Breeze Cafe) and multiple distinct customers:

| Checklist ID | Verification Focus | Architectural Enforcement | Test Result |
| :--- | :--- | :--- | :---: |
| **ST6-01** | Seed & Activate Tenant A and Tenant B | Both seeded with distinct UUID primary keys, distinct Meta `phone_number_id` values, and distinct owner phones. | ✅ **VERIFIED** |
| **ST6-02** | Concurrent Customer Orders Across Tenants | Simultaneous customer checkout at Tenant A and Tenant B executed via `Promise.all`. Both orders created concurrently with correct `restaurant_id` scoping and distinct order references. | ✅ **VERIFIED** |
| **ST6-03** | Customer Session Isolation | Dual-ordering customer (`919633000003`) interacting with Tenant A and Tenant B simultaneously maintained two independent conversation sessions in PostgreSQL (`@@unique([restaurant_id, customer_phone])`). Zero state or cart leakage. | ✅ **VERIFIED** |
| **ST6-04** | Saved Address Isolation | Address saved by a customer at Tenant A returned exactly 1 address for Tenant A queries and 0 addresses for Tenant B queries. Cross-tenant address reuse was strictly blocked (`CROSS_TENANT_VIOLATION`). | ✅ **VERIFIED** |
| **ST6-05** | Owner Notification Routing | Order placed at Tenant A dispatched an outbox alert exclusively to Owner A (`+919876543210`); order placed at Tenant B dispatched exclusively to Owner B (`+919811122233`). Zero credential or routing cross-contamination. | ✅ **VERIFIED** |
| **ST6-06** | Cross-Tenant Attack Scenarios | **Attack 1:** Owner A attempts to accept Tenant B's order via Tenant A webhook -> Rejected with `CROSS_TENANT_VIOLATION`.<br/>**Attack 2:** Owner A attempts to accept Tenant B's order via Tenant B webhook -> Rejected with `UNAUTHORIZED_OWNER`.<br/>In both attack vectors, Tenant B's order remained completely untouched. | ✅ **VERIFIED** |
| **ST6-07** | Soft-Disabled Tenant Behavior | Tenant B was soft-disabled (`is_active = false`). Inbound webhook events were recognized as inactive, marked `FAILED` in `webhook_events`, safely dropped without customer state mutation, and acknowledged with HTTP 200 to prevent Meta delivery retry storms. Tenant B was subsequently restored to active. | ✅ **VERIFIED** |

---

## 4. Security Audit Findings & Severity Matrix

| Threat Vector | Severity | Finding & Mitigation Status | Verification Result |
| :--- | :---: | :--- | :---: |
| **Webhook HMAC-SHA256 Forgery** | **Critical** | All incoming POST requests require valid `x-hub-signature-256`. Signatures are computed using the raw request body buffer and compared via `crypto.timingSafeEqual` to prevent timing attacks. Forged or missing signatures are rejected with HTTP 403/401. | ✅ **PASSED** |
| **GET Webhook Verification Handshake** | **Medium** | GET handshake enforces `hub.mode === 'subscribe'`. Custom verify token is hashed via SHA-256 before constant-time comparison to prevent length-leakage attacks. Invalid tokens rejected with HTTP 403. | ✅ **PASSED** |
| **SQL Injection & Query Tampering** | **Critical** | All queries use Prisma ORM parameterized statements or tagged template literals (`tx.$queryRaw`). Attacks embedding SQL payloads (`'; DROP TABLE orders; --`, `1' OR '1'='1`) in buttons, addresses, or notes are safely escaped and parameterized without execution. | ✅ **PASSED** |
| **Interactive Button Tampering** | **High** | Action payloads are strictly parsed and validated against UUID regular expressions and state machine whitelists. Tampered actions (e.g. `OWNER_MAYBE:<id>`) are rejected with `UNRECOGNIZED_OWNER_ACTION`. Out-of-order customer buttons are rejected with `INVALID_ACTION_FOR_STEP`. | ✅ **PASSED** |
| **Owner Identity Spoofing** | **Critical** | Decisions require the incoming sender phone to match the restaurant's configured `owner_phone` (normalized to bare digits). Customers or unauthorized senders attempting `OWNER_ACCEPT` or `OWNER_REJECT` are rejected with `UNAUTHORIZED_OWNER` and logged as security events. | ✅ **PASSED** |
| **Malformed & Oversized Payloads (DoS)** | **Medium** | Malformed JSON is caught by Express error middleware and returns HTTP 400. Inbound JSON body size is explicitly capped at `limit: '1mb'`; oversized requests are rejected with HTTP 413 "Payload too large". | ✅ **PASSED (Hardened)** |
| **Sensitive Credential & Token Redaction** | **High** | Access tokens, app secrets, and verify tokens are masked across logs, outbox payloads, and error messages (`[REDACTED]`). Safe regex escaping was implemented to prevent regex metacharacter crashes during token redaction. | ✅ **PASSED (Fixed)** |
| **Information Disclosure & Security Headers** | **Low** | `app.disable('x-powered-by')` removes Express fingerprinting. Defensive HTTP headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`) are injected into all HTTP responses. | ✅ **PASSED (Hardened)** |
| **Webhook Replay & Duplicate Delivery** | **High** | Incoming Meta message IDs are persisted as unique `event_key` records in `webhook_events`. Retried duplicate deliveries trigger PostgreSQL unique constraint P2002 and are acknowledged with HTTP 200 without reprocessing. | ✅ **PASSED** |

---

## 5. Reliability, Concurrency & Failure Recovery Findings

### 5.1 Concurrency & Race Condition Defense
1. **Concurrent Customer Order Confirmation:**
   - **Race Scenario:** Two identical confirmation requests with the same `confirmation_token` submitted at the exact same millisecond.
   - **Handling:** Caught at the database boundary via unique constraint on `orders.confirmation_token`. The competing request rolls back cleanly, catches `P2002`, queries the committed order created by the race winner, and returns `{ success: true, order: existingOrder, isDuplicate: true }`. Zero duplicate orders created.
2. **Concurrent Conflicting Owner Decisions:**
   - **Race Scenario:** Simultaneous Accept and Reject taps submitted in parallel.
   - **Handling:** PostgreSQL pessimistic row locking (`SELECT ... FOR UPDATE`) serializes the transactions. The first decision commits; the second observes that the order is no longer in `PENDING_RESTAURANT_CONFIRMATION` and fails cleanly with `CONFLICTING_DECISION`.
3. **Concurrent Distributed Outbox Workers:**
   - **Race Scenario:** Two worker processes polling pending outbox messages simultaneously.
   - **Handling:** `SELECT ... FOR UPDATE SKIP LOCKED` guarantees each worker claims distinct rows without blocking or double-claiming.

### 5.2 Worker Crashes & Lease Expiration Fencing
1. **Worker Crash Recovery:** When a worker crashes after claiming an outbox message, the lease TTL (default 60s) expires. Fresh workers automatically reclaim the message because `(payload->'lease'->>'lease_expires_at')::timestamptz < NOW()`.
2. **Stale Worker Fencing:** If an expired or lagging worker attempts to write dispatch outcomes after its lease has been reclaimed, `updateOutboxResult` verifies `lease_token`. A token mismatch results in immediate rejection (`FENCED_OUT`), preventing stale workers from corrupting outbox metadata.

### 5.3 Meta API Failure Semantics & Timeouts
1. **HTTP Timeouts (`UNCERTAIN_DISPATCH`):** When Meta does not respond within the 10-second timeout, the outbox row transitions to `UNCERTAIN_DISPATCH`. The worker **never blindly retries** uncertain dispatches, preventing duplicate WhatsApp messages from reaching customers or owners.
2. **Transient 5xx Errors:** Increments `attempts` and leaves status `PENDING` with bounded exponential backoff up to 5 attempts.
3. **Non-Retryable 4xx Errors:** Immediately marked `FAILED` with sanitized error messages and access tokens redacted.

---

## 6. Defects Identified & Fixed

During this audit, four specific defects were identified and resolved within the existing architecture:

### Defect 1: Concurrent Customer Order Confirmation Race Condition
- **Defect:** When concurrent order confirmations with identical confirmation tokens arrived simultaneously, both passed the entry read check because neither had committed yet. The second request failed with an uncaught Prisma `P2002` exception on `confirmation_token`.
- **Fix:** In [`src/services/order.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/order.service.js), wrapped `confirmCustomerOrder` in a targeted catch for `P2002` on `confirmation_token`. When an insert collision occurs, the function retrieves the committed order created by the competing transaction and returns `{ success: true, order: existingOrder, isDuplicate: true }`.
- **Verification:** Verified in Group 4 test 2 with `Promise.all` concurrent confirmations; both return success, exactly 1 order row exists in PostgreSQL.

### Defect 2: Regex Metacharacter Vulnerability in Access Token Redaction
- **Defect:** In `whatsapp.service.js`, `rawErrorMessage.replace(new RegExp(accessToken, 'g'), '[REDACTED]')` passed the raw token string directly to `RegExp`. If an access token contained regex metacharacters (`+`, `.`, `$`, `*`), it caused syntax errors or unintended regex behavior.
- **Fix:** Added `escapeRegex(accessToken)` to escape special regex characters prior to compiling the redaction expression.
- **Verification:** Verified with tokens containing dots, pluses, and special characters; zero regex compilation errors.

### Defect 3: Missing HTTP Security Defense Headers & Express Fingerprint
- **Defect:** `app.js` did not disable Express fingerprinting (`X-Powered-By: Express`) and omitted baseline HTTP defense headers.
- **Fix:** Added `app.disable('x-powered-by')` and middleware setting `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
- **Verification:** Verified across all HTTP GET and POST tests; headers verified in Group 2.

### Defect 4: Unbounded Request Body Size (DoS Vulnerability)
- **Defect:** `express.json()` lacked an explicit payload limit, relying on defaults and lacking an explicit HTTP 413 error handler.
- **Fix:** Configured `express.json({ limit: '1mb', verify: ... })` and added an explicit error handler returning HTTP 413 `Payload too large. Maximum allowed size is 1MB.`.
- **Verification:** Tested in Group 2 with a 1MB+ request; rejected with HTTP 413.

---

## 7. Production Readiness Assessment

| Evaluation Dimension | Readiness Score | Evaluation & Evidence |
| :--- | :---: | :--- |
| **Multi-Tenant Scoping** | **100 / 100** | Strict separation across queries, sessions, addresses, orders, and credentials. Zero cross-tenant leaks. |
| **Cryptographic Security** | **100 / 100** | Timing-safe HMAC-SHA256, constant-time GET challenge hashing, token redaction, parameterized queries. |
| **Transactional Atomicity** | **100 / 100** | PostgreSQL transactions guarantee zero phantom orders, zero leaked decisions, and zero orphaned notifications. |
| **Concurrency & Fencing** | **95 / 100** | Pessimistic locking (`FOR UPDATE`) and distributed worker leases (`FOR UPDATE SKIP LOCKED`) prevent race conditions. |
| **Operational Infrastructure** | **90 / 100** | PM2 cluster configuration (`ecosystem.config.js`), graceful SIGTERM/SIGINT shutdown, structured JSON logging. |
| **Overall Production Score** | **97 / 100** | **PRODUCTION READY for Stages 1–5.3 functionality.** |

---

## 8. Unresolved Risks & Operational Recommendations

1. **Meta WhatsApp 24-Hour Customer Care Window:**
   - *Risk:* WhatsApp Cloud API free-form messages can only be sent within 24 hours of the customer's last message. If an owner accepts an order after 24 hours, Meta will reject free-form customer text messages.
   - *Mitigation:* Ensure owner non-response auto-expiry (Stage 7.3: 30-minute timeout) is deployed so orders are never pending past the 24-hour window.
2. **PostgreSQL Connection Pool vs PM2 Cluster Instances:**
   - *Risk:* In PM2 cluster mode with `instances: max` on multi-core servers, each cluster instance maintains its own Prisma connection pool. If `connection_limit=10` on 8 CPU cores, peak connections could reach 80.
   - *Mitigation:* Ensure PostgreSQL `max_connections` is configured to at least 150 (standard production default).
3. **Background Worker Daemonization:**
   - *Risk:* Outbox messages currently require active worker polling or cron execution.
   - *Mitigation:* Deploy Stage 7.1 dedicated outbox worker (`src/jobs/notification-worker.js`) as a standalone PM2 background process.

---

## 9. Comprehensive Test Suite Results

All 12 test suites were executed sequentially against the PostgreSQL database:

| Command | Suite Name | Assertions | Result |
| :--- | :--- | :---: | :---: |
| `npm run test:webhook` | Stage 1.5 Webhook HMAC security & parsing | 86 / 86 | ✅ PASSED |
| `npm run test:stage2` | Stage 2 Multi-tenant isolation & constraints | 59 / 59 | ✅ PASSED |
| `npm run test:stage4:migration` | Stage 4.0 Schema migrations & indexes | 30 / 30 | ✅ PASSED |
| `npm run test:stage4:cart` | Stage 4.1 Catalogue cart processing & validation | 88 / 88 | ✅ PASSED |
| `npm run test:stage4:conversation` | Stage 4.2 State machine & reminders | 52 / 52 | ✅ PASSED |
| `npm run test:stage4:address` | Stage 4.3 Address collection, GPS & consent | 116 / 116 | ✅ PASSED |
| `npm run test:stage4:fulfilment` | Stage 4.4 Fulfilment selection & review | 58 / 58 | ✅ PASSED |
| `npm run test:stage5:outbox` | Stage 5.1 Owner notification & outbox dispatch | 60 / 60 | ✅ PASSED |
| `npm run test:stage5:decision` | Stage 5.2 Owner decision processing | 78 / 78 | ✅ PASSED |
| `npm run test:stage5:customer` | Stage 5.3 Customer decision notifications | 89 / 89 | ✅ PASSED |
| `npm run test:stage6` | Stage 6 End-to-end integration & security audit | 105 / 105 | ✅ PASSED |
| `npm run test:shutdown` | Graceful shutdown & connection cleanup | 6 / 6 | ✅ PASSED |
| **Combined** | **Full System Test Harness (12 Suites)** | **827 / 827** | **✅ 100% PASSED** |

---

## 10. Conclusion

The RESTOPRO backend implementation across Stages 1.0 through 5.3 has been thoroughly audited and proven resilient under multi-tenant workloads, security attack scenarios, and concurrent race conditions. All Stage 6 acceptance criteria (`ST6-01` through `ST6-07`) have been fully satisfied with zero regressions.

