# RESTOPRO — Meta WhatsApp Cloud API Integration Specification

**Document Version:** 1.0.0  
**Status:** Approved for Planning / Pre-Implementation  
**API Specification:** Meta WhatsApp Cloud API (Graph API v21.0)  

---

## 1. Meta WhatsApp Cloud API Architecture & Setup

RESTOPRO leverages Meta’s official **WhatsApp Cloud API** hosted directly on Meta’s global infrastructure.

### 1.1 Developer & Account Hierarchy
- **Meta Business Portfolio (Business Manager):** Top-level corporate account holding restaurant assets.
- **WhatsApp Business Account (WABA):** The container for phone numbers, message templates, analytics, and payment methods.
- **Phone Number ID (`phone_number_id`):** The 15-to-17-digit numeric identifier assigned by Meta to the restaurant's phone number. **This is RESTOPRO's primary tenant routing key.**
- **Commerce Manager Product Catalog:** The catalog holding menu items and collections linked to the WABA.
- **System User Access Token:** A permanent, granular access token generated in Meta Business Manager with permissions:
  - `whatsapp_business_messaging`
  - `whatsapp_business_management`
  - `catalog_management` (if catalog details are read via Graph API)

---

## 2. Webhook Ingestion & Cryptographic Verification

Meta sends webhook events via HTTPS to RESTOPRO’s configured callback endpoint:  
`POST https://api.restopro.app/api/webhook`

### 2.1 Webhook Setup Verification (HTTP GET)
When configuring the webhook in the Meta App Dashboard, Meta sends a GET verification request:
- **Query Parameters:**
  - `hub.mode`: Must equal `"subscribe"`
  - `hub.verify_token`: Verified against internal `META_VERIFY_TOKEN`
  - `hub.challenge`: Random alphanumeric string sent by Meta
- **Response:** RESTOPRO must respond with HTTP 200 and return the raw `hub.challenge` string in the response body.

### 2.2 Payload Authentication via HMAC-SHA256 (HTTP POST)
Every incoming POST request contains an HTTP header:
`x-hub-signature-256: sha256=<hex_digest>`

**Verification Algorithm:**
1. Capture the raw, unparsed request body buffer before JSON parsing.
2. Compute `crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')`.
3. Compare the computed digest against the received header using `crypto.timingSafeEqual`.
4. If invalid, reject immediately with HTTP 403 Forbidden.

---

## 3. Real Meta Webhook Payloads (Verified Formats)

