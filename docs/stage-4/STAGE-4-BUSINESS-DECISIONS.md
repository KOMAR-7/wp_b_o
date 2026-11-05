# RESTOPRO — Stage 4: Business Decisions & Policy Specifications

**Document Version:** 2.1.0  
**Status:** Pending User Review & Approval (Zero Silent Implementations)  
**Scope:** Policy Decisions Governing Customer Ordering Flows & Conversational Edge Cases  

---

## 1. Overview

Conversational ordering engines handle free-form human communication that inevitably encounters ambiguous edge cases (e.g. submitting a new cart halfway through checkout, typing free-form modification requests, or going silent).

This document details the **13 core business decisions**. For every decision, it provides:
1. **Recommended Default**
2. **Reason**
3. **Alternative**
4. **Consequence of Choosing the Alternative**
5. **Approval Requirement**

---

## 2. Master Decision Matrix

| # | Business Decision Issue | Recommended Default | Explicit Approval Required? |
| :- | :--- | :--- | :--- |
| **D-01** | Incoming cart during active session | **Replace Existing Cart** with latest submission & invalidate tokens | **YES (Pending Approval)** |
| **D-02** | Customer text attempting cart edit | **Catalog Re-direct** (No free-form NLP edits) | **YES (Pending Approval)** |
| **D-03** | Address correction on review screen | **Provide `[Change Address]` Button** | **YES (Pending Approval)** |
| **D-04** | Session inactivity timeout duration | **2 Hours TTL** | **YES (Pending Approval)** |
| **D-05** | Takeaway fulfillment address notice | **Display Pickup Notice** with Restaurant Name | **YES (Pending Approval)** |
| **D-06** | Unrecognized / unsupported messages | **Contextual Re-Prompt** (Cap at 2 reminders) | **YES (Pending Approval)** |
| **D-07** | Catalog item name missing from Meta webhook | **Display SKU Fallback** (`SKU: <id>`) | **YES (Pending Approval)** |
| **D-08** | Cancellation after confirmation | **Disallow in Customer Bot** (Owner handles in Stage 5) | **YES (Pending Approval)** |
| **D-09** | Cart unit price discrepancies | **Snapshot Cart Price as Submitted** (Strict Corrupt Rejection) | **YES (Pending Approval)** |
| **D-10** | Minimum order amount enforcement | **Disabled by Default** | **YES (Pending Approval)** |
| **D-11** | Webhook event data retention & PII purge | **30-Day Automated Purge** of `webhook_events` | **YES (Pending Approval)** |
| **D-12** | Outbound message timeout & duplicate suppression | **Status Reconciliation Window (Favor Suppression Over Spam)** | **YES (Pending Approval)** |
| **D-13** | Distributed lease fencing & stale worker commit | **Strict CAS Fencing Abort** (Stolen leases discard commits) | **YES (Pending Approval)** |

---

## 3. Detailed Decision Specifications

### Decision D-01: Incoming Cart Submission During an Active Checkout Session
* **Context:** A customer submitted Cart A and is currently on the address step (`AWAITING_ADDRESS_INPUT`). They then return to the native WhatsApp catalog and submit Cart B.
* **Recommended Default:** **Replace Cart with New Selection & Invalidate Prior Tokens.** Overwrite Cart A in `session.state.cart` with Cart B, invalidate any prior confirmation action token, and inform the customer: *"We updated your cart with your latest selection! Please continue with your delivery address."*
* **Reason:** Customers browsing a catalog frequently realize they forgot an item or selected the wrong quantity. Replacing the cart honors their latest intent cleanly without conversational dead-ends, while invalidating prior confirmation tokens prevents accidental confirmation of stale carts.
* **Alternative:** **Reject New Cart.** Discard Cart B and send: *"You already have a cart in progress. Please complete or cancel your current order first."*
* **Consequence of Alternative:** Increases customer friction and abandonment; customers who simply wanted to add a drink are forced to cancel their entire flow and re-start.
* **User Approval Required:** **YES**.

---

### Decision D-02: Customer Attempts to Edit Cart via Free-Form Text
* **Context:** Customer types in chat: *"Remove the garlic bread"* or *"Make it 3 biryanis instead of 2"*.
* **Recommended Default:** **Catalog Re-direct (No Free-Form NLP Edits).** Respond with a polite automated prompt: *"To modify items or quantities, please tap the button below to update your selection in the catalogue:"* accompanied by `[View Catalogue]`.
* **Reason:** Complies strictly with the Phase 0 architectural boundary: **No AI/LLM chatbots**. Free-form text parsing for modifiers/quantities is notoriously error-prone and leads to order disputes.
* **Alternative:** **Keyword/Regex Parsing.** Attempt regex rules to match product names and numbers from text.
* **Consequence of Alternative:** Brittle parsing failures, miscalculated totals, and severe customer frustration when typos occur.
* **User Approval Required:** **YES**.

---

