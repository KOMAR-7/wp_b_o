# RESTOPRO — Security, Reliability & Data Protection Specification

**Document Version:** 1.0.0  
**Status:** Approved for Planning / Pre-Implementation  
**Target Environment:** Production Node.js, PostgreSQL, Hostinger VPS  

---

## 1. Webhook Security Architecture

Webhooks expose RESTOPRO to the public Internet. Rigorous perimeter security must be applied before any business logic processes incoming traffic.

### 1.1 Meta HMAC-SHA256 Request Signature Validation
- Every POST request to `/api/webhook` includes the `X-Hub-Signature-256` header: `sha256=<hex_digest>`.
- Express must parse the request body such that the raw byte buffer is preserved.
```javascript
// src/app.js middleware ordering
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf; // Preserve exact raw buffer for HMAC verification
  }
}));
```
- The verification middleware performs cryptographic validation:
```javascript
// src/middleware/verifyWebhook.js
const crypto = require('crypto');

function verifyMetaSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  const [prefix, hash] = signature.split('=');
  if (prefix !== 'sha256' || !hash) {
    return res.status(401).json({ error: 'Malformed webhook signature' });
  }

  const expectedHash = crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  const hashBuffer = Buffer.from(hash, 'hex');
  const expectedBuffer = Buffer.from(expectedHash, 'hex');

  if (hashBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(hashBuffer, expectedBuffer)) {
    return res.status(403).json({ error: 'Invalid webhook signature' });
  }

  next();
}
```

---

## 2. Multi-Tenant Isolation & Defense in Depth

### 2.1 The Cardinal Rule of Tenant Scoping
Every database read, insert, update, and delete operation on tenant-owned tables (`orders`, `conversation_sessions`, `saved_addresses`, `webhook_events`) **MUST** include `restaurant_id` in its query predicate.

```javascript
// Correct & Safe
const order = await prisma.order.findFirst({
  where: {
    id: targetOrderId,
    restaurant_id: currentTenant.id
  }
});

// Strictly Prohibited (Vulnerable to Cross-Tenant Leakage)
const order = await prisma.order.findUnique({
  where: { id: targetOrderId }
});
```

### 2.2 PostgreSQL Row-Level Security (RLS) Evaluation
While application-level filtering is mandatory, PostgreSQL Row-Level Security (RLS) can provide a secondary database-enforced safety net.
- **Mechanism:** `SET LOCAL app.current_tenant_id = 'tenant-uuid';` before running queries, with RLS policy: `USING (restaurant_id = current_setting('app.current_tenant_id')::uuid)`.
- **Operational Reality:** In Node.js applications with shared connection pooling (e.g., Prisma connection pools), session-level variables require explicit per-transaction reset to avoid tenant bleeding across pooled connections.
- **Architectural Decision for MVP:** Application-level scoping via Prisma client extension wrappers is adopted for MVP. RLS will be evaluated as an infrastructure safeguard once automated connection pool tenant wrappers are integrated.

---

## 3. Owner Authorization & Decision Integrity

### 3.1 Defense Against Malicious or Accidental Actions
When an incoming webhook indicates an order approval or rejection:
1. **Phone Number ID Matching:** The receiving number (`metadata.phone_number_id`) must match `restaurant.phone_number_id`.
2. **Owner Sender Validation:** The sender’s WhatsApp ID (`messages[0].from`) must strictly match `restaurant.owner_phone`. Any third party clicking buttons or replying is immediately rejected with HTTP 200 (to prevent Meta retries) and an alert logged.
3. **Cross-Tenant Guard:** The order payload contains `order_id`. RESTOPRO verifies that `orders.restaurant_id == restaurant.id`.
4. **Single Terminal Decision Guard:** Orders can transition from `PENDING_RESTAURANT_CONFIRMATION` to `ACCEPTED` or `REJECTED` **exactly once**.
```javascript
const result = await prisma.order.updateMany({
  where: {
    id: orderId,
    restaurant_id: restaurant.id,
    status: 'PENDING_RESTAURANT_CONFIRMATION' // Crucial concurrency guard
  },
  data: {
    status: decision, // 'ACCEPTED' or 'REJECTED'
    decision_at: new Date()
  }
});

if (result.count === 0) {
  // Order was already finalized or belongs to another tenant.
  return notifyOwnerDecisionAlreadyRecorded(orderId);
}
```

