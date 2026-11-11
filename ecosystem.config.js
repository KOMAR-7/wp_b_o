/**
 * RESTOPRO — PM2 Process Manager Configuration
 * Hostinger KVM 2 VPS Production Configuration (2 vCPU, 8 GB RAM)
 *
 * Dedicated to RestPro (/opt/whatsapp_only) on port 3101.
 * STRICT ISOLATION: Zero interference with RestroConnect.
 */
module.exports = {
  apps: [
    {
      name: 'restopro-backend',
      script: 'src/server.js',
      cwd: '/opt/whatsapp_only',
      // Hostinger KVM 2 has 2 vCPU cores. 2 instances provide zero-downtime reloads
      // and full CPU utilization while leaving ample headroom for PostgreSQL, Nginx, and RestroConnect.
      instances: 2,
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 10000, // 10s graceful shutdown budget for in-flight requests and db disconnect
      listen_timeout: 8000,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3101,
        NOTIFICATION_ROUTING_MODE: 'CENTRAL'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3101,
        NOTIFICATION_ROUTING_MODE: 'CENTRAL'
      }
    }
  ]
};
