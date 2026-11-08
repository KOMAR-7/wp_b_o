# RESTOPRO — R6.6.2 Central WhatsApp Blocker Resolution Report

**Execution Date:** November 8, 2026  
**Status:** COMPLETE (ALL CHECKS PASS)  
**Routing Mode (Active Env):** `LEGACY`  
**Repository Branch:** `master`

---

## 1. Executive Summary

This report documents the resolution of the two production blockers identified during the `R6.6.1 Final Production Readiness Audit`:
1. **Independent Meta Template Approval Verification**: Decoupled template approval so that `restopro_order_alert`, `restopro_customer_order_accepted`, and `restopro_customer_order_rejected` are validated independently. Replaced shared boolean expressions with database-backed template configuration in `central_whatsapp_accounts.templates` and dedicated environment overrides.
2. **Super Admin Central WhatsApp Management API**: Implemented secure administrative endpoints (`/api/admin/central-account/*`) under strict `requireSuperAdminAuth` middleware. Platform owners can onboard the central phone number, test Meta Cloud API connectivity, rotate access tokens (stored encrypted with AES-256-GCM), view live template statuses, and update verification states.

All existing multi-tenant architecture, order state machines, and `LEGACY` fallback workflows were preserved with zero regressions.

---

## 2. Component Implementation Status

| Component | Status | Description |
| :--- | :---: | :--- |
| **Database Migration: `templates` column** | `PASS` | Added `templates JSONB DEFAULT '{}'` to `central_whatsapp_accounts` via migration `20261108220000_add_central_account_templates`. |
| **Central Template Service (`template-config.service.js`)** | `PASS` | Centralized template specification, per-template independent approval evaluation, database status queries, and audit-logged mutations. |
| **Independent Template Validation in `order.service.js`** | `PASS` | Replaced legacy shared boolean evaluation with dedicated calls to `isTemplateApproved()`. Unapproved templates produce a classified failure (`BLOCKED_TEMPLATE_NOT_CONFIGURED`) without falling back to restaurant credentials. |
| **Super Admin API (`admin-central-account.controller.js`)** | `PASS` | Complete CRUD, token rotation, Meta connection test, and per-template approval status management. |
| **Super Admin Route Protection (`requireSuperAdminAuth`)** | `PASS` | Unauthenticated requests return HTTP 401; non-super-admin sessions return HTTP 403 Forbidden. |
| **Token Encryption & Redaction** | `PASS` | Encrypted with AES-256-GCM (`enc:v1:`). Plaintext tokens and raw ciphertexts are strictly stripped from all JSON responses and log contexts. |
| **Backward Compatibility & LEGACY Parity** | `PASS` | Default `NOTIFICATION_ROUTING_MODE=LEGACY` preserves existing restaurant direct-dispatch and opt-in checks. |

---

## 3. Files Created and Modified

### Created Files
- `prisma/migrations/20261108220000_add_central_account_templates/migration.sql`: PostgreSQL DDL adding `templates` JSONB column.
- `src/services/template-config.service.js`: Independent template validation, specifications, status transitions, and test override harnesses.
- `src/controllers/admin-central-account.controller.js`: Controller handlers for Super Admin Central WhatsApp management.
- `src/routes/admin-central-account.routes.js`: Protected Express router mounted at `/api/admin/central-account`.
- `test/r6-central-template-approval-test.js`: 55 unit and integration tests verifying independent template validation across CENTRAL and LEGACY modes.
- `test/r6-central-admin-api-test.js`: 65 integration tests covering authorization, validation, token rotation, Meta connection testing, template status management, and audit logging.

### Modified Files
- `prisma/schema.prisma`: Added `templates Json? @default("{}") @db.JsonB` to model `CentralWhatsAppAccount`.
- `src/services/central-whatsapp.service.js`: Added support for `templates` in `createCentralAccount`, `updateCentralAccount`, and `sanitizeCentralAccount`.
- `src/services/order.service.js`: Integrated `isTemplateApproved` for owner alerts and customer decision notifications.
- `src/services/admin-auth.service.js`: Adjusted session validation so `requireSuperAdminAuth` can distinguish between unauthenticated (401) and forbidden non-super-admin (403) roles.
- `src/app.js`: Mounted `/api/admin/central-account` routes.
- `package.json`: Added `test:r6:template`, `test:r6:admin`, and updated `test:r6:all` to run all 7 R6 test suites.
- `test/r6-central-webhook-test.js`: Seeded central test account with approved template configuration.
- `test/r6-central-order-routing-test.js`: Integrated test template harnesses for controlled failure testing.

