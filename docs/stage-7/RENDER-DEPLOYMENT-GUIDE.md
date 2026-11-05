# RESTOPRO — Render Production Deployment Guide

This guide describes the end-to-end procedure for deploying RESTOPRO to **Render** using either automated Infrastructure as Code (Render Blueprints) or manual service configuration.

---

## 1. Architecture & Resource Sizing

RESTOPRO runs on Render as three coordinated resources:
1. **`restopro-postgres`** — Managed PostgreSQL 16 database.
2. **`restopro-api`** — Node.js Express Web Service handling API requests and Meta WhatsApp webhooks.
3. **`restopro-worker`** — Standalone Node.js Background Worker handling durable outbox message dispatch and scheduled maintenance.

> [!IMPORTANT] Production Plan Sizing Requirement
> Do not use Render Free Tier for RESTOPRO. Free web services spin down after 15 minutes of inactivity (causing 50+ second cold starts which violate Meta's 5.0-second webhook timeout), and Free PostgreSQL databases are permanently destroyed after 30 days.
> 
> Sizing configuration:
> - `restopro-api`: **Starter Plan ($7/mo)**
> - `restopro-worker`: **Starter Plan ($7/mo)**
> - `restopro-postgres`: **Starter Plan ($7/mo)**
> - Total: **$21.00 / month**

---

## 2. Deployment Method A: Render Blueprint (Recommended)

Render Blueprints allow one-click declarative deployment using [`deployment/render.yaml`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/deployment/render.yaml).

### Step 1: Push Repository to GitHub / GitLab
Ensure all commits are pushed to your remote Git repository:
```bash
git push origin master
```

### Step 2: Create Blueprint in Render
1. Navigate to your [Render Dashboard](https://dashboard.render.com/).
2. Click **New +** in the top right corner and select **Blueprint**.
3. Select your repository (`restopro-whatsapp` or your repository name).
4. Set the **Blueprint Path** to:
   ```
   deployment/render.yaml
   ```
5. Click **Connect**.

### Step 3: Enter Production Environment Secrets
Render will detect `sync: false` secrets specified in the Blueprint and prompt for values:
- `META_WEBHOOK_VERIFY_TOKEN`: Random 32+ character alphanumeric string (e.g., `prod_verify_7f9e8a12bc44d8`).
- `META_APP_SECRET`: App Secret obtained from the Meta App Dashboard under *App settings > Basic*.

### Step 4: Review and Apply
1. Verify the 3 resources (`restopro-postgres`, `restopro-api`, `restopro-worker`) are listed.
2. Click **Apply**.
3. Render will automatically:
   - Provision PostgreSQL 16.
   - Run `buildCommand: npm install && npx prisma generate`.
   - Run `preDeployCommand: npx prisma migrate deploy` on the database.
   - Start the web service and verify `/health`.
   - Start the background worker.

---

## 3. Deployment Method B: Manual Dashboard Configuration

If not using Blueprints, create the three resources manually:

### Step 1: Create Managed PostgreSQL Database
1. In Render Dashboard, click **New +** -> **PostgreSQL**.
2. **Name:** `restopro-postgres`
3. **Database:** `restopro`
4. **User:** `restopro_user`
5. **Region:** Select closest region (e.g., Frankfurt or Oregon).
6. **Plan:** **Starter ($7/mo)**
7. Click **Create Database**.
8. Copy the **Internal Database URL** (e.g., `postgresql://restopro_user:xxx@dpg-xxx-a:5432/restopro`).

### Step 2: Create Web Service (`restopro-api`)
1. Click **New +** -> **Web Service**.
2. Connect your Git repository.
3. Configure settings:
   - **Name:** `restopro-api`
   - **Runtime:** `Node`
   - **Region:** Same as database.
   - **Branch:** `master`
   - **Build Command:** `npm install && npx prisma generate`
   - **Pre-Deploy Command:** `npx prisma migrate deploy`
   - **Start Command:** `node src/server.js`
   - **Plan:** **Starter ($7/mo)**
4. In **Advanced Settings**, set **Health Check Path** to `/health`.
5. Add Environment Variables:
   - `NODE_ENV` = `production`
   - `PORT` = `10000`
   - `DATABASE_URL` = Paste Internal Database URL from Step 1.
   - `META_WEBHOOK_VERIFY_TOKEN` = Your secret verify token.
   - `META_APP_SECRET` = Your Meta App Secret.
   - `META_API_VERSION` = `v21.0`
   - `LOG_LEVEL` = `info`
6. Click **Create Web Service**.

### Step 3: Create Background Worker (`restopro-worker`)
1. Click **New +** -> **Background Worker**.
2. Connect the same Git repository.
3. Configure settings:
   - **Name:** `restopro-worker`
   - **Runtime:** `Node`
   - **Region:** Same as database.
   - **Branch:** `master`
   - **Build Command:** `npm install && npx prisma generate`
   - **Start Command:** `node src/jobs/notification-worker.js`
   - **Plan:** **Starter ($7/mo)**
4. Add Environment Variables:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = Paste Internal Database URL from Step 1.
   - `POLL_INTERVAL_MS` = `2000`
   - `OUTBOX_BATCH_SIZE` = `10`
   - `LOG_LEVEL` = `info`
5. Click **Create Background Worker**.

---

## 4. Initial Database Seeding

Once migrations have deployed, seed your initial production restaurant(s):

### Option 1: Via Render Web Shell (Dashboard)
1. Open your `restopro-api` web service in the Render Dashboard.
2. Click on the **Shell** tab.
3. Run:
   ```bash
   node prisma/seed.js
   ```

### Option 2: From Local Terminal via External Database URL
1. From Render PostgreSQL dashboard, copy the **External Database URL**.
2. Run locally:
   ```bash
   DATABASE_URL="postgresql://restopro_user:xxx@dpg-xxx-a.render.com:5432/restopro?sslmode=require" node prisma/seed.js
   ```

---

## 5. Meta WhatsApp Developer App Configuration

1. Log in to [developers.facebook.com](https://developers.facebook.com/).
2. Select your WhatsApp App.
3. In the sidebar, navigate to **WhatsApp** -> **Configuration**.
4. In the **Webhook** section, click **Edit**:
   - **Callback URL:** `https://restopro-api.onrender.com/api/webhook` (replace with your Render URL or custom domain).
   - **Verify Token:** The exact value configured in `META_WEBHOOK_VERIFY_TOKEN`.
5. Click **Verify and Save**. Meta will send a GET challenge request; RESTOPRO will respond with HTTP 200 and the challenge nonce.
6. Under **Webhook Fields**, click **Manage** and subscribe to:
   - `messages` (Mandatory: triggers webhooks for customer orders, locations, buttons).

---

## 6. Post-Deployment Verification & Smoke Tests

Verify each component:

### 1. Health Endpoint Verification
```bash
curl -i https://restopro-api.onrender.com/health
```
**Expected Response:**
```http
HTTP/2 200 
content-type: application/json; charset=utf-8
x-content-type-options: nosniff
x-frame-options: DENY

{"status":"ok","service":"RESTOPRO-WhatsApp-Backend","timestamp":"2026-11-05T18:15:00.000Z"}
```

### 2. Root Endpoint Verification
```bash
curl -i https://restopro-api.onrender.com/
```
**Expected Response:** HTTP 200 `{"status":"operational","service":"RESTOPRO WhatsApp Ordering Engine"}`.

### 3. Worker Activity Check
In Render Dashboard -> `restopro-worker` -> **Logs**:
Verify log lines:
```
{"level":"INFO","message":"Starting RESTOPRO Render Notification Worker","context":{"workerId":"render_worker_...","pollIntervalMs":2000,"batchSize":10}}
```

---

## 7. Database Backup & Disaster Recovery

### Automated Backups
Render Managed PostgreSQL (Starter Plan) automatically performs daily snapshots with a 7-day retention period. Backups can be restored with a single click in the Render Dashboard under **Backups**.

### On-Demand Snapshot Runbook ([`scripts/backup-db.sh`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/scripts/backup-db.sh))
To take an off-platform backup before major updates:
```bash
DATABASE_URL="<RENDER_EXTERNAL_DATABASE_URL>?sslmode=require" ./scripts/backup-db.sh
```
This generates a verified, compressed PostgreSQL custom-format archive in `./backups/restopro_backup_YYYYMMDD_HHMMSS.dump`.

### Restore Runbook
To restore a snapshot into a new database:
```bash
pg_restore --clean --if-exists --no-owner --no-privileges -d "<TARGET_DATABASE_URL>?sslmode=require" ./backups/restopro_backup_YYYYMMDD_HHMMSS.dump
```
