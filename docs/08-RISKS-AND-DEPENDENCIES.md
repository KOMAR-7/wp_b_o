# RESTOPRO — Risk & Dependency Register

**Document Version:** 1.0.0  
**Status:** Approved for Planning / Pre-Implementation  
**Review Frequency:** Weekly during implementation stages  

---

## 1. Risk Assessment Matrix Overview

| Risk ID | Risk Category | Description | Probability | Impact | Blocking? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RSK-01** | Meta Integration | Owner notifications fail due to 24-hour service window expiry | High | Critical | **Yes** |
| **RSK-02** | Meta Integration | Meta Cart webhook lacks human-readable product titles | High | High | **Yes** |
| **RSK-03** | Meta Integration | WhatsApp Business App Coexistence fragility / 14-day logout | High | High | No |
| **RSK-04** | Security / Tenancy | Accidental cross-tenant data leakage via un-scoped DB queries | Low | Critical | **Yes** |
| **RSK-05** | Reliability | Duplicate webhook retries from Meta causing duplicate orders | High | High | **Yes** |
| **RSK-06** | Operational | Restaurant owner does not respond to order notification | High | High | No |
| **RSK-07** | Reliability | Meta Graph API transient outages causing lost notifications | Medium | High | No |
| **RSK-08** | Security | Webhook forgery / unauthorized HTTP requests to webhook | Medium | Critical | **Yes** |
| **RSK-09** | Concurrency | Race conditions from rapid customer messages or concurrent owner clicks | Medium | Medium | No |
| **RSK-10** | Infrastructure | Hostinger VPS resource exhaustion or single point of failure | Low | Medium | No |

---

## 2. Detailed Risk Profiles & Mitigation Plans

### RSK-01: Owner Notifications Fail Outside 24-Hour Customer Service Window
- **Description:** Meta strictly enforces a 24-hour customer service window for free-form WhatsApp messages. Because restaurant owners do not actively message the bot prior to incoming orders, standard interactive or text messages will fail with Meta Error `131047` ("Re-engagement message: More than 24 hours have passed").
- **Probability:** High | **Impact:** Critical | **Blocking:** Yes
- **Mitigation Strategy:**
  1. Mandate the use of pre-approved **Meta Utility Message Templates** for owner notifications.
  2. Embed Quick Reply buttons (`ORDER_ACCEPT_{order_id}` and `ORDER_REJECT_{order_id}`) inside the approved template.
  3. Pre-register and verify template approval during Stage 1 POC before writing production notification code.
- **Verification Method:** Send a test utility template message from the backend to an owner number that has not sent a message in > 48 hours; verify delivery on the device.

---

### RSK-02: Native Cart Webhook Lacks Human-Readable Product Titles
- **Description:** Real Meta incoming `type: "order"` webhook payloads contain `product_retailer_id`, `quantity`, `item_price`, and `currency`, but omit product titles (`name`, e.g., "Chicken Biryani"). Relying solely on the webhook payload would display raw SKUs to the customer and owner.
- **Probability:** High | **Impact:** High | **Blocking:** Yes
- **Mitigation Strategy:**
  1. Primary: Use Meta Graph API catalog edge (`GET /{catalog_id}/products?filter={"retailer_id":{"eq":"..."}}`) to fetch product titles upon first cart receipt.
  2. Cache SKU-to-Name mappings in memory or local cache with a 24-hour TTL.
  3. Fallback: If catalog API access is restricted, format summary using `Item [SKU] x Quantity (Price)`.
- **Verification Method:** Test cart submission with live catalog in Stage 1; verify name enrichment logic.

---

### RSK-03: WhatsApp Business App Coexistence Fragility
- **Description:** Meta's Coexistence feature requires the mobile app to be opened every 14 days and imposes a 5 messages/sec throughput limit. If a restaurant owner's phone goes offline or uninstalls the app, the Cloud API integration can become desynchronized.
- **Probability:** High | **Impact:** High | **Blocking:** No
- **Mitigation Strategy:**
  1. Clearly document coexistence requirements in restaurant onboarding guide.
  2. Recommend commercial restaurants use a dedicated virtual phone number for WhatsApp Cloud API rather than sharing a personal mobile device.
  3. Implement automated connection health checks monitoring webhook delivery receipts.
- **Verification Method:** Monitor test coexisting number for 14 days during staging.

---

### RSK-04: Cross-Tenant Data Leakage via Un-Scoped DB Queries
- **Description:** In a shared database multi-tenant architecture, a single missing `where: { restaurant_id }` clause in a Prisma query could allow Restaurant A to view or mutate Restaurant B's orders.
- **Probability:** Low | **Impact:** Critical | **Blocking:** Yes
- **Mitigation Strategy:**
  1. Enforce strict code review requiring `restaurant_id` on every database operation.
  2. Implement Prisma Client query middleware / extension that validates `restaurant_id` presence on all tenant-owned models.
  3. Write exhaustive automated cross-tenant security test suites in Stage 6.
