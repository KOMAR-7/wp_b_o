# RESTOPRO — Stage 2: Database Setup & Configuration Guide

**Document Version:** 1.0.0  
**Database Engine:** PostgreSQL 15+ (Verified on PostgreSQL 18.x)  
**ORM / Data Layer:** Prisma ORM (v6.19.3)  
**Target Environment:** Local Development, Docker, Hostinger VPS  

---

## 1. Overview

RESTOPRO uses a **shared-database, shared-schema** multi-tenant architecture. Every restaurant tenant operates within the same PostgreSQL instance, isolated strictly by foreign keys on `restaurant_id` and unique routing through Meta WhatsApp `phone_number_id`.

---

## 2. Environment Configuration (`.env`)

Add the standard connection string to `.env`:

```env
# PostgreSQL Database Connection String
DATABASE_URL="postgresql://postgres:admin@localhost:5432/restopro_dev?schema=public"
```

### Connection URL Breakdown:
- `postgresql://`: Database protocol.
- `postgres:admin`: Database username and password (never commit real credentials).
- `localhost:5432`: Host and standard PostgreSQL port.
- `/restopro_dev`: The database name.
- `?schema=public`: Target schema.

---

## 3. Database Provisioning & Migrations

### 3.1 Initial Database Creation (if not exists)
In PostgreSQL CLI or pgAdmin:
```sql
CREATE DATABASE restopro_dev;
```

### 3.2 Running Migrations
To apply the database schema migration to a clean database:
```bash
npx prisma migrate dev --name init_restopro_schema
```
For production CI/CD deployments:
```bash
npx prisma migrate deploy
```

### 3.3 Generating the Prisma Client
```bash
npx prisma generate
```

---

## 4. Database Client Singleton (`src/config/database.js`)

To prevent connection pool exhaustion and memory leaks, the application shares a single `PrismaClient` instance:

```javascript
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' }
      ]
    : [{ emit: 'event', level: 'error' }]
});

prisma.$on('error', (e) => {
  logger.error('Prisma Database Error', { message: e.message, target: e.target });
});

prisma.$on('warn', (e) => {
  logger.warn('Prisma Database Warning', { message: e.message });
});

module.exports = prisma;
```

---

## 5. Graceful Connection Management

In `src/server.js`, clean disconnection is handled during process termination (`SIGTERM`, `SIGINT`):

```javascript
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down HTTP server gracefully...`);
  server.close(async () => {
    try {
      await prisma.$disconnect();
      logger.info('Prisma database client disconnected cleanly.');
    } catch (err) {
      logger.error('Error during database disconnection', { error: err.message });
    }
    process.exit(0);
  });
}
```

---

## 6. Seeding Development Test Tenants

To seed two isolated development test restaurants (Restaurant A & Restaurant B):
```bash
npm run db:seed
```
*Never seed production credentials or real customer data.*

---

## 7. Connection Pool & Hostinger VPS Capacity Planning

### 7.1 PostgreSQL Server Ceiling
PostgreSQL default configuration provides:
```sql
SHOW max_connections; -- 100
```
On typical Hostinger Ubuntu VPS setups (2 to 4 vCPUs, 8 GB RAM), increasing `max_connections` excessively causes excessive memory consumption per backend connection process (Postgres spawns a dedicated process per connection). A ceiling of 100 connections is standard and safe.

### 7.2 Connection Budget Breakdown
When running under PM2 cluster mode in Stage 8:
* **Web Server Instances:** 4 PM2 cluster workers.
* **Per-Worker Connection Limit:** `connection_limit = 10`.
* **Peak Web Traffic Utilization:** $4 \times 10 = 40$ connections.
* **Background Jobs (Stage 7):**
  * `notification-worker.js`: 5 connections.
  * `session-cleanup.js`: 5 connections.
* **Total Application Peak Utilization:** 50 connections (50% of server capacity).
* **Headroom Remaining:** 50 connections reserved for administrative `psql` sessions, automated backups (`pg_dump`), Prisma migrations, and transient connection bursts.

### 7.3 Configured Connection String
In `.env` and `.env.example`:
```env
DATABASE_URL="postgresql://postgres:admin@localhost:5432/restopro_dev?schema=public&connection_limit=10&pool_timeout=20"
```
* `connection_limit=10`: Restricts this Prisma Client process to a maximum of 10 simultaneous pooled connections.
* `pool_timeout=20`: Specifies a 20-second timeout to acquire a connection from the pool before rejecting the query with a timeout error.


