/**
 * RESTOPRO — Centralized Meta WhatsApp Template Configuration & Validation Service
 * R6.6.2 Implementation
 *
 * Provides independent approval validation and status tracking for Meta Utility Templates:
 * 1. restopro_order_alert (Owner Order Alert)
 * 2. restopro_customer_order_accepted (Customer Order Accepted)
 * 3. restopro_customer_order_rejected (Customer Order Rejected)
 *
 * Core Rules:
 * - Each template maintains its own independent approval status.
 * - OWNER_TEMPLATE_APPROVED never approves customer templates.
 * - CENTRAL_TEMPLATE_APPROVED is never treated as blanket approval for every template.
 * - Distinguishes between CONFIGURED approval and VERIFIED Meta approval.
 * - In CENTRAL mode, unapproved templates fail safely with BLOCKED_TEMPLATE_NOT_CONFIGURED.
 * - Never falls back to RESTAURANT credentials on template failure in CENTRAL mode.
 */
const prisma = require('../config/database');
const config = require('../config/env');
const logger = require('../utils/logger');
const axios = require('axios');
const { parseInternalNotes } = require('./admin-restaurant.service');

const SUPPORTED_TEMPLATES = {
  ORDER_ALERT: process.env.ORDER_ALERT_TEMPLATE_NAME || process.env.META_ORDER_ALERT_TEMPLATE || 'restopro_order_alert',
  CUSTOMER_ACCEPTED: 'restopro_customer_order_accepted',
  CUSTOMER_REJECTED: 'restopro_customer_order_rejected'
};

const TEMPLATE_STATUSES = {
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  UNKNOWN: 'UNKNOWN',
  UNCONFIGURED: 'UNCONFIGURED'
};

const APPROVAL_SOURCES = {
  SUPER_ADMIN_MANUAL_VERIFIED: 'SUPER_ADMIN_MANUAL_VERIFIED',
  META_VERIFIED: 'META_VERIFIED',
  ENVIRONMENT_CONFIGURED: 'ENVIRONMENT_CONFIGURED',
  TEST_OVERRIDE: 'TEST_OVERRIDE',
  NOT_CONFIGURED: 'NOT_CONFIGURED'
};

const TEMPLATE_SPECS = {
  [SUPPORTED_TEMPLATES.ORDER_ALERT]: {
    name: SUPPORTED_TEMPLATES.ORDER_ALERT,
    language: 'en',
    category: 'UTILITY',
    targetRole: 'OWNER',
    description: 'Order notification sent to restaurant owner with Accept and Reject quick-reply buttons.',
    variables: [
      'Customer Name',
      'Customer Phone',
      'Order Type',
      'Delivery Address',
      'Formatted Order Items',
      'Total Payable with Payment Method'
    ],
    buttons: ['Accept', 'Reject']
  },
  [SUPPORTED_TEMPLATES.CUSTOMER_ACCEPTED]: {
    name: 'restopro_customer_order_accepted',
    language: 'en',
    category: 'UTILITY',
    targetRole: 'CUSTOMER',
    description: 'Confirmation notification sent to customer when restaurant accepts order.',
    variables: ['Restaurant Name', 'Order Reference', 'Fulfilment Type', 'Total Amount'],
    buttons: []
  },
  [SUPPORTED_TEMPLATES.CUSTOMER_REJECTED]: {
    name: 'restopro_customer_order_rejected',
    language: 'en',
    category: 'UTILITY',
    targetRole: 'CUSTOMER',
    description: 'Notification sent to customer when restaurant rejects order with reason.',
    variables: ['Restaurant Name', 'Order Reference', 'Rejection Reason'],
    buttons: []
  }
};

