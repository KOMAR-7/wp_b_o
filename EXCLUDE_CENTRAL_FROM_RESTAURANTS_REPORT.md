# RESTOPRO — EXCLUDE CENTRAL WHATSAPP ACCOUNT FROM RESTAURANT MANAGEMENT REPORT

**Date:** 2026-11-09  
**Target Environment:** Production / Staging (`https://restopro-api-clmr.onrender.com/admin#restaurants`)  
**Database:** `restopro_jadq` on Render PostgreSQL (Singapore)  
**Status:** COMPLETE & VERIFIED  

---

## 1. Executive Summary & Root Cause Analysis

### The Problem
In the Super Admin Panel under the **Restaurants** section (`https://restopro-api-clmr.onrender.com/admin#restaurants`), accounts belonging to the platform's Central WhatsApp Business Account were erroneously listed as individual restaurant tenants.

Specifically:
- `RestPro` (canonical platform record, Phone Number ID: `1427497060448125`, WABA ID: `1620323530136933`)
- `Webhook Verification Bistro` (1 record)
- `DB Integrity Test Cafe` (6 records)
- `UI Assignment Test Bistro` (3 records)

### Root Cause
1. **Historical Schema Design:** In early stages of the project, `RestPro` was provisioned directly into the `restaurants` table as a fixture representing the central dispatch identity before dedicated `central_whatsapp_accounts` tables existed.
2. **Staging Automation Side-Effects:** During verification runs for Central WhatsApp features, automated integration test scripts inserted test fixtures (`UI Assignment Test Bistro`, `DB Integrity Test Cafe`) directly into the `restaurants` table with WABA ID `1620323530136933`.
3. **Missing Architectural Boundary in API Layer:** `listRestaurants` in `admin-restaurant.service.js` previously executed a blanket `prisma.restaurant.findMany()`, returning all rows without verifying whether a record was a genuine restaurant tenant or a platform-owned service account.
4. **Shared WABA Nuance:** In a multi-tenant WhatsApp Business platform, legitimate restaurant tenants may also share the platform's WABA ID (`1620323530136933`). A naive filter such as `WHERE waba_id != central_waba_id` would break legitimate restaurant tenants onboarded under the platform's WABA.

---

## 2. Non-Destructive Resolution & Database Classification

In strict adherence to production safety guidelines:
- **Zero Database Deletions:** No records were deleted from PostgreSQL.
- **Zero Meta Disconnections:** No Meta phone number registrations, certificates, or tokens were modified or unregistered.
- **Production Routing Maintained:** `NOTIFICATION_ROUTING_MODE=LEGACY` was preserved.

### Database Migration: `20261109153000_separate_central_and_restaurant_accounts`
Two classification fields were added to the `restaurants` table:
- `is_platform_account Boolean NOT NULL DEFAULT false`
- `account_type VARCHAR(64) NOT NULL DEFAULT 'RESTAURANT'`
- Dedicated B-tree indexes added on `(is_platform_account)` and `(account_type)` for query performance.

### Account Classification in Live Database (`restopro_jadq`)
| Account Name | Phone Number ID | WABA ID | `is_platform_account` | `account_type` | Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Spice Garden Restaurant** | `111111111111111` | `100000000000001` | `false` | `RESTAURANT` | Genuine Tenant |
| **Ocean Breeze Cafe** | `222222222222222` | `100000000000002` | `false` | `RESTAURANT` | Genuine Tenant |
| **RestPro** | `1427497060448125` | `1620323530136933` | `true` | `PLATFORM_CENTRAL` | Platform Legacy Central |
| **Webhook Verification Bistro** | `1427497060448126` | `1620323530136933` | `true` | `PLATFORM_TEST` | Platform Staging Fixture |
| **DB Integrity Test Cafe** (6 entries) | `1427*` | `1620323530136933` | `true` | `PLATFORM_TEST` | Platform Staging Fixture |
| **UI Assignment Test Bistro** (3 entries) | `1427*` | `1620323530136933` | `true` | `PLATFORM_TEST` | Platform Staging Fixture |
| **Naila** (in `central_whatsapp_accounts`) | `106734138803096` | `103820662432290` | N/A | N/A | Active Central WhatsApp Account |

---

## 3. Code Modifications & Defense-in-Depth

### Backend Services

