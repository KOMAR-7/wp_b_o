/**
 * RESTOPRO — Super Admin Central WhatsApp Management Controller
 * R6.6.2 & R6.8 Multi-Account Implementation
 *
 * Implements endpoints:
 * - GET    /api/admin/central-accounts                (List all central accounts)
 * - GET    /api/admin/central-accounts/:id            (Get single central account details)
 * - POST   /api/admin/central-accounts                (Create new central account)
 * - PATCH  /api/admin/central-accounts/:id            (Update central account details)
 * - POST   /api/admin/central-accounts/:id/test-connection (Test Meta connection)
 * - POST   /api/admin/central-accounts/:id/activate   (Activate account)
 * - POST   /api/admin/central-accounts/:id/deactivate (Deactivate account with warning)
 * - DELETE /api/admin/central-accounts/:id            (Safe delete with dependency check)
 * - GET    /api/admin/central-accounts/:id/restaurants (List assigned restaurants)
 * - GET    /api/admin/restaurants/unassigned-central-account (List unassigned restaurants)
 * - PUT    /api/admin/restaurants/:restaurantId/central-account (Assign restaurant)
 * - DELETE /api/admin/restaurants/:restaurantId/central-account (Unassign restaurant)
 *
 * Backward-compatible legacy routes:
 * - GET    /api/admin/central-account                 (Active account / env fallback)
 * - POST   /api/admin/central-account                 (Single active enforcement)
 * - PATCH  /api/admin/central-account                 (Update active account)
 * - POST   /api/admin/central-account/test-connection (Test active connection)
 * - Template management endpoints (/templates, /definitions, /submit, /verify-meta)
 */