### 3.1 Customer Initial Text Message ("Hi")
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "100293847561029",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550123456",
              "phone_number_id": "109876543210123"
            },
            "contacts": [
              {
                "profile": { "name": "Omar Khan" },
                "wa_id": "919876543210"
              }
            ],
            "messages": [
              {
                "from": "919876543210",
                "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=",
                "timestamp": "1730800000",
                "type": "text",
                "text": { "body": "Hi" }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

### 3.2 Native Catalog Cart / Order Submission (`type: "order"`)
When a customer sends their cart from the native WhatsApp catalog:
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "100293847561029",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550123456",
              "phone_number_id": "109876543210123"
            },
            "contacts": [
              {
                "profile": { "name": "Omar Khan" },
                "wa_id": "919876543210"
              }
            ],
            "messages": [
              {
                "from": "919876543210",
                "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0FCRAA=",
                "timestamp": "1730800045",
                "type": "order",
                "order": {
                  "catalog_id": "987654321098765",
                  "text": "Please provide extra tissues and cutlery",
                  "product_items": [
                    {
                      "product_retailer_id": "SKU_CHKN_BIRYANI_01",
                      "quantity": 2,
                      "item_price": 240,
                      "currency": "INR"
                    },
                    {
                      "product_retailer_id": "SKU_COLD_COFFEE_04",
                      "quantity": 1,
                      "item_price": 80,
                      "currency": "INR"
                    }
                  ]
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

> [!IMPORTANT]
> **Key Finding on Cart Payloads:**
> Meta's incoming `order` payload contains `product_retailer_id`, `quantity`, `item_price`, `currency`, and customer notes (`text`).
> It does **NOT** contain human-readable product names (e.g., "Chicken Biryani").
> RESTOPRO handles this by:
> 1. Querying the Meta Graph API catalog edge (`GET /{catalog_id}/products?filter=...`) to resolve SKU to name, OR
> 2. Caching catalog SKUs upon first read, OR
> 3. Displaying `SKU: SKU_CHKN_BIRYANI_01` as a safe fallback if catalog permissions are restricted.

### 3.3 Customer WhatsApp Location Sharing (`type: "location"`)
```json
{
  "from": "919876543210",
  "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0FDRQA=",
  "timestamp": "1730800090",
  "type": "location",
  "location": {
    "latitude": 19.1363257,
    "longitude": 72.8276601,
    "name": "Green Valley Apartments",
    "address": "Flat 302, Green Valley Apartments, Link Road, Andheri West, Mumbai 400053"
  }
}
```

### 3.4 Owner Quick Reply Button Tap from Template (`type: "button"`)
When the restaurant owner taps an action button on a Meta Utility Template notification:
```json
{
  "from": "919811122233",
  "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0FDRkEA=",
  "timestamp": "1730800120",
  "type": "button",
  "button": {
    "payload": "ORDER_ACCEPT_RP1024",
    "text": "Accept Order"
  },
  "context": {
    "from": "15550123456",
    "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0FEQ0EA="
  }
}
```

### 3.5 Interactive Button Reply (`type: "interactive"`)
When a customer clicks an interactive button during checkout (e.g. Confirm Order):
```json
{
  "from": "919876543210",
  "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0FDR0EA=",
  "timestamp": "1730800105",
  "type": "interactive",
  "interactive": {
    "type": "button_reply",
    "button_reply": {
      "id": "BTN_CONFIRM_ORDER",
      "title": "✅ Confirm Order"
    }
  }
}
```

---

## 4. Outbound API Specifications

All outbound messages are sent via HTTPS:  
`POST https://graph.facebook.com/v21.0/{phone_number_id}/messages`  
`Authorization: Bearer {restaurant_access_token}`  
`Content-Type: application/json`

### 4.1 Sending Welcome Message with Native Catalog Prompt
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "interactive",
  "interactive": {
    "type": "catalog_message",
    "body": {
      "text": "Welcome to *Royal Biryani House*! 🥘\n\nBrowse our fresh menu and place your order directly through WhatsApp by tapping the button below."
    },
    "action": {
      "name": "catalog_message"
    },
    "footer": {
      "text": "Fast Delivery & Takeaway Available"
    }
  }
}
```

### 4.2 Sending Address Consent Quick Replies (Interactive)
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": {
      "text": "Would you like us to save this address for your future orders at *Royal Biryani House*?"
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": { "id": "BTN_SAVE_ADDR_YES", "title": "Yes, Save Address" }
        },
        {
          "type": "reply",
          "reply": { "id": "BTN_SAVE_ADDR_NO", "title": "No, Just This Once" }
        }
      ]
    }
  }
}
```

### 4.3 Sending Owner Notification (Meta Utility Template)
Because the restaurant owner did not initiate the conversation within the preceding 24 hours, sending freeform messages will trigger Meta Error 131047. Therefore, RESTOPRO must dispatch a pre-approved **Utility Template**:

**Template Definition on Meta:**
- Name: `restopro_owner_order_alert`
- Category: `UTILITY`
- Language: `en_US`
- Body:
  `New Order #{{1}} at {{2}}!\nCustomer: {{3}} ({{4}})\nType: {{5}}\nAddress: {{6}}\n\nItems:\n{{7}}\n\nTotal: {{8}}`
- Buttons: Quick Reply buttons `[Accept Order]` and `[Reject Order]`.

**Dispatch Payload:**
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919811122233",
  "type": "template",
  "template": {
    "name": "restopro_owner_order_alert",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "RP-1024" },
          { "type": "text", "text": "Royal Biryani House" },
          { "type": "text", "text": "Omar Khan" },
          { "type": "text", "text": "+919876543210" },
          { "type": "text", "text": "Delivery" },
          { "type": "text", "text": "Flat 302, Andheri West, Mumbai" },
          { "type": "text", "text": "• Chicken Biryani x 2 (₹480)\n• Cold Coffee x 1 (₹80)" },
          { "type": "text", "text": "₹560" }
        ]
      },
      {
        "type": "button",
        "sub_type": "quick_reply",
        "index": "0",
        "parameters": [
          { "type": "payload", "payload": "ORDER_ACCEPT_RP1024" }
        ]
      },
      {
        "type": "button",
        "sub_type": "quick_reply",
        "index": "1",
        "parameters": [
          { "type": "payload", "payload": "ORDER_REJECT_RP1024" }
        ]
      }
    ]
  }
}
```

---

## 5. WhatsApp Business App & Cloud API Coexistence Analysis

Meta officially provides "Coexistence" allowing a phone number to run both the WhatsApp Business mobile app and Cloud API simultaneously.

### 5.1 Technical Realities & Constraints
1. **App Version Requirement:** Mobile phone must run WhatsApp Business App v2.24.17 or newer.
2. **Activity Requirement:** The primary smartphone must connect and open the mobile app at least once every 14 days, or the Cloud API connection is suspended.
3. **Throughput Cap:** Coexisting phone numbers are capped at **5 messages per second (mps)** (compared to 80-250 mps for dedicated Cloud API numbers).
4. **Disabled Mobile Features:** On the mobile app, Broadcast Lists, Message Edit/Revoke, and Live Location sharing become disabled once linked to Cloud API.
5. **Message Mirroring (Echoes):** Messages sent via Cloud API appear in the owner's phone app chat list. If the owner manually chats from the phone, webhook echoes are sent to RESTOPRO.

---

## 6. Classification of Integration Knowledge

To maintain engineering integrity, all technical aspects are strictly categorized:

### 6.1 Verified Facts (Backed by Documentation & Specs)
- Webhook signature verification uses HMAC-SHA256 with the Meta App Secret.
- Incoming carts arrive as message `type: "order"`, containing `order.product_items`.
- Location messages provide `latitude`, `longitude`, and optional `name`/`address`.
- Business-initiated messages outside the 24-hour customer service window strictly require pre-approved message templates.
- Interactive catalog prompts require `interactive.type: "catalog_message"`.

### 6.2 Documentation-Based Conclusions
- Graph API catalog queries can enrich `product_retailer_id` with product names and images if `catalog_management` permissions are granted.
- Quick Reply buttons in message templates return incoming webhooks with `type: "button"`, unlike free-form interactive replies which return `type: "interactive"`.

### 6.3 Untested Assumptions & Open Questions (To Be Live-Tested in Stage 1)
- *Will restaurant owners consistently keep their WhatsApp Business App open every 14 days in coexistence mode, or will dedicated numbers be needed?*
- *What is the exact latency of Meta Commerce Manager catalog sync when a restaurant modifies prices in the WhatsApp Business App?*
- *How gracefully does the WhatsApp client handle catalog messages when a customer runs an outdated WhatsApp mobile build?*