#### 1. `src/services/admin-restaurant.service.js`
- **`listRestaurants()` Server-Side Filtering:** Dynamically gathers all active and configured Central WhatsApp Phone Number IDs and applies a strict compound Prisma filter:
  ```javascript
  where: {
    is_platform_account: false,
    account_type: 'RESTAURANT',
    phone_number_id: { notIn: Array.from(centralPhoneIds) }
  }
  ```
- **`createRestaurant()` Validation Guard:** Explicitly checks if a submitted `phone_number_id` belongs to any registered Central WhatsApp account. If so, rejects with `409 Conflict` (`code: 'CENTRAL_ACCOUNT_PHONE_CONFLICT'`). Newly created restaurants are explicitly committed with `is_platform_account: false` and `account_type: 'RESTAURANT'`.
- **Targeted Operations Guard:** `getRestaurantById()`, `updateRestaurant()`, `updateRestaurantStatus()`, and `retryFailedOutboxMessages()` verify `!restaurant.is_platform_account`, returning `404 Not Found` if a platform ID is addressed as a restaurant tenant.

#### 2. `src/services/central-whatsapp.service.js`
- **`getUnassignedRestaurants()` Filter:** Filters out platform accounts so that only genuine unassigned restaurant tenants are available for assignment to Central WhatsApp accounts in the admin UI dropdown.
- **`assignRestaurantToCentralAccount()` & `unassignRestaurantFromCentralAccount()`:** Added rejection guards if someone attempts to assign a platform-owned account.

#### 3. `src/services/admin-dashboard.service.js`
- **`getDashboardStats()` Isolation:** Aggregates and status groupings for restaurant tenant statistics now filter on `is_platform_account: false` and `account_type: 'RESTAURANT'`, preventing test or central accounts from skewing platform metrics.

### Frontend UI Defense

#### `public/admin/app.js`
- **`loadRestaurants()` Client-Side Defense:** In addition to backend API filtering, the frontend table renderer includes an explicit defensive filter:
  ```javascript
  const restaurants = (data.restaurants || []).filter((r) =>
    !r.is_platform_account &&
    r.account_type !== 'PLATFORM_CENTRAL' &&
    r.account_type !== 'PLATFORM_TEST'
  );
  ```

---

## 4. Verification & Test Suite Execution

A dedicated 10-scenario regression test suite was created in `test/r6-9-exclude-central-from-restaurants-test.js` and executed:

| Scenario | Objective | Status | Result |
| :--- | :--- | :--- | :--- |
| **1** | Central Account Excluded from Restaurants List | PASS | Neither Central Account nor Test Bistros appear in `GET /api/admin/restaurants` |
| **2** | Central Account Visible in Central Accounts | PASS | Active Central Account (`Naila`) correctly visible in `GET /api/admin/central-accounts` |
| **3** | Genuine Restaurant Accounts Visible | PASS | Genuine tenants (`Spice Garden`, `Ocean Breeze`) correctly visible |
| **4** | Multiple Restaurants Routing Through Central | PASS | Multiple independent restaurants can route through Central account concurrently |
| **5** | Shared WABA ID Restaurant Not Excluded | PASS | Restaurant sharing Central WABA ID (`1620323530136933`) is **not** excluded |
| **6** | Restaurant Tenant Isolation Intact | PASS | Unassigned restaurant dropdown excludes all platform accounts |
| **7 & 8** | Central Message Routing & Owner Callbacks | PASS | Acceptance outbox notification and order decision flow execute cleanly |
| **9** | Restaurant CRUD Functional | PASS | Create, Read, Update, Suspend operations functional; duplicate Central phone rejected |
| **10** | Central Account Security Guard | PASS | Non-admin and unauthenticated requests to Central WhatsApp routes rejected with `401` |

**R6.8 Management Test Suite Verification:**
- Ran `npm run test:r6:8`: **99 passed, 0 failed**.

---

## 5. Summary of Files Changed

- `prisma/schema.prisma`: Added `is_platform_account` and `account_type` fields with indexes.
- `prisma/migrations/20261109153000_separate_central_and_restaurant_accounts/migration.sql`: Non-destructive schema migration.
- `src/services/admin-restaurant.service.js`: Server-side filtering, conflict validation, and lookup guards.
- `src/services/central-whatsapp.service.js`: Unassigned list filtering and assignment validation.
- `src/services/admin-dashboard.service.js`: Dashboard count aggregation filtering.
- `public/admin/app.js`: Defensive client-side row filtering.
- `package.json`: Added `test:r6:9` and updated `test:r6:all`.
- `test/r6-9-exclude-central-from-restaurants-test.js`: 10-scenario verification test suite.
