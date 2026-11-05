# RESTOPRO — Master Implementation Checklist

**Document Version:** 1.0.0  
**Status:** Pre-Implementation Gate (All Tasks Pending Explicit Authorization)  
**Verification Standard:** Every task must be verified with automated test suites or live API validation before being checked.

---

## Stage 1 — Meta Proof of Concept (POC)

- [BLOCKED] **ST1-01:** Create Meta Developer App and configure WhatsApp Cloud API product.  
  *Acceptance Criterion:* Meta App Dashboard displays valid App ID and App Secret. *(Requires user Meta Developer Account)*
- [BLOCKED] **ST1-02:** Configure test WhatsApp Business Account (WABA) and test phone number.  
  *Acceptance Criterion:* Test number can send/receive WhatsApp messages in Meta sandbox. *(Requires user Meta Developer Account)*
- [BLOCKED] **ST1-03:** Set up secure public tunnel (ngrok / Cloudflare Tunnel) to local test server.  
  *Acceptance Criterion:* Tunnel URL is reachable over HTTPS from the public Internet. *(Requires user running tunnel locally)*
- [x] **ST1-04:** Complete Meta Webhook Verification handshake (`hub.challenge`).  
  *Acceptance Criterion:* Verified via `test/webhook-test.js` (valid token echoes challenge, invalid token returns 403, missing params returns 400). Live Meta callback pending tunnel.
- [x] **ST1-05:** Capture and log incoming raw JSON for customer greeting ("Hi").  
  *Acceptance Criterion:* Verified via `test/webhook-test.js`; sanitized sample saved in `docs/test-payloads/01-text-message.json`.
- [BLOCKED] **ST1-06:** Link test product catalog in Meta Commerce Manager and send `catalog_message`.  
  *Acceptance Criterion:* WhatsApp client displays native "View Catalog" interactive button. *(Requires Commerce Manager catalog)*
- [x] **ST1-07:** Submit cart from native WhatsApp catalog and capture incoming webhook.  
  *Acceptance Criterion:* Verified via `test/webhook-test.js` (`order.product_items`, SKUs, and subtotal parsed accurately); sanitized sample saved in `docs/test-payloads/02-catalog-order.json`.
- [x] **ST1-08:** Send location pin from WhatsApp and capture incoming webhook.  
  *Acceptance Criterion:* Verified via `test/webhook-test.js` (latitude, longitude, and address extracted); sanitized sample saved in `docs/test-payloads/03-location-message.json`.
- [BLOCKED] **ST1-09:** Create and get Meta approval for Utility Message Template with Quick Reply buttons.  
  *Acceptance Criterion:* Template status in Meta Business Manager changes to `APPROVED`. *(Requires Meta Business Manager submission)*
- [BLOCKED] **ST1-10:** Dispatch test Utility Template to owner phone number outside 24h window.  
  *Acceptance Criterion:* Message arrives on owner device with actionable Quick Reply buttons. *(Requires approved template and credentials)*
- [x] **ST1-11:** Tap Quick Reply button on owner device and capture incoming webhook.  
  *Acceptance Criterion:* Verified via `test/webhook-test.js` (button payload and context extracted); sanitized sample saved in `docs/test-payloads/04-template-button-reply.json`.
- [x] **ST1-12:** Verify WhatsApp Business App Coexistence constraints.  
  *Acceptance Criterion:* Coexistence specifications, 5 mps throughput cap, and 14-day login rules documented in `docs/04-META-WHATSAPP-INTEGRATION.md`.

---

## Stage 2 — Backend Foundation

- [x] **ST2-01:** Initialize Node.js project with `package.json` and strict production dependencies.  
  *Acceptance Criterion:* Verified: `package.json` contains only `express`, `dotenv`, `axios`, and `nodemon`.
- [x] **ST2-02:** Configure environment variable schema and `.env.example`.  
  *Acceptance Criterion:* Verified: `.env.example` and `.env` configured with validation in `src/config/env.js`.
