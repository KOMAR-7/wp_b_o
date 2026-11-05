# RESTOPRO — Stage 2: Database Migration Results

**Migration Execution Date:** 2026-11-05  
**Tooling:** Prisma Migrate (v6.19.3)  
**Target Engine:** PostgreSQL 18.x (localhost:5432)  
**Database:** `restopro_dev`  

---

## 1. Migration Execution Summary

The initial baseline schema migration was generated and applied cleanly against the `restopro_dev` database:

```text
Environment variables loaded from .env
Prisma schema loaded from prisma\schema.prisma
Datasource "db": PostgreSQL database "restopro_dev", schema "public" at "localhost:5432"

Applying migration `20261105105348_init_restopro_schema`

The following migration(s) have been created and applied from new schema changes:

prisma\migrations/
  └─ 20261105105348_init_restopro_schema/
    └─ migration.sql

Your database is now in sync with your schema.

Running generate... (Use --skip-generate to skip the generators)
Running generate... - Prisma Client
✔ Generated Prisma Client (v6.19.3) to .\node_modules\@prisma\client in 191ms
```

---

## 2. Database Entities Created

### 2.1 Enums Created (4)
- `"OrderType"` (`DELIVERY`, `TAKEAWAY`)
- `"OrderStatus"` (`PENDING_RESTAURANT_CONFIRMATION`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `CANCELLED`)
- `"WebhookStatus"` (`RECEIVED`, `PROCESSING`, `COMPLETED`, `FAILED`, `DUPLICATE`)
- `"NotificationStatus"` (`PENDING`, `SENT`, `FAILED`)

### 2.2 Relational Tables Created (6)
1. `"restaurants"` (Tenant master configuration table)
2. `"orders"` (Submitted orders with JSONB line-item snapshots)
3. `"conversation_sessions"` (Session state machine table)
4. `"saved_addresses"` (Customer consented address book)
5. `"webhook_events"` (Idempotency and incoming payload audit trail)
6. `"order_notifications"` (Durable notification outbox queue)

### 2.3 Unique Constraints & Composite Keys (5)
- `restaurants_phone_number_id_key` (`UNIQUE (phone_number_id)`)
- `orders_order_reference_key` (`UNIQUE (order_reference)`)
- `conversation_sessions_restaurant_id_customer_phone_key` (`UNIQUE (restaurant_id, customer_phone)`)
- `webhook_events_event_key_key` (`UNIQUE (event_key)`)
- Primary keys on all 6 tables using `UUID`

### 2.4 Performance & Query Indexes (6)
- `orders_restaurant_id_status_idx` on `(restaurant_id, status)`
- `orders_restaurant_id_customer_phone_idx` on `(restaurant_id, customer_phone)`
- `conversation_sessions_expires_at_idx` on `(expires_at)`
- `saved_addresses_restaurant_id_customer_phone_idx` on `(restaurant_id, customer_phone)`
- `webhook_events_processing_status_idx` on `(processing_status)`
- `order_notifications_delivery_status_retry_count_idx` on `(delivery_status, retry_count)`

### 2.5 Foreign Key Constraints & Cascade Rules (6)
- `orders_restaurant_id_fkey`: `REFERENCES restaurants(id) ON DELETE RESTRICT`
- `conversation_sessions_restaurant_id_fkey`: `REFERENCES restaurants(id) ON DELETE CASCADE`
- `saved_addresses_restaurant_id_fkey`: `REFERENCES restaurants(id) ON DELETE CASCADE`
- `webhook_events_restaurant_id_fkey`: `REFERENCES restaurants(id) ON DELETE SET NULL`
- `order_notifications_order_id_fkey`: `REFERENCES orders(id) ON DELETE CASCADE`
- `order_notifications_restaurant_id_fkey`: `REFERENCES restaurants(id) ON DELETE CASCADE`
