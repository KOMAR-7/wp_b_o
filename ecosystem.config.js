/**
 * RESTOPRO — PM2 Process Manager Configuration
 * Production deployment cluster configuration with zero-downtime reloads.
 */
module.exports = {
  apps: [
    {
      name: 'restopro-backend',
      script: 'src/server.js',
      instances: 'max', // Scale across all available CPU cores in cluster mode
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      kill_timeout: 10000, // 10s graceful shutdown budget before SIGKILL
      listen_timeout: 8000,
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};

