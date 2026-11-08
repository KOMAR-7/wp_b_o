# RESTOPRO — R6.8 CENTRAL WHATSAPP ACCOUNT MANAGEMENT AUDIT

**Audit Date:** November 9, 2026  
**Auditor:** RestPro Architecture & Engineering Team  
**Scope:** Super Admin Central WhatsApp Account Management Module (UI, APIs, Schema, Routing & Multi-Tenant Isolation)

---

## Executive Summary

Task **R6.8** requires implementing a complete **Central WhatsApp Account Management** module inside the existing RestPro Super Admin Panel. The module must allow Super Admins to view, add, edit, test connection, activate, deactivate, and safely delete Central WhatsApp accounts, as well as assign restaurant tenants to specific central accounts.

This audit evaluates the codebase following **R6.7** to determine existing capabilities, reuse opportunities, schema constraints, and the gap between current state and R6.8 requirements.

---

## 1. Core Architectural Questions & Findings

### Q1: What is already implemented?
- **Database Model:** `CentralWhatsAppAccount` table exists in PostgreSQL with columns `id`, `phone_number_id` (unique), `waba_id`, `display_phone_number`, `access_token_encrypted`, `templates` (JSONB), `is_active`, `created_at`, `updated_at`.
- **Encryption:** Authenticated AES-256-GCM encryption (`src/utils/crypto.js`) is used for access token encryption/decryption.
- **Service Layer:** `src/services/central-whatsapp.service.js` provides `createCentralAccount`, `getActiveCentralAccount`, `getCentralAccountById`, `updateCentralAccount`, `deactivateCentralAccount`, `resolveCentralCredentials`, and `sanitizeCentralAccount`.
- **Template System:** `src/services/template-config.service.js` manages copy-ready schemas, per-template status checks (`isTemplateApproved`), Meta Graph API submissions, and live Graph API verification.
- **Routing Engine:** Dual-channel routing (`RESTAURANT` vs `CENTRAL`) in `src/services/order.service.js` and `src/services/outbox.service.js`.
- **Webhook Ingestion:** `src/controllers/webhook.controller.js` routes central number events without tenant phone matching, extracting tenant identity from the signed order callback.

### Q2: Which APIs can be reused?
- **Existing Routes:** Mounted under `/api/admin/central-account` in `src/routes/admin-central-account.routes.js`.
- **Existing Handlers to Reuse/Extend:**
  - `handleTestConnection` (`POST /api/admin/central-account/test-connection` and `/api/admin/central-accounts/:id/test-connection`).
  - `handleGetTemplates`, `handleGetTemplateDefinitions`, `handleUpdateTemplate`, `handleSubmitTemplatesToMeta`, `handleVerifyTemplatesWithMeta`.
  - Super Admin Auth Middleware (`requireSuperAdminAuth`) and Rate Limiter (`centralConnectionTestRateLimiter`).
- **Required New/Plural Endpoints:**
  - `GET /api/admin/central-accounts` (List all accounts with summary metrics, restaurant counts, status).
  - `GET /api/admin/central-accounts/:id` (Get single account details).
  - `POST /api/admin/central-accounts` (Create account).
  - `PATCH /api/admin/central-accounts/:id` (Update account details, optional token rotation).
  - `POST /api/admin/central-accounts/:id/activate` (Safely activate).
  - `POST /api/admin/central-accounts/:id/deactivate` (Safely deactivate with dependency check).
  - `DELETE /api/admin/central-accounts/:id` (Safely delete with foreign key & pending outbox checks).
  - `GET /api/admin/central-accounts/:id/restaurants` (Get restaurants assigned to account).
  - `GET /api/admin/restaurants/unassigned-central-account` (Get restaurants without central account).
  - `PUT /api/admin/restaurants/:restaurantId/central-account` (Assign/reassign restaurant).
  - `DELETE /api/admin/restaurants/:restaurantId/central-account` (Unassign restaurant).

### Q3: Whether account deletion/deactivation already exists?
- **Deactivation:** Supported in service (`deactivateCentralAccount` sets `is_active: false`), but no dedicated HTTP endpoint was exposed.
- **Deletion:** **Does NOT exist**. There is no `deleteCentralAccount` service function, no `DELETE` route, and no safety check for associated orders or pending outbox messages.
- **Soft Deletion:** The table currently lacks a `deleted_at` timestamp.

### Q4: Whether multiple central accounts are fully supported by the database?
- **NO. The database currently blocks multiple active central accounts.**
  Migration `20261108183000_add_central_whatsapp_architecture` created:
  ```sql
  CREATE UNIQUE INDEX "central_whatsapp_accounts_single_active_idx" 
  ON "central_whatsapp_accounts"("is_active") 
  WHERE "is_active" = true;
  ```
  This index guarantees that at most ONE record can have `is_active = true`.
  To support multiple central accounts active simultaneously (e.g., Central Account 1 assigned to Restaurants A & B, Central Account 2 assigned to Restaurants C & D), **this index must be dropped via a clean, versioned migration**.

