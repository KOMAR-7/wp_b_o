# RESTOPRO — Stage 2: Database Schema & Entity Reference

**Document Version:** 1.0.0  
**Target Engine:** PostgreSQL 15+  
**ORM:** Prisma v6.19.3  

---

## 1. Schema Design Principles

1. **Shared-Database Multi-Tenancy:** Single PostgreSQL instance with shared tables.
2. **Mandatory Tenant Scoping:** Every tenant-owned table contains `restaurant_id UUID NOT NULL REFERENCES restaurants(id)`.
3. **UUID Primary Keys:** All tables use cryptographically random UUID primary keys (`gen_random_uuid()` / Prisma `@default(uuid())`).
4. **Referential Cascade Invariants:**
   - Deleting a restaurant with existing submitted orders is strictly **restricted** (`ON DELETE RESTRICT`) to prevent accidental financial/audit data loss.
   - Sessions, saved addresses, and notification records cascade delete (`ON DELETE CASCADE`) if a restaurant is purged.
   - Webhook events preserve audit records with `ON DELETE SET NULL`.
5. **No Deviations:** This implementation adheres 100% to the approved blueprint in [`docs/03-DATABASE-DESIGN.md`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/03-DATABASE-DESIGN.md).

---

## 2. Table Specifications

### 2.1 `restaurants` (Tenant Registry)
| Column | Type | Nullable | Constraints / Defaults | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `UUID` | No | `PRIMARY KEY` | Internal tenant UUID. |
| `name` | `VARCHAR(255)` | No | None | Restaurant business name. |
| `phone_number_id` | `VARCHAR(64)` | No | `UNIQUE` | Meta WhatsApp Cloud API Phone Number ID. |
| `waba_id` | `VARCHAR(64)` | No | None | Meta WhatsApp Business Account ID. |
| `owner_phone` | `VARCHAR(32)` | No | None | Owner WhatsApp number with country code. |
| `access_token_encrypted` | `TEXT` | No | None | Encrypted permanent Meta access token. |
| `is_active` | `BOOLEAN` | No | Default `TRUE` | Soft kill switch for restaurant automation. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | Registration timestamp. |
| `updated_at` | `TIMESTAMPTZ` | No | Auto-updated | Configuration update timestamp. |

---

### 2.2 `orders` (Immutable Submitted Orders)
| Column | Type | Nullable | Constraints / Defaults | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `UUID` | No | `PRIMARY KEY`, Composite unique with `restaurant_id` | Internal order UUID. |
| `restaurant_id` | `UUID` | No | `FK -> restaurants(id) ON DELETE RESTRICT` | Owning restaurant tenant. |
| `order_reference` | `VARCHAR(32)` | No | `UNIQUE` | Human-friendly order identifier (e.g. `RP-1024`). |
| `customer_name` | `VARCHAR(255)` | Yes | None | Customer display name from WhatsApp. |
| `customer_phone` | `VARCHAR(32)` | No | Indexed with `restaurant_id` | Customer WhatsApp phone number. |
| `address_snapshot` | `TEXT` | Yes | None | Full text address captured at order time. |
| `latitude` | `DECIMAL(10, 7)` | Yes | None | GPS latitude coordinate. |
| `longitude` | `DECIMAL(10, 7)` | Yes | None | GPS longitude coordinate. |
| `order_type` | `ENUM('DELIVERY', 'TAKEAWAY')` | No | None | Fulfillment method. |
| `items` | `JSONB` | No | None | Immutable snapshot of line items, SKUs, and unit prices. |
| `total_amount` | `DECIMAL(10, 2)` | No | None | Calculated order total amount. |
| `currency` | `CHAR(3)` | No | Default `'INR'` | ISO 4217 currency code. |
| `status` | `ENUM('PENDING_RESTAURANT_CONFIRMATION', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED')` | No | Default `'PENDING_RESTAURANT_CONFIRMATION'` | Order state. |
| `decision_at` | `TIMESTAMPTZ` | Yes | None | Owner decision timestamp. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | Submission timestamp. |
| `updated_at` | `TIMESTAMPTZ` | No | Auto-updated | Update timestamp. |

---

