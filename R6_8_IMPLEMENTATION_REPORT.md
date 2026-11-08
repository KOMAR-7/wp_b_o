# RESTOPRO — R6.8 Central WhatsApp Account Management Implementation Report

**Document Version:** 1.0.0  
**Phase:** R6.8 — Central WhatsApp Account Management in Super Admin Panel  
**Execution Timestamp:** 2026-11-09T01:25:00+05:30  
**Environment Guard:** `NOTIFICATION_ROUTING_MODE=LEGACY`  

---

## 1. Executive Summary

In R6.8, RestPro successfully implemented full **Central WhatsApp Account Management** directly inside the Super Admin Panel. This module extends the multi-tenant architecture introduced in R6.5–R6.7, transforming the single-account central system into an enterprise-grade **multi-central-account platform** where:
1. Multiple Central WhatsApp accounts can be created, configured, tested against Meta, and activated concurrently.
2. Individual restaurants can be explicitly mapped to dedicated Central WhatsApp accounts or fall back to active accounts.
3. Super Admins can manage the entire lifecycle (Add, View, Edit, Test, Activate, Deactivate, Safe Delete, Restaurant Mapping) via an intuitive, responsive web UI with zero manual SQL intervention.
4. Production safety is strictly maintained with `NOTIFICATION_ROUTING_MODE=LEGACY`, AES-256-GCM authenticated encryption at rest, complete token redaction, and database-level dependency protection.

---

## 2. Architecture Overview

### 2.1 Multi-Account & Tenant Mapping Model

```
                    ┌────────────────────────────────────────────────────────┐
                    │               SUPER ADMIN PANEL (UI)                   │
                    │   Central WhatsApp Tab  •  Modals  •  Health Badges    │
                    └───────────────────────────┬────────────────────────────┘
                                                │ REST API (Bearer Auth)
                                                ▼
                    ┌────────────────────────────────────────────────────────┐
                    │      admin-central-account.controller.js               │
                    │  Plural CRUD  •  Test Meta  •  Assign  •  Safe Delete  │
                    └───────────────────────────┬────────────────────────────┘
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     ▼                                                     ▼
    ┌─────────────────────────────────┐                   ┌─────────────────────────────────┐
    │  Central Account Alpha (North)  │                   │  Central Account Beta (South)   │
    │  Phone Number ID: 888000111001  │                   │  Phone Number ID: 888000111002  │
    │  Status: CONNECTED / ACTIVE     │                   │  Status: CONNECTED / ACTIVE     │
    └────────────────┬────────────────┘                   └────────────────┬────────────────┘
                     │ Assigned                                            │ Assigned
                     ▼                                                     ▼
         ┌───────────────────────┐                             ┌───────────────────────┐
         │ Restaurant A (ABC)    │                             │ Restaurant B (DEF)    │
         │ Central Account: Alpha│                             │ Central Account: Beta │
         └───────────────────────┘                             └───────────────────────┘
```

### 2.2 Dynamic Credential Resolution Hierarchy

When an outbox dispatch or template validation executes, `resolveCentralCredentials({ restaurantId, centralAccountId })` resolves credentials via a 4-tier fallback:

1. **Explicit Account (`centralAccountId`)**: Queries PostgreSQL by specific UUID if provided directly.
2. **Restaurant Assignment (`restaurantId`)**: Checks `Restaurant.central_account_id` relation; if assigned to an active, non-deleted central account, uses that account.
3. **Active Database Account Fallback**: Queries any active, non-deleted `CentralWhatsAppAccount` in PostgreSQL.
4. **Environment Fallback**: Falls back to `CENTRAL_PHONE_NUMBER_ID` and `CENTRAL_ACCESS_TOKEN` if database is unconfigured.

### 2.3 Safe Deletion & Dependency Protection Lifecycle

To prevent orphaned foreign keys and audit trail destruction, account deletion follows strict state guards:

```
[ Super Admin clicks Delete ]
            │
            ▼
[ Assigned Restaurants Exist? ] ──YES──► HTTP 400 (ASSIGNED_RESTAURANTS_EXIST)
            │ NO
            ▼
[ Pending Central Dispatches? ] ──YES──► HTTP 400 (PENDING_DISPATCHES_EXIST)
            │ NO
            ▼
[ Historical Outbox Exists? ]   ──YES──► Soft Delete (sets deleted_at, is_active=false)
            │ NO
            ▼
[ Hard Delete ]                 ───────► DELETE FROM central_whatsapp_accounts (Purged)
```

---