const TEMPLATE_META_DEFINITIONS = {
  [SUPPORTED_TEMPLATES.ORDER_ALERT]: {
    name: SUPPORTED_TEMPLATES.ORDER_ALERT,
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: '🍽️ *New Order Received!*\n\n━━━━━━━━━━━━━━━━━━━━\n👤 *Customer:* {{1}}\n📞 *Phone:* {{2}}\n📦 *Order Type:* {{3}}\n📍 *Address:* {{4}}\n\n🛒 *Items:*\n{{5}}\n\n━━━━━━━━━━━━━━━━━━━━\n💰 *Total:* {{6}}\n\nPlease review and confirm or cancel the order.',
        example: {
          body_text: [
            [
              'Madi',
              '+919152115523',
              'Delivery',
              '504, United Avenue, Howldak Building, Mumbai 400008',
              '4x Chicken Dum Biryani (Special)',
              '₹3200.00 (Pay COD)'
            ]
          ]
        }
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'QUICK_REPLY',
            text: 'Accept'
          },
          {
            type: 'QUICK_REPLY',
            text: 'Reject'
          }
        ]
      }
    ]
  },
  [SUPPORTED_TEMPLATES.CUSTOMER_ACCEPTED]: {
    name: 'restopro_customer_order_accepted',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Great news! Your order with {{1}} has been confirmed.\n\nOrder Ref: {{2}}\nFulfilment: {{3}}\nTotal: {{4}}\n\nThank you for ordering with us!',
        example: {
          body_text: [
            ['RestPro Demo', '#RP-261108-G83P', 'Delivery', '₹550.00']
          ]
        }
      }
    ]
  },
  [SUPPORTED_TEMPLATES.CUSTOMER_REJECTED]: {
    name: 'restopro_customer_order_rejected',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'We are sorry to inform you that your order with {{1}} could not be accepted.\n\nOrder Ref: {{2}}\nReason: {{3}}\n\nIf you have any questions, please contact the restaurant directly.',
        example: {
          body_text: [
            ['RestPro Demo', '#RP-261108-G83P', 'The restaurant is currently experiencing high demand and cannot accept new orders.']
          ]
        }
      }
    ]
  }
};

// In-memory test override map for deterministic unit testing
const testApprovalOverrides = new Map();

/**
 * Sets an in-memory template approval override for automated testing.
 * @param {string} templateName
 * @param {boolean|string} statusOrBoolean - true/false or 'APPROVED'|'PENDING'|'REJECTED'|'UNCONFIGURED'
 */
function setTemplateApprovalForTesting(templateName, statusOrBoolean) {
  if (typeof statusOrBoolean === 'boolean') {
    testApprovalOverrides.set(templateName, statusOrBoolean ? 'APPROVED' : 'UNCONFIGURED');
  } else if (typeof statusOrBoolean === 'string') {
    testApprovalOverrides.set(templateName, statusOrBoolean.toUpperCase().trim());
  } else if (statusOrBoolean === null) {
    testApprovalOverrides.delete(templateName);
  }
}

/**
 * Clears all in-memory test approval overrides.
 */
function resetTemplateApprovalsForTesting() {
  testApprovalOverrides.clear();
}

/**
 * Reads specific template approval status from environment variables.
 * Note: Never uses OWNER_TEMPLATE_APPROVED to approve customer templates.
 *
 * @param {string} templateName
 * @returns {{isApproved: boolean, status: string, approvalSource: string|null}|null}
 */
function getEnvironmentTemplateStatus(templateName) {
  // Check explicit template-specific environment variables
  if (
    templateName === SUPPORTED_TEMPLATES.ORDER_ALERT ||
    templateName === 'restopro_order_alert' ||
    templateName === 'ORDER_ALERT'
  ) {
    if (
      process.env.TEMPLATE_APPROVED_ORDER_ALERT === 'true' ||
      process.env.CENTRAL_ORDER_ALERT_APPROVED === 'true' ||
      process.env.OWNER_ORDER_ALERT_APPROVED === 'true'
    ) {
      return {
        isApproved: true,
        status: 'APPROVED',
        approvalSource: 'ENVIRONMENT_CONFIGURED'
      };
    }
  }

  if (templateName === SUPPORTED_TEMPLATES.CUSTOMER_ACCEPTED) {
    if (
      process.env.TEMPLATE_APPROVED_CUSTOMER_ACCEPTED === 'true' ||
      process.env.CENTRAL_CUSTOMER_ACCEPTED_APPROVED === 'true'
    ) {
      return {
        isApproved: true,
        status: 'APPROVED',
        approvalSource: 'ENVIRONMENT_CONFIGURED'
      };
    }
  }

  if (templateName === SUPPORTED_TEMPLATES.CUSTOMER_REJECTED) {
    if (
      process.env.TEMPLATE_APPROVED_CUSTOMER_REJECTED === 'true' ||
      process.env.CENTRAL_CUSTOMER_REJECTED_APPROVED === 'true'
    ) {
      return {
        isApproved: true,
        status: 'APPROVED',
        approvalSource: 'ENVIRONMENT_CONFIGURED'
      };
    }
  }

  return null;
}

