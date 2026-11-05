# RESTOPRO — Stage 4.0: Schema Migration & Database Prerequisites Results

**Document Version:** 1.0.0  
**Status:** Complete & Verified  
**Execution Date:** 2026-11-05  
**Prisma Migration:** `20261105144500_add_stage4_prerequisites`  
**Database Engine:** PostgreSQL 18.x (`restopro_dev`)  
**ORM:** Prisma v6.19.3  

---

## 1. Executive Summary

Stage 4.0 successfully applies and verifies the three approved database schema prerequisites for the RESTOPRO Stage 4 Ordering Engine:
1. **`orders.confirmation_token`:** A dedicated nullable, unique column (`VARCHAR(128)`) providing database-enforced idempotency for customer order confirmations. Existing orders remain valid with `NULL` tokens.
2. **`webhook_events` Distributed Lease Fields:** Replaces timestamp-based leases with explicit distributed lock fields (`claimed_by`, `lease_token`, `lease_expires_at`, `attempt_count`) and a composite index for atomic batch claiming (`FOR UPDATE SKIP LOCKED`).
3. **`outbox_messages` Durable Queue Table:** A dedicated transactional outbox table (11 columns) for customer-facing WhatsApp messages, featuring unique `idempotency_key` deduplication, composite status/tenant indexes, and `ON DELETE CASCADE` foreign key referencing `restaurants`.

All 3 migrations were verified on the development database `restopro_dev` and verified from scratch on a clean audit database (`restopro_stage4_clean_audit`). Regression testing confirmed **181/181 passing assertions** across all 4 test suites with zero failures.

---

## 2. Exact Schema Changes

### 2.1 Prisma Schema Modifications (`prisma/schema.prisma`)

```prisma
// Added OutboxStatus Enum
enum OutboxStatus {
  PENDING
  ACCEPTED
  UNCERTAIN_DISPATCH
  DELIVERED
  READ
  FAILED
  SUPPRESSED
}

// Model Restaurant: Added Outbox Messages Relation
model Restaurant {
  ...
  outbox_messages        OutboxMessage[]
  ...
}

// Model Order: Added confirmation_token unique column
model Order {
  ...
  order_reference    String              @unique @db.VarChar(32)
  confirmation_token String?             @unique @db.VarChar(128)
  ...
}

// Model WebhookEvent: Added distributed worker lease fields and index
model WebhookEvent {
  ...
  claimed_by        String?        @db.VarChar(64)
  lease_token       String?        @db.Uuid
  lease_expires_at  DateTime?      @db.Timestamptz()
  attempt_count     Int            @default(0)
  ...
  @@index([processing_status])
  @@index([processing_status, lease_expires_at])
  @@map("webhook_events")
}

// Created OutboxMessage Model
model OutboxMessage {
  id              String       @id @default(uuid()) @db.Uuid
  restaurant_id   String       @db.Uuid
  recipient_phone String       @db.VarChar(32)
  message_type    String       @db.VarChar(32)
  payload         Json         @db.JsonB
  idempotency_key String       @unique @db.VarChar(128)
  status          OutboxStatus @default(PENDING)
  attempts        Int          @default(0)
  last_error      String?      @db.Text
  created_at      DateTime     @default(now()) @db.Timestamptz()
  updated_at      DateTime     @updatedAt @db.Timestamptz()

  restaurant      Restaurant   @relation(fields: [restaurant_id], references: [id], onDelete: Cascade)

  @@index([status, created_at])
  @@index([restaurant_id, status])
  @@index([restaurant_id, created_at])
  @@map("outbox_messages")
}
```

---

## 3. Migration Name & Applied SQL Summary

**Migration Directory:** `prisma/migrations/20261105144500_add_stage4_prerequisites/`  
**Migration File:** `migration.sql`

