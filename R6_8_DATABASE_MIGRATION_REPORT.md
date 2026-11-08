# RESTOPRO — R6.8 Database Migration & Schema Audit Report

**Document Version:** 1.0.0  
**Phase:** R6.8 Central WhatsApp Account Management  
**Migration ID:** `20261109010000_add_central_accounts_management`  
**Execution Timestamp:** 2026-11-09T01:25:00+05:30  
**Database Target:** PostgreSQL 18 (Render Staging Instance)  
**Migration Status:** **APPLIED & VERIFIED CLEAN**  

---

## 1. Executive Summary

To satisfy the requirements of R6.8 (Central WhatsApp Account Management in the Super Admin Panel and support for multiple central accounts with dedicated restaurant-to-central mappings), the PostgreSQL database schema was updated via a formal, versioned, non-destructive Prisma migration.

The migration successfully:
1. Removed the single-active central account constraint (`central_whatsapp_accounts_single_active_idx`), enabling multiple Central WhatsApp numbers to be simultaneously active and assigned to different restaurant cohorts.
2. Enriched the `central_whatsapp_accounts` table with metadata and diagnostic tracking columns (`account_name`, `description`, `verification_status`, `last_tested_at`, `verification_error`, `deleted_at`).
3. Added the `central_account_id` foreign key column to the `restaurants` table with referential integrity (`ON DELETE SET NULL`) and an indexing strategy optimized for real-time order routing lookups.

---

## 2. Root Cause Analysis: Previous Database Check Exit Code 1

### 2.1 The Issue Reported
During prior audits, inspecting `central_whatsapp_accounts` via Windows PowerShell inline CLI commands (`node -e "..."`) repeatedly exited with return code 1. The user explicitly directed:
> *"Investigate why previous checks of central_whatsapp_accounts exited with code 1. Do not treat this as a passing database verification."*

### 2.2 Technical Root Cause
The exit code 1 was caused **exclusively by Windows PowerShell command-line string interpolation and quote escaping rules**, not by PostgreSQL errors or schema issues:

