/**
 * RESTOPRO — Central WhatsApp Restaurant Order Notification Template Test
 *
 * Validates:
 * 1. Exact 6-parameter Meta Utility Template mapping for Central owner order notifications.
 *    - {{1}}: Customer name
 *    - {{2}}: Customer phone
 *    - {{3}}: Order type ("Delivery" or "Takeaway (Self-Pickup)")
 *    - {{4}}: Delivery address
 *    - {{5}}: Formatted order items (dynamic, multi-item support)
 *    - {{6}}: Total payable amount with payment method (e.g. ₹2400.00 (Pay COD))
 * 2. HMAC-signed Accept and Reject interactive quick-reply buttons (preserved index 0 & 1).
 * 3. Dynamic multi-item formatting (item quantities, product names).
 * 4. Payment method tagging (COD, Counter, custom payment methods).
 * 5. Safe fallbacks for missing/null fields (customer name, phone, address, empty items).
 * 6. Dynamic template name resolution from environment with default restopro_order_alert.
 * 7. Template configuration service specifications and definitions.
 */
require('./load-test-env');
const assert = require('assert');
const { buildOwnerNotificationPayload } = require('../src/services/whatsapp.service');
const {
  SUPPORTED_TEMPLATES,
  TEMPLATE_SPECS,
  TEMPLATE_META_DEFINITIONS,
  isTemplateApproved,
  setTemplateApprovalForTesting,
  resetTemplateApprovalsForTesting
} = require('../src/services/template-config.service');
const { verifySignedOwnerCallback } = require('../src/utils/callback-signer');

let totalPassed = 0;
function pass(msg) {
  totalPassed++;
  console.log(`  ✅ [PASS] ${msg}`);
}

