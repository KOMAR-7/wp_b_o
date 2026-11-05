# RESTOPRO — Stage 5.1: Owner Notification & Outbox Dispatch Results

**Document Version:** 1.0.0  
**Stage:** 5.1 — Owner Notification & Outbox Dispatch  
**Date:** 2026-11-05  
**Author:** RESTOPRO Engineering Team  
**Status:** APPROVED & FULLY VERIFIED  

---

## 1. Executive Summary

Stage 5.1 implements the resilient, multi-tenant owner notification and asynchronous outbox dispatch system for RESTOPRO. When a customer confirms an order on WhatsApp, the backend atomically creates the customer's order, an owner notification tracking record, and a durable outbox message within a single database transaction. Outbound WhatsApp messages are dispatched reliably using a distributed PostgreSQL worker claiming pattern (`FOR UPDATE SKIP LOCKED`) with worker fencing tokens, bounded retries, and strict secret redaction.

All **60 out of 60 test assertions passed** in the dedicated Stage 5.1 test suite, and the full regression test harness completed with **555 out of 555 passed assertions (100% success rate)** across all test suites.

---

## 2. Core Architecture & Implementation

### 2.1 Atomic Order & Outbox Persistence (`ST5-01`)
To eliminate phantom orders and orphaned notifications, order persistence and notification queuing occur inside a single PostgreSQL transaction (`tx`):

```javascript
// src/services/order.service.js
await prisma.$transaction(async (tx) => {
  // 1. Create order with collision retry
  const order = await createOrderWithReferenceRetry(tx, orderData);

  // 2. Resolve owner phone from restaurant record
  const ownerPhone = restaurant.owner_phone ? restaurant.owner_phone.trim() : null;

  // 3. Build interactive WhatsApp payload
  const notifPayload = buildOwnerNotificationPayload({
    ownerPhone,
    order,
    restaurantName: restaurant.name
  });

  // 4. Atomically insert OutboxMessage with deterministic idempotency key
  const outboxMessage = await tx.outboxMessage.create({
    data: {
      restaurant_id: restaurant.id,
      recipient_phone: ownerPhone,
      message_type: 'OWNER_ORDER_NOTIFICATION',
      payload: notifPayload,
      idempotency_key: `owner_notif_${order.id}`,
      status: 'PENDING'
    }
  });

  // 5. Atomically insert OrderNotification tracking record
  await tx.orderNotification.create({
    data: {
      order_id: order.id,
      restaurant_id: restaurant.id,
      recipient_phone: ownerPhone,
      delivery_status: 'PENDING'
    }
  });
});
```

- **Rollback Guarantee:** If the outbox insertion fails for any reason (e.g., foreign key violation, disk/DB error), the transaction is aborted and rolled back cleanly—leaving zero leaked order rows in the database.
- **Idempotency Guarantee:** The unique constraint `outbox_messages_idempotency_key_key` on `owner_notif_${order.id}` ensures that duplicate confirmation requests from network retries or double clicks return the existing order without creating duplicate outbox records.

