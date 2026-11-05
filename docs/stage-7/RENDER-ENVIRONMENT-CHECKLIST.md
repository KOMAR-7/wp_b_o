# RESTOPRO — Render Production Environment Variable Checklist

This checklist documents every configuration key required for RESTOPRO's services on Render.

---

## 1. Web Service Environment Variables (`restopro-api`)

| Variable Name | Required | Sensitivity | Default / Example Value | Purpose & Production Notes |
| :--- | :---: | :---: | :--- | :--- |
| `NODE_ENV` | **YES** | Public | `production` | Enables production optimizations, suppresses detailed error stack traces, and enforces security headers. |
| `PORT` | **YES** | Public | `10000` | HTTP listening port. Render sets `PORT=10000` by default. `server.js` binds to `0.0.0.0:${PORT}`. |
| `DATABASE_URL` | **YES** | **SECRET** | `postgresql://user:pass@dpg-xxx-a:5432/restopro` | PostgreSQL connection string. When using Render Blueprints, automatically linked via `fromDatabase: name: restopro-postgres`. Must include `sslmode=require` if connecting externally. |
| `META_WEBHOOK_VERIFY_TOKEN` | **YES** | **SECRET** | Generated 32+ character random hex/alphanumeric | Shared secret token passed by Meta during GET challenge webhook verification (`hub.verify_token`). Must never be committed to git. |
| `META_APP_SECRET` | **YES** | **SECRET** | From Meta App Dashboard (`32 hex chars`) | Used to verify HMAC-SHA256 signatures (`x-hub-signature-256`) on all inbound webhook POST requests. Rejects forged or tampered payloads. |
| `META_API_VERSION` | NO | Public | `v21.0` | Meta Graph API version used for WhatsApp Cloud API calls. Default is `v21.0`. |
| `LOG_LEVEL` | NO | Public | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`). In production, use `info` or `warn` to avoid log spam. Logger automatically redacts tokens and phone numbers. |

---

## 2. Background Worker Environment Variables (`restopro-worker`)

| Variable Name | Required | Sensitivity | Default / Example Value | Purpose & Production Notes |
| :--- | :---: | :---: | :--- | :--- |
| `NODE_ENV` | **YES** | Public | `production` | Enforces production runtime optimizations. |
| `DATABASE_URL` | **YES** | **SECRET** | `postgresql://user:pass@dpg-xxx-a:5432/restopro` | Must point to the exact same database as `restopro-api` so the worker can claim outbox messages and manage session states. |
| `POLL_INTERVAL_MS` | NO | Public | `2000` | Interval in milliseconds between outbox poll cycles. Default is `2000` (2 seconds). |
| `OUTBOX_BATCH_SIZE` | NO | Public | `10` | Maximum number of pending outbox messages claimed in a single transaction via `FOR UPDATE SKIP LOCKED`. |
| `LOG_LEVEL` | NO | Public | `info` | Logging verbosity for the worker process. |

---

## 3. Database Credentials (Multi-Tenant Restaurant Level)

In RESTOPRO, individual restaurants configure their own Meta WhatsApp Business credentials within the PostgreSQL database (`restaurants` table). These credentials are encrypted / protected and scoped per tenant:

| Field in `restaurants` Table | Sensitivity | Purpose & Notes |
| :--- | :---: | :--- |
| `phone_number_id` | Public | Meta WhatsApp Business Phone Number ID. Used to resolve the incoming tenant on webhooks. |
| `whatsapp_access_token` | **SECRET** | Meta System User Access Token with `whatsapp_business_messaging` permissions. Used to send outbound messages on behalf of this restaurant. |
| `owner_phone` | **SECRET / PII** | WhatsApp phone number of the restaurant owner. Receives interactive order acceptance notifications. |

---

## 4. Pre-Launch Verification Checklist

Before directing live customer traffic to Render:

- [ ] `DATABASE_URL` connects successfully via internal Render network (`dpg-xxx-a:5432`).
- [ ] `NODE_ENV` is set to `production` on both Web Service and Background Worker.
- [ ] `META_WEBHOOK_VERIFY_TOKEN` is a strong random secret and matches Meta App Dashboard.
- [ ] `META_APP_SECRET` matches the Meta App Secret exactly.
- [ ] Express `trust proxy` is active (`app.get('trust proxy') === 1`).
- [ ] Web Service bound to `0.0.0.0` (accessible within Render container).
- [ ] Render Web Service `/health` responds with HTTP 200 `{ status: "ok" }`.
- [ ] Background Worker logs confirm active polling without database connection errors.
- [ ] Prisma migrations applied cleanly (`npx prisma migrate deploy` in pre-deploy command).
- [ ] Test restaurant records seeded with valid credentials in PostgreSQL.
- [ ] Render PostgreSQL plan is Starter or higher (persistent storage and daily backups active).
- [ ] Meta Webhook verified and subscribed to `messages` field.

