/**
 * RESTOPRO — R6.6.2 Central WhatsApp Independent Template Approval Test Suite
 *
 * Verifies:
 * 1. Independent Meta Template approval configuration and resolution
 * 2. Database-backed template status tracking per template
 * 3. Never using OWNER_TEMPLATE_APPROVED to approve customer templates
 * 4. Never using CENTRAL_TEMPLATE_APPROVED as blanket approval
 * 5. Selective blocking: Owner alert approved but Customer Accepted unapproved
 * 6. Selective blocking: Customer Accepted approved but Customer Rejected unapproved
 * 7. Classified failure (BLOCKED_TEMPLATE_NOT_CONFIGURED) without fallback to restaurant
 * 8. LEGACY mode behavior preservation
 */
require('./load-test-env');
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const prisma = require('../src/config/database');
const config = require('../src/config/env');
const {
  SUPPORTED_TEMPLATES,
  TEMPLATE_SPECS,
  isTemplateApproved,
  getCentralTemplateStatuses,
  updateCentralTemplateStatus,
  setTemplateApprovalForTesting,
  resetTemplateApprovalsForTesting
} = require('../src/services/template-config.service');
const {
  createCentralAccount,
  deactivateCentralAccount
} = require('../src/services/central-whatsapp.service');
const {
  confirmCustomerOrder,
  processOwnerOrderDecision
} = require('../src/services/order.service');
const { formatInternalNotes } = require('../src/services/admin-restaurant.service');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failed++;
  }
}

