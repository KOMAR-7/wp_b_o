/**
 * RESTOPRO — Super Admin Central WhatsApp Management Controller
 * R6.6.2 Implementation
 *
 * Implements endpoints:
 * - GET    /api/admin/central-account              (Get active central account configuration)
 * - POST   /api/admin/central-account              (Onboard central WhatsApp account)
 * - PATCH  /api/admin/central-account              (Update/rotate central WhatsApp account)
 * - POST   /api/admin/central-account/test-connection (Test Meta Graph API connectivity)
 * - GET    /api/admin/central-account/templates    (Get individual status for the 3 templates)
 * - PATCH  /api/admin/central-account/templates/:templateName (Update individual template status)
 */
const prisma = require('../config/database');
const config = require('../config/env');
const logger = require('../utils/logger');
const {
  getActiveCentralAccount,
  getCentralAccountById,
  createCentralAccount,
  updateCentralAccount,
  deactivateCentralAccount,
  resolveCentralCredentials,
  sanitizeCentralAccount
} = require('../services/central-whatsapp.service');
const {
  getCentralTemplateStatuses,
  getCopyReadyTemplateDefinitions,
  updateCentralTemplateStatus,
  verifyCentralTemplatesWithMeta,
  submitCentralTemplateToMeta,
  submitAllCentralTemplatesToMeta,
  SUPPORTED_TEMPLATES
} = require('../services/template-config.service');
const { verifyMetaWhatsAppToken } = require('../services/whatsapp.service');

/**
 * GET /api/admin/central-account
 * Returns sanitized central account configuration and connection state.
 */
async function handleGetCentralAccount(req, res) {
  try {
    const activeAccount = await getActiveCentralAccount();

    if (activeAccount) {
      return res.status(200).json({
        success: true,
        configured: true,
        source: 'DATABASE',
        account: sanitizeCentralAccount(activeAccount)
      });
    }

    // Check environment variable fallback
    const envPhone = (config.central?.phoneNumberId || process.env.CENTRAL_PHONE_NUMBER_ID || '').trim();
    const envWaba = (config.central?.wabaId || process.env.CENTRAL_WABA_ID || '').trim();
    const envToken = (config.central?.accessToken || process.env.CENTRAL_ACCESS_TOKEN || '').trim();

    if (envPhone && envToken) {
      return res.status(200).json({
        success: true,
        configured: true,
        source: 'ENVIRONMENT',
        account: {
          id: null,
          phone_number_id: envPhone,
          waba_id: envWaba || null,
          display_phone_number: null,
          is_active: true,
          has_token: true,
          templates: {},
          created_at: null,
          updated_at: null
        }
      });
    }

    return res.status(200).json({
      success: true,
      configured: false,
      source: 'NONE',
      account: null
    });
  } catch (err) {
    logger.error('Error fetching central WhatsApp account', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/central-account
 * Onboards a new Central WhatsApp account, encrypts token, enforces single active account.
 */
async function handleCreateCentralAccount(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const {
      phoneNumberId,
      wabaId,
      accessToken,
      displayPhoneNumber,
      isActive = true,
      deactivatePrevious = false,
      templates = {}
    } = req.body || {};

    if (!phoneNumberId || typeof phoneNumberId !== 'string' || !phoneNumberId.trim()) {
      return res.status(400).json({ success: false, error: 'Missing required field: phoneNumberId' });
    }

    if (!wabaId || typeof wabaId !== 'string' || !wabaId.trim()) {
      return res.status(400).json({ success: false, error: 'Missing required field: wabaId' });
    }

    if (!accessToken || typeof accessToken !== 'string' || !accessToken.trim()) {
      return res.status(400).json({ success: false, error: 'Missing required field: accessToken' });
    }

    // If requested, deactivate existing active account first
    if (isActive && deactivatePrevious) {
      const existingActive = await getActiveCentralAccount();
      if (existingActive) {
        await deactivateCentralAccount(existingActive.id);
        logger.info('Deactivated previous Central WhatsApp account before creating new one', {
          previousId: existingActive.id
        });
      }
    }

    const created = await createCentralAccount({
      phoneNumberId,
      wabaId,
      accessToken,
      displayPhoneNumber,
      isActive,
      templates
    });

    // Record audit log
    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: 'CENTRAL_WHATSAPP_ACCOUNT_CREATED',
          entity_type: 'CentralWhatsAppAccount',
          entity_id: created.id,
          metadata: {
            phoneNumberId: created.phone_number_id,
            wabaId: created.waba_id,
            isActive: created.is_active
          }
        }
      }).catch(err => logger.warn('Failed to record audit log', { error: err.message }));
    }

    return res.status(201).json({
      success: true,
      account: created
    });
  } catch (err) {
    if (err.code === 'SINGLE_ACTIVE_ACCOUNT_EXISTS') {
      return res.status(409).json({
        success: false,
        code: 'SINGLE_ACTIVE_ACCOUNT_EXISTS',
        error: 'An active Central WhatsApp account already exists. Pass deactivatePrevious: true or deactivate the existing account first.'
      });
    }

    if (err.code === 'INVALID_TOKEN_PREFIX') {
      return res.status(400).json({
        success: false,
        code: 'INVALID_TOKEN_PREFIX',
        error: err.message
      });
    }

    if (err.code === 'DUPLICATE_PHONE_NUMBER_ID') {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_PHONE_NUMBER_ID',
        error: err.message
      });
    }

    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error creating Central WhatsApp account', { error: err.message });
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
    return res.status(status).json({ success: false, error: err.message });
  }
}

