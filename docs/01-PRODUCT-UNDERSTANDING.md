# RESTOPRO — Product Understanding & Business Requirements Specification

**Document Version:** 1.0.0  
**Status:** Approved for Planning / Pre-Implementation  
**Target Environment:** Node.js, Express, PostgreSQL, Prisma, Meta WhatsApp Cloud API  

---

## 1. Product Overview

**RESTOPRO** is a multi-tenant WhatsApp ordering automation backend designed specifically for independent restaurants. Its core mission is to transform a restaurant’s existing WhatsApp Business account into an automated ordering counter without requiring custom consumer mobile applications, complex restaurant management software, or third-party marketplace commissions.

### 1.1 What RESTOPRO Is
- **An Automated Ordering Engine:** Guides customers through an automated WhatsApp chat conversation from initial greeting, catalog browsing, cart reception, address/location capture, delivery/takeaway preference, to final order confirmation.
- **A Multi-Tenant SaaS Backend:** A single, centralized Node.js/Express service backed by a shared PostgreSQL database that serves multiple independent restaurants concurrently with strict data, session, and operational isolation.
- **An Owner Approval Dispatcher:** Automatically formats and delivers actionable order notifications directly to the restaurant owner's WhatsApp number, capturing their atomic decision (Accept or Reject) and routing the final outcome back to the customer.

### 1.2 What RESTOPRO Is NOT
- **NOT a Restaurant Management System (RMS):** RESTOPRO does not manage restaurant tables, POS hardware, kitchen display systems (KDS), table reservations, employee payroll, or ingredient procurement.
- **NOT a Menu or Catalog Management System:** RESTOPRO does not maintain or edit menu items, categories, pictures, modifiers, or prices. Restaurant owners maintain their products and collections directly inside their native WhatsApp Business catalogue or Meta Commerce Manager.
- **NOT an Inventory Control System:** RESTOPRO does not track real-time stock levels or automatically disable out-of-stock items.
- **NOT a Payment Gateway:** The MVP focuses on order capture, address capture, and owner confirmation. Online card/UPI payment processing is strictly out of scope for the initial MVP.
- **NOT an AI Agent / NLP Free-Form Chatbot:** RESTOPRO uses deterministic state-machine conversation flows, structured WhatsApp interactive messages, and native catalog events. It does not guess or interpret free-form conversational orders.

---

## 2. Product Scope & Operational Boundaries

| Operational Area | Restaurant Owner Responsibility | RESTOPRO Backend Responsibility |
| :--- | :--- | :--- |
| **WhatsApp Business Account** | Owns phone number, WhatsApp Business account/WABA, business profile, and opening hours. | Connects to WABA via Meta WhatsApp Cloud API webhooks and outbound messaging endpoints. |
| **Catalog & Products** | Creates, updates, photographs, and prices items in Meta Commerce Manager / WhatsApp Catalog. | Ingests native WhatsApp cart (`type: "order"`) payloads, validates prices and line items, formats summaries. |
| **Customer Interaction** | Hands-off during routine ordering; does not need to manually reply to greetings or cart submissions. | Manages deterministic session state machine, sends welcome prompts, captures addresses, requests confirmation. |
| **Order Decision** | Reviews incoming consolidated WhatsApp notification; taps **Accept Order** or **Reject Order**. | Dispatches actionable notifications, verifies owner authorization, executes atomic database status updates. |
| **Customer Notification** | None; automated. | Sends immediate post-decision update to the customer with restaurant instructions or rejection notice. |
| **Order Fulfillment** | Prepares food, packages order, and arranges delivery or takeaway counter pickup. | Stores persistent, immutable order records and historical snapshots for record-keeping. |

---

## 3. End-to-End Business Workflows

### Workflow A: Customer Starts a Conversation
1. **Initiation:** Customer opens the restaurant's WhatsApp profile and sends an initial greeting (e.g., "Hi", "Hello", "Menu", or any text).
2. **Webhook Receipt & Tenant Resolution:**
   - Meta triggers an incoming message webhook `POST` to RESTOPRO.
   - RESTOPRO validates the webhook HMAC-SHA256 signature against Meta App Secret.
   - RESTOPRO inspects `entry[0].changes[0].value.metadata.phone_number_id`.
   - The backend queries the `restaurants` database table to resolve the tenant (`restaurant_id`). **Tenant resolution must never rely on customer phone numbers or customer-supplied data.**
   - If the restaurant is inactive or not found, the event is safely dropped with a 200 OK acknowledgment to Meta.