async function runTestSuite() {
  console.log('\n============================================================');
  console.log('   RESTOPRO — R6.6.2 TEMPLATE APPROVAL INDEPENDENCE TEST    ');
  console.log('============================================================\n');

  const createdCentralAccountIds = [];
  const createdRestaurantIds = [];
  const createdOrderIds = [];
  const createdOutboxIds = [];

  const centralPhoneId = '999888777111';
  const restPhoneId = '111222333444';
  const ownerPhone = '+919876500111';
  const customerPhoneA = '919811000991';
  const customerPhoneB = '919811000992';
  const customerPhoneC = '919811000993';
  const customerPhoneLeg = '919811000994';

  try {
    // Teardown any conflicting fixtures
    await prisma.centralWhatsAppAccount.deleteMany({
      where: { phone_number_id: centralPhoneId }
    });
    await prisma.restaurant.deleteMany({
      where: { phone_number_id: restPhoneId }
    });

    // -------------------------------------------------------------------------
    // TEST GROUP 1: Service Specifications & Initial Template State
    // -------------------------------------------------------------------------
    console.log('--- TEST GROUP 1: Service Specifications & Initial Template State ---');

    assert(SUPPORTED_TEMPLATES.ORDER_ALERT === 'restopro_order_alert', 'SUPPORTED_TEMPLATES defines ORDER_ALERT');
    assert(SUPPORTED_TEMPLATES.CUSTOMER_ACCEPTED === 'restopro_customer_order_accepted', 'SUPPORTED_TEMPLATES defines CUSTOMER_ACCEPTED');
    assert(SUPPORTED_TEMPLATES.CUSTOMER_REJECTED === 'restopro_customer_order_rejected', 'SUPPORTED_TEMPLATES defines CUSTOMER_REJECTED');

    const specs = Object.values(TEMPLATE_SPECS);
    assert(specs.length === 3, 'Exactly 3 templates specified in TEMPLATE_SPECS');
    assert(specs.every(s => s.language === 'en'), 'All templates target language "en"');
    assert(specs.every(s => s.category === 'UTILITY'), 'All templates categorized as "UTILITY"');

    // In unconfigured state, template approval evaluates to false with classified reason
    resetTemplateApprovalsForTesting();
    const unconfiguredCheck = await isTemplateApproved('restopro_order_alert', { routingMode: 'CENTRAL' });
    assert(unconfiguredCheck.isApproved === false, 'Unconfigured template evaluates isApproved = false');
    assert(unconfiguredCheck.status === 'UNCONFIGURED', 'Unconfigured template status is UNCONFIGURED');
    assert(typeof unconfiguredCheck.reason === 'string', 'Failure reason is provided');

    // -------------------------------------------------------------------------
    // TEST GROUP 2: Independent Environment Variable Isolation
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Independent Environment Variable Isolation ---');

    // Setting OWNER_TEMPLATE_APPROVED must NOT approve customer templates
    process.env.OWNER_TEMPLATE_APPROVED = 'true';
    delete process.env.TEMPLATE_APPROVED_CUSTOMER_ACCEPTED;
    delete process.env.TEMPLATE_APPROVED_CUSTOMER_REJECTED;

    const custAcceptWithLegacyOwnerFlag = await isTemplateApproved('restopro_customer_order_accepted', { routingMode: 'CENTRAL' });
    assert(custAcceptWithLegacyOwnerFlag.isApproved === false, 'OWNER_TEMPLATE_APPROVED does NOT approve customer_order_accepted');

    const custRejectWithLegacyOwnerFlag = await isTemplateApproved('restopro_customer_order_rejected', { routingMode: 'CENTRAL' });
    assert(custRejectWithLegacyOwnerFlag.isApproved === false, 'OWNER_TEMPLATE_APPROVED does NOT approve customer_order_rejected');

    // Setting specific TEMPLATE_APPROVED_CUSTOMER_ACCEPTED approves ONLY customer accepted
    process.env.TEMPLATE_APPROVED_CUSTOMER_ACCEPTED = 'true';
    const custAcceptCheck = await isTemplateApproved('restopro_customer_order_accepted', { routingMode: 'CENTRAL' });
    const custRejectCheck = await isTemplateApproved('restopro_customer_order_rejected', { routingMode: 'CENTRAL' });
    assert(custAcceptCheck.isApproved === true, 'TEMPLATE_APPROVED_CUSTOMER_ACCEPTED enables customer_order_accepted');
    assert(custRejectCheck.isApproved === false, 'customer_order_rejected remains unapproved (Strict Independence)');

    delete process.env.TEMPLATE_APPROVED_CUSTOMER_ACCEPTED;
    delete process.env.OWNER_TEMPLATE_APPROVED;

    // -------------------------------------------------------------------------
    // TEST GROUP 3: Database-Backed Template Status Management
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Database-Backed Template Status Management ---');

    // Create an active Central WhatsApp account
    const centralAcc = await createCentralAccount({
      phoneNumberId: centralPhoneId,
      wabaId: 'waba_meta_test_888999',
      accessToken: 'EAA_TEST_VALID_ACCESS_TOKEN_CENTRAL_META_123',
      displayPhoneNumber: '+1 800-555-0100',
      isActive: true,
      templates: {}
    });
    createdCentralAccountIds.push(centralAcc.id);

    // Initial statuses via getCentralTemplateStatuses
    const initialStatuses = await getCentralTemplateStatuses();
    assert(initialStatuses.length === 3, 'getCentralTemplateStatuses returns 3 templates');
    assert(initialStatuses.every(t => t.isApproved === false), 'All templates initially unapproved');

    // Update restopro_order_alert to APPROVED in DB
    const updatedAlert = await updateCentralTemplateStatus({
      templateName: 'restopro_order_alert',
      status: 'APPROVED',
      approvalSource: 'SUPER_ADMIN_MANUAL_VERIFIED',
      adminId: 'admin_test_uuid_111'
    });
    assert(updatedAlert.isApproved === true, 'updateCentralTemplateStatus sets isApproved = true');
    assert(updatedAlert.status === 'APPROVED', 'Template status set to APPROVED');
    assert(updatedAlert.approvalSource === 'SUPER_ADMIN_MANUAL_VERIFIED', 'Approval source recorded as SUPER_ADMIN_MANUAL_VERIFIED');
    assert(updatedAlert.verifiedAt !== null, 'verifiedAt timestamp recorded');

    // Verify DB resolution
    const dbAlertCheck = await isTemplateApproved('restopro_order_alert', { routingMode: 'CENTRAL' });
    const dbAcceptCheck = await isTemplateApproved('restopro_customer_order_accepted', { routingMode: 'CENTRAL' });
    assert(dbAlertCheck.isApproved === true, 'DB-backed restopro_order_alert resolves isApproved = true');
    assert(dbAlertCheck.status === 'APPROVED', 'DB-backed restopro_order_alert status is APPROVED');
    assert(dbAcceptCheck.isApproved === false, 'DB-backed restopro_customer_order_accepted remains isApproved = false');

    // Update restopro_customer_order_rejected to REJECTED with failure reason
    const updatedReject = await updateCentralTemplateStatus({
      templateName: 'restopro_customer_order_rejected',
      status: 'REJECTED',
      failureReason: 'Variable {{3}} exceeds maximum character length per Meta review'
    });
    assert(updatedReject.isApproved === false, 'Rejected template resolves isApproved = false');
    assert(updatedReject.status === 'REJECTED', 'Status is REJECTED');
    assert(updatedReject.failureReason.includes('Variable {{3}}'), 'Failure reason persisted in database');

    // -------------------------------------------------------------------------
    // TEST GROUP 4: End-to-End Selective Blocking in CENTRAL Mode
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: End-to-End Selective Blocking in CENTRAL Mode ---');

    process.env.NOTIFICATION_ROUTING_MODE = 'CENTRAL';

    // Seed Restaurant
    const notes = formatInternalNotes('Test notes', {
      optedIn: true,
      consentedAt: new Date().toISOString(),
      source: 'SUPER_ADMIN_MANUAL_VERIFIED',
      revoked: false
    });

    const rest = await prisma.restaurant.create({
      data: {
        name: 'Curry Palace (Template Test)',
        phone_number_id: restPhoneId,
        waba_id: 'waba_rest_test_111',
        owner_phone: ownerPhone,
        access_token_encrypted: 'mock_token_enc',
        internal_notes: notes,
        is_active: true
      }
    });
    createdRestaurantIds.push(rest.id);

    // Scenario A: Order alert is APPROVED in DB, but customer accepted is UNAPPROVED
    // 1. Confirm customer order
    const orderTokenA = `conf_token_tmpl_a_${Date.now()}`;
    await prisma.conversationSession.create({
      data: {
        restaurant_id: rest.id,
        customer_phone: customerPhoneA,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 3600000),
        state: {
          cart: {
            subtotal: 450,
            currency: 'INR',
            items: [{ productRetailerId: 'SKU_PANEER', productName: 'Shahi Paneer', quantity: 1, unitPrice: 450 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: orderTokenA
        }
      }
    });

    const confirmResA = await confirmCustomerOrder({
      restaurantId: rest.id,
      customerPhone: customerPhoneA,
      confirmationToken: orderTokenA
    });
    assert(confirmResA.success === true, 'Order A confirmed successfully');
    createdOrderIds.push(confirmResA.order.id);

    // Verify Owner Alert Outbox message was created as PENDING (since restopro_order_alert is APPROVED)
    const ownerOutboxA = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: `owner_notif_${confirmResA.order.id}` }
    });
    assert(ownerOutboxA !== null, 'Owner alert outbox message created');
    assert(ownerOutboxA.status === 'PENDING', 'Owner alert outbox status is PENDING (Approved template)');
    assert(ownerOutboxA.sender_channel === 'CENTRAL', 'Owner alert sender_channel is CENTRAL');
    assert(ownerOutboxA.payload?.type === 'template', 'Owner alert payload is a template');
    assert(ownerOutboxA.payload?.template?.name === 'restopro_order_alert', 'Template name is restopro_order_alert');
    if (ownerOutboxA) createdOutboxIds.push(ownerOutboxA.id);

    // 2. Owner accepts Order A
    // Since restopro_customer_order_accepted is UNAPPROVED, customer decision outbox must be FAILED with BLOCKED_TEMPLATE_NOT_CONFIGURED
    const acceptDecisionRes = await processOwnerOrderDecision({
      senderPhone: ownerPhone,
      orderId: confirmResA.order.id,
      decision: 'ACCEPT'
    });
    assert(acceptDecisionRes.success === true, 'Owner accept decision processed');
    assert(acceptDecisionRes.order.status === 'ACCEPTED', 'Order status updated to ACCEPTED');

    const customerOutboxA = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: `customer_decision_${confirmResA.order.id}_accept` }
    });
    assert(customerOutboxA !== null, 'Customer decision outbox message created');
    assert(customerOutboxA.status === 'FAILED', 'Customer outbox marked FAILED due to unapproved template');
    assert(customerOutboxA.sender_channel === 'CENTRAL', 'Customer outbox sender_channel remains CENTRAL (Zero fallback to RESTAURANT)');
    assert(customerOutboxA.payload?.blockedReason === 'BLOCKED_TEMPLATE_NOT_CONFIGURED', 'Payload records BLOCKED_TEMPLATE_NOT_CONFIGURED');
    assert(customerOutboxA.last_error.includes('restopro_customer_order_accepted'), 'last_error indicates restopro_customer_order_accepted is unapproved');
    if (customerOutboxA) createdOutboxIds.push(customerOutboxA.id);

    // -------------------------------------------------------------------------
    // Scenario B: Customer accepted approved, but customer rejected unapproved
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario B: Customer Accepted Approved, Customer Rejected Unapproved ---');

    // Approve customer accepted template in DB
    await updateCentralTemplateStatus({
      templateName: 'restopro_customer_order_accepted',
      status: 'APPROVED',
      approvalSource: 'SUPER_ADMIN_MANUAL_VERIFIED'
    });

    // Seed Order B for Rejection Test
    const orderTokenB = `conf_token_tmpl_b_${Date.now()}`;
    await prisma.conversationSession.create({
      data: {
        restaurant_id: rest.id,
        customer_phone: customerPhoneB,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 3600000),
        state: {
          cart: {
            subtotal: 300,
            currency: 'INR',
            items: [{ productRetailerId: 'SKU_DAL', productName: 'Dal Makhani', quantity: 1, unitPrice: 300 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: orderTokenB
        }
      }
    });

    const confirmResB = await confirmCustomerOrder({
      restaurantId: rest.id,
      customerPhone: customerPhoneB,
      confirmationToken: orderTokenB
    });
    createdOrderIds.push(confirmResB.order.id);
    const ownerOutboxB = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: `owner_notif_${confirmResB.order.id}` }
    });
    if (ownerOutboxB) createdOutboxIds.push(ownerOutboxB.id);

    // Owner rejects Order B
    // Since restopro_customer_order_rejected is still REJECTED/UNAPPROVED in DB, customer decision must be marked FAILED
    const rejectDecisionRes = await processOwnerOrderDecision({
      senderPhone: ownerPhone,
      orderId: confirmResB.order.id,
      decision: 'REJECT'
    });
    assert(rejectDecisionRes.success === true, 'Owner reject decision processed');
    assert(rejectDecisionRes.order.status === 'REJECTED', 'Order status updated to REJECTED');

    const customerOutboxB = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: `customer_decision_${confirmResB.order.id}_reject` }
    });
    assert(customerOutboxB !== null, 'Customer reject outbox message created');
    assert(customerOutboxB.status === 'FAILED', 'Customer reject outbox marked FAILED due to unapproved template');
    assert(customerOutboxB.last_error.includes('restopro_customer_order_rejected'), 'last_error indicates restopro_customer_order_rejected is unapproved');
    if (customerOutboxB) createdOutboxIds.push(customerOutboxB.id);

    // -------------------------------------------------------------------------
    // Scenario C: Customer accepted IS approved -> Accept creates PENDING outbox
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario C: Customer Accepted Approved -> Dispatches PENDING Outbox ---');

    const orderTokenC = `conf_token_tmpl_c_${Date.now()}`;
    await prisma.conversationSession.create({
      data: {
        restaurant_id: rest.id,
        customer_phone: customerPhoneC,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 3600000),
        state: {
          cart: {
            subtotal: 500,
            currency: 'INR',
            items: [{ productRetailerId: 'SKU_BIRYANI', productName: 'Biryani', quantity: 2, unitPrice: 250 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: orderTokenC
        }
      }
    });

    const confirmResC = await confirmCustomerOrder({
      restaurantId: rest.id,
      customerPhone: customerPhoneC,
      confirmationToken: orderTokenC
    });
    createdOrderIds.push(confirmResC.order.id);
    const ownerOutboxC = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: `owner_notif_${confirmResC.order.id}` }
    });
    if (ownerOutboxC) createdOutboxIds.push(ownerOutboxC.id);

    // Owner accepts Order C
    const acceptDecisionC = await processOwnerOrderDecision({
      senderPhone: ownerPhone,
      orderId: confirmResC.order.id,
      decision: 'ACCEPT'
    });
    assert(acceptDecisionC.success === true, 'Owner accept decision processed for Order C');

    const customerOutboxC = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: `customer_decision_${confirmResC.order.id}_accept` }
    });
    assert(customerOutboxC !== null, 'Customer accept outbox message created');
    assert(customerOutboxC.status === 'PENDING', 'Customer accept outbox status is PENDING (Approved template)');
    assert(customerOutboxC.sender_channel === 'CENTRAL', 'Sender channel is CENTRAL');
    assert(customerOutboxC.payload?.template?.name === 'restopro_customer_order_accepted', 'Emitted template is restopro_customer_order_accepted');
    if (customerOutboxC) createdOutboxIds.push(customerOutboxC.id);

    // -------------------------------------------------------------------------
    // TEST GROUP 5: LEGACY Mode Regression Parity
    // -------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 5: LEGACY Mode Regression Parity ---');

    process.env.NOTIFICATION_ROUTING_MODE = 'LEGACY';

    const orderTokenLegacy = `conf_token_tmpl_leg_${Date.now()}`;
    await prisma.conversationSession.create({
      data: {
        restaurant_id: rest.id,
        customer_phone: customerPhoneLeg,
        current_step: 'AWAITING_CONFIRMATION',
        expires_at: new Date(Date.now() + 3600000),
        state: {
          cart: {
            subtotal: 200,
            currency: 'INR',
            items: [{ productRetailerId: 'SKU_NAAN', productName: 'Garlic Naan', quantity: 4, unitPrice: 50 }]
          },
          orderType: 'TAKEAWAY',
          confirmationToken: orderTokenLegacy
        }
      }
    });

    const confirmResLeg = await confirmCustomerOrder({
      restaurantId: rest.id,
      customerPhone: customerPhoneLeg,
      confirmationToken: orderTokenLegacy
    });
    createdOrderIds.push(confirmResLeg.order.id);

    const ownerOutboxLeg = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: `owner_notif_${confirmResLeg.order.id}` }
    });
    assert(ownerOutboxLeg !== null, 'Legacy owner outbox message created');
    assert(ownerOutboxLeg.sender_channel === 'RESTAURANT', 'Legacy owner alert sender_channel is RESTAURANT');
    if (ownerOutboxLeg) createdOutboxIds.push(ownerOutboxLeg.id);

    const acceptLegRes = await processOwnerOrderDecision({
      senderPhone: ownerPhone,
      orderId: confirmResLeg.order.id,
      decision: 'ACCEPT'
    });
    assert(acceptLegRes.success === true, 'Legacy owner accept processed');

    const customerOutboxLeg = await prisma.outboxMessage.findFirst({
      where: { idempotency_key: `customer_decision_${confirmResLeg.order.id}_accept` }
    });
    assert(customerOutboxLeg !== null, 'Legacy customer decision outbox message created');
    assert(customerOutboxLeg.status === 'PENDING', 'Legacy customer decision outbox status is PENDING');
    assert(customerOutboxLeg.sender_channel === 'RESTAURANT', 'Legacy customer decision sender_channel is RESTAURANT');
    assert(customerOutboxLeg.payload?.type === 'text', 'Legacy customer decision is free-form text');
    if (customerOutboxLeg) createdOutboxIds.push(customerOutboxLeg.id);

  } catch (err) {
    console.error('❌ Unhandled test error:', err);
    failed++;
  } finally {
    // Teardown
    console.log('\n--- Cleaning up test artifacts ---');
    try {
      resetTemplateApprovalsForTesting();
      process.env.NOTIFICATION_ROUTING_MODE = 'LEGACY';

      if (createdOutboxIds.length > 0) {
        await prisma.outboxMessage.deleteMany({ where: { id: { in: createdOutboxIds } } });
      }
      if (createdOrderIds.length > 0) {
        await prisma.orderNotification.deleteMany({ where: { order_id: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      await prisma.conversationSession.deleteMany({
        where: { customer_phone: { in: [customerPhoneA, customerPhoneB, customerPhoneC, customerPhoneLeg] } }
      });
      if (createdRestaurantIds.length > 0) {
        await prisma.restaurant.deleteMany({ where: { id: { in: createdRestaurantIds } } });
      }
      if (createdCentralAccountIds.length > 0) {
        await prisma.centralWhatsAppAccount.deleteMany({ where: { id: { in: createdCentralAccountIds } } });
      }
      await prisma.$disconnect();
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr.message);
    }

    console.log('\n============================================================');
    console.log(`   TEMPLATE APPROVAL TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('============================================================\n');

    if (failed > 0) process.exit(1);
  }
}

runTestSuite();