---

## 4. Phase 1 — Independent Meta Template Approval

### 4.1 Supported Templates & Target Roles
RestPro explicitly defines three Meta Utility Templates:

| Template Name | Language | Category | Target Recipient | Variables |
| :--- | :---: | :---: | :---: | :--- |
| `restopro_order_alert` | `en` | `UTILITY` | Restaurant Owner | Restaurant Name, Order Ref, Order Type, Items Summary, Total Amount |
| `restopro_customer_order_accepted` | `en` | `UTILITY` | Customer | Restaurant Name, Order Ref, Fulfilment Type, Total Amount |
| `restopro_customer_order_rejected` | `en` | `UTILITY` | Customer | Restaurant Name, Order Ref, Rejection Reason |

### 4.2 Resolution Order
`isTemplateApproved(templateName, { db, restaurant, routingMode })` enforces a strict resolution hierarchy in `CENTRAL` mode:
1. **In-Memory Test Overrides**: Checked first to support deterministic isolated test execution (`setTemplateApprovalForTesting`).
2. **PostgreSQL Central Account Status**: Queries the active `CentralWhatsAppAccount.templates[templateName]`. If `status === 'APPROVED'`, resolves to approved.
3. **Specific Environment Variable**:
   - `restopro_order_alert`: `TEMPLATE_APPROVED_ORDER_ALERT === 'true'`
   - `restopro_customer_order_accepted`: `TEMPLATE_APPROVED_CUSTOMER_ACCEPTED === 'true'` or `CENTRAL_CUSTOMER_ACCEPTED_APPROVED === 'true'`
   - `restopro_customer_order_rejected`: `TEMPLATE_APPROVED_CUSTOMER_REJECTED === 'true'` or `CENTRAL_CUSTOMER_REJECTED_APPROVED === 'true'`
4. **Default Safe Unapproved**: If no configuration or database record marks the template approved, returns `isApproved: false` with structured status (`UNCONFIGURED` or `REJECTED`) and explanatory failure reason.

### 4.3 Invariants Enforced
- **Zero Cross-Template Bleed**: `OWNER_TEMPLATE_APPROVED` does NOT approve customer templates. `CENTRAL_TEMPLATE_APPROVED` does NOT blanket-approve all templates.
- **Selective Blocking**: If `restopro_order_alert` is approved but `restopro_customer_order_accepted` is unapproved, the owner alert is dispatched normally, but the customer accept notification is marked as `FAILED` (`BLOCKED_TEMPLATE_NOT_CONFIGURED`). The customer order state (`ACCEPTED`) remains intact.
- **Zero Credential Fallback**: Unapproved Central templates never fall back to restaurant credentials or restaurant outbox channels. The outbox record retains `sender_channel = 'CENTRAL'` and `status = 'FAILED'`.
- **LEGACY Isolation**: In `LEGACY` mode, customer notifications continue using conversational session text messages, and owner alerts check restaurant internal notes consent.

---

## 5. Phase 2 & 3 — Super Admin Central WhatsApp Management API

### 5.1 Endpoints Specification

