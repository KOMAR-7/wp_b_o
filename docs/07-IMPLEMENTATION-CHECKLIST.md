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

- [ ] **ST3-01:** Install and configure Prisma ORM with PostgreSQL provider.  
  *Acceptance Criterion:* `prisma/schema.prisma` configured and connected to local PostgreSQL.
- [ ] **ST3-02:** Define complete database models in `schema.prisma`.  
  *Acceptance Criterion:* Schema includes `Restaurant`, `Order`, `ConversationSession`, `SavedAddress`, `WebhookEvent`, `OrderNotification`.
- [ ] **ST3-03:** Generate and apply initial database migration.  
  *Acceptance Criterion:* `npx prisma migrate dev` creates all 6 tables, foreign keys, indexes, and constraints.
- [ ] **ST3-04:** Create Prisma database client singleton in `src/config/database.js`.  
  *Acceptance Criterion:* Application shares single Prisma client instance across requests.
- [ ] **ST3-05:** Implement test database seed script in `prisma/seed.js`.  
  *Acceptance Criterion:* Seeding provisions Restaurant A (`111111`) and Restaurant B (`222222`).
- [ ] **ST3-06:** Verify unique constraints and foreign key cascade rules in database.  
  *Acceptance Criterion:* Attempting duplicate `phone_number_id` or duplicate `order_reference` throws DB error.

---

## Stage 4 — Single Restaurant Customer Ordering Engine

- [ ] **ST4-01:** Implement `src/services/tenant.service.js` for tenant resolution.  
  *Acceptance Criterion:* Correctly resolves `restaurant_id` from `metadata.phone_number_id`; rejects unknown IDs.
- [ ] **ST4-02:** Implement event deduplication using `webhook_events` table.  
  *Acceptance Criterion:* Re-sending an identical `wamid` returns immediately without re-triggering logic.
- [ ] **ST4-03:** Implement `src/services/whatsapp.service.js` for outbound messaging.  
  *Acceptance Criterion:* Successfully sends text messages and interactive catalog prompts via Meta Graph API.
- [ ] **ST4-04:** Handle initial customer greeting ("Hi") in `conversation.service.js`.  
  *Acceptance Criterion:* Customer receives personalized welcome message and catalog prompt; session is `AWAITING_CART`.
- [ ] **ST4-05:** Handle incoming native catalog cart (`type: "order"`).  
  *Acceptance Criterion:* Validates line items, calculates total amount, and transitions session to address flow.
- [ ] **ST4-06:** Implement empty and malformed cart defense.  
  *Acceptance Criterion:* Empty or 0-quantity cart returns polite rejection; no order is created.
- [ ] **ST4-07:** Implement saved address lookup and reuse prompt.  
  *Acceptance Criterion:* If customer has saved address for this restaurant, bot asks if they want to reuse it.
- [ ] **ST4-08:** Implement new text address capture.  
  *Acceptance Criterion:* Text address is parsed and temporarily saved in conversation session state.
- [ ] **ST4-09:** Implement WhatsApp location pin capture (`type: "location"`).  
  *Acceptance Criterion:* Latitude, longitude, and formatted address are saved in session state.
- [ ] **ST4-10:** Implement explicit address-saving consent flow.  
  *Acceptance Criterion:* If customer taps "Yes, Save", row is created in `saved_addresses`; if "No", no row is created.
- [ ] **ST4-11:** Implement Delivery vs. Takeaway selection.  
  *Acceptance Criterion:* Correctly updates order type; validates delivery address presence if Delivery selected.
- [ ] **ST4-12:** Implement formatted order summary with Confirm / Cancel buttons.  
  *Acceptance Criterion:* Displays items, quantities, subtotal, address, and interactive buttons.
- [ ] **ST4-13:** Implement customer order confirmation handler.  
  *Acceptance Criterion:* Creates single record in `orders` with status `PENDING_RESTAURANT_CONFIRMATION`.
- [ ] **ST4-14:** Implement customer cancellation handler.  
  *Acceptance Criterion:* Clears session state; creates no record in `orders` table.

---

## Stage 5 — Owner Notification & Decision Processing

- [ ] **ST5-01:** Implement `src/services/notification.service.js` for owner alerts.  
  *Acceptance Criterion:* Inserts row into `order_notifications` and dispatches Meta Utility Template.
- [ ] **ST5-02:** Verify owner notification payload on owner WhatsApp device.  
  *Acceptance Criterion:* Owner receives consolidated alert with customer details, items, total, and action buttons.
- [ ] **ST5-03:** Handle incoming owner webhook for Accept / Reject.  
  *Acceptance Criterion:* Captures button click and extracts order ID and decision.
- [ ] **ST5-04:** Enforce owner authorization guard.  
  *Acceptance Criterion:* If button click sender phone does not match `restaurant.owner_phone`, action is rejected.