/**
 * Evaluates whether a specific Meta Utility Template is approved and eligible for dispatch.
 * Enforces strict per-template independent validation.
 *
 * Resolution Order in CENTRAL mode:
 * 1. Test in-memory override (if set)
 * 2. Active CentralWhatsAppAccount `templates` JSON in PostgreSQL
 * 3. Specific environment variable for this exact template
 * 4. Default: Unapproved with structured reason
 *
 * @param {string} templateName - Exact Meta template name
 * @param {Object} [options]
 * @param {Object} [options.db=prisma] - Prisma client or transaction client
 * @param {Object} [options.restaurant] - Restaurant tenant record (for LEGACY mode checks)
 * @param {string} [options.routingMode] - 'CENTRAL' | 'LEGACY' (defaults to config.routingMode)
 * @returns {Promise<{isApproved: boolean, status: string, approvalSource: string|null, reason?: string, verifiedAt?: string|null, templateName: string}>}
 */
async function isTemplateApproved(templateName, {
  db = prisma,
  restaurant = null,
  routingMode = null
} = {}) {
  const effectiveMode = (routingMode || config.routingMode || 'LEGACY').toUpperCase().trim();

  // 1. Check in-memory test overrides first (for deterministic unit tests)
  if (testApprovalOverrides.has(templateName)) {
    const overrideStatus = testApprovalOverrides.get(templateName);
    const isApproved = overrideStatus === 'APPROVED';
    return {
      templateName,
      isApproved,
      status: overrideStatus,
      approvalSource: 'TEST_OVERRIDE',
      reason: isApproved ? null : `Template ${templateName} is not approved in test environment`
    };
  }

  // 2. LEGACY Mode Handling:
  // In LEGACY mode, owner alerts sent via restaurant number check restaurant-specific consent
  if (effectiveMode === 'LEGACY') {
    if (templateName === SUPPORTED_TEMPLATES.ORDER_ALERT || templateName === 'restopro_order_alert') {
      const parsedNotes = restaurant ? parseInternalNotes(restaurant.internal_notes) : null;
      const isApproved = Boolean(
        parsedNotes?.ownerConsent?.templateApproved ||
        process.env.OWNER_TEMPLATE_APPROVED === 'true' ||
        process.env.TEMPLATE_APPROVED_ORDER_ALERT === 'true'
      );

      return {
        templateName,
        isApproved,
        status: isApproved ? 'APPROVED' : 'UNCONFIGURED',
        approvalSource: isApproved ? 'RESTAURANT_CONSENT_OR_LEGACY_ENV' : null,
        reason: isApproved ? null : 'Owner alert template not approved in restaurant notes or OWNER_TEMPLATE_APPROVED'
      };
    }

    // In LEGACY mode, customer decisions do not use Meta utility templates (free-form within 24h window)
    return {
      templateName,
      isApproved: true,
      status: 'LEGACY_SESSION_WINDOW',
      approvalSource: 'LEGACY_WINDOW',
      reason: null
    };
  }

  // 3. CENTRAL Mode Handling: Strict independent template validation
  // Step A: Check PostgreSQL active CentralWhatsAppAccount.templates (restaurant assigned or global active)
  try {
    let targetCentralAccount = null;
    if (restaurant && restaurant.central_account_id) {
      targetCentralAccount = await db.centralWhatsAppAccount.findUnique({
        where: { id: restaurant.central_account_id },
        select: { templates: true, phone_number_id: true, is_active: true }
      });
      if (targetCentralAccount && !targetCentralAccount.is_active) {
        targetCentralAccount = null;
      }
    }

    if (!targetCentralAccount) {
      targetCentralAccount = await db.centralWhatsAppAccount.findFirst({
        where: { is_active: true, deleted_at: null },
        select: { templates: true, phone_number_id: true }
      });
    }

    if (targetCentralAccount && targetCentralAccount.templates) {
      const dbTemplates = typeof targetCentralAccount.templates === 'object' && targetCentralAccount.templates !== null
        ? targetCentralAccount.templates
        : {};

      const templateEntry = dbTemplates[templateName] ||
        (templateName === SUPPORTED_TEMPLATES.ORDER_ALERT ? (dbTemplates['restopro_order_alert'] || dbTemplates[SUPPORTED_TEMPLATES.ORDER_ALERT]) : null) ||
        (templateName === 'restopro_order_alert' ? dbTemplates[SUPPORTED_TEMPLATES.ORDER_ALERT] : null);
      if (templateEntry && typeof templateEntry === 'object') {
        const rawStatus = (templateEntry.status || '').toUpperCase().trim();
        const isApproved = rawStatus === 'APPROVED';
        return {
          templateName,
          isApproved,
          status: isApproved ? 'APPROVED' : (rawStatus || 'PENDING'),
          approvalSource: templateEntry.approvalSource || (isApproved ? 'DATABASE_VERIFIED' : null),
          verifiedAt: templateEntry.verifiedAt || null,
          reason: isApproved ? null : (templateEntry.failureReason || `Template ${templateName} status is ${rawStatus || 'PENDING'}`)
        };
      }
    }
  } catch (err) {
    logger.warn('Failed to query database for central template approval; checking fallback', {
      templateName,
      error: err.message
    });
  }

  // Step B: Check specific environment variable for this exact template
  const envStatus = getEnvironmentTemplateStatus(templateName);
  if (envStatus) {
    return {
      templateName,
      isApproved: envStatus.isApproved,
      status: envStatus.status,
      approvalSource: envStatus.approvalSource,
      reason: null
    };
  }

  // Step C: Neither database nor specific environment approval exists
  return {
    templateName,
    isApproved: false,
    status: 'UNCONFIGURED',
    approvalSource: 'NOT_CONFIGURED',
    reason: `Meta Utility Template "${templateName}" is not configured or approved. Please verify in Meta Business Manager and update approval status via Super Admin API.`
  };
}