### Q5: Whether restaurant mapping is already supported?
- **NO.**
  - The `Restaurant` model in `prisma/schema.prisma` and the `restaurants` PostgreSQL table contain **no `central_account_id` column**.
  - `resolveCentralCredentials()` in `central-whatsapp.service.js` currently fetches `findFirst({ where: { is_active: true } })`, oblivious to which restaurant is dispatching.
  - A versioned migration must add `central_account_id UUID REFERENCES central_whatsapp_accounts(id) ON DELETE RESTRICT` (or `SET NULL`) with an index `restaurants_central_account_id_idx`.
  - `resolveCentralCredentials` must be updated to accept `{ restaurantId, centralAccountId }` to look up the restaurant's assigned account first before falling back.

### Q6: Whether frontend functionality already exists?
- **NO.**
  - `public/admin/index.html` contains tabs for Dashboard, Restaurants, Subscriptions, Payments, Audit Logs, and System, but has no Central WhatsApp navigation or UI pane.
  - `public/admin/app.js` has no state or handlers for Central WhatsApp account management.
  - The UI must be cleanly added using the existing design system (`.panel`, `.data-table`, `.badge`, `.modal-backdrop`, `.btn`).

---

## 2. Investigation: Why Previous Checks of `central_whatsapp_accounts` Exited with Code 1

The prompt requested:
> *"Investigate why previous checks of central_whatsapp_accounts exited with code 1. Do not treat this as a passing database verification."*

### Findings from Direct Investigation:
1. **PowerShell Quote & Variable Interpolation:**
   In Windows PowerShell, inline commands like `node -e "const cols = await prisma.$queryRaw..."` fail because PowerShell interprets `$queryRaw` as an empty PowerShell variable, stripping it from the string and passing `prisma.("SELECT...")` to Node. This throws `SyntaxError: Unexpected token '('` and causes PowerShell to exit with code 1.
2. **Escaped Double Quotes in PowerShell:**
   PowerShell unescapes `\"` into bare strings, causing Node to see invalid syntax like `table_name = central_whatsapp_accounts` without quotes, resulting in `SyntaxError: Unexpected identifier` and exit code 1.
3. **Historical Test Unhandled Exception (Step 6980):**
   In R6.6.2 test execution, `verifyCentralTemplatesWithMeta` was invoked without an explicit `db` reference, causing `Cannot read properties of undefined (reading 'findFirst')` and exiting with code 1.