## 3. Inventory of Created and Modified Files

| File Path | Nature of Change | Summary of Modifications |
|:---|:---:|:---|
| `prisma/schema.prisma` | Modified | Added fields `account_name`, `description`, `verification_status`, `last_tested_at`, `verification_error`, `deleted_at` to `CentralWhatsAppAccount`. Added `central_account_id` foreign key to `Restaurant`. Added `@@index([deleted_at])` and `@@index([central_account_id])`. |
| `prisma/migrations/20261109010000_add_central_accounts_management/migration.sql` | Created | Dropped single active partial index `central_whatsapp_accounts_single_active_idx`. Added new columns and foreign key constraint `fk_restaurants_central_account` with `ON DELETE SET NULL`. |
| `src/services/central-whatsapp.service.js` | Modified | Added multi-account CRUD, dynamic resolution (`restaurantId`, `centralAccountId`), Meta Cloud API testing (`testCentralAccountConnection`), activation/deactivation, safe deletion logic, and restaurant assignment functions (`getAssignedRestaurants`, `getUnassignedRestaurants`, `assignRestaurantToCentralAccount`, `unassignRestaurantFromCentralAccount`). Added test hook `setTestHttpClient`. |
| `src/services/admin-restaurant.service.js` | Modified | Updated `listRestaurants` and `getRestaurantById` to include `central_account` relation (`id`, `account_name`, `display_phone_number`). |
| `src/services/outbox.service.js` | Modified | Updated worker dispatch loop to pass `restaurantId: msg.restaurant_id` to `resolveCentralCredentials`, dynamically routing notifications through restaurant's assigned central line. |
| `src/services/template-config.service.js` | Modified | Updated `isTemplateApproved` to check restaurant-assigned central account first before active fallback. |
| `src/controllers/admin-central-account.controller.js` | Modified | Added handlers for plural account CRUD, connection test, activation, deactivation, safe deletion, assigned restaurant listing, and restaurant-to-central mapping. Full Super Admin audit logging for all mutations. |
| `src/routes/admin-central-account.routes.js` | Modified | Mounted plural routes under `/api/admin/central-accounts` while maintaining full backward compatibility for singular endpoints under `/api/admin/central-account`. |
| `src/routes/admin-restaurant.routes.js` | Modified | Added `/unassigned-central-account`, `PUT /:restaurantId/central-account`, and `DELETE /:restaurantId/central-account`. |
| `src/app.js` | Modified | Mounted `/api/admin/central-accounts` route handler. |
| `public/admin/index.html` | Modified | Added Central WhatsApp navigation tab (`#central-accounts`), stat cards, accounts table, search/filter controls, and 5 interactive modals (Add, Edit, View Profile, Manage Assignments, Safe Delete). |
| `public/admin/app.js` | Modified | Added state management, tab switching, API communication for all central account operations, live connection testing, and restaurant assignment management. |
| `public/admin/styles.css` | Modified | Added styling utilities for `.btn-xs` and modal spacing. |
| `test/r6-8-central-account-management-test.js` | Created | Comprehensive 50-scenario test suite verifying CRUD, multi-account routing, connection testing, lifecycle guards, and regression safety. |
| `test/r6-central-database-config-test.js` | Modified | Updated schema assertion to recognize R6.8 multi-account schema migration while preserving backward compatibility. |
| `test/r6-central-security-test.js` | Modified | Refined credential leakage assertion to verify zero secret leakage on restaurant object with `central_account_id` relation. |
| `package.json` | Modified | Added `"test:r6:8"` script and updated `"test:r6:all"` to include R6.8 suite. |

---

## 4. API Endpoints Specification

### 4.1 Plural Central Account Endpoints (`/api/admin/central-accounts`)

| Method | Endpoint | Description | Auth Required |
|:---|:---|:---|:---:|
| `GET` | `/api/admin/central-accounts` | Lists all non-deleted central accounts with assigned restaurant counts | Super Admin |
| `POST` | `/api/admin/central-accounts` | Creates a new central account (supports multiple concurrent active accounts) | Super Admin |
| `GET` | `/api/admin/central-accounts/:id` | Retrieves full details of a specific central account (redacted token) | Super Admin |
| `PATCH` | `/api/admin/central-accounts/:id` | Updates account metadata; retains encrypted token if input is empty | Super Admin |
| `DELETE` | `/api/admin/central-accounts/:id` | Safely deletes account (hard delete if unreferenced; soft delete if dispatches exist; blocked if assigned) | Super Admin |
| `POST` | `/api/admin/central-accounts/:id/test-connection` | Tests Meta Graph API connectivity and updates verification status in PostgreSQL | Super Admin |
| `POST` | `/api/admin/central-accounts/:id/activate` | Sets `is_active: true` for the account | Super Admin |
| `POST` | `/api/admin/central-accounts/:id/deactivate` | Sets `is_active: false`; returns warnings if active restaurants are assigned | Super Admin |
| `GET` | `/api/admin/central-accounts/:id/restaurants` | Lists all restaurants currently assigned to this central account | Super Admin |

