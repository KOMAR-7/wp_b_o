# RESTOPRO — Stage 1: Verified Meta Webhook Payload Samples

**Document Version:** 1.0.0  
**Data Origin:** Official Meta WhatsApp Cloud API v21.0 Webhook Specifications  
**Sanitization:** All phone numbers, message IDs, and catalog IDs are mock/sanitized values.  

---

## 1. Payload Inventory in `docs/test-payloads/`

| File Name | Message Type | Description |
| :--- | :--- | :--- |
| [`01-text-message.json`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/test-payloads/01-text-message.json) | `text` | Customer greeting ("Hi") initiating conversation. |
| [`02-catalog-order.json`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/test-payloads/02-catalog-order.json) | `order` | Native WhatsApp Catalog Cart submission with items and prices. |
| [`03-location-message.json`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/test-payloads/03-location-message.json) | `location` | Customer location pin with GPS coordinates and address. |
| [`04-template-button-reply.json`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/test-payloads/04-template-button-reply.json) | `button` | Restaurant owner tap on Utility Template Quick Reply button (`ORDER_ACCEPT_RP1024`). |
| [`05-interactive-button-reply.json`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/test-payloads/05-interactive-button-reply.json) | `interactive` | Customer tap on interactive message button (`BTN_CONFIRM_ORDER`). |
| [`06-delivery-status-receipt.json`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/test-payloads/06-delivery-status-receipt.json) | `statuses` | Delivery status receipt (`sent`, `delivered`, `read`). |

---

## 2. Structural Breakdown of Key Payloads

### 2.1 Native WhatsApp Catalog Order Payload (`type: "order"`)
```json
{
  "messages": [
    {
      "from": "919876543210",
      "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0FCRAA=",
      "timestamp": "1730800045",
      "type": "order",
      "order": {
        "catalog_id": "987654321098765",
        "text": "Please make it spicy and send extra cutlery",
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
}
```

#### Field Characteristics & Architectural Observations:
- **`catalog_id`:** Identifier of the Commerce Manager catalog associated with the restaurant.
- **`text`:** Optional customer instructions entered when submitting the cart.
- **`product_items[].product_retailer_id`:** The SKU/Content ID defined in Commerce Manager.
- **`product_items[].quantity`:** Unit count chosen by customer.
- **`product_items[].item_price`:** Price per unit at the time the cart was sent.
- **`product_items[].currency`:** Currency code (e.g., `'INR'`, `'USD'`).
- **Product Name:** **Omitted by Meta.** The cart payload does not provide product titles. Enriched via Meta Graph API catalog query or local SKU-to-Name catalog cache.

---

### 2.2 Template Quick Reply Button Tap (`type: "button"`)
```json
{
  "messages": [
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
  ]
}
```

#### Key Extraction Fields:
- **`button.payload`:** Developer-defined action token (e.g., `ORDER_ACCEPT_{order_id}` or `ORDER_REJECT_{order_id}`).
- **`context.id`:** Message ID of the notification message that was tapped.
- **`from`:** Sender phone number (used to verify owner authorization).