### Decision D-03: Address Modification Prior to Final Confirmation
* **Context:** On the final order review screen (`AWAITING_CONFIRMATION`), the customer notices a typo in their delivery address.
* **Recommended Default:** **Provide an Interactive `[📍 Change Address]` Button** alongside `[✅ Confirm Order]` and `[❌ Cancel Order]`. Tapping it routes the state back to `AWAITING_ADDRESS_INPUT`.
* **Reason:** Allows customers to fix address mistakes without discarding their cart or starting over from scratch.
* **Alternative:** **Binary Choice Only (`[Confirm]` and `[Cancel]`).** If the address is incorrect, the customer must tap Cancel and re-start the entire checkout flow.
* **Consequence of Alternative:** High checkout drop-off rate right at the finish line.
* **User Approval Required:** **YES**.

---

### Decision D-04: Session Inactivity Timeout Duration
* **Context:** A customer initiates a checkout flow and stops responding.
* **Recommended Default:** **2 Hours TTL (`expires_at = NOW() + INTERVAL '2 hours'`).**
* **Reason:** Real-world restaurant ordering frequently involves interruptions (e.g., waiting for family members to decide, phone calls). 2 hours provides generous breathing room while ensuring stale sessions do not linger overnight. When an expired session receives a message, it cleanly resets to `IDLE`.
* **Alternative:** **30 Minutes TTL.**
* **Consequence of Alternative:** Customers who pause for 35 minutes find their cart wiped out and must re-select items in the catalog.
* **User Approval Required:** **YES**.

---

### Decision D-05: Takeaway Fulfillment — Restaurant Pickup Address Display
* **Context:** Customer selects `[🥡 Takeaway / Pickup]`.
* **Recommended Default:** **Display Restaurant Pickup Notice.** Format summary as: *"Fulfillment: 🥡 Takeaway (Pickup at restaurant counter)"*.
* **Reason:** The existing `restaurants` schema contains `name` and `phone_number_id`, but does not have a physical `street_address` column. Adding schema columns is prohibited during Stage 4 planning.
* **Alternative:** **Add `pickup_address` to `restaurants` table.**
* **Consequence of Alternative:** Requires a database migration during Stage 4, violating the approved zero-migration boundary for this stage.
* **User Approval Required:** **YES**.

---

### Decision D-06: Unrecognized or Unsupported Customer Messages
* **Context:** Customer sends voice notes, stickers, images, or unrecognized text during checkout.
* **Recommended Default:** **Contextual Re-Prompt (Capped at 2 Consecutive Reminders).** Reply: *"We didn't quite catch that. Please use the options below to continue:"* and re-render the active step's buttons. If 2 consecutive unsupported messages are received, go quiet to prevent spam loops.
* **Reason:** Guides confused users back onto the conversational rails without spamming their WhatsApp chat.
* **Alternative:** **Silent Drop.** Completely ignore any unrecognized message without responding.
* **Consequence of Alternative:** Customer assumes the bot crashed or froze, leading to abandonment.
* **User Approval Required:** **YES**.

---

### Decision D-07: Human-Readable Product Names vs. Raw SKU Fallback
* **Context:** Meta's `type: "order"` webhook delivers `product_retailer_id` (e.g. `SKU_BIRYANI_01`), price, and quantity, but does **not** deliver human-readable item names ("Chicken Dum Biryani").
* **Recommended Default:** **Display SKU Fallback (`Item: SKU_CHKN_BIRYANI_01`).**
* **Reason:** Fetching item names requires querying Meta Graph API `GET /{catalog_id}/products`, which requires active `catalog_management` permissions and Commerce Manager catalog synchronization. Displaying raw SKUs allows Stage 4 to be completely implemented and tested autonomously without external live catalog dependencies.
* **Alternative:** **Mandatory Live Graph API Catalog Lookup.** Block checkout until product names are fetched from Meta Commerce Manager.
* **Consequence of Alternative:** Fails if Meta Commerce catalog permissions are not yet configured or during offline automated CI test runs.
* **User Approval Required:** **YES**.

---

### Decision D-08: Customer Cancellation After Confirmation but Before Restaurant Acceptance
* **Context:** Customer confirms an order (`status: PENDING_RESTAURANT_CONFIRMATION`). Two minutes later, before the restaurant owner reviews it, the customer types "Cancel".
* **Recommended Default:** **Disallow Cancellation in Customer Bot (Handled in Stage 5).** Reply: *"Your order has already been submitted to the restaurant. To cancel, please contact the restaurant directly at {owner_phone}."*
* **Reason:** Preserves the strict architectural boundary between Stage 4 (customer engine) and Stage 5 (owner decision processing).
* **Alternative:** **Allow Customer Self-Cancellation.** Allow the customer to cancel as long as status is `PENDING_RESTAURANT_CONFIRMATION`.
* **Consequence of Alternative:** Adds complex cancellation notification workflows that belong in Stage 5.
* **User Approval Required:** **YES**.

---