### 4.2 Restaurant-to-Central Mapping Endpoints

| Method | Endpoint | Description | Auth Required |
|:---|:---|:---|:---:|
| `GET` | `/api/admin/restaurants/unassigned-central-account` | Lists all active restaurants not currently mapped to any central line | Super Admin |
| `PUT` | `/api/admin/restaurants/:restaurantId/central-account` | Assigns a restaurant to a designated central account (`centralAccountId`) | Super Admin |
| `DELETE` | `/api/admin/restaurants/:restaurantId/central-account` | Unassigns a restaurant from its central account (reverts to fallback) | Super Admin |

### 4.3 Legacy Singular Compatibility Endpoints (`/api/admin/central-account`)

All existing endpoints (`GET /api/admin/central-account`, `POST /api/admin/central-account`, `POST /test-connection`, `GET /templates`, `PATCH /templates/:templateName`, `POST /templates/verify-meta`, `GET /templates/definitions`, `POST /templates/submit-meta`) remain 100% functional and backward-compatible.

---

## 5. Super Admin UI Features

1. **Central WhatsApp Navigation Tab (`#central-accounts`)**:
   - Sidebar item with dedicated icon and direct routing.
   - 4 Stat Cards: Total Accounts, Active Lines, Verified Lines, Assigned Restaurants.
   - Search input and status filter (`All`, `Active`, `Inactive`, `Connected`, `Disconnected`).
2. **Interactive Accounts Table**:
   - Displays Account Name & Description, Phone Number ID & Display Phone, Status (`Active` / `Inactive`), Verification Badge (`Connected`, `Disconnected`, `Unverified`), Assigned Restaurants Count, and Last Tested timestamp.
   - Action buttons: Test Connection, View, Edit, Activate/Deactivate, Manage Restaurants, Delete.
3. **Add Account Modal**:
   - Clean form capturing Account Name, Description, Phone Number ID, WABA ID, Display Phone Number, and Access Token (with format validation requiring `EAA...`).
   - "Active on Creation" toggle.
4. **Edit Account Modal**:
   - Edits name, description, phone number ID, WABA ID, and display phone.
   - Access token rotation helper: field can be left blank to retain existing encrypted token securely.
5. **View Profile Modal**:
   - Full diagnostic view showing verification status, error details (if disconnected), last test time, and template configuration status.
6. **Manage Restaurant Assignments Modal**:
   - Shows all currently assigned restaurants with one-click unassign actions.
   - Dropdown of unassigned restaurants to quickly map restaurants to this line.
7. **Safe Delete Confirmation Dialog**:
   - Explains deletion safety policy: dependency checks block deletion if assigned restaurants or pending outbox messages exist. Explains soft-deletion vs hard-deletion.

---

## 6. Security and Safety Verification

1. **Production Mode Guard**: Verified `.env` contains `NOTIFICATION_ROUTING_MODE=LEGACY`. Production customer ordering remains completely isolated from Central WhatsApp dispatches.
2. **Authenticated Encryption at Rest**: All access tokens are encrypted with AES-256-GCM using `ENCRYPTION_KEY` and formatted as `enc:v1:<iv>:<tag>:<ciphertext>`.
3. **Strict Credential Redaction**: Plaintext access tokens and raw ciphertexts are never included in GET API responses, frontend rendering, or log outputs.
4. **Zero Live Customer Traffic During Connection Tests**: `testCentralAccountConnection` executes only `GET https://graph.facebook.com/v21.0/{phone_number_id}` for token validation. Zero WhatsApp outbound messages are sent.
5. **Multi-Tenant Isolation**: Verified that restaurant orders and session lookups are strictly segregated by `restaurant_id`.

---

## 7. Conclusion

Phase R6.8 is **COMPLETE and FULLY VERIFIED**. RestPro now features a robust, secure, and production-ready Central WhatsApp Account Management system in the Super Admin Panel, backed by comprehensive automated test coverage and backward compatibility across all existing ordering flows.