```sql
-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'ACCEPTED', 'UNCERTAIN_DISPATCH', 'DELIVERED', 'READ', 'FAILED', 'SUPPRESSED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "confirmation_token" VARCHAR(128);

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimed_by" VARCHAR(64),
ADD COLUMN     "lease_expires_at" TIMESTAMPTZ,
ADD COLUMN     "lease_token" UUID;

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "recipient_phone" VARCHAR(32) NOT NULL,
    "message_type" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_idempotency_key_key" ON "outbox_messages"("idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_messages_status_created_at_idx" ON "outbox_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbox_messages_restaurant_id_status_idx" ON "outbox_messages"("restaurant_id", "status");

-- CreateIndex
CREATE INDEX "outbox_messages_restaurant_id_created_at_idx" ON "outbox_messages"("restaurant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_confirmation_token_key" ON "orders"("confirmation_token");

-- CreateIndex
CREATE INDEX "webhook_events_processing_status_lease_expires_at_idx" ON "webhook_events"("processing_status", "lease_expires_at");

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

---

## 4. Constraints, Indexes & Foreign Keys Verified

Direct queries against PostgreSQL system catalogs (`information_schema` and `pg_indexes`) confirmed:

| Catalog Object | Type | Details | Status |
| :--- | :--- | :--- | :--- |
| `orders_confirmation_token_key` | Unique Index / Constraint | `orders(confirmation_token)` | ✅ Verified |
| `outbox_messages_idempotency_key_key` | Unique Index / Constraint | `outbox_messages(idempotency_key)` | ✅ Verified |
| `outbox_messages_status_created_at_idx` | Composite Index | `outbox_messages(status, created_at)` | ✅ Verified |
| `outbox_messages_restaurant_id_status_idx` | Composite Index | `outbox_messages(restaurant_id, status)` | ✅ Verified |
| `outbox_messages_restaurant_id_created_at_idx` | Composite Index | `outbox_messages(restaurant_id, created_at)` | ✅ Verified |
| `webhook_events_processing_status_lease_expires_at_idx` | Composite Index | `webhook_events(processing_status, lease_expires_at)` | ✅ Verified |
| `outbox_messages_restaurant_id_fkey` | Foreign Key | References `restaurants(id)` ON DELETE CASCADE | ✅ Verified |

---

## 5. Preflight Backup Confirmation

Prior to applying migrations, a full, standalone PostgreSQL backup was generated via `pg_dump`:
* **Backup Filename:** `pre_stage4_backup_1793889758991.sql`
* **File Size:** 39,144 bytes
* **Local Workspace Path:** `scratch/pre_stage4_backup_1793889758991.sql` (git-ignored)
* **Persisted Artifact Path:** `C:\Users\khano\.gemini\antigravity\brain\8a52acab-9985-4158-99de-f47d4820f523\scratch\pre_stage4_backup_1793889758991.sql`
* **Integrity:** Non-zero file size, verified valid SQL dump containing all pre-existing schema DDL and table data.

---

## 6. Development Database Verification (`restopro_dev`)

* `npx prisma migrate status` Output:
  ```
  3 migrations found in prisma/migrations
  Database schema is up to date!
  ```
* Existing Data Preservation Audit:
  * `restaurants`: 2 rows intact
  * `orders`: 2 rows intact (all pre-existing orders confirmed with `confirmation_token: null`)
  * `conversation_sessions`: 2 rows intact
  * `webhook_events`: 70 rows intact (all pre-existing records confirmed with `attempt_count: 0`, `claimed_by: null`)
  * `order_notifications`: 1 row intact

---

## 7. Clean Database Migration Verification (`restopro_stage4_clean_audit`)

To ensure reproducibility, a fresh database was initialized and migrated from scratch:
1. Created empty database `restopro_stage4_clean_audit`.
2. Executed `npx prisma migrate deploy` targeting `restopro_stage4_clean_audit`.
3. Verified sequential execution of all 3 migrations:
   * `20261105105348_init_restopro_schema`
   * `20261105121500_enforce_notification_tenant_consistency`
   * `20261105144500_add_stage4_prerequisites`
4. Verified that all 8 core tables were created:
   * `_prisma_migrations`, `restaurants`, `orders`, `conversation_sessions`, `saved_addresses`, `webhook_events`, `order_notifications`, `outbox_messages`.
5. Dropped and cleaned up `restopro_stage4_clean_audit`.

---

## 8. Automated Test & Regression Results

A dedicated test suite was implemented in `test/stage4-migration-test.js` covering all 8 specific requirements:
* **Test Group 1:** Orders — Multiple `NULL` confirmation tokens allowed (2 assertions)
* **Test Group 2:** Orders — Duplicate non-null confirmation tokens rejected with `P2002` (3 assertions)
* **Test Group 3:** Existing orders remain readable with valid nullable attribute (2 assertions)
* **Test Group 4:** Webhook lease fields (`claimed_by`, `lease_token`, `lease_expires_at`, `attempt_count`) persistence and defaults (8 assertions)
* **Test Group 5:** Outbox message creation with UUID PK, defaults, timestamps, and JSONB payload (6 assertions)
* **Test Group 6:** Outbox duplicate `idempotency_key` rejection with `P2002` (2 assertions)
* **Test Group 7:** Outbox foreign key violation rejection with `P2003` on invalid `restaurant_id` (2 assertions)
* **Test Group 8:** Tenant-scoped outbox query isolation and parent join (5 assertions)

### Master Test Suite Execution Summary
| Suite File | Target Phase | Result |
| :--- | :--- | :--- |
| `test/webhook-test.js` | Stage 1 & 1.5 Security & Webhooks | **86 / 86 PASSED** |
| `test/stage2-database-test.js` | Stage 2 & 3 Multi-Tenant DB | **59 / 59 PASSED** |
| `test/graceful-shutdown-test.js` | Stage 3 Child Process Shutdown | **6 / 6 PASSED** |
| `test/stage4-migration-test.js` | Stage 4.0 Schema Prerequisites | **30 / 30 PASSED** |
| **Total Test Assertions** | **All Stages (1.0 to 4.0)** | **181 / 181 PASSED (0 failures)** |

---

## 9. Rollback Procedure & Limitations

### 9.1 Point-in-Time Database Restore (Recommended)
If rollback is required prior to production usage:
```bash
# Terminate existing connections and restore from the verified pre-migration backup
psql -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'restopro_dev';"
psql -U postgres -d postgres -c "DROP DATABASE restopro_dev;"
psql -U postgres -d postgres -c "CREATE DATABASE restopro_dev;"
psql -U postgres -d restopro_dev -f scratch/pre_stage4_backup_1793889758991.sql
```

### 9.2 Reversible SQL Rollback Script
If restoring from dump is not desired, the following DDL reverses migration `20261105144500_add_stage4_prerequisites`:
```sql
-- Drop Outbox Messages table and constraints
DROP TABLE IF EXISTS "outbox_messages";

