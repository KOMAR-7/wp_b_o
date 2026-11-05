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

## 7. Connection Pool: Local Verification vs. Future Production Sizing

### 7.1 Locally Verified Configuration (Current Active State)
* **Local Database Engine:** PostgreSQL 18.x running on `localhost:5432`.
* **Verified Server Max Connections:**
  ```sql
  SHOW max_connections; -- Returns 100
  ```
* **Active Development Connection String (`.env`):**
  ```env
  DATABASE_URL="postgresql://postgres:admin@localhost:5432/restopro_dev?schema=public"
  ```
* **Active Process Architecture:** A single Node.js process runs Express and Prisma Client.
* **Prisma Default Pool Behavior:** Without an explicit `connection_limit` query parameter, Prisma Client opens a pool sized at `(num_physical_cpus * 2) + 1`. In local development on a single instance, this consumes approximately 5–17 connections under load, safely below the local PostgreSQL ceiling of 100 connections.

### 7.2 Proposed Production Capacity Model (Hostinger VPS Stage 8 Planning)
> [!NOTE]
> The following parameters are **theoretical architectural sizing targets** for future Stage 7 (workers) and Stage 8 (VPS PM2 deployment). They are **NOT** currently deployed, active, or verified in the local environment.

When deploying to Hostinger Ubuntu VPS with PM2 cluster mode:
* **Proposed Web Server Model:** 4 PM2 cluster worker processes.
* **Recommended Production Query String:**
  ```env
  DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB?schema=public&connection_limit=10&pool_timeout=20"
  ```
* **Proposed Connection Budget Breakdown:**
  * 4 PM2 web workers $\times$ 10 connections = 40 peak active connections.
  * Future Stage 7 background workers (`notification-worker.js`, `session-cleanup.js`) = ~10 connections.
  * Total planned application peak = 50 connections (50% of the standard 100 `max_connections` ceiling).
  * Remaining 50 connections reserved for migrations, `pg_dump` backups, and administrative access.



