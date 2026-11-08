/**
 * RESTOPRO — Express Application Setup
 */
const express = require('express');
const path = require('path');
const { verifyWebhookSignature } = require('./middleware/verifyWebhook');
const { handleGetVerification, handleIncomingEvent } = require('./controllers/webhook.controller');
const adminAuthRoutes = require('./routes/admin-auth.routes');
const adminRestaurantRoutes = require('./routes/admin-restaurant.routes');
const adminSubscriptionRoutes = require('./routes/admin-subscription.routes');
const adminPaymentRoutes = require('./routes/admin-payment.routes');
const adminDashboardRoutes = require('./routes/admin-dashboard.routes');
const adminSystemRoutes = require('./routes/admin-system.routes');
const adminAuditLogRoutes = require('./routes/admin-audit-logs.routes');
const adminCentralAccountRoutes = require('./routes/admin-central-account.routes');
const prisma = require('./config/database');
const logger = require('./utils/logger');

const app = express();

// Trust Render / cloud reverse proxy front-end (1 hop)
app.set('trust proxy', 1);

// Disable Express fingerprinting header for security hardening
app.disable('x-powered-by');

// Standard HTTP security defense headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Capture raw body buffer for HMAC-SHA256 signature verification with bounded 1MB payload limit
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Basic request logging
app.use((req, res, next) => {
  logger.debug(`Incoming ${req.method} request to ${req.originalUrl}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'RESTOPRO-WhatsApp-Backend',
    timestamp: new Date().toISOString()
  });
});

// Database readiness check endpoint
app.get('/health/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      status: 'ready',
      database: 'connected'
    });
  } catch (err) {
    logger.error('Database readiness check failed', { error: err.message });
    return res.status(503).json({
      status: 'error',
      database: 'disconnected',
      error: 'Database unavailable'
    });
  }
});

// Root welcome endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'RESTOPRO WhatsApp Ordering Backend',
    version: '1.0.0-poc',
    status: 'operational',
    healthEndpoint: '/health',
    webhookEndpoint: '/api/webhook'
  });
});

// Meta WhatsApp Webhook endpoints
app.get('/api/webhook', handleGetVerification);
app.post('/api/webhook', verifyWebhookSignature, handleIncomingEvent);

// Super Admin API endpoints
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/restaurants', adminRestaurantRoutes);
app.use('/api/admin/subscriptions', adminSubscriptionRoutes);
app.use('/api/admin/payments', adminPaymentRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/system', adminSystemRoutes);
app.use('/api/admin/audit-logs', adminAuditLogRoutes);
app.use('/api/admin/central-account', adminCentralAccountRoutes);
app.use('/api/admin/central-accounts', adminCentralAccountRoutes);

// Super Admin Frontend Panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/index.html'));
});
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/index.html'));
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  // Handle client-sent malformed JSON syntax errors gracefully with HTTP 400
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.warn('Malformed JSON request body received', { error: err.message });
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }

  // Handle oversized request payloads gracefully with HTTP 413
  if (err.type === 'entity.too.large' || err.status === 413) {
    logger.warn('Oversized request body rejected', { limit: err.limit });
    return res.status(413).json({ error: 'Payload too large. Maximum allowed size is 1MB.' });
  }

  logger.error('Unhandled server error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