- [ ] **ST5-05:** Enforce cross-tenant order validation.  
  *Acceptance Criterion:* If order belongs to a different restaurant, action is rejected and logged.
- [ ] **ST5-06:** Execute atomic order status transition.  
  *Acceptance Criterion:* Transitions status from `PENDING_RESTAURANT_CONFIRMATION` to `ACCEPTED` or `REJECTED`.
- [ ] **ST5-07:** Enforce single terminal decision guard.  
  *Acceptance Criterion:* Tapping Accept on an already rejected order leaves order as REJECTED; owner is notified.
- [ ] **ST5-08:** Deliver customer decision notification.  
  *Acceptance Criterion:* Customer receives immediate WhatsApp message confirming food preparation or order rejection.

---

## Stage 6 — Multi-Tenant Verification & Security Testing

- [ ] **ST6-01:** Seed and activate second test restaurant (Restaurant B).  
  *Acceptance Criterion:* Both restaurants present in database with distinct `phone_number_id` and credentials.
- [ ] **ST6-02:** Simulate concurrent customer orders for Restaurant A and Restaurant B.  
  *Acceptance Criterion:* Both orders process simultaneously; orders are tagged with correct `restaurant_id`.
- [ ] **ST6-03:** Verify customer session isolation across tenants.  
  *Acceptance Criterion:* Customer ordering at Restaurant A and Restaurant B simultaneously maintains two independent sessions.
- [ ] **ST6-04:** Verify saved address isolation across tenants.  
  *Acceptance Criterion:* Address saved at Restaurant A is not visible or offered when ordering at Restaurant B.
- [ ] **ST6-05:** Verify owner notification routing across tenants.  
  *Acceptance Criterion:* Order at Restaurant A notifies only Owner A; order at Restaurant B notifies only Owner B.
- [ ] **ST6-06:** Test cross-tenant attack scenario.  
  *Acceptance Criterion:* Owner A attempting to accept Restaurant B's order is rejected with zero state changes.
- [ ] **ST6-07:** Test soft-disabled tenant behavior (`is_active = false`).  
  *Acceptance Criterion:* Webhook events for disabled restaurant are safely dropped without processing.

---

## Stage 7 — Production Hardening & Reliability

- [ ] **ST7-01:** Implement durable notification outbox worker (`src/jobs/notification-worker.js`).  
  *Acceptance Criterion:* Automatically retries failed outbound notifications with exponential backoff up to 5 attempts.
- [ ] **ST7-02:** Implement automated session expiration worker (`src/jobs/session-cleanup.js`).  
  *Acceptance Criterion:* Purges expired sessions older than 2 hours every 24 hours.
- [ ] **ST7-03:** Implement 30-minute owner non-response auto-expiry job (`src/jobs/order-timeout.js`).  
  *Acceptance Criterion:* Pending orders unacknowledged after 30 mins marked `EXPIRED`; customer notified.
- [ ] **ST7-04:** Test server restart during active checkout.  
  *Acceptance Criterion:* Customer can resume checkout from exact same step after server reboot.
- [ ] **ST7-05:** Test database outage resilience.  
  *Acceptance Criterion:* Returns HTTP 500 to Meta so Meta retries event; no partial corrupt records created.
- [ ] **ST7-06:** Create automated database backup script (`scripts/backup-db.sh`).  
  *Acceptance Criterion:* Creates timestamped, gzip-compressed `pg_dump` backup file.

---

## Stage 8 — Hostinger VPS Deployment

- [ ] **ST8-01:** Provision Hostinger Ubuntu VPS with Node.js LTS, PostgreSQL 15, and PM2.  
  *Acceptance Criterion:* VPS accessible via SSH with non-root sudo user.
- [ ] **ST8-02:** Install and secure production PostgreSQL database.  
  *Acceptance Criterion:* Database accepts connections only from localhost.
- [ ] **ST8-03:** Configure Nginx reverse proxy with Let's Encrypt SSL (`certbot`).  
  *Acceptance Criterion:* `https://api.restopro.app/health` returns valid SSL certificate (A+ rating).
- [ ] **ST8-04:** Configure PM2 process manager with `ecosystem.config.js`.  
  *Acceptance Criterion:* RESTOPRO runs as persistent background service and auto-restarts on server reboot.
- [ ] **ST8-05:** Configure production environment variables in `.env`.  
  *Acceptance Criterion:* Production secrets, database URLs, and Meta tokens properly injected.
- [ ] **ST8-06:** Run production Prisma migrations (`npx prisma migrate deploy`).  
  *Acceptance Criterion:* Production database schema matches development schema perfectly.
- [ ] **ST8-07:** Update Meta Developer App Webhook URL to production HTTPS endpoint.  
  *Acceptance Criterion:* Meta webhook verification succeeds on production endpoint.
- [ ] **ST8-08:** Execute live production smoke test order.  
  *Acceptance Criterion:* Live WhatsApp customer places order, owner accepts on WhatsApp, customer receives confirmation.

