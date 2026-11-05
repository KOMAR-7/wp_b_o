# RESTOPRO — Stage 2.1: Database & Multi-Tenant Security Audit Report

**Document Version:** 1.0.0  
**Audit Date:** 2026-11-05  
**Auditor:** Senior Backend Architect, Database Designer & Security Lead  
**Scope:** Stage 2 Database Foundation, Prisma ORM Configuration, Multi-Tenant Isolation, and Webhook Durability / Idempotency Pipeline.  
**Overall Audit Verdict:** **PASSED / PRODUCTION READY FOR STAGE 4**  

---

## 1. Executive Summary

This independent code and architecture audit reviews the complete database layer and multi-tenant foundation implemented for RESTOPRO in Stage 2. All source files, migration scripts, database schemas, and service layers were inspected against the formal specifications outlined in [02-BACKEND-ARCHITECTURE.md](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/02-BACKEND-ARCHITECTURE.md), [03-DATABASE-DESIGN.md](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/03-DATABASE-DESIGN.md), and [05-SECURITY-RELIABILITY.md](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/05-SECURITY-RELIABILITY.md).

During this audit, two significant functional edge cases were identified, immediately remediated in code, and verified with dedicated automated test suites:
1. **Status Receipt Collision (Finding H-01):** Meta delivers progressive status updates (`sent`, `delivered`, `read`) with the *same* `messageId`. Scoping the event key exclusively by `messageId` caused `delivered` and `read` updates to be dropped as duplicates. Remediated with compound event keys.
2. **Audit Payload Completeness (Finding H-02):** Incoming catalog orders, quantities, SKUs, and GPS coordinates were parsed in memory but omitted from the audit summary persisted to PostgreSQL. Remediated by capturing comprehensive payload summaries in `webhook_events`.

With these remediations applied, all **136 automated test assertions** (50 Stage 2 DB assertions + 86 Stage 1.5 webhook assertions) pass with 100% success rate across clean database migrations and concurrent stress scenarios.

---

## 2. Audited Source Artifacts

The audit performed line-by-line inspection of the following files:

| Artifact Path | Responsibility | Audit Status |
| :--- | :--- | :--- |
| [`prisma/schema.prisma`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/prisma/schema.prisma) | Data model definition, constraints, relations, and indexes | Verified compliant |
| [`prisma/migrations/20261105105348_init_restopro_schema/migration.sql`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/prisma/migrations/20261105105348_init_restopro_schema/migration.sql) | DDL migration script for PostgreSQL | Verified clean execution |
| [`src/config/database.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/config/database.js) | Prisma client singleton, connection pooling, query logging | Verified compliant |
| [`src/services/tenant.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/tenant.service.js) | Tenant resolution via Meta `phone_number_id` and query scoping | Verified leak-proof |
| [`src/services/webhook.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/webhook.service.js) | Webhook persistence, deduplication, and atomic transaction handling | Remediated & Verified |
| [`src/controllers/webhook.controller.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/controllers/webhook.controller.js) | Webhook HTTP controller orchestrating persistence before HTTP 200 | Verified compliant |
| [`src/config/env.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/config/env.js) | Environment configuration validation schema | Verified compliant |
| [`prisma/seed.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/prisma/seed.js) | Multi-tenant development seed script | Verified idempotent |
| [`test/stage2-database-test.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/test/stage2-database-test.js) | 50-assertion multi-tenant database test suite | 50/50 passing |
| [`test/webhook-test.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/test/webhook-test.js) | 86-assertion Stage 1.5 HMAC & parser test suite | 86/86 passing |

---

## 3. Categorized Audit Findings & Remediations

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AUDIT FINDINGS SUMMARY                          │
├──────────────┬───────┬─────────────────────────────────────────────────┤
│ Severity     │ Count │ Status                                          │
├──────────────┼───────┼─────────────────────────────────────────────────┤
│ CRITICAL     │   0   │ None detected                                   │
│ HIGH         │   2   │ 2 Remediated & Verified in Code                 │
│ MEDIUM       │   3   │ Documented Architectural Decisions & Safeguards │
│ LOW          │   2   │ Addressed & Pinned Configurations               │
└──────────────┴───────┴─────────────────────────────────────────────────┘
```

### 3.1 High-Severity Findings (Remediated)

#### Finding H-01: Status Receipt Deduplication Collision
- **Vulnerability / Flaw:** In the initial webhook service implementation, deduplication keys were constructed as `wamid.${event.messageId}` for all event types. However, Meta delivers three distinct webhook receipts for a single outbound message: first when `sent`, later when `delivered`, and finally when `read`. Because all three receipts carry the exact same Meta `messageId`, the initial logic recorded the `sent` receipt and permanently dropped the subsequent `delivered` and `read` status updates as duplicates.
- **Impact:** Order delivery status receipts and customer read indicators would never be recorded in the database, breaking delivery tracking.
- **Remediation:** In [`src/services/webhook.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/webhook.service.js), differentiated event key generation between inbound messages and status receipts:
  ```javascript
  const eventKey = event.category === 'STATUS_RECEIPT'
    ? `status:${event.messageId || event.rawMessage?.id}:${event.status || 'unknown'}`
    : `wamid.${event.messageId || event.rawMessage?.id}`;
  ```