/**
 * PATCH /api/admin/central-account
 * Updates or rotates token for the Central WhatsApp account.
 */
async function handleUpdateCentralAccount(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { id, ...updateFields } = req.body || {};

    let targetId = id;
    if (!targetId) {
      const active = await getActiveCentralAccount();
      if (!active) {
        return res.status(404).json({
          success: false,
          error: 'No active Central WhatsApp account found to update. Use POST /api/admin/central-account to create one.'
        });
      }
      targetId = active.id;
    }

    const updated = await updateCentralAccount(targetId, updateFields);

    // Record audit log
    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: 'CENTRAL_WHATSAPP_ACCOUNT_UPDATED',
          entity_type: 'CentralWhatsAppAccount',
          entity_id: updated.id,
          metadata: {
            phoneNumberId: updated.phone_number_id,
            rotatedToken: Boolean(updateFields.accessToken),
            isActive: updated.is_active
          }
        }
      }).catch(err => logger.warn('Failed to record audit log', { error: err.message }));
    }

    return res.status(200).json({
      success: true,
      account: updated
    });
  } catch (err) {
    if (err.code === 'ACCOUNT_NOT_FOUND') {
      return res.status(404).json({ success: false, error: err.message });
    }
    if (err.code === 'SINGLE_ACTIVE_ACCOUNT_EXISTS') {
      return res.status(409).json({ success: false, error: err.message });
    }
    if (err.code === 'INVALID_TOKEN_PREFIX') {
      return res.status(400).json({ success: false, error: err.message });
    }

    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error updating Central WhatsApp account', { error: err.message });
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
    return res.status(status).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/admin/central-account/test-connection
 * Tests Meta WhatsApp Cloud API connectivity using configured credentials.
 */
async function handleTestConnection(req, res) {
  try {
    let creds;
    try {
      creds = await resolveCentralCredentials();
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        status: 'UNCONFIGURED',
        error: credErr.message
      });
    }

    // Call Meta Graph API to verify token and phone number ID
    const verification = await verifyMetaWhatsAppToken({
      phoneNumberId: creds.phoneNumberId,
      accessToken: creds.accessToken,
      httpClient: req.httpClient || null
    });

    if (verification.valid) {
      return res.status(200).json({
        success: true,
        status: 'CONNECTED',
        verified: true,
        source: creds.source,
        phoneNumberId: creds.phoneNumberId,
        verifiedName: verification.verifiedName || null,
        displayPhoneNumber: verification.displayPhoneNumber || creds.displayPhoneNumber || null,
        qualityRating: verification.qualityRating || null
      });
    }

    return res.status(200).json({
      success: false,
      status: 'DISCONNECTED',
      verified: false,
      source: creds.source,
      error: verification.error || 'Token verification failed against Meta API',
      statusCode: verification.statusCode || null,
      metaErrorCode: verification.errorCode || null
    });
  } catch (err) {
    logger.error('Unexpected error testing Central WhatsApp connection', { error: err.message });
    return res.status(500).json({
      success: false,
      status: 'ERROR',
      error: 'Failed to test connection: ' + err.message
    });
  }
}