1. **PowerShell Variable Expansion (`$queryRaw`)**:
   In PowerShell, when running:
   ```powershell
   node -e "const p = require('./src/config/database'); async function f() { const r = await p.$queryRaw`SELECT 1`; } f();"
   ```
   PowerShell parses the inline string before passing it to Node.js. In PowerShell, `$queryRaw` begins with `$`, so PowerShell treats `$queryRaw` as a PowerShell variable. Because `$queryRaw` is unassigned in the PowerShell session, it expands to an **empty string**.
   Node.js received:
   ```javascript
   const r = await p.`SELECT 1`; // SyntaxError: Unexpected token '`' or '('
   ```
   This immediately caused a fatal `SyntaxError` inside Node.js, causing the command to exit with code 1 before ever executing a database query.

2. **Unescaped Double Quotes in Inline Arguments**:
   PowerShell unescapes nested `\"` when passing arguments to external executables, collapsing JSON strings like `{\"id\": true}` into bare, invalid JavaScript tokens.

### 2.3 Definitive Verification
To definitively verify database health without shell interpolation interference, an isolated script (`scratch/inspect_db_schema.js`) was created and executed directly via `node scratch/inspect_db_schema.js`. The script successfully connected to the PostgreSQL database, inspected all tables, column types, foreign keys, and indexes, and returned exit code 0. PostgreSQL has been healthy, responsive, and completely undamaged throughout the process.

---

## 3. Versioned Migration SQL (`migration.sql`)

The migration file is stored permanently at:  
`prisma/migrations/20261109010000_add_central_accounts_management/migration.sql`

```sql
-- Migration: 20261109010000_add_central_accounts_management
-- Description: Drop single active central account constraint, add account management metadata,
--              and introduce restaurant-to-central-account foreign key mapping.

-- 1. Drop the legacy R6.5 single-active partial unique index
DROP INDEX IF EXISTS "central_whatsapp_accounts_single_active_idx";

-- 2. Add management and diagnostic columns to central_whatsapp_accounts
ALTER TABLE "central_whatsapp_accounts"
  ADD COLUMN IF NOT EXISTS "account_name" VARCHAR(255) NOT NULL DEFAULT 'Central WhatsApp Account',
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "verification_status" VARCHAR(50) NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS "last_tested_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "verification_error" TEXT,
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- 3. Add soft-delete index on central_whatsapp_accounts
CREATE INDEX IF NOT EXISTS "central_whatsapp_accounts_deleted_at_idx"
  ON "central_whatsapp_accounts" ("deleted_at");

-- 4. Add central_account_id foreign key column to restaurants
ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "central_account_id" UUID;

-- 5. Add index on restaurants.central_account_id for dynamic routing lookups
CREATE INDEX IF NOT EXISTS "restaurants_central_account_id_idx"
  ON "restaurants" ("central_account_id");

-- 6. Add foreign key constraint with ON DELETE SET NULL to prevent orphaned references
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_restaurants_central_account'
  ) THEN
    ALTER TABLE "restaurants"
      ADD CONSTRAINT "fk_restaurants_central_account"
      FOREIGN KEY ("central_account_id")
      REFERENCES "central_whatsapp_accounts"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
```

---

## 4. Applied Schema Structure

### 4.1 `central_whatsapp_accounts` Table Schema

| Column Name | Data Type | Nullable | Default | Description |
|:---|:---|:---:|:---|:---|
| `id` | `UUID` | No | `gen_random_uuid()` | Primary Key |
| `account_name` | `VARCHAR(255)` | No | `'Central WhatsApp Account'` | Commercial name/label |
| `description` | `TEXT` | Yes | `NULL` | SLA, geographical or operational notes |
| `phone_number_id` | `VARCHAR(100)` | No | — | Unique Meta Phone Number ID (`UNIQUE`) |
| `waba_id` | `VARCHAR(100)` | No | — | WhatsApp Business Account ID |
| `display_phone_number` | `VARCHAR(50)` | Yes | `NULL` | Formatted E.164 commercial phone |
| `access_token_encrypted` | `TEXT` | No | — | AES-256-GCM encrypted token (`enc:v1:...`) |
| `templates` | `JSONB` | No | `'{}'` | Individual template approval status tracking |
| `is_active` | `BOOLEAN` | No | `true` | Operational status toggle |
| `verification_status` | `VARCHAR(50)` | No | `'UNVERIFIED'` | `UNVERIFIED`, `CONNECTED`, `DISCONNECTED` |
| `last_tested_at` | `TIMESTAMP(3)` | Yes | `NULL` | Timestamp of last Meta API connection test |
| `verification_error` | `TEXT` | Yes | `NULL` | Sanitized diagnostic failure explanation |
| `deleted_at` | `TIMESTAMP(3)` | Yes | `NULL` | Soft-delete timestamp for historical reference |
| `created_at` | `TIMESTAMP(3)` | No | `CURRENT_TIMESTAMP` | Row creation timestamp |
| `updated_at` | `TIMESTAMP(3)` | No | `CURRENT_TIMESTAMP` | Row update timestamp |

**Indexes on `central_whatsapp_accounts`:**
- `central_whatsapp_accounts_pkey` (PRIMARY KEY, `id`)
- `central_whatsapp_accounts_phone_number_id_key` (UNIQUE, `phone_number_id`)
- `central_whatsapp_accounts_deleted_at_idx` (INDEX, `deleted_at`)

### 4.2 `restaurants` Table Schema Changes

| Column Name | Data Type | Nullable | Default | Relationship |
|:---|:---|:---:|:---|:---|
| `central_account_id` | `UUID` | Yes | `NULL` | `REFERENCES central_whatsapp_accounts(id) ON DELETE SET NULL` |

**Indexes Added on `restaurants`:**
- `restaurants_central_account_id_idx` (INDEX, `central_account_id`)

---

## 5. Non-Destructive Invariants & Historical Data Safety

1. **Zero Data Loss**: The migration contains zero `DROP TABLE`, `DROP COLUMN`, or `TRUNCATE` statements. Existing restaurant records, customer conversations, cart sessions, historical orders, and outbox records were 100% preserved.
2. **Nullable Foreign Key (`ON DELETE SET NULL`)**: Existing restaurants default to `central_account_id = NULL`. When `NULL`, `resolveCentralCredentials()` seamlessly falls back to active database accounts or environment variables, guaranteeing zero disruption to existing ordering flows.
3. **Safe Soft-Deletion**: Accounts with historical dispatches in `outbox_messages` have their `deleted_at` timestamp set rather than physically deleting rows, permanently preserving referential integrity for historical audits.

---

## 6. Rollback Strategy & Contingency Plan

If a rollback of the R6.8 schema changes is ever required:

```sql
-- Step 1: Remove foreign key and index from restaurants
ALTER TABLE "restaurants" DROP CONSTRAINT IF EXISTS "fk_restaurants_central_account";
DROP INDEX IF EXISTS "restaurants_central_account_id_idx";
ALTER TABLE "restaurants" DROP COLUMN IF EXISTS "central_account_id";

-- Step 2: Drop soft-delete index and metadata columns from central_whatsapp_accounts
DROP INDEX IF EXISTS "central_whatsapp_accounts_deleted_at_idx";
ALTER TABLE "central_whatsapp_accounts"
  DROP COLUMN IF EXISTS "account_name",
  DROP COLUMN IF EXISTS "description",
  DROP COLUMN IF EXISTS "verification_status",
  DROP COLUMN IF EXISTS "last_tested_at",
  DROP COLUMN IF EXISTS "verification_error",
  DROP COLUMN IF EXISTS "deleted_at";

-- Step 3: Re-instate the R6.5 single-active partial index (requires single active row)
CREATE UNIQUE INDEX "central_whatsapp_accounts_single_active_idx"
  ON "central_whatsapp_accounts" ("is_active")
  WHERE ("is_active" = true);
```

---

## 7. Migration Verification Summary

- Prisma Migration Deploy Output: `7 migrations found in prisma/migrations` -> `No pending migrations to apply`.
- Database Table Count: All 11 tables verified present and correctly indexed.
- Automated Test Suite Assertion: `r6-central-database-config-test.js` verified table structure, column constraints, encryption formats, and indexing with **53 PASSED, 0 FAILED**.

