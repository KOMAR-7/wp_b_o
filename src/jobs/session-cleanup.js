/**
 * RESTOPRO — Automated Session Cleanup Job
 * Stage 7: Purges expired conversation sessions from PostgreSQL
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');

/**
 * Deletes conversation sessions that have exceeded their 2-hour inactivity TTL.
 *
 * @param {Object} [db=prisma]
 * @returns {Promise<{cleanedCount: number}>}
 */
async function cleanupExpiredSessions(db = prisma) {
  const now = new Date();

  try {
    const result = await db.conversationSession.deleteMany({
      where: {
        expires_at: {
          lt: now
        }
      }
    });

    if (result.count > 0) {
      logger.info('Cleaned up expired conversation sessions', {
        deletedCount: result.count,
        cleanedAt: now.toISOString()
      });
    }

    return { cleanedCount: result.count };
  } catch (err) {
    logger.error('Failed to cleanup expired conversation sessions', {
      error: err.message
    });
    throw err;
  }
}

if (require.main === module) {
  cleanupExpiredSessions()
    .then(({ cleanedCount }) => {
      console.log(`[SESSION CLEANUP] Done. Purged ${cleanedCount} expired sessions.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[SESSION CLEANUP] Error:', err);
      process.exit(1);
    });
}

module.exports = {
  cleanupExpiredSessions
};