async function runTests() {
  console.log('\n============================================================');
  console.log('   CENTRAL WHATSAPP ORDER NOTIFICATION TEMPLATE TEST SUITE    ');
  console.log('============================================================\n');

  // -------------------------------------------------------------
  // TEST GROUP 1: Template Specification & Meta Definitions
  // -------------------------------------------------------------
  console.log('--- TEST GROUP 1: Template Specification & Meta Definitions ---');

  const alertTemplateName = SUPPORTED_TEMPLATES.ORDER_ALERT;
  assert(alertTemplateName, 'SUPPORTED_TEMPLATES defines ORDER_ALERT');
  pass(`ORDER_ALERT template resolved as: "${alertTemplateName}"`);

  const spec = TEMPLATE_SPECS[alertTemplateName];
  assert(spec, 'TEMPLATE_SPECS defines ORDER_ALERT');
  assert.strictEqual(spec.targetRole, 'OWNER', 'Target role is OWNER');
  assert.strictEqual(spec.category, 'UTILITY', 'Category is UTILITY');
  assert.strictEqual(spec.language, 'en', 'Language code is "en"');
  assert.strictEqual(spec.variables.length, 6, 'Spec lists exactly 6 variables');
  assert.deepStrictEqual(spec.buttons, ['Accept', 'Reject'], 'Buttons list Accept and Reject');
  pass('TEMPLATE_SPECS defines 6 variables, UTILITY category, and 2 buttons');

  const metaDef = TEMPLATE_META_DEFINITIONS[alertTemplateName];
  assert(metaDef, 'TEMPLATE_META_DEFINITIONS defines ORDER_ALERT');
  const bodyComponent = metaDef.components.find(c => c.type === 'BODY');
  assert(bodyComponent, 'Body component present in Meta definitions');
  assert(bodyComponent.text.includes('{{1}}'), 'Body text includes {{1}} Customer');
  assert(bodyComponent.text.includes('{{2}}'), 'Body text includes {{2}} Phone');
  assert(bodyComponent.text.includes('{{3}}'), 'Body text includes {{3}} Order Type');
  assert(bodyComponent.text.includes('{{4}}'), 'Body text includes {{4}} Address');
  assert(bodyComponent.text.includes('{{5}}'), 'Body text includes {{5}} Items');
  assert(bodyComponent.text.includes('{{6}}'), 'Body text includes {{6}} Total');
  assert(bodyComponent.text.includes('🍽️ *New Order Received!*'), 'Body text has approved header');
  assert(bodyComponent.example.body_text[0].length === 6, 'Example body text contains exactly 6 values');

  const buttonsComponent = metaDef.components.find(c => c.type === 'BUTTONS');
  assert(buttonsComponent, 'Buttons component present in Meta definitions');
  assert.strictEqual(buttonsComponent.buttons.length, 2, 'Defines exactly 2 quick reply buttons');
  assert.strictEqual(buttonsComponent.buttons[0].text, 'Accept', 'First button is Accept');
  assert.strictEqual(buttonsComponent.buttons[1].text, 'Reject', 'Second button is Reject');
  pass('TEMPLATE_META_DEFINITIONS matches Meta approved body and button specifications');

  // -------------------------------------------------------------
  // TEST GROUP 2: Delivery Order with Multiple Items & COD
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: Delivery Order with Multiple Items (COD) ---');

  const deliveryOrder = {
    id: 'e1000000-0000-0000-0000-000000000001',
    order_reference: 'RP-261109-TEST1',
    customer_name: 'Madi Khan',
    customer_phone: '+919152115523',
    order_type: 'DELIVERY',
    address_snapshot: '504, United Avenue, Howldak Building, Maulana Azad Rd, Mumbai 400008',
    items: [
      { productName: 'Chicken Dum Biryani (Special)', quantity: 2, unitPrice: 800.00 },
      { productName: 'Butter Naan', quantity: 4, unitPrice: 60.00 },
      { productName: 'Gulab Jamun (2 pcs)', quantity: 1, unitPrice: 120.00 }
    ],
    total_amount: 1960.00,
    currency: 'INR'
  };

  const deliveryPayload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: deliveryOrder,
    restaurantName: 'RestPro Mumbai',
    useTemplate: true
  });

  assert.strictEqual(deliveryPayload.messaging_product, 'whatsapp', 'Messaging product is whatsapp');
  assert.strictEqual(deliveryPayload.type, 'template', 'Payload type is template');
  assert.strictEqual(deliveryPayload.to, '918369377477', 'Recipient is normalized digits');
  assert.strictEqual(deliveryPayload.template.name, alertTemplateName, 'Uses active template name');
  assert.strictEqual(deliveryPayload.template.language.code, 'en', 'Language code is "en"');

  const delBody = deliveryPayload.template.components.find(c => c.type === 'body');
  assert(delBody, 'Body component exists in payload');
  assert.strictEqual(delBody.parameters.length, 6, 'Payload body contains exactly 6 parameters');

  // Verify parameter mappings
  assert.strictEqual(delBody.parameters[0].text, 'Madi Khan', '{{1}} Customer Name');
  assert.strictEqual(delBody.parameters[1].text, '+919152115523', '{{2}} Customer Phone');
  assert.strictEqual(delBody.parameters[2].text, 'Delivery', '{{3}} Order Type');
  assert.strictEqual(delBody.parameters[3].text, deliveryOrder.address_snapshot, '{{4}} Delivery Address');

  // Formatted items check
  const expectedItems = '2x Chicken Dum Biryani (Special)\n4x Butter Naan\n1x Gulab Jamun (2 pcs)';
  assert.strictEqual(delBody.parameters[4].text, expectedItems, '{{5}} Formatted order items with multi-item newlines');

  // Total amount check
  assert.strictEqual(delBody.parameters[5].text, '₹1960.00 (Pay COD)', '{{6}} Total with (Pay COD)');
  pass('Delivery order correctly maps 6 parameters with multi-item summary and (Pay COD)');

  // Quick reply buttons check
  const buttons = deliveryPayload.template.components.filter(c => c.type === 'button');
  assert.strictEqual(buttons.length, 2, 'Exactly 2 button components');
  assert.strictEqual(buttons[0].sub_type, 'quick_reply', 'Button 0 is quick_reply');
  assert.strictEqual(buttons[0].index, '0', 'Button 0 index is "0"');
  assert.strictEqual(buttons[1].sub_type, 'quick_reply', 'Button 1 is quick_reply');
  assert.strictEqual(buttons[1].index, '1', 'Button 1 index is "1"');

  const acceptPayload = buttons[0].parameters[0].payload;
  const rejectPayload = buttons[1].parameters[0].payload;
  assert(acceptPayload.startsWith('OWNER_ACCEPT:'), 'Button 0 payload starts with OWNER_ACCEPT:');
  assert(rejectPayload.startsWith('OWNER_REJECT:'), 'Button 1 payload starts with OWNER_REJECT:');
  assert(acceptPayload.length <= 128, `Accept payload within 128 chars (${acceptPayload.length})`);
  assert(rejectPayload.length <= 128, `Reject payload within 128 chars (${rejectPayload.length})`);

  // Verify cryptographic signatures on buttons
  const verifiedAccept = verifySignedOwnerCallback(acceptPayload);
  assert.strictEqual(verifiedAccept.valid, true, 'Accept button callback has valid HMAC signature');
  assert.strictEqual(verifiedAccept.orderId, deliveryOrder.id, 'Accept button maps to order ID');
  assert.strictEqual(verifiedAccept.action, 'ACCEPT', 'Accept button action is ACCEPT');

  const verifiedReject = verifySignedOwnerCallback(rejectPayload);
  assert.strictEqual(verifiedReject.valid, true, 'Reject button callback has valid HMAC signature');
  assert.strictEqual(verifiedReject.orderId, deliveryOrder.id, 'Reject button maps to order ID');
  assert.strictEqual(verifiedReject.action, 'REJECT', 'Reject button action is REJECT');
  pass('Buttons have valid HMAC-signed callbacks and conform to Meta 128-char limit');

  // -------------------------------------------------------------
  // TEST GROUP 3: Takeaway (Self-Pickup) Order with (Pay at Counter)
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: Takeaway Order (Pay at Counter) ---');

  const takeawayOrder = {
    id: 'e2000000-0000-0000-0000-000000000002',
    order_reference: 'RP-261109-TEST2',
    customer_name: 'Sara Ali',
    customer_phone: '919876543210',
    order_type: 'TAKEAWAY',
    address_snapshot: null,
    items: [
      { productName: 'Paneer Tikka Roll', quantity: 1, unitPrice: 150.00 }
    ],
    total_amount: 150.00,
    currency: 'INR'
  };

  const takeawayPayload = buildOwnerNotificationPayload({
    ownerPhone: '+91 83693 77477',
    order: takeawayOrder,
    restaurantName: 'RestPro Pune',
    useTemplate: true
  });

  const takeBody = takeawayPayload.template.components.find(c => c.type === 'body');
  assert.strictEqual(takeBody.parameters.length, 6, 'Takeaway payload contains 6 parameters');
  assert.strictEqual(takeBody.parameters[0].text, 'Sara Ali', '{{1}} Customer Name');
  assert.strictEqual(takeBody.parameters[1].text, '919876543210', '{{2}} Customer Phone');
  assert.strictEqual(takeBody.parameters[2].text, 'Takeaway (Self-Pickup)', '{{3}} Order Type is Takeaway (Self-Pickup)');
  assert.strictEqual(takeBody.parameters[3].text, 'Takeaway (Self-Pickup)', '{{4}} Address falls back to Takeaway (Self-Pickup)');
  assert.strictEqual(takeBody.parameters[4].text, '1x Paneer Tikka Roll', '{{5}} Formatted item');
  assert.strictEqual(takeBody.parameters[5].text, '₹150.00 (Pay at Counter)', '{{6}} Total with (Pay at Counter)');
  pass('Takeaway order maps {{3}} and {{4}} to Takeaway and {{6}} to (Pay at Counter)');

  // -------------------------------------------------------------
  // TEST GROUP 4: Custom Payment Methods (UPI, Online)
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: Custom Payment Method Tagging ---');

  const upiOrder = {
    id: 'e3000000-0000-0000-0000-000000000003',
    order_reference: 'RP-261109-TEST3',
    customer_name: 'Rahul Sharma',
    customer_phone: '919822233344',
    order_type: 'DELIVERY',
    address_snapshot: 'Flat 101, Sunshine Park, Bengaluru',
    items: [{ productName: 'Cold Coffee', quantity: 2 }],
    total_amount: 240.00,
    currency: 'INR',
    payment_method: 'upi'
  };

  const upiPayload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: upiOrder,
    useTemplate: true
  });

  const upiBody = upiPayload.template.components.find(c => c.type === 'body');
  assert.strictEqual(upiBody.parameters[5].text, '₹240.00 (Pay UPI)', 'Total with custom payment method (Pay UPI)');
  pass('Explicit payment_method ("upi") formats cleanly as (Pay UPI)');

  // -------------------------------------------------------------
  // TEST GROUP 5: Safe Fallbacks on Edge Cases & Missing Fields
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: Edge Cases & Missing Fields Resilience ---');

  const minimalOrder = {
    id: 'e4000000-0000-0000-0000-000000000004',
    order_reference: 'RP-261109-MIN',
    customer_name: null,
    customer_phone: null,
    order_type: 'DELIVERY',
    address_snapshot: null,
    items: [],
    total_amount: null,
    currency: null
  };

  const minPayload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: minimalOrder,
    useTemplate: true
  });

  const minBody = minPayload.template.components.find(c => c.type === 'body');
  assert.strictEqual(minBody.parameters.length, 6, 'Resilient against null fields');
  assert.strictEqual(minBody.parameters[0].text, 'Customer', 'Default customer name');
  assert.strictEqual(minBody.parameters[1].text, 'N/A', 'Default customer phone');
  assert.strictEqual(minBody.parameters[2].text, 'Delivery', 'Default order type');
  assert.strictEqual(minBody.parameters[3].text, 'Address not provided', 'Default address text');
  assert.strictEqual(minBody.parameters[4].text, '1x Order Items', 'Default items text');
  assert.strictEqual(minBody.parameters[5].text, '₹0.00 (Pay COD)', 'Default total text');

  // Verify no empty string parameters (Meta rejects empty text params)
  for (let i = 0; i < minBody.parameters.length; i++) {
    assert(minBody.parameters[i].text.length > 0, `Parameter {{${i + 1}}} must be non-empty`);
    assert(minBody.parameters[i].text.length <= 1024, `Parameter {{${i + 1}}} within 1024 chars`);
  }
  pass('All parameters guarantee non-empty strings <= 1024 chars even with missing order fields');

  // -------------------------------------------------------------
  // TEST GROUP 6: Interactive Fallback Body Matches Layout
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 6: Interactive Fallback Body Verification ---');

  const interactivePayload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: deliveryOrder,
    restaurantName: 'RestPro Mumbai',
    useTemplate: false
  });

  assert.strictEqual(interactivePayload.type, 'interactive', 'Message type is interactive');
  const interactiveBody = interactivePayload.interactive.body.text;
  assert(interactiveBody.includes('🍽️ *New Order Received!*'), 'Interactive body has same header');
  assert(interactiveBody.includes('👤 *Customer:* Madi Khan'), 'Interactive body has customer');
  assert(interactiveBody.includes('📞 *Phone:* +919152115523'), 'Interactive body has phone');
  assert(interactiveBody.includes('📦 *Order Type:* Delivery'), 'Interactive body has order type');
  assert(interactiveBody.includes('📍 *Address:* 504, United Avenue'), 'Interactive body has address');
  assert(interactiveBody.includes('🛒 *Items:*\n2x Chicken Dum Biryani (Special)'), 'Interactive body has formatted items');
  assert(interactiveBody.includes('💰 *Total:* ₹1960.00 (Pay COD)'), 'Interactive body has total with payment method');
  assert(interactiveBody.includes('Order Ref: #RP-261109-TEST1'), 'Interactive body retains order reference');
  pass('Interactive fallback body mirrors approved template layout and preserves order reference');

  // -------------------------------------------------------------
  // TEST GROUP 7: Dynamic Environment Template Name Configuration
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 7: Dynamic Environment Template Name Configuration ---');

  const customTemplatePayload = buildOwnerNotificationPayload({
    ownerPhone: '918369377477',
    order: deliveryOrder,
    useTemplate: true,
    templateName: 'custom_order_alert_v2'
  });
  assert.strictEqual(customTemplatePayload.template.name, 'custom_order_alert_v2', 'Respects explicit custom template name');
  assert.strictEqual(customTemplatePayload.template.components.find(c => c.type === 'body').parameters.length, 6, 'Custom template still maps 6 parameters');
  pass('Supports dynamic template name override while maintaining 6-parameter schema');

  console.log('\n============================================================');
  console.log(`   ALL ${totalPassed} TEMPLATE TESTS PASSED (0 FAILURES)     `);
  console.log('============================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});