3. **Session Initialization:**
   - Retrieves or initializes the customer's conversation session for `(restaurant_id, customer_phone)`.
   - Sets session status to `AWAITING_CART`.
4. **Outbound Response:**
   - Sends a personalized welcome message greeting the customer with the restaurant's trade name.
   - Sends an interactive `catalog_message` (or text prompt with direct instructions) prompting the customer to browse the native WhatsApp Catalog.

### Workflow B: Customer Browses & Submits Native Catalog Cart
1. **Browsing:** Customer opens the native WhatsApp catalog inside the chat, views collections, selects products, specifies quantities, and taps "Send Cart to Business".
2. **Payload Receipt:**
   - Meta delivers a webhook message with `type: "order"`.
   - The payload contains `order.catalog_id`, `order.text` (optional customer notes), and `order.product_items` containing an array of `{ product_retailer_id, quantity, item_price, currency }`.
3. **Cart Validation & Defense:**
   - **Empty / Malformed Check:** Reject carts with 0 items, negative quantities, or invalid formats with a polite customer message.
   - **Price Verification:** Extract unit price and currency. The backend verifies line-item prices where catalog data is accessible or records snapshots cleanly, computing `total = SUM(quantity * item_price)`. The customer-calculated total is never blindly accepted without line-item verification.
   - **Session Update:** Updates the conversation session state to `CART_RECEIVED` with cart items and calculated subtotal preserved in the session JSONB payload.

### Workflow C: Address Collection & Consent
After cart reception, the bot advances the session to address collection:
1. **Saved Address Lookup:**
   - Query `saved_addresses` matching `restaurant_id` AND `customer_phone`.
2. **Case 1 — Saved Address Exists:**
   - The bot presents the existing address:  
     `"We found your saved address: [Flat 302, Andheri West]. Would you like to use this address?"` with interactive quick replies: `[Use Saved Address]` / `[Enter New Address]`.
   - If customer selects `Use Saved Address`, the address is copied into session state.
3. **Case 2 — New Address Input:**
   - If no saved address exists (or customer opts to enter a new one), the bot prompts:  
     `"Please send your delivery address (type your full address or share your location pin via WhatsApp)."`
   - **Text Input:** Customer types their street address. Captured as text.
   - **Location Sharing:** Customer taps WhatsApp paperclip → Location → Send Current Location. Meta sends `type: "location"` containing `latitude`, `longitude`, and optional `name`/`address`.
4. **Explicit Save-Address Consent:**
   - When a new address or location is received, the bot explicitly prompts:  
     `"Would you like us to save this address for your future orders at [Restaurant Name]?"` with quick replies `[Yes, Save]` / `[No, Just for Now]`.
   - **If Yes:** Persist in `saved_addresses` for `(restaurant_id, customer_phone)`.
   - **If No:** Retain only in current session state; do not create a `saved_addresses` record.
   - **Rule:** Updating or adding a saved address must NEVER alter historic orders.

### Workflow D: Order Type Selection (Delivery vs. Takeaway)
1. **Prompt:** The bot asks: `"How would you like to receive your order?"` with options `[Delivery]` / `[Takeaway]`.
2. **Delivery Path:**
   - Validates that an address has been captured and confirmed.
   - Sets order type to `DELIVERY`.
3. **Takeaway Path:**
   - Sets order type to `TAKEAWAY`.
   - Does not mandate a delivery address (address prompt can be bypassed if takeaway is selected upfront, or address discarded from final delivery calculation).

### Workflow E: Order Review & Customer Confirmation
1. **Review Summary:** The bot compiles and sends an unambiguous review message:
   ```text
   🛒 *ORDER SUMMARY — [Restaurant Name]*
   ─────────────────────────────
   • Chicken Biryani × 2  (₹480)
   • Cold Coffee × 1      (₹80)
   ─────────────────────────────
   *Subtotal:* ₹560
   *Order Type:* Delivery
   *Address:* Flat 302, Andheri West, Mumbai
   ─────────────────────────────
   Please confirm your order to send it to the kitchen:
   ```
   Interactive Buttons: `[✅ Confirm Order]` / `[❌ Cancel Order]`.