---

## 4. Idempotency & Webhook Deduplication

Meta webhooks adhere to at-least-once delivery guarantees. Network delays, slow server responses, or 5xx spikes trigger automatic Meta webhook retries.

### 4.1 Two-Phase Event Deduplication
1. **Extraction:** Extract `message.id` (`wamid.HBgL...`) from the webhook payload.
2. **Atomic Ingestion Check:**
```javascript
async function recordAndCheckEvent(restaurantId, eventKey, eventType) {
  try {
    const event = await prisma.webhookEvent.create({
      data: {
        restaurant_id: restaurantId,
        event_key: eventKey,
        event_type: eventType,
        processing_status: 'PROCESSING'
      }
    });
    return { isDuplicate: false, eventId: event.id };
  } catch (error) {
    if (error.code === 'P2002') { // Unique constraint violation in Prisma
      return { isDuplicate: true };
    }
    throw error;
  }
}
```
3. If `isDuplicate === true`, the event handler immediately halts processing and returns HTTP 200 OK.

---

## 5. Notification Reliability & Durable Outbox

### 5.1 The Anti-Pattern: Synchronous Messaging in DB Transactions
Never make an outbound HTTP call to Meta inside a PostgreSQL transaction. If Meta times out (10s), the database connection pool is exhausted, holding locks and stalling other customers.

### 5.2 The Solution: Persist First, Dispatch Durably
1. Customer confirms order.
2. Database transaction creates `orders` record and inserts an `order_notifications` outbox row (`status: PENDING`).
3. Database transaction commits.
4. Immediate dispatch attempt is triggered asynchronously.
5. If Meta API call succeeds, update outbox to `SENT`.
6. If Meta API fails or times out, outbox remains `PENDING` with `retry_count` incremented.
7. A lightweight Node.js background worker polls `order_notifications` every 30 seconds for pending records with exponential backoff (`delay = 2^retry_count * 1000ms`), with a maximum limit of 5 retries.

---

## 6. Structured Logging & Auditing

### 6.1 Logging Rules
- Logs must be structured JSON output to stdout for ingestion by PM2 and monitoring agents.
- Every incoming webhook is assigned an internal `correlation_id` (UUID).
- **Prohibited Data in Logs:**
  - Meta App Secret (`META_APP_SECRET`).
  - System User Access Tokens (`access_token`).
  - Full customer credit/payment details (if introduced later).
  - Webhook verify tokens.
- Customer phone numbers are masked in non-debug logs (e.g., `+91 98765 ****10`).

---

## 7. Privacy & Data Minimization

1. **Customer Address Consent:** Customer delivery addresses are saved to `saved_addresses` **only** after explicit customer confirmation (`BTN_SAVE_ADDR_YES`).
2. **Zero Global Customer Profiles:** Customer data is scoped strictly to the restaurant with which they interact.
3. **Data Retention & Expiry:**
   - Conversation sessions expire and are purged after 2 hours of inactivity.
   - Webhook audit records are purged after 30 days.
   - Orders and address snapshots are preserved for business reconciliation.
4. **Credential Security:** Meta access tokens are encrypted at rest using AES-256-GCM before database insertion.

---

## 8. Backup & Disaster Recovery Plan

1. **Daily Automated PostgreSQL Backups:** Run nightly via cron script executing `pg_dump` with gzip compression.
2. **Encrypted Offsite Storage:** Database dumps encrypted with GPG and uploaded to secondary secure object storage.
3. **Recovery Time Objective (RTO):** < 30 minutes to restore on a fresh VPS instance.
4. **Recovery Point Objective (RPO):** < 24 hours (point-in-time recovery via WAL archiving recommended for v2).