-- Drop OutboxStatus Enum
DROP TYPE IF EXISTS "OutboxStatus";

-- Remove lease index and columns from webhook_events
DROP INDEX IF EXISTS "webhook_events_processing_status_lease_expires_at_idx";
ALTER TABLE "webhook_events" 
  DROP COLUMN IF EXISTS "attempt_count",
  DROP COLUMN IF EXISTS "claimed_by",
  DROP COLUMN IF EXISTS "lease_expires_at",
  DROP COLUMN IF EXISTS "lease_token";

-- Remove unique constraint and column from orders
DROP INDEX IF EXISTS "orders_confirmation_token_key";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "confirmation_token";

-- Remove migration record from Prisma tracking table
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105144500_add_stage4_prerequisites';
```

### 9.3 Rollback Limitations
* Dropping `outbox_messages` irreversibly destroys any queued or dispatched customer message history created during testing.
* Dropping `confirmation_token` removes token-level duplicate confirmation protections.

---

## 10. Assumptions & Verification Status

* **Status Enum:** `OutboxStatus` contains the 7 states defined in the approved Stage 4 architecture (`PENDING`, `ACCEPTED`, `UNCERTAIN_DISPATCH`, `DELIVERED`, `READ`, `FAILED`, `SUPPRESSED`).
* **Tenant Relationship:** `outbox_messages.restaurant_id` enforces `ON DELETE CASCADE` consistent with session and notification queue tables.
* **Feature Scope:** Zero business logic (cart, conversational state machine, WhatsApp dispatch, recovery workers) was implemented.
* **Checklist Status:** Items `ST4-01` through `ST4-14` remain strictly unchecked (`[ ]`).