/**
 * Returns the current status of all 3 central templates.
 * Used by Super Admin API to display template readiness.
 *
 * @param {Object} [db=prisma]
 * @returns {Promise<Array<Object>>}
 */
async function getCentralTemplateStatuses(db = prisma) {
  let dbTemplates = {};
  try {
    const activeAccount = await db.centralWhatsAppAccount.findFirst({
      where: { is_active: true },
      select: { templates: true }
    });
    if (activeAccount && activeAccount.templates && typeof activeAccount.templates === 'object') {
      dbTemplates = activeAccount.templates;
    }
  } catch (err) {
    logger.warn('Could not read central account templates from DB', { error: err.message });
  }

  const results = [];

  for (const [key, spec] of Object.entries(TEMPLATE_SPECS)) {
    const templateName = spec.name;
    const dbEntry = dbTemplates[templateName] || {};
    const evalResult = await isTemplateApproved(templateName, { db, routingMode: 'CENTRAL' });

    results.push({
      name: spec.name,
      language: spec.language,
      category: spec.category,
      targetRole: spec.targetRole,
      description: spec.description,
      variables: spec.variables,
      buttons: spec.buttons,
      isApproved: evalResult.isApproved,
      status: evalResult.status,
      approvalSource: evalResult.approvalSource || dbEntry.approvalSource || 'NOT_CONFIGURED',
      verifiedAt: dbEntry.verifiedAt || evalResult.verifiedAt || null,
      updatedAt: dbEntry.updatedAt || null,
      failureReason: evalResult.isApproved ? null : (dbEntry.failureReason || evalResult.reason || null)
    });
  }

  return results;
}

/**
 * Updates a specific template's approval status in the active CentralWhatsAppAccount record.
 *
 * @param {Object} params
 * @param {string} params.templateName - One of the 3 supported templates
 * @param {'APPROVED'|'PENDING'|'REJECTED'|'UNCONFIGURED'} params.status - New status
 * @param {string} [params.approvalSource] - e.g. 'SUPER_ADMIN_MANUAL_VERIFIED' or 'META_API_VERIFIED'
 * @param {string} [params.failureReason] - Reason if rejected or pending
 * @param {string} [params.adminId] - Super admin user ID performing update
 * @param {Object} [params.db=prisma]
 * @returns {Promise<Object>} Updated template status record
 */