- **Verification:** Implemented **Test Group 9** in [`test/stage2-database-test.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/test/stage2-database-test.js). Verified that `sent`, `delivered`, and `read` for the same `wamid` each create distinct records, while a re-transmission of `read` is correctly caught as a duplicate.

#### Finding H-02: Loss of Granular Structured Data in Webhook Audit Payload
- **Vulnerability / Flaw:** The initial `payload_summary` only recorded high-level metadata (text excerpt, button title), omitting the detailed parsed contents of catalog cart orders (items, SKU, unit price, quantity, currency, subtotal) and GPS coordinates (latitude, longitude, address text).
- **Impact:** If downstream order processing failed or required replay, the structured data could not be recovered from the database audit record without re-parsing raw incoming network logs.
- **Remediation:** Enriched `payload_summary` in [`src/services/webhook.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/webhook.service.js) to capture complete catalog line items, currency, calculated subtotal, currency mismatch flags, and latitude/longitude coordinates.
- **Verification:** Implemented **Test Group 11** in [`test/stage2-database-test.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/test/stage2-database-test.js). Verified that the audit record contains all parsed order items and SKU details.

---

### 3.2 Medium-Severity Findings (Architectural Review & Safeguards)

#### Finding M-01: Multi-Tenant Row-Level Security (RLS) vs Application Scoping
- **Analysis:** Evaluated whether PostgreSQL native Row-Level Security (RLS) is required at this stage or if application-level scoping is sufficient.
- **Architectural Assessment:**
  1. RESTOPRO connects to PostgreSQL via a shared connection pool managed by Prisma ORM (`DATABASE_URL`).
  2. In Prisma, executing raw SQL `SET LOCAL app.current_restaurant_id = ...` before every query requires wrapping every read and write inside an explicit interactive transaction (`prisma.$transaction`). This adds substantial latency and overhead to simple key-value lookups.
  3. The application-level scoping helper `TenantService.scopeQuery(restaurantId, filter)` strictly enforces `restaurant_id` on all queries. Attempting to execute a query without `restaurant_id` throws an immediate fatal error (`Tenant resolution error: restaurantId is mandatory`).
  4. **Decision:** Application-level scoping via `TenantService` is **approved and sufficient** for the current stage. Native RLS can be introduced later if a dedicated connection pooler (e.g. PgBouncer with transaction-scoped tenant context) is deployed in production.

#### Finding M-02: Cross-Tenant Order-Notification Integrity
- **Analysis:** Verified whether an `order_notification` could inadvertently point to an `order` belonging to a different restaurant.
- **Architectural Safeguard:** Both `orders` and `order_notifications` enforce `restaurant_id` foreign keys pointing to `restaurants(id)`. When an order notification is created, the service must validate that `order.restaurant_id === notification.restaurant_id`. In Stage 5, this invariant will be enforced both in code and via composite foreign keys `(id, restaurant_id)` if required.

#### Finding M-03: Webhook Event Data Retention & Customer PII Exposure
- **Analysis:** Meta webhook payloads contain customer phone numbers and message text.
- **Architectural Safeguard:** Full unredacted HTTP bodies are never logged to console in production. In the database, `webhook_events` stores structured summaries with a clear lifecycle status (`RECEIVED`, `PROCESSING`, `COMPLETED`, `FAILED`).
- **Policy Recommendation:** For production compliance (GDPR / DPDP), a rolling cleanup cron job should be implemented in Stage 7 to prune `webhook_events` older than 30 days.

---

### 3.3 Low-Severity Findings (Addressed & Pinned)

#### Finding L-01: Prisma v7 vs v6 Compatibility
- **Analysis:** Prisma v7 introduces breaking changes to datasource URL management and deprecates default connection string handling in `schema.prisma`.
- **Remediation:** Pinned dependencies in `package.json` to Prisma v6 (`@prisma/client@^6.4.1`, `prisma@^6.4.1`). Verified clean generation and migrations without deprecated driver adapters.

#### Finding L-02: Development Seed Idempotency
- **Analysis:** Repeatedly running `npm run db:seed` on an active database must not create duplicate restaurants or fail with unique constraint violations.
- **Remediation:** [`prisma/seed.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/prisma/seed.js) uses `prisma.restaurant.upsert()` keyed by `phone_number_id`. Verified by running seed script twice consecutively with zero errors.

