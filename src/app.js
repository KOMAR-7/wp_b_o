/**
 * RESTOPRO — Express Application Setup
 */
const express = require('express');
const { verifyWebhookSignature } = require('./middleware/verifyWebhook');
const { handleGetVerification, handleIncomingEvent } = require('./controllers/webhook.controller');
const logger = require('./utils/logger');

const app = express();

// Capture raw body buffer for HMAC-SHA256 signature verification
app.use(express.json({
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

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  logger.error('Unhandled server error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