| Method | Endpoint | Access | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/admin/central-account` | Super Admin | Returns the active Central WhatsApp Account details, verification status, and template summaries. Returns `{ configured: false }` if none active. |
| `POST` | `/api/admin/central-account` | Super Admin | Creates a new Central WhatsApp Account. Supports `deactivatePrevious: true` to seamlessly deactivate any existing active account. |
| `PATCH` | `/api/admin/central-account` | Super Admin | Updates metadata or rotates the Meta access token (`accessToken`). |
| `POST` | `/api/admin/central-account/test-connection` | Super Admin | Verifies credentials against Meta Cloud API (`/v21.0/<phone_number_id>`) without sending any WhatsApp messages. |
| `GET` | `/api/admin/central-account/templates` | Super Admin | Lists all supported templates with their current approval status, verification timestamps, and failure reasons. |
| `PATCH` | `/api/admin/central-account/templates/:templateName` | Super Admin | Updates approval status (`APPROVED`, `REJECTED`, `PENDING`, `UNCONFIGURED`) for a specific template. |

### 5.2 Security & Authentication Controls
- **Authentication**: Validated via `requireSuperAdminAuth` middleware. Supports Bearer header (`Authorization: Bearer <token>`), `X-Admin-Token` header, or `admin_session` cookie.
- **Role Enforcement**: Rejects non-super-admin accounts (`SUPPORT`, `RESTAURANT_ADMIN`) with HTTP `403 Forbidden` (`Super Admin privileges required`). Unauthenticated requests return HTTP `401 Unauthorized`.
- **Token Protection**: 
  - Token input validated for required `EAA` prefix.
  - Plaintext access tokens are encrypted using AES-256-GCM prior to database insertion.
  - Plaintext tokens and raw ciphertexts are strictly stripped from all controller responses (`has_token: true` indicator only).
  - All administrative actions record audit log events (`CENTRAL_WHATSAPP_ACCOUNT_CREATED`, `CENTRAL_WHATSAPP_ACCOUNT_UPDATED`, `CENTRAL_TEMPLATE_STATUS_UPDATED`).

---

## 6. Verification and Test Results

### 6.1 Test Suite Breakdown

| Suite | File | Tests | Result |
| :--- | :--- | :---: | :---: |
| **R6.5 Central Database & Config** | `test/r6-central-database-config-test.js` | 55 | `PASS` |
| **R6.6 Central Webhook Routing** | `test/r6-central-webhook-test.js` | 30 | `PASS` |
| **R6.6 Central Outbox Dispatch** | `test/r6-central-dispatch-test.js` | 30 | `PASS` |
| **R6.6 Central Order Routing** | `test/r6-central-order-routing-test.js` | 30 | `PASS` |
| **R6.6 Central Security & Isolation** | `test/r6-central-security-test.js` | 33 | `PASS` |
| **R6.6.2 Central Template Approval** | `test/r6-central-template-approval-test.js` | 55 | `PASS` |
| **R6.6.2 Super Admin Central API** | `test/r6-central-admin-api-test.js` | 65 | `PASS` |
| **Total R6 Test Suite (`npm run test:r6:all`)** | | **298** | **`PASS` (0 FAILED)** |

### 6.2 Regression Verification

| Test Suite | Command | Tests | Result |
| :--- | :--- | :---: | :---: |
| **R6.3 Customer Ordering & Address** | `npm run test:r6:customer` | 16 | `PASS` |
| **Stage 10 Refactored Flow** | `npm run test:stage10:flow` | 123 | `PASS` |
| **Stage 11 Owner Auth & Security** | `npm run test:stage11` | 76 | `PASS` |
| **Stage 6 End-to-End Security Audit** | `npm run test:stage6` | 103 | `PASS` |
| **Stage 9 Super Admin Auth** | `npm run test:stage9` | 49 | `PASS` |

---

## 7. Operational Readiness & Meta Configuration Checklist

Before switching `NOTIFICATION_ROUTING_MODE=CENTRAL` in production:

1. **Meta Business Manager Setup**:
   - Register the dedicated Central WhatsApp Business Number (XYZ) in Meta Business Manager under the central WABA.
   - Generate a System User Permanent Access Token with `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
2. **Template Creation & Submission**:
   - Submit `restopro_order_alert` (Utility category, 2 quick reply buttons: "Accept Order", "Reject Order").
   - Submit `restopro_customer_order_accepted` (Utility category, 4 body parameters).
   - Submit `restopro_customer_order_rejected` (Utility category, 3 body parameters).
3. **Onboarding Central Account via API**:
   - Authenticate as Super Admin.
   - Call `POST /api/admin/central-account` with `{ phoneNumberId, wabaId, accessToken, displayPhoneNumber }`.
   - Call `POST /api/admin/central-account/test-connection` to verify Meta Cloud API handshake.
4. **Marking Templates Approved**:
   - Once Meta approves each template, update the central account via `PATCH /api/admin/central-account/templates/:templateName` with `{ status: "APPROVED", approvalSource: "META_BUSINESS_MANAGER_VERIFIED" }`.
5. **Switching Routing Mode**:
   - Set environment variable `NOTIFICATION_ROUTING_MODE=CENTRAL` on Render.
   - Deploy/restart web service and background worker.

---

## 8. Conclusion

All blockers identified in `R6_6_1_PRODUCTION_READINESS_AUDIT.md` are resolved. The Central WhatsApp architecture now has:
- Decoupled, independent template verification with zero cross-template assumptions.
- Secure, encrypted Super Admin management for credentials and templates.
- Complete regression parity under `LEGACY` routing mode.
- 100% passing test suites across 298 R6 tests and 367 regression tests.