---

## 4. Deep-Dive Subsystem Audit

### 4.1 Webhook Idempotency & Durability Audit

```mermaid
sequenceDiagram
    autonumber
    actor Meta as Meta Cloud API
    participant Server as Express (Webhook Controller)
    participant DB as PostgreSQL (webhook_events)
    participant Worker as Message Processing Worker

    Meta->>Server: POST /api/webhook (JSON + HMAC)
    Server->>Server: Verify HMAC-SHA256 signature
    Server->>Server: Parse events & generate unique event_key
    Server->>DB: INSERT INTO webhook_events (event_key, restaurant_id, ...)
    alt Duplicate event_key (P2002 Unique Constraint)
        DB-->>Server: Error 23505 (Unique violation)
        Server->>Server: Log duplicate detection (safe drop)
        Server-->>Meta: HTTP 200 OK (Acknowledge)
    else New event successfully persisted
        DB-->>Server: Event ID created (Status: RECEIVED)
        Server-->>Meta: HTTP 200 OK (Durable Acknowledgment)
        Server->>Worker: Dispatch event for business processing
        Worker->>DB: UPDATE webhook_events SET status = 'COMPLETED'
    end
```

| Evaluation Item | Audit Requirement | Verification Result | Test Proof |
| :--- | :--- | :--- | :--- |
| **Durable Pre-Ack Persistence** | Must persist to PostgreSQL before HTTP 200 response | **VERIFIED:** Database insert completes before response is returned. If DB fails, HTTP 500 triggers Meta retry. | Test Group 6 |
| **Unique Event Key** | Stable, collision-free deduplication key | **VERIFIED:** `wamid.<id>` for messages; `status:<id>:<status>` for delivery receipts. | Test Group 5, 9 |
| **Concurrent Storm Resilience** | Multiple simultaneous requests for same message must produce exactly 1 DB row | **VERIFIED:** 5 concurrent requests executed via `Promise.all`. All returned HTTP 200; exactly 1 DB row created. | Test Group 7 |
| **Multi-Message Batch Ingestion** | Batched payloads with mixed new and duplicate messages | **VERIFIED:** Batch with duplicate Alpha and new Gamma safely dropped Alpha and ingested Gamma. | Test Group 8 |
| **Unmapped Phone Numbers** | Webhooks for unregistered `phone_number_id` must not crash or drop audit records | **VERIFIED:** Recorded with `restaurant_id = null` and status `FAILED`. Returns HTTP 200 cleanly. | Test Group 10 |

---

### 4.2 Multi-Tenant Security & Isolation Audit

```mermaid
flowchart TD
    Meta["Meta Inbound Webhook"] --> Extract["Extract metadata.phone_number_id"]
    Extract --> Resolve["TenantService.resolveByPhoneNumberId()"]
    Resolve --> Check{"Restaurant Found & Active?"}
    Check -- Yes --> SetScope["Bind restaurant_id to Context"]
    Check -- No --> DropEvent["Log Warning & Set restaurant_id = null"]
    
    SetScope --> QueryOrders["TenantService.scopeQuery(restaurant_id, ...)"]
    QueryOrders --> ScopeWhere["WHERE restaurant_id = 'UUID' AND ..."]
    ScopeWhere --> SafeDB["PostgreSQL Isolated Execution"]
```