/**
 * GET /api/admin/central-account/templates
 * Returns individual status for the 3 Central WhatsApp Meta Utility Templates.
 */
async function handleGetTemplates(req, res) {
  try {
    const templates = await getCentralTemplateStatuses();
    return res.status(200).json({
      success: true,
      templates
    });
  } catch (err) {
    logger.error('Error fetching central template statuses', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PATCH /api/admin/central-account/templates/:templateName
 * Updates a specific template's approval status in the active Central WhatsApp Account.
 */
async function handleUpdateTemplate(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { templateName } = req.params;
    const { status, approvalSource, failureReason } = req.body || {};

    if (!templateName) {
      return res.status(400).json({ success: false, error: 'Missing templateName in URL parameter' });
    }

    const updated = await updateCentralTemplateStatus({
      templateName,
      status,
      approvalSource,
      failureReason,
      adminId
    });

    // Record audit log
    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: 'CENTRAL_TEMPLATE_STATUS_UPDATED',
          entity_type: 'CentralWhatsAppAccount',
          entity_id: templateName,
          metadata: {
            templateName,
            status: updated.status,
            approvalSource: updated.approvalSource
          }
        }
      }).catch(err => logger.warn('Failed to record audit log', { error: err.message }));
    }

    return res.status(200).json({
      success: true,
      template: updated
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logger.error('Error updating template status', { error: err.message });
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
    return res.status(status).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/admin/central-account/templates/verify-meta
 * Queries Meta WhatsApp Cloud API directly for all 3 templates and records live verification.
 */
async function handleVerifyTemplatesWithMeta(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const result = await verifyCentralTemplatesWithMeta({
      httpClient: req.httpClient || null,
      adminId
    });

    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: 'CENTRAL_TEMPLATES_META_VERIFIED',
          entity_type: 'CentralWhatsAppAccount',
          metadata: {
            verifiedSource: result.verifiedSource,
            templateCount: result.templates.length
          }
        }
      }).catch(err => logger.warn('Failed to record audit log', { error: err.message }));
    }

    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error verifying templates with Meta API', { error: err.message });
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/admin/central-account/templates/definitions
 * Returns copy-ready template definitions for manual or programmatic creation.
 */
async function handleGetTemplateDefinitions(req, res) {
  try {
    const definitions = getCopyReadyTemplateDefinitions();
    return res.status(200).json({
      success: true,
      definitions
    });
  } catch (err) {
    logger.error('Error fetching template definitions', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/central-account/templates/submit
 * Submits all or a specific template definition to Meta Graph API.
 */
async function handleSubmitTemplatesToMeta(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { templateName } = req.body || {};

    let result;
    if (templateName) {
      result = await submitCentralTemplateToMeta({
        templateName,
        httpClient: req.httpClient || null,
        adminId
      });
    } else {
      result = await submitAllCentralTemplatesToMeta({
        httpClient: req.httpClient || null,
        adminId
      });
    }

    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: 'CENTRAL_TEMPLATES_META_SUBMITTED',
          entity_type: 'CentralWhatsAppAccount',
          metadata: {
            templateName: templateName || 'ALL',
            success: result.success
          }
        }
      }).catch(err => logger.warn('Failed to record audit log', { error: err.message }));
    }

    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error submitting templates to Meta API', { error: err.message });
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      code: err.code || 'META_SUBMISSION_ERROR',
      error: err.message
    });
  }
}

module.exports = {
  handleGetCentralAccount,
  handleCreateCentralAccount,
  handleUpdateCentralAccount,
  handleTestConnection,
  handleGetTemplates,
  handleGetTemplateDefinitions,
  handleUpdateTemplate,
  handleVerifyTemplatesWithMeta,
  handleSubmitTemplatesToMeta
};