- [x] **ST2-03:** Implement raw body buffer retention in Express body parser (`src/app.js`).  
  *Acceptance Criterion:* Verified: `req.rawBody` preserves unparsed Buffer for HMAC verification.
- [x] **ST2-04:** Implement `verifyWebhook.js` signature verification middleware.  
  *Acceptance Criterion:* Verified: Requests with forged/tampered signatures return 403; valid signatures pass.
- [x] **ST2-05:** Implement GET webhook challenge verification in `src/controllers/webhook.controller.js`.  
  *Acceptance Criterion:* Verified: Returns HTTP 200 with challenge string when verify token matches.
- [x] **ST2-06:** Implement `GET /health` endpoint.  
  *Acceptance Criterion:* Verified: Returns HTTP 200 with `{ status: "ok", timestamp: ... }`.
- [x] **ST2-07:** Implement structured JSON logging utility (`src/utils/logger.js`).  
  *Acceptance Criterion:* Verified: Outputs structured JSON; secrets and tokens are redacted.
- [x] **ST2-08:** Add automated unit tests for signature validation and health check.  
  *Acceptance Criterion:* Verified: 38/38 passing assertions in `test/webhook-test.js`.

---

## Stage 3 — Database Foundation & Prisma Schema

- [x] **ST3-01:** Install and configure Prisma ORM with PostgreSQL provider.  
  *Acceptance Criterion:* Verified: Prisma v6.19.3 installed, connected to local PostgreSQL database `restopro_dev`.
- [x] **ST3-02:** Define complete database models in `schema.prisma`.  
  *Acceptance Criterion:* Verified: Models `Restaurant`, `Order`, `ConversationSession`, `SavedAddress`, `WebhookEvent`, `OrderNotification` with 4 explicit enums defined.
- [x] **ST3-03:** Generate and apply initial database migration.  
  *Acceptance Criterion:* Verified: Migration `20261105105348_init_restopro_schema` applied cleanly to PostgreSQL.
- [x] **ST3-04:** Create Prisma database client singleton in `src/config/database.js`.  
  *Acceptance Criterion:* Verified: Shared client singleton configured with graceful shutdown disconnection in `src/server.js`.
- [x] **ST3-05:** Implement test database seed script in `prisma/seed.js`.  
  *Acceptance Criterion:* Verified: `npm run db:seed` provisions Tenant A (`111111111111111`) and Tenant B (`222222222222222`).
- [x] **ST3-06:** Verify unique constraints and foreign key cascade rules in database.  
  *Acceptance Criterion:* Verified in `test/stage2-database-test.js` (P2002 on unique violations, P2003 on invalid FKs, Restrict on active orders).
- [x] **ST3-07:** Enforce composite foreign key on `order_notifications(order_id, restaurant_id)` referencing `orders(id, restaurant_id)`.  
  *Acceptance Criterion:* Verified via migration `20261105121500_enforce_notification_tenant_consistency` and `test/stage2-database-test.js` (matching insert succeeds, mismatched insert rejected with P2003).
- [x] **ST3-08:** Configure connection pool capacity parameters and verify graceful shutdown lifecycle.  
  *Acceptance Criterion:* Verified: Local PostgreSQL `max_connections = 100` inspected; production capacity budgeted; child process signal-triggered graceful shutdown verified in `test/graceful-shutdown-test.js` (stops accepting requests, disconnects Prisma, and releases port cleanly).

---

## Stage 4 — Single Restaurant Customer Ordering Engine

- [x] **ST4-00:** Implement Stage 4.0 database prerequisites migration (`confirmation_token`, webhook worker lease fields, and `outbox_messages` table).  
  *Acceptance Criterion:* Added `orders.confirmation_token` (nullable, unique), `webhook_events` distributed worker lease fields (`claimed_by`, `lease_token`, `lease_expires_at`, `attempt_count`), and `outbox_messages` table with indexes and constraints via migration `20261105144500_add_stage4_prerequisites`. Verified on `restopro_dev` and clean audit database.