### Decision D-09: Cart Unit Price Discrepancies & Stale Pricing
* **Context:** Restaurant owner updates prices in Meta Commerce Manager, but a customer's cached WhatsApp catalog submits an order with yesterday's lower price.
* **Recommended Default:** **Snapshot Submitted Cart Price (Strict Rejection of Corrupt Values).** Record the items and prices exactly as submitted in the cart snapshot, provided the prices and quantities are valid positive numbers. Corrupt prices ($\le 0$, negative, or non-numeric) are strictly rejected. In Stage 5, the restaurant owner inspects the submitted total and decides whether to Accept or Reject.
* **Reason:** Complies with Phase 0 design: RESTOPRO is an automated order counter, not a menu manager. The restaurant owner holds ultimate acceptance authority.
* **Alternative:** **Reject Orders with Outdated Prices.** Query Meta catalog in real-time and reject if prices do not match.
* **Consequence of Alternative:** Adds external latency and catalog dependency to every incoming cart webhook.
* **User Approval Required:** **YES**.

---

### Decision D-10: Minimum Order Amount Enforcement
* **Context:** A customer places an order for a single ₹40 item for delivery.
* **Recommended Default:** **Disabled by Default.** Accept all non-zero carts.
* **Reason:** Adding minimum order thresholds requires adding configuration fields to `restaurants` (e.g. `min_order_delivery`), violating the zero-migration boundary for Stage 4.
* **Alternative:** **Hardcode Minimum Order Amount (e.g. ₹150 for Delivery).**
* **Consequence of Alternative:** Inflexible hardcoded business logic that may not suit all restaurant tenants.
* **User Approval Required:** **YES**.

---

### Decision D-11: Webhook Event Data Retention & Automated PII Purge Policy
* **Context:** `webhook_events` stores customer phone numbers, text messages, order details, and GPS coordinates for durable replayability. Retaining this data indefinitely creates database bloat and violates data minimization standards (DPDP / GDPR).
* **Recommended Default:** **30-Day Automated Purge.** Execute a scheduled maintenance routine:
  ```sql
  DELETE FROM webhook_events WHERE received_at < NOW() - INTERVAL '30 days';
  ```
  `conversation_sessions` older than 7 days with status `IDLE` are similarly purged.
* **Reason:** 30 days provides ample headroom for debugging, payment/receipt disputes, and operational recovery. Automated purging maintains lean PostgreSQL index sizes and ensures compliance.
* **Alternative:** **Indefinite Storage or Immediate Deletion.**
* **Consequence of Alternative:** Indefinite storage leads to unbounded table bloat and regulatory non-compliance; immediate deletion destroys replayability and audit capabilities.
* **User Approval Required:** **YES**.

---

### Decision D-12: Outbound Message Timeout & Duplicate Suppression Policy
* **Context:** Meta WhatsApp Cloud API does not support client-generated idempotency keys. If an outbound send encounters an uncertain outcome (network timeout, HTTP 504, socket hangup), blind retries risk sending duplicate WhatsApp messages to the customer.
* **Recommended Default:** **Reconciliation Window & Customer Activity Suppression (Favor Duplicate Suppression Over Customer Spam).** Transition message to `UNCERTAIN_DISPATCH` and wait 60 seconds. If an asynchronous delivery receipt arrives from Meta matching the message, mark `DELIVERED`. If customer activity is observed in the conversation, suppress the retry (`SUPPRESSED_BY_CUSTOMER_ACTIVITY`). For critical order confirmation receipts, execute at most 1 bounded fallback retry if no receipt/activity occurs.
* **Reason:** Customers are severely agitated by receiving duplicate order confirmation messages or spam prompts. Waiting for status receipts resolves network drops safely in over 95% of cases.
* **Alternative:** **Immediate Blind Retry on Network Timeout.**
* **Consequence of Alternative:** Customers frequently receive duplicate messages whenever Meta API or the host network encounters transient latency.
* **User Approval Required:** **YES**.

---

### Decision D-13: Distributed Webhook Lease Fencing & Stolen Worker Abort Policy
* **Context:** If a background recovery worker pauses (e.g. Node.js garbage collection pause) exceeding its 2-minute lease TTL without renewing its heartbeat, a secondary worker reclaims the event. When the slow worker finishes its work, what should happen?
* **Recommended Default:** **Strict CAS Fencing Abort (Stolen Leases Discard Commits).** The worker executes a Compare-And-Swap update checking `WHERE id = $id AND lease_token = $lease_token`. If 0 rows match, the worker logs a warning and cleanly aborts without committing state changes or throwing unhandled exceptions.
* **Reason:** Guarantees strict linearizability in distributed recovery and prevents split-brain writes where two workers attempt to advance conversation state concurrently.
* **Alternative:** **Unconditional Commit.** Worker overwrites database status regardless of whether another worker took over.
* **Consequence of Alternative:** Severe race conditions, split-brain state corruptions, and potential duplicate order submissions.
* **User Approval Required:** **YES**.
