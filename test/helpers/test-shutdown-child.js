/**
 * Child process helper to test graceful shutdown signal handling
 */
process.env.PORT = '3991';

const http = require('http');
const server = require('../../src/server');

// Wait for the server to be listening
setTimeout(() => {
  // 1. Verify health check responds while operational
  http.get('http://localhost:3991/health', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('[CHILD_VERIFIED] Health check OK:', res.statusCode);

      // 2. Dispatch real SIGTERM signal to trigger signal listener
      console.log('[CHILD_DISPATCH] Dispatching SIGTERM signal event...');
      process.emit('SIGTERM');
    });
  }).on('error', (err) => {
    console.error('[CHILD_ERROR] Pre-shutdown request failed:', err.message);
    process.exit(1);
  });
}, 600);