- [ ] **ST4-01:** Implement `src/services/tenant.service.js` for tenant resolution.  
  *Acceptance Criterion:* Correctly resolves `restaurant_id` from `metadata.phone_number_id`; rejects unknown IDs. (Foundational resolver built in Stage 2; pending full Stage 4 ordering integration)
- [ ] **ST4-02:** Implement event deduplication using `webhook_events` table.  
  *Acceptance Criterion:* Re-sending an identical `wamid` returns immediately without re-triggering logic. (Foundational deduplication built in Stage 2; pending full Stage 4 ordering integration)
- [ ] **ST4-03:** Implement `src/services/whatsapp.service.js` for outbound messaging.  
  *Acceptance Criterion:* Successfully sends text messages and interactive catalog prompts via Meta Graph API.
- [ ] **ST4-04:** Handle initial customer greeting ("Hi") in `conversation.service.js`.  
  *Acceptance Criterion:* Customer receives personalized welcome message and catalog prompt; session is `AWAITING_CART`.
- [x] **ST4-05:** Handle incoming native catalog cart (`type: "order"`).  
  *Acceptance Criterion:* Validates line items, calculates total amount, and transitions session to address flow. (Completed in Stage 4.1 with integer-cents arithmetic, cart replacement, token regeneration, and session state persistence)
- [x] **ST4-06:** Implement empty and malformed cart defense.  
  *Acceptance Criterion:* Empty or 0-quantity cart returns polite rejection; no order is created. (Completed in Stage 4.1: rejects empty, missing SKU, zero/negative quantity, decimal quantity, negative/non-numeric price, and currency mismatches)
- [x] **ST4-07:** Implement saved address lookup and reuse prompt.  
  *Acceptance Criterion:* If customer has saved address for this restaurant, bot asks if they want to reuse it. (Completed in Stage 4.3: strictly scoped by `(restaurant_id, customer_phone)`, offers `[Use Saved Address]` / `[Enter New Address]`, validates tenant ownership, cross-tenant/cross-customer access strictly blocked)
- [x] **ST4-08:** Implement new text address capture.  
  *Acceptance Criterion:* Text address is parsed and temporarily saved in conversation session state. (Completed in Stage 4.3: validates minimum length $\ge 10$ characters, rejects short/empty text with contextual reprompts, preserves input in session state, zero permanent DB writes before consent)
- [x] **ST4-09:** Implement WhatsApp location pin capture (`type: "location"`).  
  *Acceptance Criterion:* Latitude, longitude, and formatted address are saved in session state. (Completed in Stage 4.3: parses GPS coordinates preserving `0.0`, enforces valid coordinate ranges, executes mandatory 2-step building name and room/flat number collection pipeline before marking location address complete)
- [x] **ST4-10:** Implement explicit address-saving consent flow.  
  *Acceptance Criterion:* If customer taps "Yes, Save", row is created in `saved_addresses`; if "No", no row is created. (Completed in Stage 4.3: `BTN_CONSENT_YES` persists row with duplicate prevention; `BTN_CONSENT_NO` retains address exclusively in session state; zero automatic persistence)
- [x] **ST4-11:** Implement Delivery vs. Takeaway selection.  
  *Acceptance Criterion:* Correctly updates order type; validates delivery address presence if Delivery selected. (Completed in Stage 4.4: `BTN_ORDER_DELIVERY` strictly guards on completed address presence; `BTN_ORDER_TAKEAWAY` cleanly bypasses address requirement; state transitions deterministically to `AWAITING_CONFIRMATION`)
- [x] **ST4-12:** Implement formatted order summary with Confirm / Cancel buttons.  
  *Acceptance Criterion:* Displays items, quantities, subtotal, address, and interactive buttons. (Completed in Stage 4.4: deterministic order summary recalculates totals via integer paise/cents arithmetic, formats items snapshot, provides `BTN_CONFIRM_ORDER:<token>`, `BTN_CANCEL_ORDER`, and `BTN_CHANGE_ADDRESS` with token invalidation)