- **Verification Method:** Run automated integration tests attempting cross-tenant reads, updates, and button clicks; ensure 100% denial rate.

---

### RSK-05: Duplicate Webhook Retries Causing Duplicate Orders
- **Description:** If RESTOPRO takes > 20s to respond to Meta or network issues occur, Meta automatically retries the webhook with identical payloads, potentially creating duplicate orders or repeated messages.
- **Probability:** High | **Impact:** High | **Blocking:** Yes
- **Mitigation Strategy:**
  1. Implement immediate HTTP 200 acknowledgment in Express controller before asynchronous processing.
  2. Maintain `webhook_events` deduplication table with unique constraint on `event_key` (`wamid`).
  3. Wrap order creation in database transactions that check session status atomically.
- **Verification Method:** Send 5 identical simulated cart webhooks concurrently using Postman; verify exactly one order is created.

---

### RSK-06: Restaurant Owner Non-Response to Order Notification
- **Description:** Restaurant owner is busy in the kitchen, asleep, or phone battery is dead. The customer is left waiting indefinitely in `PENDING_RESTAURANT_CONFIRMATION`.
- **Probability:** High | **Impact:** High | **Blocking:** No
- **Mitigation Strategy:**
  1. Implement an automated background timeout job (`src/jobs/order-timeout.js`) running every 60 seconds.
  2. Orders pending for > 30 minutes are automatically transitioned to `EXPIRED`.
  3. Send polite customer notification: *"We apologize, but [Restaurant Name] did not respond in time. Your order has been cancelled and you have not been charged."*
  4. Dispatch single reminder ping to owner at 10 minutes.
- **Verification Method:** Unit test order timeout worker with simulated expired orders.

---

### RSK-07: Meta Graph API Outages Causing Lost Notifications
- **Description:** Outbound HTTP requests to Meta API fail due to network timeouts, rate limiting, or Meta cloud outages.
- **Probability:** Medium | **Impact:** High | **Blocking:** No
- **Mitigation Strategy:**
  1. Persist the order in PostgreSQL **first** before attempting outbound API calls.
  2. Queue all outbound notifications in `order_notifications` outbox table.
  3. Implement background retry worker with exponential backoff and max 5 attempts.
- **Verification Method:** Mock Meta API returning 500 errors; verify order remains safely persisted and outbox retries automatically.

---

### RSK-08: Webhook Forgery & Unauthorized Requests
- **Description:** Malicious third parties discovering the public webhook endpoint send spoofed requests, tampering with order states or triggering false notifications.
- **Probability:** Medium | **Impact:** Critical | **Blocking:** Yes
- **Mitigation Strategy:**
  1. Enforce strict HMAC-SHA256 signature verification using `META_APP_SECRET` on all incoming POST requests.
  2. Use `crypto.timingSafeEqual` to prevent timing attacks.
  3. Reject unsigned or invalid requests with HTTP 403 Forbidden before reaching controller logic.
- **Verification Method:** Send POST requests with modified bodies or forged signatures; verify 100% rejection.

---

### RSK-09: Race Conditions from Rapid Customer Messages
- **Description:** Customer taps multiple buttons or sends rapid text messages while previous state transition is processing.
- **Probability:** Medium | **Impact:** Medium | **Blocking:** No
- **Mitigation Strategy:**
  1. Maintain deterministic step-check validation: ignore incoming messages that do not match the expected `current_step`.
  2. Use optimistic locking or atomic database updates on `conversation_sessions`.
- **Verification Method:** Simulate 10 rapid concurrent text messages from single customer; verify session remains consistent.

---

### RSK-10: Hostinger VPS Single Point of Failure
- **Description:** VPS reboot, crash, or disk exhaustion disrupts ordering services.
- **Probability:** Low | **Impact:** Medium | **Blocking:** No
- **Mitigation Strategy:**
  1. Use PM2 process manager configured with `autorestart: true` and startup hooks (`pm2 startup`).
  2. Implement daily automated PostgreSQL database backups to remote storage.
  3. Configure system disk space and RAM alerts.
- **Verification Method:** Execute `kill -9` on Node.js process; verify PM2 restarts application within 2 seconds.

---

## 3. External Technical Dependencies

1. **Meta WhatsApp Cloud API (v21.0):** Core messaging and catalog pipeline.
2. **Meta Commerce Manager:** Product catalog management for each restaurant.
3. **PostgreSQL 15+:** Relational storage and JSONB support.
4. **Hostinger Ubuntu VPS:** Production runtime environment.
5. **Let's Encrypt / Certbot:** Automated TLS/SSL certificate issuance.