### 2.2 Owner Notification Payload & Security (`ST5-02`)
The owner notification is formatted as an interactive WhatsApp message containing quick-action buttons for restaurant owners:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": {
      "text": "🔔 *NEW ORDER RECEIVED*\\n\\n*Ref:* RP-261105-XXXX\\n*Customer:* Saeem (9198311XXXXX)..."
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": {
            "id": "OWNER_ACCEPT:<order_id>",
            "title": "✅ Accept"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "OWNER_REJECT:<order_id>",
            "title": "❌ Reject"
          }
        }
      ]
    }
  }
}
```

- **Token Protection:** The customer's internal `confirmation_token` is never included in the owner notification payload, body text, or button IDs. Only the public `order_reference` and internal `order.id` UUID are referenced.
- **Tenant Isolation:** The owner's WhatsApp number is resolved directly from the tenant record (`Restaurant.owner_phone`), ensuring Tenant A's orders can never be routed to Tenant B's owner.

### 2.3 Distributed Outbox Dispatcher (`src/services/outbox.service.js`)
The outbox dispatch engine is designed for high concurrency, horizontal worker scalability, and failure recovery:

1. **Atomic Batch Claiming (`FOR UPDATE SKIP LOCKED`):**
   ```sql
   SELECT id, restaurant_id, recipient_phone, message_type, payload, idempotency_key, status, attempts
   FROM outbox_messages
   WHERE (
     (status = 'PENDING' AND attempts < 5)
     OR (status = 'UNCERTAIN_DISPATCH' AND attempts < 5 AND (
       (payload->'lease'->>'lease_expires_at') IS NULL 
       OR (payload->'lease'->>'lease_expires_at')::timestamptz < NOW()
     ))
   )
   AND (
     (payload->'lease'->>'lease_expires_at') IS NULL
     OR (payload->'lease'->>'lease_expires_at')::timestamptz < NOW()
   )
   ORDER BY created_at ASC
   LIMIT 10
   FOR UPDATE SKIP LOCKED;
   ```
   Multiple workers running concurrently claim disjoint sets of messages without lock contention or duplicate dispatches.

2. **Lease Fencing:**
   Each claim generates a unique `lease_token` (UUID) stored in `payload.lease` alongside `lease_expires_at` (default 60s TTL). When a worker completes its HTTP dispatch, `updateOutboxResult` verifies that the row's `lease_token` still matches. If the lease expired and a fresh worker reclaimed the message, the stale worker is safely rejected with `FENCED_OUT`, preventing state corruption.

3. **Transaction Boundary Separation:**
   The database connection is never held open during the external Meta Cloud API HTTP call. The claim runs in a short transaction (~5ms), the HTTP call executes outside any transaction (~200–2000ms), and the outcome is committed in a separate fenced transaction (~5ms).

4. **Outcome Classification & Bounded Retries:**
   - **HTTP 200 (Success):** Status transitions to `ACCEPTED`, `payload.meta_message_id` is recorded from Meta's response (`wamid`), and `order_notifications.delivery_status` updates to `SENT`.
   - **Timeout (Network Error / Socket Timeout):** Status transitions to `UNCERTAIN_DISPATCH` to prevent immediate duplicate sends while Meta might have processed the request.
   - **HTTP 4xx (Client Error):** Status transitions to `FAILED` (non-retryable).
   - **HTTP 5xx (Server Error):** Status returns to `PENDING` with incremented `attempts`. If `attempts >= maxAttempts` (default 5), the message transitions to `FAILED`.

5. **Token Redaction:**
   All Meta API access tokens, secrets, and auth headers are sanitized via `sanitizeForLog` before being recorded in error strings, console logs, or database rows (`last_error`).

---

## 3. Test Suite & Verification Results

### 3.1 Stage 5.1 Test Suite Breakdown (`test/stage5-owner-outbox-test.js`)

| Group | Focus | Assertions | Result |
| :--- | :--- | :---: | :---: |
| **Group 1** | Atomic Order & Outbox Persistence & Rollback | 14 / 14 | ✅ PASSED |
| **Group 2** | Notification Content, Security & Token Protection | 18 / 18 | ✅ PASSED |
| **Group 3** | Outbox Dispatcher, Leases & Worker Fencing | 10 / 10 | ✅ PASSED |
| **Group 4** | WhatsApp Cloud API Dispatch, Timeouts & Error Handling | 18 / 18 | ✅ PASSED |
| **Total** | **Stage 5.1 Dedicated Test Suite** | **60 / 60** | **✅ 100% PASSED** |

### 3.2 Full Regression Test Suite Summary

| Test Script | Description | Assertions | Result |
| :--- | :--- | :---: | :---: |
| `npm run test:webhook` | Stage 1.5 Webhook HMAC security & parsing | 86 / 86 | ✅ PASSED |
| `npm run test:stage2` | Stage 2 Multi-tenant isolation & DB constraints | 59 / 59 | ✅ PASSED |
| `npm run test:stage4:migration` | Stage 4.0 Schema migrations & indexes | 30 / 30 | ✅ PASSED |
| `npm run test:stage4:cart` | Stage 4.1 Catalogue cart processing & validation | 88 / 88 | ✅ PASSED |
| `npm run test:stage4:conversation` | Stage 4.2 Conversation state machine & reminders | 52 / 52 | ✅ PASSED |
| `npm run test:stage4:address` | Stage 4.3 Address collection, GPS & consent | 116 / 116 | ✅ PASSED |
| `npm run test:stage4:fulfilment` | Stage 4.4 Fulfilment selection & order review | 58 / 58 | ✅ PASSED |
| `npm run test:stage5:outbox` | Stage 5.1 Owner notification & outbox dispatch | 60 / 60 | ✅ PASSED |
| `npm run test:shutdown` | Graceful shutdown & connection cleanup | 6 / 6 | ✅ PASSED |
| **Combined** | **Full System Regression Harness** | **555 / 555** | **✅ 100% PASSED** |

---

## 4. Key Files Created / Modified

- `src/services/whatsapp.service.js` — WhatsApp Cloud API messaging client, restaurant credential resolver, owner notification payload builder, and token-redacted HTTP dispatcher.
- `src/services/outbox.service.js` — Distributed outbox queue service with `FOR UPDATE SKIP LOCKED` claiming, lease tokens, fenced result updates, and bounded backoff.
- `src/services/order.service.js` — Updated `confirmCustomerOrder` to atomically persist `Order`, `OutboxMessage`, and `OrderNotification` in the same transaction.
- `test/stage5-owner-outbox-test.js` — Comprehensive test suite covering atomic rollbacks, replay deduplication, worker claiming, fencing, timeouts, and redaction.
- `package.json` — Added `"test:stage5:outbox"` script.
- `docs/07-IMPLEMENTATION-CHECKLIST.md` — Marked `ST5-01` and `ST5-02` completed (`[x]`).

---

## 5. Scope Boundary Confirmation

Stage 5.1 is complete. As required by project specifications:
- **Zero Owner Accept/Reject Webhook Processing:** Incoming owner button clicks are strictly reserved for Stage 5.2.
- **Zero Customer Decision Notifications:** Dispatching acceptance or rejection messages to customers is reserved for Stage 5.3.
- **Zero Git Commits or Pushes:** No unapproved git operations performed.
- **Zero Unapproved Schema Changes:** Utilized existing Prisma schema and Stage 4.0 database migration.