async function updateCentralTemplateStatus({
  templateName,
  status,
  approvalSource = 'SUPER_ADMIN_MANUAL_VERIFIED',
  failureReason = null,
  adminId = null,
  isMetaVerified = false,
  db = prisma
}) {
  if (!templateName || !TEMPLATE_SPECS[templateName]) {
    const err = new Error(`[TEMPLATE ERROR] Unsupported template "${templateName}". Supported templates: ${Object.values(SUPPORTED_TEMPLATES).join(', ')}`);
    err.code = 'UNSUPPORTED_TEMPLATE';
    err.statusCode = 400;
    throw err;
  }

  const upperStatus = String(status || '').toUpperCase().trim();
  const validStatuses = ['APPROVED', 'PENDING', 'REJECTED', 'UNCONFIGURED', 'NOT_SUBMITTED', 'UNKNOWN'];
  if (!validStatuses.includes(upperStatus)) {
    const err = new Error(`[TEMPLATE ERROR] Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
    err.code = 'INVALID_STATUS';
    err.statusCode = 400;
    throw err;
  }

  // Security Invariant: Never allow manual API callers to forge META_VERIFIED
  // without an actual successful Meta API query. Downgrade forged claims to SUPER_ADMIN_MANUAL_VERIFIED.
  let effectiveSource = approvalSource;
  if (!isMetaVerified && (effectiveSource === 'META_VERIFIED' || effectiveSource === 'META_API_VERIFIED')) {
    effectiveSource = 'SUPER_ADMIN_MANUAL_VERIFIED';
    logger.warn('Manual template update attempted to claim META_VERIFIED; downgraded to SUPER_ADMIN_MANUAL_VERIFIED', {
      templateName,
      adminId
    });
  }

  const activeAccount = await db.centralWhatsAppAccount.findFirst({
    where: { is_active: true }
  });

  if (!activeAccount) {
    const err = new Error('[TEMPLATE ERROR] No active Central WhatsApp account found. Please onboard a Central WhatsApp account first.');
    err.code = 'NO_ACTIVE_CENTRAL_ACCOUNT';
    err.statusCode = 404;
    throw err;
  }

  const currentTemplates = (activeAccount.templates && typeof activeAccount.templates === 'object')
    ? { ...activeAccount.templates }
    : {};

  const now = new Date().toISOString();
  const isApproved = upperStatus === 'APPROVED';

  currentTemplates[templateName] = {
    name: templateName,
    status: upperStatus,
    approvalSource: isApproved ? effectiveSource : null,
    verifiedAt: isApproved ? now : null,
    updatedAt: now,
    updatedByAdminId: adminId,
    failureReason: isApproved ? null : failureReason
  };

  await db.centralWhatsAppAccount.update({
    where: { id: activeAccount.id },
    data: {
      templates: currentTemplates
    }
  });

  logger.info('Central WhatsApp template status updated', {
    templateName,
    status: upperStatus,
    adminId,
    accountId: activeAccount.id,
    approvalSource: isApproved ? effectiveSource : null
  });

  const spec = TEMPLATE_SPECS[templateName];
  return {
    name: templateName,
    language: spec.language,
    category: spec.category,
    targetRole: spec.targetRole,
    description: spec.description,
    isApproved,
    status: upperStatus,
    approvalSource: isApproved ? effectiveSource : 'NOT_CONFIGURED',
    verifiedAt: isApproved ? now : null,
    updatedAt: now,
    failureReason: isApproved ? null : failureReason
  };
}

/**
 * Directly queries Meta WhatsApp Business Management API for live template approval status.
 * GET https://graph.facebook.com/v21.0/{waba_id}/message_templates?name={templateName}
 *
 * @param {Object} [options]
 * @param {Object} [options.httpClient] - Optional custom HTTP client (for unit testing)
 * @param {string} [options.adminId]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<{success: boolean, verifiedSource: string, templates: Array<Object>}>}
 */
async function verifyCentralTemplatesWithMeta({ httpClient = null, adminId = null, db = prisma } = {}) {
  const { resolveCentralCredentials } = require('./central-whatsapp.service');
  const creds = await resolveCentralCredentials(db);

  if (!creds || !creds.wabaId || !creds.accessToken) {
    const err = new Error('Central WhatsApp credentials (wabaId, accessToken) are not configured.');
    err.code = 'MISSING_CENTRAL_CREDENTIALS';
    err.statusCode = 400;
    throw err;
  }

  const client = httpClient || axios;
  const isMockToken = !httpClient && (
    creds.accessToken.startsWith('mock_') ||
    creds.accessToken.startsWith('EAAB_test') ||
    creds.accessToken.startsWith('EAABmock') ||
    creds.accessToken.startsWith('EAA_TEST_MOCK_VALID_')
  );

  const verifiedTemplates = [];
  const activeAccount = await db.centralWhatsAppAccount.findFirst({
    where: { is_active: true }
  });

  const currentTemplates = (activeAccount?.templates && typeof activeAccount.templates === 'object')
    ? { ...activeAccount.templates }
    : {};

  const now = new Date().toISOString();

  for (const [key, spec] of Object.entries(TEMPLATE_SPECS)) {
    const templateName = spec.name;
    let metaStatus = 'UNKNOWN';
    let failureReason = null;
    let verified = false;

    if (isMockToken) {
      // Deterministic mock verification in test environments
      metaStatus = 'APPROVED';
      verified = true;
    } else {
      try {
        const url = `https://graph.facebook.com/v21.0/${creds.wabaId}/message_templates`;
        const resp = await client.get(url, {
          headers: {
            'Authorization': `Bearer ${creds.accessToken}`,
            'Content-Type': 'application/json'
          },
          params: { name: templateName },
          timeout: 8000
        });

        const data = resp.data?.data || [];
        if (data.length === 0) {
          metaStatus = 'NOT_SUBMITTED';
          failureReason = `Template "${templateName}" not found on Meta WABA ${creds.wabaId}. Please create it in Meta Business Manager.`;
        } else {
          const match = data.find(t => t.name === templateName) || data[0];
          metaStatus = (match.status || 'UNKNOWN').toUpperCase().trim();
          verified = true;
          if (metaStatus === 'REJECTED') {
            failureReason = match.reason || 'Template rejected by Meta review';
          } else if (metaStatus === 'PENDING') {
            failureReason = 'Template pending Meta review';
          }
        }
      } catch (metaErr) {
        const metaError = metaErr.response?.data?.error;
        const statusCode = metaErr.response?.status;
        const rawMsg = metaError?.message || metaErr.message || 'Meta API verification failed';
        const cleanMsg = rawMsg.replace(/EAA[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]');

        logger.warn('Meta template verification query failed', {
          templateName,
          statusCode,
          error: cleanMsg
        });

        metaStatus = 'UNKNOWN';
        failureReason = `Meta API query failed (${statusCode || 'network'}): ${cleanMsg}`;
      }
    }

    const isApproved = metaStatus === 'APPROVED';

    currentTemplates[templateName] = {
      name: templateName,
      status: metaStatus,
      approvalSource: verified ? 'META_VERIFIED' : 'NOT_CONFIGURED',
      verifiedAt: verified && isApproved ? now : null,
      updatedAt: now,
      updatedByAdminId: adminId,
      failureReason: isApproved ? null : failureReason
    };

    verifiedTemplates.push({
      name: templateName,
      language: spec.language,
      category: spec.category,
      targetRole: spec.targetRole,
      isApproved,
      status: metaStatus,
      approvalSource: verified ? 'META_VERIFIED' : 'NOT_CONFIGURED',
      verifiedAt: verified && isApproved ? now : null,
      updatedAt: now,
      failureReason: isApproved ? null : failureReason
    });
  }

  if (activeAccount) {
    await db.centralWhatsAppAccount.update({
      where: { id: activeAccount.id },
      data: { templates: currentTemplates }
    });
  }

  logger.info('Central WhatsApp templates verified against Meta API', {
    wabaId: creds.wabaId,
    verifiedSource: isMockToken ? 'MOCK_META_API' : 'META_GRAPH_API',
    count: verifiedTemplates.length
  });

  return {
    success: true,
    verifiedSource: isMockToken ? 'MOCK_META_API' : 'META_GRAPH_API',
    templates: verifiedTemplates
  };
}