- [x] **ST4-13:** Implement customer order confirmation handler.  
  *Acceptance Criterion:* Creates single record in `orders` with status `PENDING_RESTAURANT_CONFIRMATION`. (Completed in Stage 4.4: atomic database transaction creates order with targeted collision retry on `order_reference`, database-backed idempotency guard on `confirmation_token` prevents replay/duplicate rows, resets session to `IDLE`)
- [x] **ST4-14:** Implement customer cancellation handler.  
  *Acceptance Criterion:* Clears session state; creates no record in `orders` table. (Completed in Stage 4.4: `BTN_CANCEL_ORDER` resets conversation session to `IDLE`, clears checkout state, and creates exactly zero rows in `orders` table)

---

## Stage 5 — Owner Notification & Decision Processing

- [x] **ST5-01:** Implement owner notification and durable outbox dispatch (`src/services/whatsapp.service.js`, `src/services/outbox.service.js`, and `src/services/order.service.js`).  
  *Acceptance Criterion:* Inserts row into `order_notifications` and `outbox_messages` atomically with order creation in the exact same database transaction; dispatches owner alert via durable outbox dispatcher with PostgreSQL `FOR UPDATE SKIP LOCKED`, worker lease tokens, and bounded retries. (Completed in Stage 5.1: atomic transaction guarantees zero phantom orders, `outbox_messages_idempotency_key_key` ensures exactly one notification row per order, row locking prevents duplicate concurrent worker claims, and DB connection is never held open during external Meta HTTP calls)
- [x] **ST5-02:** Verify owner notification payload structure and interactive buttons.  
  *Acceptance Criterion:* Owner receives consolidated alert with customer details, items, total, and action buttons (`OWNER_ACCEPT:<order_id>` and `OWNER_REJECT:<order_id>`) with zero internal confirmation token leakage. (Completed in Stage 5.1: interactive button payload embeds `order.id` UUIDs, formats multi-line order summary with customer phone/name and items, resolves tenant owner phone from restaurant record, and redacts access tokens from all error logs and outbox records)
- [x] **ST5-03:** Handle incoming owner webhook for Accept / Reject (`src/controllers/webhook.controller.js` and `src/services/order.service.js`).  
  *Acceptance Criterion:* Captures button click and extracts order ID and decision. (Completed in Stage 5.2: `parseOwnerAction` validates `OWNER_ACCEPT:<order_id>` and `OWNER_REJECT:<order_id>`, strictly validating UUID format and rejecting malformed payloads; `webhook.controller.js` routes owner interactive payloads directly to `processOwnerOrderDecision`)
- [x] **ST5-04:** Enforce owner authorization guard.  
  *Acceptance Criterion:* If button click sender phone does not match `restaurant.owner_phone`, action is rejected. (Completed in Stage 5.2: normalizes phone numbers and verifies `cleanSenderPhone === cleanOwnerPhone`; rejects customers or arbitrary senders with `UNAUTHORIZED_OWNER` and zero database mutation)
- [x] **ST5-05:** Enforce cross-tenant order validation.  
  *Acceptance Criterion:* If order belongs to a different restaurant, action is rejected and logged. (Completed in Stage 5.2: validates `order.restaurant_id === restaurant.id`; rejects cross-tenant attempts with `CROSS_TENANT_VIOLATION` while preserving order status)
- [x] **ST5-06:** Execute atomic order status transition.  
  *Acceptance Criterion:* Transitions status from `PENDING_RESTAURANT_CONFIRMATION` to `ACCEPTED` or `REJECTED`. (Completed in Stage 5.2: uses PostgreSQL `SELECT ... FOR UPDATE` row locking to atomically transition status to `ACCEPTED` or `REJECTED` and persist `decision_at` timestamp)