2. **Customer Confirms:**
   - Atomic database transaction creates exactly **one** record in `orders` table.
   - Status set to `PENDING_RESTAURANT_CONFIRMATION`.
   - Conversation session updated to `AWAITING_OWNER_DECISION`.
   - Bot replies to customer:  
     `"Thank you! Your order #RP1024 has been sent to [Restaurant Name]. Please wait while the restaurant confirms your order."`
   - **Critical Rule:** Customer confirmation does NOT equal acceptance.
3. **Customer Cancels:**
   - No order is created.
   - Session reset to idle/cancelled.
   - Bot replies: `"Your order has been cancelled. You can start over anytime by saying Hi."`

### Workflow F: Consolidated Owner Notification
1. **Durable Dispatch:**
   - Using PostgreSQL transaction guarantees, the order is persisted *before* attempting outbound WhatsApp delivery.
   - RESTOPRO queues an owner notification.
2. **Template Requirement (24-Hour Window Bypassing):**
   - Because restaurant owners may not have interacted with the bot within the preceding 24 hours, free-form messages to `owner_phone` will fail with Meta Error 131047.
   - The notification MUST be sent as an approved **Meta Utility Template** containing Quick Reply buttons (`[Accept Order]`, `[Reject Order]`).
3. **Notification Content:**
   ```text
   🔔 *NEW ORDER #RP1024*
   *Restaurant:* Royal Biryani House
   *Customer:* Omar Khan (+91 98765 43210)
   *Order Type:* Delivery
   *Address:* Flat 302, Andheri West, Mumbai (Lat: 19.136, Long: 72.827)
   
   *Items:*
   • Chicken Biryani × 2 (₹480)
   • Cold Coffee × 1 (₹80)
   
   *Total Amount:* ₹560
   ```
   Action buttons: `[Accept Order]` (payload: `ORDER_ACCEPT_RP1024`) | `[Reject Order]` (payload: `ORDER_REJECT_RP1024`).

### Workflow G: Owner Decision & Atomic State Transition
1. **Webhook Ingestion:** Owner taps `[Accept Order]` or `[Reject Order]`. Meta delivers a webhook (`type: "button"` or `type: "interactive"`).
2. **Security & Authorization Verification:**
   - **Sender Authorization:** Webhook `from` phone number MUST match the restaurant's configured `owner_phone`.
   - **Tenant Verification:** Webhook `phone_number_id` MUST match the restaurant's `phone_number_id`.
   - **Cross-Tenant Guard:** The target order (`order_id`) MUST have `restaurant_id == restaurant.id`.
3. **State Machine Integrity (Terminal Decisions):**
   - Order status MUST be `PENDING_RESTAURANT_CONFIRMATION`.
   - If order is already `ACCEPTED` or `REJECTED`, ignore duplicate taps and notify owner: `"Order #RP1024 has already been processed as [STATUS]."`
4. **Atomic Execution:**
   - Within a database transaction, update order status to `ACCEPTED` or `REJECTED`, set `decision_at = NOW()`.
5. **Customer & Owner Feedback:**
   - **If Accepted:** Send message to customer:  
     `"🎉 Great news! [Restaurant Name] has accepted your order #RP1024. Your food is being prepared."`
   - **If Rejected:** Send message to customer:  
     `"😔 We're sorry. [Restaurant Name] is unable to accept your order #RP1024 at this time. Please contact the restaurant directly for details."`
   - Send confirmation reply to owner confirming action was logged.

---

## 4. Multi-Tenant Architectural Requirements

RESTOPRO serves $N$ restaurants via a single backend instance and a single PostgreSQL database.

1. **Shared Database, Shared Schema:** No separate database or schema per tenant.
2. **Mandatory Tenant Scoping:** Every business entity (`orders`, `conversation_sessions`, `saved_addresses`, `webhook_events`) MUST have a foreign key column `restaurant_id` referencing `restaurants.id`.
3. **Tenant Resolution from Trusted Source:** Tenant is resolved *strictly* from Meta's incoming metadata (`phone_number_id`). Customers and external callers have zero control over tenant routing.
4. **Zero Cross-Tenant Leakage:** A query from restaurant A's context must never be able to select, update, or delete restaurant B's records.