const prisma = require('../config/database');
const config = require('../config/env');
const logger = require('../utils/logger');
const {
  createCentralAccount,
  listCentralAccounts,
  getActiveCentralAccount,
  getCentralAccountById,
  resolveCentralCredentials,
  updateCentralAccount,
  testCentralAccountConnection,
  activateCentralAccount,
  deactivateCentralAccount,
  deleteCentralAccount,
  sanitizeCentralAccount,
  getAssignedRestaurants,
  getUnassignedRestaurants,
  assignRestaurantToCentralAccount,
  unassignRestaurantFromCentralAccount
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
 * GET /api/admin/central-accounts
 * Lists all registered Central WhatsApp accounts with stats and assigned restaurant counts.
 */
async function handleListCentralAccounts(req, res) {
  try {
    const { includeDeleted, status, search } = req.query || {};
    const accounts = await listCentralAccounts({
      includeDeleted: includeDeleted === 'true',
      status: status ? String(status).toUpperCase() : null,
      search: search ? String(search) : null
    });

    return res.status(200).json({
      success: true,
      count: accounts.length,
      accounts
    });
  } catch (err) {
    logger.error('Error listing central WhatsApp accounts', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/admin/central-accounts/:id
 * Retrieves a single Central WhatsApp account by ID with detailed assigned restaurants.
 */
async function handleGetCentralAccountById(req, res) {
  try {
    const { id } = req.params;
    const account = await getCentralAccountById(id);

    if (!account || account.deleted_at) {
      return res.status(404).json({ success: false, error: 'Central WhatsApp account not found' });
    }

    return res.status(200).json({
      success: true,
      account: sanitizeCentralAccount(account),
      restaurants: account.restaurants || []
    });
  } catch (err) {
    logger.error('Error fetching central WhatsApp account by ID', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/admin/central-account (Legacy singular endpoint)
 * Returns active central account or environment fallback for backward compatibility.
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
          account_name: 'Environment Central Account',
          description: 'Loaded from environment variables',
          phone_number_id: envPhone,
          waba_id: envWaba || null,
          display_phone_number: null,
          is_active: true,
          verification_status: 'UNVERIFIED',
          last_tested_at: null,
          verification_error: null,
          deleted_at: null,
          has_token: true,
          templates: {},
          assigned_restaurants_count: 0,
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
 * Helper to process account creation logic for both plural and singular endpoints.
 */
async function processAccountCreation(req, res, { enforceSingleActive = false }) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const {
      accountName,
      description,
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

    // In legacy singular mode, if deactivatePrevious is true, deactivate existing active first
    if (enforceSingleActive && isActive && deactivatePrevious) {
      const existingActive = await getActiveCentralAccount();
      if (existingActive) {
        await deactivateCentralAccount(existingActive.id);
        logger.info('Deactivated previous Central WhatsApp account before creating new one', {
          previousId: existingActive.id
        });
      }
    }

    const created = await createCentralAccount({
      accountName,
      description,
      phoneNumberId,
      wabaId,
      accessToken,
      displayPhoneNumber,
      isActive,
      enforceSingleActive: enforceSingleActive && !deactivatePrevious,
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
            accountName: created.account_name,
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
 * POST /api/admin/central-accounts
 * Multi-account creation endpoint. Does not enforce single active account.
 */
async function handleCreateCentralAccountPlural(req, res) {
  return processAccountCreation(req, res, { enforceSingleActive: false });
}

/**
 * POST /api/admin/central-account (Legacy singular endpoint)
 * Enforces single active account if deactivatePrevious is false.
 */
async function handleCreateCentralAccount(req, res) {
  return processAccountCreation(req, res, { enforceSingleActive: true });
}

/**
 * PATCH /api/admin/central-accounts/:id
 * Updates account details, supports optional token rotation (preserves token if blank).
 */
async function handleUpdateCentralAccountById(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { id } = req.params;
    const updateFields = req.body || {};

    const updated = await updateCentralAccount(id, updateFields);

    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: 'CENTRAL_WHATSAPP_ACCOUNT_UPDATED',
          entity_type: 'CentralWhatsAppAccount',
          entity_id: updated.id,
          metadata: {
            accountName: updated.account_name,
            phoneNumberId: updated.phone_number_id,
            rotatedToken: Boolean(updateFields.accessToken && updateFields.accessToken.trim()),
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
    if (err.code === 'DUPLICATE_PHONE_NUMBER_ID') {
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
 * PATCH /api/admin/central-account (Legacy singular update)
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
 * POST /api/admin/central-accounts/:id/test-connection
 * Tests Meta connectivity for a specific central account.
 */
async function handleTestAccountConnectionById(req, res) {
  try {
    const { id } = req.params;
    const outcome = await testCentralAccountConnection(id, {
      httpClient: req.httpClient || null
    });

    return res.status(200).json(outcome);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      status: 'ERROR',
      error: err.message
    });
  }
}

/**
 * POST /api/admin/central-account/test-connection (Legacy test connection on active account)
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
 * POST /api/admin/central-accounts/:id/activate
 */
async function handleActivateCentralAccount(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { id } = req.params;

    const activated = await activateCentralAccount(id);

    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: 'CENTRAL_WHATSAPP_ACCOUNT_ACTIVATED',
          entity_type: 'CentralWhatsAppAccount',
          entity_id: id,
          metadata: {
            phoneNumberId: activated.phone_number_id,
            accountName: activated.account_name
          }
        }
      }).catch(err => logger.warn('Failed to record audit log', { error: err.message }));
    }

    return res.status(200).json({
      success: true,
      account: activated
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/admin/central-accounts/:id/deactivate
 */
async function handleDeactivateCentralAccount(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { id } = req.params;

    const result = await deactivateCentralAccount(id);

    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: 'CENTRAL_WHATSAPP_ACCOUNT_DEACTIVATED',
          entity_type: 'CentralWhatsAppAccount',
          entity_id: id,
          metadata: {
            phoneNumberId: result.phone_number_id,
            accountName: result.account_name,
            warning: result.warning
          }
        }
      }).catch(err => logger.warn('Failed to record audit log', { error: err.message }));
    }

    return res.status(200).json({
      success: true,
      account: result,
      warning: result.warning
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

/**
 * DELETE /api/admin/central-accounts/:id
 */
async function handleDeleteCentralAccount(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { id } = req.params;
    const { force = false } = req.query || {};

    const result = await deleteCentralAccount(id, { force: force === 'true' });

    if (adminId) {
      await prisma.auditLog.create({
        data: {
          admin_user_id: adminId,
          action: result.softDeleted ? 'CENTRAL_WHATSAPP_ACCOUNT_SOFT_DELETED' : 'CENTRAL_WHATSAPP_ACCOUNT_DELETED',
          entity_type: 'CentralWhatsAppAccount',
          entity_id: id,
          metadata: {
            softDeleted: result.softDeleted
          }
        }
      }).catch(err => logger.warn('Failed to record audit log', { error: err.message }));
    }

    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      code: err.code || 'DELETE_FAILED',
      error: err.message
    });
  }
}

/**
 * GET /api/admin/central-accounts/:id/restaurants
 * Lists restaurants assigned to this central account.
 */
async function handleGetAssignedRestaurants(req, res) {
  try {
    const { id } = req.params;
    const restaurants = await getAssignedRestaurants(id);
    return res.status(200).json({
      success: true,
      count: restaurants.length,
      restaurants
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/admin/restaurants/unassigned-central-account
 * Lists restaurants with no central account assigned.
 */
async function handleGetUnassignedRestaurants(req, res) {
  try {
    const restaurants = await getUnassignedRestaurants();
    return res.status(200).json({
      success: true,
      count: restaurants.length,
      restaurants
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * PUT /api/admin/restaurants/:restaurantId/central-account
 * Assigns or reassigns a restaurant to a central WhatsApp account.
 */
async function handleAssignRestaurant(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { restaurantId } = req.params;
    const { centralAccountId } = req.body || {};

    if (!centralAccountId || typeof centralAccountId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: centralAccountId'
      });
    }

    const updated = await assignRestaurantToCentralAccount(restaurantId, centralAccountId, { adminId });

    return res.status(200).json({
      success: true,
      restaurant: updated
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      code: err.code || 'ASSIGNMENT_ERROR',
      error: err.message
    });
  }
}

/**
 * DELETE /api/admin/restaurants/:restaurantId/central-account
 * Removes central account assignment from a restaurant.
 */
async function handleUnassignRestaurant(req, res) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const { restaurantId } = req.params;

    const updated = await unassignRestaurantFromCentralAccount(restaurantId, { adminId });

    return res.status(200).json({
      success: true,
      restaurant: updated
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * GET /api/admin/central-account/templates
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
  handleListCentralAccounts,
  handleGetCentralAccountById,
  handleGetCentralAccount,
  handleCreateCentralAccount,
  handleCreateCentralAccountPlural,
  handleUpdateCentralAccount,
  handleUpdateCentralAccountById,
  handleTestAccountConnectionById,
  handleTestConnection,
  handleActivateCentralAccount,
  handleDeactivateCentralAccount,
  handleDeleteCentralAccount,
  handleGetAssignedRestaurants,
  handleGetUnassignedRestaurants,
  handleAssignRestaurant,
  handleUnassignRestaurant,
  handleGetTemplates,
  handleGetTemplateDefinitions,
  handleUpdateTemplate,
  handleVerifyTemplatesWithMeta,
  handleSubmitTemplatesToMeta
};