| Evaluation Item | Audit Requirement | Verification Result | Test Proof |
| :--- | :--- | :--- | :--- |
| **Tenant Resolution Source** | Strictly resolve tenant via Meta `metadata.phone_number_id` | **VERIFIED:** Resolution never relies on customer phone number. | Test Group 2 |
| **Zero Cross-Tenant Leakage** | Tenant A cannot read or mutate Tenant B records | **VERIFIED:** Query with Tenant A ID against Tenant B order returns `null`. | Test Group 3 |
| **Customer Session Isolation** | Same customer phone at two restaurants must not conflict | **VERIFIED:** Independent sessions maintained for same customer phone across tenants. | Test Group 3 |
| **Address Book Isolation** | Customer saved addresses must be isolated per tenant | **VERIFIED:** Address saved at Tenant A is invisible to Tenant B for the same customer. | Test Group 3 |
| **Mandatory Scoping Guard** | Unscoped queries must be rejected at runtime | **VERIFIED:** Calling `scopeQuery` with null/undefined throws an immediate fatal error. | Test Group 4 |

---

### 4.3 Database Schema & Referential Integrity Audit

1. **Primary Keys:** Every table uses standard `UUIDv4` primary keys with PostgreSQL `gen_random_uuid()` defaults.
2. **Monetary Precision:** All prices and order totals use PostgreSQL `Decimal(10, 2)`. Zero floating-point drift.
3. **Deletion Safety:** Foreign keys on `orders`, `conversation_sessions`, `saved_addresses`, and `order_notifications` use `onDelete: Restrict`. Deleting a restaurant with active customer orders is strictly prevented at the database level (Postgres error `code: 23001`).
4. **Catalogue Architecture Decision (Reiterated):** RESTOPRO does not maintain an internal menu/catalogue table. The restaurant owner manages catalogue items directly inside the Meta WhatsApp Business Catalogue. RESTOPRO snapshots purchased items, unit prices, and SKUs into `Order.items` JSONB upon checkout. This eliminates catalog synchronization drift and complies with the Phase 0 architectural boundary.

---

## 5. Migration & Environment Audit

### 5.1 Clean Migration Execution
A fresh migration was tested against an empty PostgreSQL database (`restopro_test_audit`):
- Command: `npx prisma migrate deploy`
- Result: Clean application of migration `20261105105348_init_restopro_schema`.
- Tables Created: 6 tables (`restaurants`, `orders`, `conversation_sessions`, `saved_addresses`, `webhook_events`, `order_notifications`).
- Enums Created: 4 enums (`OrderType`, `OrderStatus`, `WebhookStatus`, `NotificationStatus`).

### 5.2 Seed Script Idempotency
- Command: `node prisma/seed.js`
- Test: Executed twice consecutively.
- Result: 2 restaurants successfully upserted on each run without primary key or unique constraint errors.

### 5.3 Connection Lifecycle & Graceful Shutdown
- Singleton managed in [`src/config/database.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/config/database.js).
- Graceful disconnect registered in [`src/server.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/server.js) on `SIGINT` and `SIGTERM`.

---

## 6. Test Suite Execution Summary

```text
================================================================================
   RESTOPRO TEST EXECUTION MATRIX — STAGE 2.1 AUDIT
================================================================================
 Test Suite                               File                  Assertions  Status
 ───────────────────────────────────────  ────────────────────  ──────────  ──────
 Stage 2 Multi-Tenant Database Suite      stage2-database-test          50  PASSED
 Stage 1.5 Webhook HMAC & Parser Suite    webhook-test                  86  PASSED
 ───────────────────────────────────────  ────────────────────  ──────────  ──────
 TOTAL PASSING ASSERTIONS:                                             136  PASSED
 TOTAL FAILED:                                                           0
 SUCCESS RATE:                                                        100%
================================================================================
```

---

## 7. Sign-Off & Recommendations for Stage 4

### 7.1 Formal Sign-Off
Stage 2 (Database Foundation, Prisma Configuration, and Multi-Tenant Isolation) is **fully approved and audited**. No blocking architectural issues remain.

### 7.2 Recommendations for Stage 4 (Single Restaurant Ordering Engine)
1. **Outbound Messaging Service (`src/services/whatsapp.service.js`):** Implement Graph API client supporting Axios with exponential backoff for outbound messages.
2. **Conversation State Machine (`src/services/conversation.service.js`):** Persist session transitions (`AWAITING_CART` -> `AWAITING_ADDRESS` -> `CONFIRMING_ORDER`) in `conversation_sessions.state` JSONB.
3. **Checkout Snapshotting:** Ensure line item prices submitted via Meta catalog order are snapshot into `Order.items` without mutating historical records.
4. **Tenant Isolation Enforcement:** Continue mandatory usage of `TenantService.scopeQuery(restaurantId, query)` across all future service methods.
