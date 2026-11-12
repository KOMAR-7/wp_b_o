# RestPro — WhatsApp Web Catalogue Browser Companion

The **RestPro WhatsApp Web Catalogue Companion** is a lightweight, restaurant-authorized browser extension designed for restaurant owners who manage their food menus exclusively through the native **WhatsApp Business mobile app**.

It securely extracts genuine product names and retailer IDs (SKUs) directly from the authenticated WhatsApp Web session and synchronizes them into the RestPro backend without requiring Meta Commerce Manager, manual data entry, or database migrations.

---

## Architecture Overview

```
┌─────────────────────────────────┐
│ Restaurant Owner's Smartphone   │
│ (WhatsApp Business Mobile App)  │
│ Creates/edits Menu Catalogue    │
└────────────────┬────────────────┘
                 │ Native WhatsApp Mobile Sync
                 ▼
┌─────────────────────────────────┐
│ WhatsApp Web                    │
│ (web.whatsapp.com)              │
│ Authenticated Owner Session     │
└────────────────┬────────────────┘
                 │ Rendered DOM Extraction
                 ▼
┌─────────────────────────────────┐
│ RestPro Browser Companion       │
│ Extracts:                       │
│ - productRetailerId             │
│ - Genuine Product Name          │
│ - Price & Currency              │
└────────────────┬────────────────┘
                 │ Authenticated POST /api/catalog/sync
                 │ Headers: X-Restaurant-Id, X-Sync-Key
                 ▼
┌─────────────────────────────────┐
│ RestPro Ordering Backend        │
│ Updates Restaurant.internal_notes│
│ In-memory TTL Cache Refresh     │
└────────────────┬────────────────┘
                 │ Authoritative Name Resolution
                 ▼
┌─────────────────────────────────┐
│ Incoming Customer Cart Webhooks │
│ Orders displayed with exact     │
│ product names (Zero SKU leaks!) │
└─────────────────────────────────┘
```

---

## Non-Negotiable Business Constraints Satisfied

1. **WhatsApp Business App Exclusivity**: Restaurant owners continue managing all products solely on their phone.
2. **Zero Meta Commerce Manager Dependency**: Works seamlessly on SMB WABA accounts where Meta Graph API catalogue queries are blocked (`error #10`).
3. **Zero Product Re-entry**: Scans existing catalogue automatically in seconds.
4. **No Schema Changes**: Reuses existing structured metadata storage in `Restaurant.internal_notes`.
5. **Strict Multi-Tenant Isolation**: Every sync request is authenticated with HMAC-SHA256 sync keys derived from the restaurant's unique ID. Restaurant A cannot view, modify, or sync catalogue data for Restaurant B.
6. **No Chat/Privacy Invasion**: The companion interacts ONLY with catalogue DOM elements. It never inspects chats, messages, contact lists, or account credentials.

---

## Installation Guide (Chrome / Edge / Brave)

1. Open your Chromium-based browser (Chrome, Edge, Brave).
2. Navigate to extensions management:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
   - Brave: `brave://extensions/`
3. Enable **Developer Mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the `companion-extension` directory from this repository.
6. The **RestPro Companion** icon (RP) will appear in your browser extension toolbar.

---

## Configuration & Usage

### Step 1: Obtain Restaurant Credentials
Ask your RestPro Super Administrator for your **Restaurant ID** and **Sync Key**, or retrieve them via:
```http
GET /api/admin/restaurants/:restaurantId/sync-token
```
Response:
```json
{
  "success": true,
  "restaurantId": "21345aa7-42b6-4d84-b267-1d42e93ef3cc",
  "restaurantName": "Zaika Caterers & Biryani",
  "syncToken": "4f9b8c2d1e0a...",
  "syncEndpoint": "/api/catalog/sync"
}
```

### Step 2: Configure the Extension
1. Click the **RestPro Companion** icon in your browser toolbar.
2. Switch to the **Connection Settings** tab.
3. Enter:
   - **Backend URL**: `https://order.restopro.in` (or your server URL)
   - **Restaurant ID**: Your restaurant UUID
   - **Restaurant Sync Key**: The 64-character token
   - **Sync Mode**: `Merge` (default) or `Replace`
4. Click **Test Connection** to confirm connectivity.
5. Click **Save Settings**.

### Step 3: Open WhatsApp Web & Sync
1. Open **[https://web.whatsapp.com](https://web.whatsapp.com)** in the same browser.
2. Ensure you are logged into your restaurant's WhatsApp Business account.
3. Open your **Business Profile** -> **Catalogue** view (or click on any chat and open Catalogue).
4. You will see a floating green pill at the bottom-right: **"Sync Menu to RestPro"**.
5. Click the pill, or open the extension popup and click **Scan & Sync WhatsApp Catalogue**.
6. The companion will auto-scroll, collect all catalogue items, and upload them to RestPro.
7. A confirmation toast will notify you when sync is complete!

---

## API Specifications

### Ingestion Endpoint: `POST /api/catalog/sync`
- **Headers**:
  - `X-Restaurant-Id`: Restaurant UUID
  - `X-Sync-Key`: HMAC-SHA256 sync token
- **Body**:
  ```json
  {
    "restaurantId": "21345aa7-42b6-4d84-b267-1d42e93ef3cc",
    "products": [
      {
        "productRetailerId": "zfzb9a6ptg",
        "name": "Butter Chicken",
        "price": 180,
        "currency": "INR"
      },
      {
        "productRetailerId": "sezp6n6uee",
        "name": "Chicken Dum Biryani (Special)",
        "price": 800,
        "currency": "INR"
      }
    ],
    "mode": "MERGE"
  }
  ```
- **Responses**:
  - `200 OK`: Successfully synchronized.
  - `400 Bad Request`: Malformed payload or invalid retailer IDs.
  - `401 Unauthorized`: Invalid or missing sync credentials.
  - `403 Forbidden`: Restaurant is inactive or suspended.
  - `404 Not Found`: Restaurant ID does not exist.

### Status Query: `GET /api/catalog/sync`
- **Headers**:
  - `X-Restaurant-Id`: Restaurant UUID
  - `X-Sync-Key`: Sync token
- **Response**:
  ```json
  {
    "success": true,
    "restaurantId": "21345aa7-42b6-4d84-b267-1d42e93ef3cc",
    "restaurantName": "Zaika Caterers & Biryani",
    "totalCatalogCount": 2,
    "catalog": {
      "zfzb9a6ptg": { "name": "Butter Chicken", "price": 180, "currency": "INR" },
      "sezp6n6uee": { "name": "Chicken Dum Biryani (Special)", "price": 800, "currency": "INR" }
    }
  }
  ```
