# RESTOPRO — Stage 1: Meta WhatsApp Cloud API Setup Guide

**Document Version:** 1.0.0  
**Target Environment:** Meta for Developers (Graph API v21.0)  
**Audience:** Backend Developers, DevOps, Integration Engineers  

---

## 1. Overview

This document provides step-by-step instructions for provisioning and configuring a Meta Developer Application and WhatsApp Business Account (WABA) to connect with the RESTOPRO backend.

---

## 2. Meta Developer Account & App Creation

1. Log into [Meta for Developers](https://developers.facebook.com/) with your Facebook Business credentials.
2. Click **My Apps** $\rightarrow$ **Create App**.
3. Select **Other** as the use case $\rightarrow$ Click **Next**.
4. Select **Business** as the app type $\rightarrow$ Click **Next**.
5. Fill in App Details:
   - **App Name:** `RESTOPRO-WhatsApp`
   - **App Contact Email:** Your developer/team email
   - **Business Account:** Select your verified Meta Business Account (or create one).
6. Click **Create App**.

---

## 3. Configuring the WhatsApp Product

1. In the App Dashboard under **Add products to your app**, locate **WhatsApp** and click **Set up**.
2. Under the left navigation menu, expand **WhatsApp** $\rightarrow$ Click **API Setup**.
3. You will see Meta's default sandbox environment:
   - **Temporary Access Token:** (Valid for 24 hours — used for sandbox testing).
   - **Phone Number ID:** (A 15-to-17 digit number, e.g., `109876543210123`).
   - **WhatsApp Business Account ID (WABA ID):** (e.g., `100293847561029`).
   - **Test Phone Number:** Meta provides a sandbox test number (e.g., `+1 555 012 3456`).
4. In the **To** field, add your personal WhatsApp number to the recipient whitelist and verify it via the 6-digit OTP sent by Meta.

---

## 4. Extracting Required Credentials for `.env`

Copy the following credentials and paste them into your local `.env` file:

| Environment Variable | Where to Find in Meta Dashboard | Description |
| :--- | :--- | :--- |
| `META_APP_SECRET` | **App settings** $\rightarrow$ **Basic** $\rightarrow$ **App secret** (Click *Show*) | Used for HMAC-SHA256 signature verification of all incoming webhooks. |
| `META_VERIFY_TOKEN` | User-defined secret string (e.g., `restopro_prod_secret_token_2026`) | Configured by you in both Meta Dashboard and `.env`. |
| `META_PHONE_NUMBER_ID` | **WhatsApp** $\rightarrow$ **API Setup** $\rightarrow$ **Phone number ID** | The unique identifier of the receiving business phone number. |
| `META_ACCESS_TOKEN` | **WhatsApp** $\rightarrow$ **API Setup** (Temporary) or System User (Permanent) | Bearer token for outbound Graph API messaging. |

---

## 5. Exposing Local Server to Meta via HTTPS Tunnel

Meta requires a publicly accessible HTTPS URL with a valid SSL/TLS certificate to deliver webhook events. For local testing, use Cloudflare Tunnel or ngrok:

### Option A: Using Cloudflare Tunnel (Recommended — Free & Stable)
```bash
cloudflared tunnel --url http://localhost:3000
```
*Cloudflare outputs a public HTTPS URL (e.g., `https://random-words.trycloudflare.com`).*

### Option B: Using ngrok
```bash
ngrok http 3000
```
*ngrok outputs a public HTTPS URL (e.g., `https://abc1-234.ngrok-free.app`).*

---

## 6. Configuring Webhook Subscription in Meta

1. In the Meta App Dashboard, navigate to **WhatsApp** $\rightarrow$ **Configuration** $\rightarrow$ **Webhook**.
2. Click **Edit**:
   - **Callback URL:** `https://<YOUR_TUNNEL_URL>/api/webhook`
   - **Verify Token:** The exact value of `META_VERIFY_TOKEN` configured in your `.env`.
3. Click **Verify and save**.
   - Meta sends an immediate HTTP GET request with `hub.mode`, `hub.verify_token`, and `hub.challenge`.
   - The RESTOPRO backend verifies the token and echoes the challenge string back.
   - A green checkmark confirms successful subscription.
4. Under **Webhook fields**, click **Manage** $\rightarrow$ Find **messages** $\rightarrow$ Click **Subscribe**.

---

## 7. Connecting WhatsApp Product Catalog

To test native WhatsApp catalog ordering (`type: "order"`):
1. Navigate to [Meta Commerce Manager](https://business.facebook.com/commerce/).
2. Select or create an e-commerce catalog for the restaurant.
3. Add at least two test products with prices, SKU/Content ID (`product_retailer_id`), and images.
4. Under **Catalog Settings** $\rightarrow$ **WhatsApp**, link the catalog to your test WABA.
5. In WhatsApp Business profile settings, toggle **Cart** and **Catalog** to ON.

---

## 8. Permanent System User Access Token (Production & Staging)

Temporary tokens expire in 24 hours. To generate a non-expiring production token:
1. Go to [Meta Business Settings](https://business.facebook.com/settings/) $\rightarrow$ **Users** $\rightarrow$ **System Users**.
2. Click **Add** $\rightarrow$ Role: **Admin** $\rightarrow$ Create system user.
3. Click **Add Assets** $\rightarrow$ Assign the **WhatsApp App** and **WABA** with full management permissions.
4. Click **Generate New Token** $\rightarrow$ Select the WhatsApp App $\rightarrow$ Check permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
   - `catalog_management`
5. Set Token Expiration to **Never**.
6. Store this token securely in production environment management. Never commit this token to Git.
