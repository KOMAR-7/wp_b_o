/**
 * RESTOPRO — Super Admin Authentication Service
 * Manages platform owner login, session generation, verification, and revocation.
 */
const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { verifyPassword } = require('../utils/password');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Pre-computed dummy hash to prevent user enumeration timing attacks
const DUMMY_HASH = 'scrypt:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

/**
 * Sanitizes admin user object to ensure password hash is never exposed.
 * @param {Object} admin - Raw database AdminUser record
 * @returns {Object} Public admin profile
 */
function sanitizeAdmin(admin) {
  if (!admin) return null;
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    isActive: admin.is_active,
    lastLoginAt: admin.last_login_at,
    createdAt: admin.created_at
  };
}

/**
 * Computes SHA-256 hash of a plaintext session token.
 * Plaintext tokens are never stored in the database.
 * @param {string} token - Plaintext bearer/session token
 * @returns {string} SHA-256 hex digest
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Authenticates a Super Admin with email and password.
 * @param {Object} credentials - { email, password, ipAddress, userAgent }
 * @returns {Promise<Object>} { token, admin }
 */
async function loginAdmin({ email, password, ipAddress, userAgent }) {
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    const err = new Error('Invalid email or password');
    err.statusCode = 400;
    throw err;
  }

  const normalizedEmail = email.trim().toLowerCase();

  const admin = await prisma.adminUser.findUnique({
    where: { email: normalizedEmail }
  });

  if (!admin) {
    // Perform constant-time dummy verification to mitigate timing attack
    await verifyPassword(password, DUMMY_HASH);
    try {
      await prisma.auditLog.create({
        data: {
          admin_user_id: null,
          action: 'ADMIN_LOGIN_FAILED',
          entity_type: 'AdminUser',
          metadata: {
            reason: 'USER_NOT_FOUND',
            attemptedEmail: normalizedEmail,
            ipAddress
          }
        }
      });
    } catch (auditErr) {
      logger.warn('Failed to record login audit log', { error: auditErr.message });
    }

    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    throw err;
  }

  // Verify account is active
  if (!admin.is_active) {
    try {
      await prisma.auditLog.create({
        data: {
          admin_user_id: admin.id,
          action: 'ADMIN_LOGIN_FAILED',
          entity_type: 'AdminUser',
          entity_id: admin.id,
          metadata: {
            reason: 'ACCOUNT_DEACTIVATED',
            ipAddress
          }
        }
      });
    } catch (auditErr) {
      logger.warn('Failed to record login audit log', { error: auditErr.message });
    }

    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    throw err;
  }

  // Verify role is SUPER_ADMIN
  if (admin.role !== 'SUPER_ADMIN') {
    try {
      await prisma.auditLog.create({
        data: {
          admin_user_id: admin.id,
          action: 'ADMIN_LOGIN_FAILED',
          entity_type: 'AdminUser',
          entity_id: admin.id,
          metadata: {
            reason: 'INSUFFICIENT_ROLE',
            ipAddress
          }
        }
      });
    } catch (auditErr) {
      logger.warn('Failed to record login audit log', { error: auditErr.message });
    }

    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    throw err;
  }

  // Verify password
  const isValidPassword = await verifyPassword(password, admin.password_hash);
  if (!isValidPassword) {
    try {
      await prisma.auditLog.create({
        data: {
          admin_user_id: admin.id,
          action: 'ADMIN_LOGIN_FAILED',
          entity_type: 'AdminUser',
          entity_id: admin.id,
          metadata: {
            reason: 'INVALID_PASSWORD',
            ipAddress
          }
        }
      });
    } catch (auditErr) {
      logger.warn('Failed to record login audit log', { error: auditErr.message });
    }

    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    throw err;
  }

  // Password valid — generate random session token
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionTokenHash = hashToken(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // Create session and update lastLoginAt
  await prisma.$transaction([
    prisma.adminSession.create({
      data: {
        admin_id: admin.id,
        session_token_hash: sessionTokenHash,
        ip_address: ipAddress || null,
        user_agent: userAgent ? userAgent.substring(0, 500) : null,
        expires_at: expiresAt
      }
    }),
    prisma.adminUser.update({
      where: { id: admin.id },
      data: { last_login_at: new Date() }
    }),
    prisma.auditLog.create({
      data: {
        admin_user_id: admin.id,
        action: 'ADMIN_LOGIN_SUCCESS',
        entity_type: 'AdminUser',
        entity_id: admin.id,
        metadata: {
          ipAddress,
          userAgent: userAgent ? userAgent.substring(0, 200) : null
        }
      }
    })
  ]);

  logger.info('Super Admin authenticated successfully', {
    adminId: admin.id,
    email: admin.email
  });

  return {
    token: sessionToken,
    admin: sanitizeAdmin(admin)
  };
}

/**
 * Validates a session token and returns the active admin user.
 * @param {string} token - Raw session token
 * @returns {Promise<{ session: Object, admin: Object }|null>}
 */
async function validateSession(token) {
  if (!token || typeof token !== 'string') return null;

  const sessionTokenHash = hashToken(token.trim());

  const session = await prisma.adminSession.findUnique({
    where: { session_token_hash: sessionTokenHash },
    include: { admin: true }
  });

  if (!session) return null;

  // Check expiration
  if (new Date() >= new Date(session.expires_at)) {
    // Clean up expired session asynchronously
    prisma.adminSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  // Check admin status
  if (!session.admin || !session.admin.is_active) {
    return null;
  }

  return {
    session,
    admin: session.admin
  };
}

/**
 * Revokes a session token.
 * @param {string} token - Raw session token
 * @returns {Promise<boolean>}
 */
async function logoutAdmin(token) {
  if (!token || typeof token !== 'string') return false;

  const sessionTokenHash = hashToken(token.trim());

  try {
    const session = await prisma.adminSession.findUnique({
      where: { session_token_hash: sessionTokenHash }
    });

    if (session) {
      await prisma.$transaction([
        prisma.adminSession.delete({ where: { id: session.id } }),
        prisma.auditLog.create({
          data: {
            admin_user_id: session.admin_id,
            action: 'ADMIN_LOGOUT',
            entity_type: 'AdminSession',
            entity_id: session.id,
            metadata: {
              sessionTokenHash: sessionTokenHash.substring(0, 8) + '...'
            }
          }
        })
      ]);
      return true;
    }
  } catch (err) {
    logger.warn('Error during admin logout', { error: err.message });
  }

  return false;
}

module.exports = {
  loginAdmin,
  validateSession,
  logoutAdmin,
  sanitizeAdmin,
  hashToken
};
