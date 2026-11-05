# RESTOPRO — Stage 1: External Dependencies & Blockers Register

**Document Version:** 1.0.0  
**Status:** Action Required from Developer / Account Owner  

---

## 1. Overview

While all core application components, Express middleware, HMAC-SHA256 signature verification, and payload parsers have been implemented and validated locally (38/38 passing tests), connecting to the live Meta WhatsApp Cloud API infrastructure requires specific external configuration in Meta Business Manager.

---

## 2. Active External Blockers

| Blocker ID | Requirement | Impact | Resolution Steps | Status |
| :--- | :--- | :--- | :--- | :--- |
| **BLK-01** | **Meta Developer App & Credentials** | Cannot establish live webhook callback or outbound API calls. | Create app at [developers.facebook.com](https://developers.facebook.com/), copy `META_APP_SECRET`, set `META_VERIFY_TOKEN`, and add to `.env`. | **BLOCKED (Requires User Action)** |
| **BLK-02** | **Public HTTPS Webhook Tunnel** | Meta cannot deliver webhooks to `localhost:3000`. | Run `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, configure public URL in Meta Webhook settings. | **BLOCKED (Requires User Action)** |
| **BLK-03** | **Meta Commerce Manager Catalog Link** | Cannot test live catalog cart submissions (`type: "order"`). | Link an e-commerce catalog with at least 2 test items to test WABA in Meta Commerce Manager. | **BLOCKED (Requires User Action)** |
| **BLK-04** | **Meta Utility Template Approval** | Cannot test outbound owner notification outside 24h window. | Submit `restopro_owner_order_alert` template in WhatsApp Manager for approval. | **BLOCKED (Requires User Action)** |

---

## 3. Unblocking Action Plan for the User

To complete live end-to-end testing with a physical WhatsApp device:

1. **Configure `.env`:**
   Open `.env` in the project root and fill in your Meta Developer App values:
   ```env
   PORT=3000
   NODE_ENV=development
   META_VERIFY_TOKEN=your_chosen_secret_verify_token
   META_APP_SECRET=your_meta_app_secret_from_dashboard
   META_PHONE_NUMBER_ID=your_test_phone_number_id
   META_ACCESS_TOKEN=your_test_system_user_access_token
   ```

2. **Start the RESTOPRO Server:**
   ```bash
   npm run dev
   ```

3. **Start Public HTTPS Tunnel:**
   In a separate terminal window:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   # OR
   ngrok http 3000
   ```

4. **Subscribe Webhook in Meta Dashboard:**
   - URL: `https://<YOUR_TUNNEL_URL>/api/webhook`
   - Verify Token: Same as `META_VERIFY_TOKEN` in `.env`
   - Subscribe to: `messages`

5. **Send Live Test Messages from WhatsApp:**
   - Text "Hi" to the Meta test number.
   - Open catalog, add items to cart, and send cart.
   - Share location pin.
   - Watch the formatted JSON logs appear in your server console!
