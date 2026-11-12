/**
 * RESTOPRO — Restaurant Catalogue Synchronization Routes
 * Mount point: /api/catalog/sync
 *
 * Provides authenticated ingestion and status endpoints for the WhatsApp Web Browser Companion.
 */
const express = require('express');
const router = express.Router();
const {
  handleSyncCatalog,
  handleGetCatalog,
  handleDeleteProduct
} = require('../controllers/catalog-sync.controller');

// GET /api/catalog/sync — Check connection status and retrieve synced items
router.get('/sync', handleGetCatalog);

// POST /api/catalog/sync — Ingest products extracted by browser companion
router.post('/sync', handleSyncCatalog);

// DELETE /api/catalog/sync/:retailerId — Remove a deleted product
router.delete('/sync/:retailerId', handleDeleteProduct);

module.exports = router;