---

## 5. Explicit Business Rules & Invariants

1. **Immutable Order Snapshots:** An order must store complete snapshots of customer name, phone, item details (names, SKUs, quantities, unit prices), delivery address text, GPS coordinates, and subtotal. Future updates to saved addresses or catalog prices must never mutate past orders.
2. **Explicit Address Consent:** Saving an address is opt-in. A customer refusing consent has their address used *only* for the current order snapshot.
3. **Restaurant-Scoped Address Books:** A customer ordering from "Restaurant A" cannot see or reuse an address saved at "Restaurant B".
4. **Idempotent Webhooks:** Meta may retry webhook events up to multiple times. RESTOPRO must ensure duplicate deliveries do not duplicate orders, advance state incorrectly, or spam owners.
5. **Durable Order Integrity:** Network failures when messaging Meta must never roll back a persisted order.

---

## 6. Out-of-Scope Features for MVP

To ensure rock-solid production stability and clean architectural boundaries, the following are strictly excluded from the initial MVP:
- Customer-facing web apps, mobile apps, or admin portals.
- Dynamic catalog editors or menu sync tools.
- Online digital payment gateways (Stripe, Razorpay, etc.).
- Automated third-party delivery dispatch (Dunzo, Shadowfax, Uber Direct).
- Live inventory deduction and stock management.
- Business analytics, sales reports, and customer segmentation dashboards.
- Multi-language translation engines or AI LLM conversational agents.

---

## 7. Open Business Decisions & Architectural Recommendations

| # | Business Decision | Options | Recommended Approach & Engineering Justification |
| :--- | :--- | :--- | :--- |
| **1** | **Restaurant Onboarding Mode** | Manual database provisioning vs. Meta Embedded Signup. | **Manual Provisioning for MVP:** Manual insertion of `phone_number_id`, `waba_id`, and credentials in database via migration seed or admin CLI. Reduces initial complexity while Embedded Signup OAuth is planned for v2. |
| **2** | **Owner Non-Response Handling** | Indefinite pending vs. Auto-expire after timeout. | **Auto-expire after 30 minutes:** Orders unacknowledged after 30 minutes transition to `EXPIRED`, and the customer is notified. Leaving orders pending indefinitely leads to unhappy, waiting customers. |
| **3** | **Owner Reminders** | Single alert vs. Periodic reminder ping. | **Single Alert + 10-Min Reminder:** Send one initial alert. If still pending after 10 minutes, dispatch one reminder utility template. |
| **4** | **Takeaway Address Collection** | Mandatory vs. Optional / Skipped. | **Skip Address for Takeaway:** If the customer selects Takeaway at step 1 of checkout, address capture is bypassed entirely, reducing friction. |
| **5** | **Post-Submission Customer Cancellation** | Allow within 2 mins vs. Disallow completely. | **Disallow via Bot for MVP:** Once submitted, order is in `PENDING_RESTAURANT_CONFIRMATION`. Customer must call restaurant phone number directly to cancel, avoiding race conditions with kitchen prep. |
| **6** | **Payment Method Handling** | COD only vs. Payment preference capture. | **Default to "Cash on Delivery / Pay on Pickup":** Clearly state in the order summary that payment is due upon receipt. |
| **7** | **Missing Catalog Price Information** | Reject order vs. Prompt for price vs. Accept with warning. | **Reject with Customer Message:** If an item in the cart has missing/zero price or currency mismatch, politely inform the customer: *"Some items in your cart could not be priced. Please contact the restaurant."* Never create an unpriced order. |
| **8** | **Unsupported / Custom Products** | Silently accept vs. Safe failure. | **Safe Rejection:** If a customer sends an unmapped SKU or custom product not in the catalog, flag the order and notify the customer. |
| **9** | **WhatsApp Business App Coexistence** | Dedicated number vs. Coexistence setup. | **Dedicated WABA Number Recommended:** While Meta supports Coexistence (v2.24.17+), it imposes throughput caps (5 mps) and requires the phone app to remain active every 14 days. For commercial restaurants, a dedicated Cloud API phone number avoids app disconnections. |