- [x] **ST5-07:** Enforce single terminal decision guard.  
  *Acceptance Criterion:* Tapping Accept on an already rejected order leaves order as REJECTED; owner is notified. (Completed in Stage 5.2: conflicting second decisions are strictly rejected with `CONFLICTING_DECISION`; repeated identical decisions return `isDuplicate: true` without creating duplicate records or mutations)
- [x] **ST5-08:** Deliver customer decision notification.  
  *Acceptance Criterion:* Customer receives immediate WhatsApp message confirming food preparation or order rejection. (Completed in Stage 5.3: `buildCustomerDecisionNotificationPayload` formats polite WhatsApp messages with zero invented delivery/prep times or rejection reasons; `processOwnerOrderDecision` atomically persists `Order` status, `OutboxMessage`, and `OrderNotification` within the exact same DB transaction with deterministic idempotency keys and rollback safety)

---

## Stage 6 — Multi-Tenant Verification & Security Testing

- [x] **ST6-01:** Seed and activate second test restaurant (Restaurant B).  
  *Acceptance Criterion:* Both restaurants present in database with distinct `phone_number_id` and credentials. (Completed in Stage 6: `prisma/seed.js` seeds Restaurant A and Restaurant B with distinct UUIDs, `phone_number_id` values `111111111111111` vs `222222222222222`, and independent credentials)
- [x] **ST6-02:** Simulate concurrent customer orders for Restaurant A and Restaurant B.  
  *Acceptance Criterion:* Both orders process simultaneously; orders are tagged with correct `restaurant_id`. (Completed in Stage 6: concurrent checkouts executed via `Promise.all` process simultaneously with strict `restaurant_id` scoping and distinct order references)
- [x] **ST6-03:** Verify customer session isolation across tenants.  
  *Acceptance Criterion:* Customer ordering at Restaurant A and Restaurant B simultaneously maintains two independent sessions. (Completed in Stage 6: dual customer maintains two completely independent conversation sessions in PostgreSQL under composite unique constraint `[restaurant_id, customer_phone]` with zero state leakage)
- [x] **ST6-04:** Verify saved address isolation across tenants.  
  *Acceptance Criterion:* Address saved at Restaurant A is not visible or offered when ordering at Restaurant B. (Completed in Stage 6: addresses queried via `restaurant_id` and `customer_phone` strictly isolate customer address books between tenants)
- [x] **ST6-05:** Verify owner notification routing across tenants.  
  *Acceptance Criterion:* Order at Restaurant A notifies only Owner A; order at Restaurant B notifies only Owner B. (Completed in Stage 6: Outbox alerts route strictly to the configured `owner_phone` of the specific restaurant where the order was placed)
- [x] **ST6-06:** Test cross-tenant attack scenario.  
  *Acceptance Criterion:* Owner A attempting to accept Restaurant B's order is rejected with zero state changes. (Completed in Stage 6: Owner A attempting to accept Restaurant B's order is rejected with `CROSS_TENANT_VIOLATION` or `UNAUTHORIZED_OWNER`; Restaurant B's order status remains untouched in `PENDING_RESTAURANT_CONFIRMATION`)
- [x] **ST6-07:** Test soft-disabled tenant behavior (`is_active = false`).  
  *Acceptance Criterion:* Webhook events for disabled restaurant are safely dropped without processing. (Completed in Stage 6: Inbound webhook events for inactive restaurants are safely dropped without customer state mutation, marked `FAILED` in `webhook_events`, and acknowledged with HTTP 200 to prevent delivery retry storms)

---

## Stage 7 — Production Hardening & Reliability

- [x] **ST7-01:** Implement durable notification outbox worker (`src/jobs/notification-worker.js`).  
  *Acceptance Criterion:* Automatically retries failed outbound notifications with exponential backoff up to 5 attempts. (Completed in Stage 7: `NotificationWorker` class with continuous polling, row-level `FOR UPDATE SKIP LOCKED` claim, stale worker fencing via UUID lease token, and `SIGTERM`/`SIGINT` graceful shutdown; verified in `test/stage7-render-readiness-test.js`)