### 2.3 `conversation_sessions` (Transient Checkout State Machine)
| Column | Type | Nullable | Constraints / Defaults | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `UUID` | No | `PRIMARY KEY` | Internal session UUID. |
| `restaurant_id` | `UUID` | No | `FK -> restaurants(id) ON DELETE CASCADE` | Associated restaurant tenant. |
| `customer_phone` | `VARCHAR(32)` | No | Composite unique with `restaurant_id` | Customer phone number. |
| `current_step` | `VARCHAR(64)` | No | Default `'IDLE'` | State machine stage. |
| `state` | `JSONB` | No | Default `'{}'` | Checkout cache (cart, address, order type). |
| `expires_at` | `TIMESTAMPTZ` | No | None | Inactivity expiration boundary. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | Inception timestamp. |
| `updated_at` | `TIMESTAMPTZ` | No | Auto-updated | Last activity timestamp. |

---

### 2.4 `saved_addresses` (Consented Customer Addresses)
| Column | Type | Nullable | Constraints / Defaults | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `UUID` | No | `PRIMARY KEY` | Internal address UUID. |
| `restaurant_id` | `UUID` | No | `FK -> restaurants(id) ON DELETE CASCADE` | Associated restaurant tenant. |
| `customer_phone` | `VARCHAR(32)` | No | Indexed with `restaurant_id` | Customer phone number. |
| `label` | `VARCHAR(64)` | Yes | Default `'Default'` | Label (e.g. "Home", "Office"). |
| `address` | `TEXT` | No | None | Formatted text address. |
| `latitude` | `DECIMAL(10, 7)` | Yes | None | Latitude coordinate. |
| `longitude` | `DECIMAL(10, 7)` | Yes | None | Longitude coordinate. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | Consent timestamp. |
| `updated_at` | `TIMESTAMPTZ` | No | Auto-updated | Modification timestamp. |

---

### 2.5 `webhook_events` (Durable Idempotency & Audit Store)
| Column | Type | Nullable | Constraints / Defaults | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `UUID` | No | `PRIMARY KEY` | Internal event UUID. |
| `restaurant_id` | `UUID` | Yes | `FK -> restaurants(id) ON DELETE SET NULL` | Resolved tenant UUID. |
| `event_key` | `VARCHAR(128)` | No | `UNIQUE` | Meta message ID (`wamid.HBgL...`). |
| `event_type` | `VARCHAR(32)` | No | None | `text`, `order`, `location`, `button`, etc. |
| `payload_summary` | `JSONB` | Yes | None | Minimized audit metadata. |
| `processing_status` | `ENUM('RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DUPLICATE')` | No | Default `'RECEIVED'` | Event lifecycle state. |
| `received_at` | `TIMESTAMPTZ` | No | `NOW()` | Ingestion timestamp. |
| `processed_at` | `TIMESTAMPTZ` | Yes | None | Completion timestamp. |

---

### 2.6 `order_notifications` (Durable Outbox Queue)
| Column | Type | Nullable | Constraints / Defaults | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `UUID` | No | `PRIMARY KEY` | Outbox notification UUID. |
| `order_id` | `UUID` | No | `FK -> orders(id, restaurant_id) ON DELETE CASCADE` | Associated order (enforced with tenant consistency). |
| `restaurant_id` | `UUID` | No | `FK -> restaurants(id) ON DELETE CASCADE` | Associated tenant. |
| `recipient_phone` | `VARCHAR(32)` | No | None | Target phone number. |
| `notification_type` | `VARCHAR(32)` | No | None | Notification category. |
| `template_name` | `VARCHAR(64)` | Yes | None | Meta template identifier. |
| `delivery_status` | `ENUM('PENDING', 'SENT', 'FAILED')` | No | Default `'PENDING'` | Dispatch status. |
| `retry_count` | `INT` | No | Default `0` | Outbox attempt count. |
| `error_message` | `TEXT` | Yes | None | Failure details. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | Queue timestamp. |
| `sent_at` | `TIMESTAMPTZ` | Yes | None | Delivery timestamp. |

> [!IMPORTANT]
> **Stage 3 Hardened Multi-Tenant Invariant:** `order_notifications` enforces a composite foreign key `(order_id, restaurant_id) REFERENCES orders(id, restaurant_id)`. It is physically impossible at the database engine level for a notification to reference an order belonging to another restaurant.