4. **Definitive Verification with Clean Script:**
   Running an isolated inspection script ([`scratch/inspect_db_schema.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/scratch/inspect_db_schema.js)) confirmed:
   - PostgreSQL connection is healthy.
   - Table `central_whatsapp_accounts` exists with all 9 columns.
   - Current row count is 0.
   - Single-active partial unique index is present.
   - `restaurants` table has no `central_account_id` column.

---

## 3. Database Schema Migration Plan

To fulfill R6.8 without breaking backward compatibility:

### 3.1 Migration Steps
1. **Drop Partial Unique Index on `is_active`:**
   Drop `central_whatsapp_accounts_single_active_idx` so multiple central accounts can be active concurrently.
2. **Add Metadata Columns to `central_whatsapp_accounts`:**
   - `account_name` (`VARCHAR(255) NOT NULL DEFAULT 'Central WhatsApp Account'`)
   - `description` (`TEXT`)
   - `verification_status` (`VARCHAR(64) DEFAULT 'UNVERIFIED'`)
   - `last_tested_at` (`TIMESTAMPTZ`)
   - `verification_error` (`TEXT`)
   - `deleted_at` (`TIMESTAMPTZ`)
3. **Add `central_account_id` to `restaurants`:**
   - `central_account_id` (`UUID REFERENCES central_whatsapp_accounts(id) ON DELETE SET NULL`)
   - Index: `CREATE INDEX "restaurants_central_account_id_idx" ON "restaurants"("central_account_id")`

### 3.2 Prisma Schema Updates
- Update `CentralWhatsAppAccount` with relations to `Restaurant[]`.
- Update `Restaurant` with optional `central_account_id` and relation `central_account`.

---

## 4. Backend Service & Controller Enhancements

### 4.1 `src/services/central-whatsapp.service.js`
- `listCentralAccounts({ includeDeleted = false })`: Return all accounts with assigned restaurant counts, sorted by creation date.
- `createCentralAccount(data)`: Store `account_name`, `description`, encrypt token, validate EAA prefix, check duplicate phone number ID.
- `updateCentralAccount(id, data)`: Support updating name, description, phone number ID, WABA ID, and optional token replacement.
- `testCentralAccountConnection(id)`: Call Meta Graph API v21.0, update `verification_status`, `last_tested_at`, and `verification_error`.
- `activateCentralAccount(id)`: Verify credentials, verify Meta status, set `is_active = true`.
- `deactivateCentralAccount(id)`: Check assigned restaurants and pending outbox messages, warn or deactivate.
- `deleteCentralAccount(id, { force = false })`:
  - Check if assigned restaurants exist -> Block with actionable error.
  - Check if pending outbox messages exist -> Block with actionable error.
  - If historical orders/notifications exist -> Perform soft deletion (`deleted_at = now()`, `is_active = false`).
  - If completely unreferenced -> Allow permanent deletion.
- `resolveCentralCredentials({ restaurantId, centralAccountId })`:
  - If `restaurantId` provided, check `restaurant.central_account_id`.
  - If assigned central account found and active, decrypt and return.
  - If not found or inactive, fall back to any active central account or environment config.
- `isCentralPhoneNumberId(phoneNumberId)`:
  - Check if `phoneNumberId` matches ANY active central account in `central_whatsapp_accounts` (`where: { phone_number_id: cleanId, is_active: true }`).

### 4.2 Restaurant Assignment Services
- `getAssignedRestaurants(centralAccountId)`: Return restaurants mapped to this central account.
- `getUnassignedRestaurants()`: Return restaurants with `central_account_id = null`.
- `assignRestaurantToCentralAccount(restaurantId, centralAccountId)`: Validate active status of central account, update restaurant, record audit log.
- `unassignRestaurantFromCentralAccount(restaurantId)`: Set `central_account_id = null`, record audit log.

### 4.3 `src/controllers/admin-central-account.controller.js`
- Implement handlers for:
  - `handleListCentralAccounts`
  - `handleGetCentralAccountById`
  - `handleCreateCentralAccount` (support `name`, `description`)
  - `handleUpdateCentralAccount`
  - `handleTestAccountConnection`
  - `handleActivateCentralAccount`
  - `handleDeactivateCentralAccount`
  - `handleDeleteCentralAccount`
  - `handleGetAssignedRestaurants`
  - `handleGetUnassignedRestaurants`
  - `handleAssignRestaurant`
  - `handleUnassignRestaurant`

---

## 5. Admin Panel UI Design Plan

### 5.1 Navigation
Add new sidebar link:
```html
<a href="#central-accounts" class="nav-item" data-tab="central-accounts">
  <span class="nav-icon">📱</span> Central WhatsApp
</a>
```

### 5.2 Central WhatsApp Management Tab Pane
1. **Overview Cards:**
   - Total Central Accounts
   - Active Accounts
   - Verified Connections
   - Assigned Restaurants
2. **Account Table:**
   - Account Name & Description
   - WhatsApp Display Number & Phone Number ID
   - WABA ID
   - Assigned Restaurants Count (clickable pill/modal)
   - Connection Status Badge (`CONNECTED`, `UNVERIFIED`, `DISCONNECTED`)
   - Active Status Toggle/Badge
   - Last Checked Timestamp
   - Actions: Test Connection, Edit, Activate/Deactivate, Manage Restaurants, Delete
3. **Modals:**
   - **Add Account Modal:** Name, Display Number, Phone Number ID, WABA ID, Permanent Token (password input), Notes, Active Checkbox.
   - **Edit Account Modal:** Masked token indicator ("●●●●●●●●●● Configured"), empty replacement input ("Leave blank to keep existing"), Name, Phone ID, WABA ID.
   - **Test Connection Modal/Banner:** Shows live test result with Meta verified name and quality rating or sanitized error.
   - **Restaurant Assignments Modal:** View assigned restaurants, dropdown to assign unassigned restaurants, button to unassign.
   - **Safe Deletion Confirmation Dialog:** Displays warning with dependency check results.

---

## 6. Safety & Non-Negotiable Invariants

1. **Production Mode:** `NOTIFICATION_ROUTING_MODE=LEGACY` remains unchanged in `.env`.
2. **Credential Masking:** Plaintext tokens are NEVER sent to the client in GET requests, logs, or error responses.
3. **No Cross-Tenant Leaks:** Restaurant tenant isolation is enforced at query and database level.
4. **Audit Logging:** Every administrative action (`CENTRAL_ACCOUNT_CREATED`, `UPDATED`, `DEACTIVATED`, `DELETED`, `RESTAURANT_ASSIGNED`, `RESTAURANT_UNASSIGNED`) creates an `AuditLog` record.
5. **No Breaking Migrations:** New columns are nullable or have safe defaults; existing historical data is preserved.