/**
 * Returns complete, copy-ready Meta template definitions for manual or programmatic creation.
 * @returns {Array<Object>}
 */
function getCopyReadyTemplateDefinitions() {
  return Object.values(TEMPLATE_META_DEFINITIONS).map(def => ({
    ...def,
    spec: TEMPLATE_SPECS[def.name]
  }));
}

/**
 * Submits a Meta utility template definition directly to Meta Graph API.
 * 1. Checks if template already exists on Meta WABA (via GET).
 * 2. If it does not exist, submits via POST /v21.0/{waba_id}/message_templates.
 * 3. Updates database templates record with real Meta status and approvalSource='META_VERIFIED'.
 *
 * @param {Object} params
 * @param {string} params.templateName
 * @param {Object} [params.httpClient]
 * @param {string} [params.adminId]
 * @param {Object} [params.db=prisma]
 * @returns {Promise<Object>}
 */
async function submitCentralTemplateToMeta({ templateName, httpClient = null, adminId = null, db = prisma } = {}) {
  if (!templateName || !TEMPLATE_SPECS[templateName]) {
    const err = new Error(`[TEMPLATE ERROR] Unsupported template "${templateName}". Supported templates: ${Object.values(SUPPORTED_TEMPLATES).join(', ')}`);
    err.code = 'UNSUPPORTED_TEMPLATE';
    err.statusCode = 400;
    throw err;
  }

  const { resolveCentralCredentials } = require('./central-whatsapp.service');
  const creds = await resolveCentralCredentials(db);

  if (!creds || !creds.wabaId || !creds.accessToken) {
    const err = new Error('Central WhatsApp credentials (wabaId, accessToken) are not configured.');
    err.code = 'MISSING_CENTRAL_CREDENTIALS';
    err.statusCode = 400;
    throw err;
  }

  const client = httpClient || axios;
  const isMockToken = !httpClient && (
    creds.accessToken.startsWith('mock_') ||
    creds.accessToken.startsWith('EAAB_test') ||
    creds.accessToken.startsWith('EAABmock') ||
    creds.accessToken.startsWith('EAA_TEST_MOCK_VALID_')
  );

  const def = TEMPLATE_META_DEFINITIONS[templateName];
  const now = new Date().toISOString();

  if (isMockToken) {
    // Deterministic mock submission in test environments
    const activeAccount = await db.centralWhatsAppAccount.findFirst({ where: { is_active: true } });
    if (activeAccount) {
      const cur = (activeAccount.templates && typeof activeAccount.templates === 'object') ? { ...activeAccount.templates } : {};
      cur[templateName] = {
        name: templateName,
        status: 'PENDING',
        approvalSource: 'META_VERIFIED',
        verifiedAt: null,
        updatedAt: now,
        updatedByAdminId: adminId,
        failureReason: 'Template submitted to Meta; pending review'
      };
      await db.centralWhatsAppAccount.update({ where: { id: activeAccount.id }, data: { templates: cur } });
    }

    return {
      success: true,
      alreadyExists: false,
      templateName,
      metaId: 'mock_meta_template_id_123',
      status: 'PENDING',
      approvalSource: 'META_VERIFIED',
      verifiedSource: 'MOCK_META_API',
      message: `Template "${templateName}" submitted in mock mode.`
    };
  }

  // Step 1: Pre-submission check: does it already exist on Meta WABA?
  try {
    const checkUrl = `https://graph.facebook.com/v21.0/${creds.wabaId}/message_templates`;
    const checkResp = await client.get(checkUrl, {
      headers: {
        'Authorization': `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json'
      },
      params: { name: templateName },
      timeout: 8000
    });

    const existing = checkResp.data?.data || [];
    const match = existing.find(t => t.name === templateName);
    if (match) {
      const matchStatus = (match.status || 'UNKNOWN').toUpperCase().trim();
      const isApproved = matchStatus === 'APPROVED';

      const activeAccount = await db.centralWhatsAppAccount.findFirst({ where: { is_active: true } });
      if (activeAccount) {
        const cur = (activeAccount.templates && typeof activeAccount.templates === 'object') ? { ...activeAccount.templates } : {};
        cur[templateName] = {
          name: templateName,
          status: matchStatus,
          approvalSource: 'META_VERIFIED',
          verifiedAt: isApproved ? now : null,
          updatedAt: now,
          updatedByAdminId: adminId,
          failureReason: isApproved ? null : (match.reason || `Template status is ${matchStatus}`)
        };
        await db.centralWhatsAppAccount.update({ where: { id: activeAccount.id }, data: { templates: cur } });
      }

      return {
        success: true,
        alreadyExists: true,
        templateName,
        metaId: match.id || null,
        status: matchStatus,
        approvalSource: 'META_VERIFIED',
        message: `Template "${templateName}" already exists on Meta WABA with status "${matchStatus}".`
      };
    }
  } catch (checkErr) {
    logger.warn('Pre-submission template existence check failed; proceeding to submit', {
      templateName,
      error: checkErr.message
    });
  }

  // Step 2: Submit template to Meta Graph API
  try {
    const postUrl = `https://graph.facebook.com/v21.0/${creds.wabaId}/message_templates`;
    const resp = await client.post(postUrl, def, {
      headers: {
        'Authorization': `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    const resData = resp.data || {};
    const metaStatus = (resData.status || 'PENDING').toUpperCase().trim();
    const isApproved = metaStatus === 'APPROVED';

    const activeAccount = await db.centralWhatsAppAccount.findFirst({ where: { is_active: true } });
    if (activeAccount) {
      const cur = (activeAccount.templates && typeof activeAccount.templates === 'object') ? { ...activeAccount.templates } : {};
      cur[templateName] = {
        name: templateName,
        status: metaStatus,
        approvalSource: 'META_VERIFIED',
        verifiedAt: isApproved ? now : null,
        updatedAt: now,
        updatedByAdminId: adminId,
        failureReason: isApproved ? null : 'Submitted to Meta review'
      };
      await db.centralWhatsAppAccount.update({ where: { id: activeAccount.id }, data: { templates: cur } });
    }

    logger.info('Meta template submitted successfully', {
      templateName,
      metaId: resData.id,
      status: metaStatus
    });

    return {
      success: true,
      alreadyExists: false,
      templateName,
      metaId: resData.id || null,
      status: metaStatus,
      approvalSource: 'META_VERIFIED',
      message: `Template "${templateName}" successfully submitted to Meta with status "${metaStatus}".`
    };
  } catch (postErr) {
    const metaError = postErr.response?.data?.error;
    const statusCode = postErr.response?.status;
    const rawMsg = metaError?.message || postErr.message || 'Meta template submission failed';
    const cleanMsg = rawMsg.replace(/EAA[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]');

    logger.error('Meta template submission failed', { templateName, statusCode, error: cleanMsg });

    const err = new Error(`Meta API template submission failed (${statusCode || 'network'}): ${cleanMsg}`);
    err.statusCode = statusCode || 502;
    err.metaErrorCode = metaError?.code;
    err.code = 'META_SUBMISSION_FAILED';
    throw err;
  }
}

/**
 * Submits all supported Central WhatsApp templates to Meta API sequentially.
 *
 * @param {Object} [options]
 * @param {Object} [options.httpClient]
 * @param {string} [options.adminId]
 * @param {Object} [options.db=prisma]
 * @returns {Promise<{success: boolean, results: Array<Object>}>}
 */
async function submitAllCentralTemplatesToMeta({ httpClient = null, adminId = null, db = prisma } = {}) {
  const results = [];
  for (const name of Object.values(SUPPORTED_TEMPLATES)) {
    const res = await submitCentralTemplateToMeta({ templateName: name, httpClient, adminId, db });
    results.push(res);
  }
  return {
    success: true,
    results
  };
}

module.exports = {
  SUPPORTED_TEMPLATES,
  TEMPLATE_SPECS,
  TEMPLATE_META_DEFINITIONS,
  TEMPLATE_STATUSES,
  APPROVAL_SOURCES,
  isTemplateApproved,
  getCentralTemplateStatuses,
  getCopyReadyTemplateDefinitions,
  updateCentralTemplateStatus,
  verifyCentralTemplatesWithMeta,
  submitCentralTemplateToMeta,
  submitAllCentralTemplatesToMeta,
  setTemplateApprovalForTesting,
  resetTemplateApprovalsForTesting
};
