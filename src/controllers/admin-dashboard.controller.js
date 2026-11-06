/**
 * RESTOPRO — Super Admin Dashboard, Database Overview & Audit Log Controller
 */
const dashboardService = require('../services/admin-dashboard.service');
const logger = require('../utils/logger');

async function handleGetDashboardStats(req, res) {
  try {
    const stats = await dashboardService.getDashboardStats();
    return res.status(200).json(stats);
  } catch (err) {
    logger.error('Error fetching dashboard stats', { error: err.message });
    return res.status(500).json({ error: 'Internal server error fetching stats' });
  }
}

async function handleGetRecentActivity(req, res) {
  try {
    const result = await dashboardService.getRecentActivity(req.query.limit);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error fetching recent activity', { error: err.message });
    return res.status(500).json({ error: 'Internal server error fetching activity' });
  }
}

async function handleGetDatabaseOverview(req, res) {
  try {
    const overview = await dashboardService.getDatabaseOverview();
    return res.status(200).json(overview);
  } catch (err) {
    logger.error('Error fetching database overview', { error: err.message });
    return res.status(500).json({ error: 'Internal server error fetching system overview' });
  }
}

async function handleListAuditLogs(req, res) {
  try {
    const result = await dashboardService.listAuditLogs(req.query);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error listing audit logs', { error: err.message });
    return res.status(500).json({ error: 'Internal server error listing audit logs' });
  }
}

module.exports = {
  handleGetDashboardStats,
  handleGetRecentActivity,
  handleGetDatabaseOverview,
  handleListAuditLogs
};