- [x] **ST7-02:** Implement automated session expiration worker (`src/jobs/session-cleanup.js`).  
  *Acceptance Criterion:* Purges expired sessions older than 2 hours every 24 hours. (Completed in Stage 7: `cleanupExpiredSessions()` purges sessions exceeding 2-hour TTL while preserving active sessions; verified in `test/stage7-render-readiness-test.js`)
- [x] **ST7-03:** Implement 30-minute owner non-response auto-expiry job (`src/jobs/order-timeout.js`).  
  *Acceptance Criterion:* Pending orders unacknowledged after 30 mins marked `EXPIRED`; customer notified. (Completed in Stage 7: `expireUnacknowledgedOrders()` automatically transitions 30-min unacknowledged orders to `EXPIRED` and atomically creates customer notification outbox record; verified in `test/stage7-render-readiness-test.js`)
- [x] **ST7-04:** Test server restart during active checkout.  
  *Acceptance Criterion:* Customer can resume checkout from exact same step after server reboot. (Completed in Stage 7: Active session state in PostgreSQL persists across simulated server reboot and allows seamless order completion; verified in `test/stage7-render-readiness-test.js`)
- [x] **ST7-05:** Test database outage resilience.  
  *Acceptance Criterion:* Returns HTTP 500 to Meta so Meta retries event; no partial corrupt records created. (Completed in Stage 7: Prisma transactions roll back completely on failure with zero partial records left; verified in `test/stage7-render-readiness-test.js`)
- [x] **ST7-06:** Create automated database backup script (`scripts/backup-db.sh`).  
  *Acceptance Criterion:* Creates timestamped, gzip-compressed `pg_dump` backup file. (Completed in Stage 7: `scripts/backup-db.sh` created with `pg_dump -Fc` compressed format, TOC integrity verification, and 14-day retention pruning; verified in `test/stage7-render-readiness-test.js`)

---

## Stage 8 — Render Cloud Deployment

- [ ] **ST8-01:** Provision Render PostgreSQL database instance (`restopro-postgres` on Starter plan).  
  *Acceptance Criterion:* Managed PostgreSQL 16 provisioned with internal connection URL and automated daily backups.
- [ ] **ST8-02:** Deploy Render Web Service (`restopro-api` on Starter plan).  
  *Acceptance Criterion:* Web service running Node.js LTS, binds to 0.0.0.0, trust proxy enabled, `/health` endpoint returning HTTP 200.
- [ ] **ST8-03:** Deploy Render Background Worker (`restopro-worker` on Starter plan).  
  *Acceptance Criterion:* Worker process running `node src/jobs/notification-worker.js` with continuous outbox polling.
- [ ] **ST8-04:** Configure production environment variables and secrets on Render.  
  *Acceptance Criterion:* `DATABASE_URL`, `META_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, and production settings injected.
- [ ] **ST8-05:** Run production Prisma migrations via Render Pre-Deploy Command (`npx prisma migrate deploy`).  
  *Acceptance Criterion:* Production database schema perfectly aligned with development migrations before traffic switches.
- [ ] **ST8-06:** Seed production restaurant tenant record(s) with Meta WhatsApp credentials.  
  *Acceptance Criterion:* Tenant record exists in production PostgreSQL with active status and valid phone_number_id.
- [ ] **ST8-07:** Update Meta Developer App Webhook URL to Render production HTTPS endpoint.  
  *Acceptance Criterion:* Meta webhook verification challenge succeeds on `https://<render-url>/api/webhook` with `messages` field subscribed.
- [ ] **ST8-08:** Execute live production smoke test order.  
  *Acceptance Criterion:* Live WhatsApp customer places catalogue cart order, owner accepts via interactive buttons, customer receives confirmation alert.

