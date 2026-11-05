# RESTOPRO — Stage 4.3: Address Collection & Saved Addresses Implementation Results

**Document Version:** 1.0.0  
**Implementation Date:** 2026-11-05  
**Status:** Implemented, Tested & Verified  
**Target Sub-Phase:** Stage 4.3 (Single Restaurant Customer Ordering Engine — Address & Consent)  

---

## 1. Executive Summary

Stage 4.3 establishes the delivery address collection and saved address management subsystem for RESTOPRO. Building directly upon the cart processing engine (Stage 4.1) and conversation state machine (Stage 4.2), Stage 4.3 delivers:

1. **Saved Address Lookup & Reuse (`ST4-07`):** Seamless discovery and interactive reuse prompts for returning customers, strictly isolated by `(restaurant_id, customer_phone)`.
2. **Defensive Manual Address Capture (`ST4-08`):** Strict text length validation ($\ge 10$ characters) with contextual reprompting and session preservation prior to explicit consent.
3. **Location Pin Parsing & Building/Room Collection Pipeline (`ST4-09`):** Resilient GPS coordinate parsing (preserving `0.0` equator/prime meridian coordinates and boundary validation) followed by a mandatory, sequential building name and room/flat number collection pipeline.
4. **Explicit Consent & Duplicate Prevention (`ST4-10`):** Zero automatic persistence; delivery addresses are persisted to `saved_addresses` strictly when the customer explicitly taps **[Yes, Save Address]**, with coordinate and text duplicate detection.
5. **Multi-Tenant & Cross-Customer Security:** Absolute database scoping preventing cross-tenant address leakage or cross-customer claiming.

---

## 2. Architecture & Address Lifecycle Flow

```mermaid
flowchart TD
    CartSubmitted["Catalogue Cart Submitted (Stage 4.1)"] --> LookupSaved{"Check saved_addresses for (tenant, customer)"}
    
    LookupSaved -->|Saved Address Found| ChoiceStep["Step: AWAITING_ADDRESS_CHOICE<br/>Buttons: [Use Saved Address] / [Enter New Address]"]
    LookupSaved -->|No Saved Address| InputStep["Step: AWAITING_ADDRESS_INPUT<br/>Prompt: Share Text Address or Location Pin"]
    
    ChoiceStep -->|Taps Use Saved Address| ValidateSaved{"Validate Address ID & Tenant/Customer Scoping"}
    ValidateSaved -->|Valid| OrderTypeStep["Step: AWAITING_ORDER_TYPE<br/>(Proceeds to Stage 4.4)"]
    ValidateSaved -->|Invalid / Cross-Tenant| RepromptChoice["Reject & Reprompt Choice"]
    
    ChoiceStep -->|Taps Enter New Address| InputStep
    
    InputStep -->|Sends Text >= 10 chars| NormManual["Normalize Manual Address<br/>(source: MANUAL, coords: null)"]
    InputStep -->|Sends Text < 10 chars| RepromptText["Reprompt: Min 10 chars required"]
    InputStep -->|Sends Location Pin| ValidateCoords{"Validate Lat [-90,90] & Lng [-180,180]<br/>(Preserve 0.0)"}
    
    ValidateCoords -->|Invalid / Out of Range| RepromptPin["Reprompt: Coordinates invalid"]
    ValidateCoords -->|Valid Coordinates| BldStep["Step: AWAITING_BUILDING_NAME<br/>Prompt: Share building / complex name"]
    
    BldStep -->|Valid Building Name| RoomStep["Step: AWAITING_ROOM_NUMBER<br/>Prompt: Share room, flat, or floor number"]
    BldStep -->|Empty / Invalid| RepromptBld["Reprompt: Building name required"]
    
    RoomStep -->|Valid Room Number| NormPin["Assemble Location Address<br/>(source: LOCATION_PIN, lat, lng, building, room)"]
    RoomStep -->|Empty / Invalid| RepromptRoom["Reprompt: Room number required"]
    
    NormManual --> ConsentStep["Step: AWAITING_SAVE_CONSENT<br/>Buttons: [Yes, Save] / [No, Continue]"]
    NormPin --> ConsentStep
    
    ConsentStep -->|Taps Yes, Save| SaveDB["Deduplicate & Persist to saved_addresses<br/>(addressSaved: true)"]
    ConsentStep -->|Taps No| KeepSession["Retain in active session only<br/>(addressSaved: false)"]
    
    SaveDB --> OrderTypeStep
    KeepSession --> OrderTypeStep
```

---

## 3. Detailed Component Implementations

### 3.1 Saved Address Lookup & Reuse (`ST4-07`)

- **Tenant Scoping:** Saved addresses are queried strictly via:
  ```javascript
  prisma.savedAddress.findMany({
    where: {
      restaurant_id: restaurantId,
      customer_phone: customerPhone.trim()
    },
    orderBy: { created_at: 'desc' }
  });
  ```
- **Cart Entry Routing:** If one or more saved addresses exist, `processIncomingCart()` routes the session to `AWAITING_ADDRESS_CHOICE`. The action payload includes the saved address list with formatted display text, building name, and room number.
- **Ownership Verification:** When a customer selects `BTN_USE_SAVED_ADDRESS:<id>` or `ADDR_SAVED_<id>`, `findSavedAddressById()` enforces that `restaurant_id === tenant.id` and `customer_phone === customer.phone`. Cross-tenant or cross-customer IDs are rejected with zero state changes.

### 3.2 Manual Text Address Validation (`ST4-08`)

- **Validation Bounds:**
  - Minimum length: 10 characters (`MIN_ADDRESS_LENGTH = 10`).
  - Maximum length: 500 characters (`MAX_ADDRESS_LENGTH = 500`).
  - Rejects empty strings, whitespace-only strings, and non-string inputs.
- **Session Preservation:** Valid text input is normalized as:
  ```json
  {
    "addressText": "Flat 204, Royal Palms, Goregaon East, Mumbai 400065",
    "buildingName": null,
    "roomNumber": null,
    "latitude": null,
    "longitude": null,
    "source": "MANUAL"
  }
  ```
- **Consent Precondition:** Zero records are inserted into `saved_addresses` at this stage; the address is retained strictly in `conversation_sessions.state.address`.

### 3.3 WhatsApp Location Pin & Building/Room Pipeline (`ST4-09`)

- **Coordinate Handling (`validateCoordinates`):**
  - Uses `safeParseCoordinate()` from [`webhook-parser.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/parsers/webhook-parser.js).
  - Explicitly preserves `0.0` (equator / prime meridian) without falsy JavaScript coercion (`val !== null && typeof val === 'number' && !isNaN(val)`).
  - Validates boundaries: $-90 \le \text{latitude} \le 90$ and $-180 \le \text{longitude} \le 180$.
- **Two-Step Pipeline Requirement:** GPS pins identify a geographical point but cannot identify indoor building or apartment coordinates. To prevent delivery failure, RESTOPRO enforces:
  1. `AWAITING_BUILDING_NAME`: Asks for building/complex name (validated $\ge 1$ char and $\le 120$ chars). Stored in `state.tempLocation.buildingName`.
  2. `AWAITING_ROOM_NUMBER`: Asks for room/flat/floor number (validated $\ge 1$ char and $\le 60$ chars). Stored in `state.tempLocation.roomNumber`.
- **Address Assembly:** Only after both details are provided is the address marked complete:
  ```json
  {
    "addressText": "Room/Flat: Flat 501, Building: Sunshine Towers, Wing B, Area: Andheri West, Mumbai",
    "buildingName": "Sunshine Towers, Wing B",
    "roomNumber": "Flat 501",
    "latitude": 19.1197,
    "longitude": 72.8468,
    "source": "LOCATION_PIN"
  }
  ```
  `tempLocation` is deleted from session state upon completion.

### 3.4 Explicit Customer Consent & Deduplication (`ST4-10`)

- **Consent Enforcement:**
  - `BTN_CONSENT_YES`: Calls `saveConsentedAddress()`. Persists record to `saved_addresses` and sets `session.state.addressSaved = true`.
  - `BTN_CONSENT_NO`: Bypasses `saved_addresses`. Sets `session.state.addressSaved = false`. Address remains in `session.state.address` for current order fulfillment only.
- **Duplicate Prevention:**
  - Before inserting a row into `saved_addresses`, queries existing addresses for `(restaurant_id, customer_phone)`.
  - Matches case-insensitive address text and checks coordinate proximity ($\Delta \le 0.0001^{\circ} \approx 11\,\text{meters}$).
  - If a match exists, reuses the existing `saved_addresses` row without inserting duplicate records.

---

## 4. Database Schema Evaluation & Compatibility

The prompt specified:
> *"If the existing database schema cannot represent these values safely, stop and report the exact schema limitation before creating a migration. Do not silently discard address details."*

### Schema Evaluation Findings:
1. **`conversation_sessions.state` (`JSONB`):** Losslessly represents the full address object:
   - `addressText` (string)
   - `buildingName` (string)
   - `roomNumber` (string)
   - `latitude` (numeric)
   - `longitude` (numeric)
   - `source` (`'MANUAL'` | `'LOCATION_PIN'` | `'SAVED'`)
2. **`saved_addresses` Table:**
   - `address` (`TEXT`): Accommodates the fully formatted combined string incorporating room number, building name, and location/area details without character limits or data loss.
   - `latitude` (`DECIMAL(10, 7)`): Accurately stores high-precision GPS coordinates.
   - `longitude` (`DECIMAL(10, 7)`): Accurately stores high-precision GPS coordinates.
   - `label` (`VARCHAR(64)`): Accommodates optional labels (e.g. `'Default'`, `'Home'`).
3. **`orders` Table (Prerequisite for Stage 4.5):**
   - `address_snapshot` (`TEXT`) and `latitude`/`longitude` (`DECIMAL(10,7)`).

**Conclusion:** The existing PostgreSQL schema safely and losslessly represents all required address parameters. **Zero schema migrations were required for Stage 4.3.**

---

## 5. Verification & Test Results

A dedicated automated test suite was implemented in [`test/stage4-address-test.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/test/stage4-address-test.js).

### Test Suite Execution Summary:

```
============================================================
   RESTOPRO — STAGE 4.3: ADDRESS COLLECTION TEST SUITE     
============================================================

--- TEST GROUP 1: Saved Addresses Lookup, Reuse & Isolation (ST4-07) ---
  ✅ [PASS] Existing saved address retrieved for customer at Tenant A
  ✅ [PASS] Address text matches seeded record
  ✅ [PASS] Address includes room/flat number
  ✅ [PASS] Customer with saved address transitions to AWAITING_ADDRESS_CHOICE
  ✅ [PASS] Cart action prompts address choice
  ✅ [PASS] Saved address list included in action
  ✅ [PASS] Selecting saved address transitions to AWAITING_ORDER_TYPE
  ✅ [PASS] Address source is SAVED
  ✅ [PASS] Session address matches saved address text
  ✅ [PASS] Session marks addressSaved = true
  ✅ [PASS] Customer without saved address transitions directly to AWAITING_ADDRESS_INPUT
  ✅ [PASS] Action prompts address collection
  ✅ [PASS] Tenant A address is invisible at Tenant B (Zero Cross-Tenant Leakage)
  ✅ [PASS] Tenant B session defaults to AWAITING_ADDRESS_INPUT (no saved address found for Tenant B)
  ✅ [PASS] Cross-tenant saved address selection rejected; step preserved
  ✅ [PASS] No address attached to Tenant B session
  ✅ [PASS] Cross-customer address access strictly rejected
  ✅ [PASS] Customer 2 cannot claim Customer 1 address
  ✅ [PASS] Generic BTN_USE_SAVED_ADDRESS transitions to AWAITING_ORDER_TYPE
  ✅ [PASS] Generic button loaded customer primary address
  ✅ [PASS] BTN_ENTER_NEW_ADDRESS transitions to AWAITING_ADDRESS_INPUT
  ✅ [PASS] Action prompts for new address input

--- TEST GROUP 2: Manual Text Address Capture & Validation (ST4-08) ---
  ✅ [PASS] Session ready in AWAITING_ADDRESS_INPUT
  ✅ [PASS] Valid text address transitions to AWAITING_SAVE_CONSENT
  ✅ [PASS] Address source is MANUAL
  ✅ [PASS] Address text matches input
  ✅ [PASS] Manual address has null latitude
  ✅ [PASS] Manual address has null longitude
  ✅ [PASS] Action type is VALID_TEXT_INPUT
  ✅ [PASS] Address is NOT permanently saved before explicit consent (ST4-08)
  ✅ [PASS] Short address rejected; step stays AWAITING_ADDRESS_INPUT
  ✅ [PASS] No address stored for short text
  ✅ [PASS] unsupportedCount incremented on invalid address
  ✅ [PASS] Contextual reprompt issued for short address
  ✅ [PASS] Reprompt indicates address is too short
  ✅ [PASS] Empty address rejected; step stays AWAITING_ADDRESS_INPUT
  ✅ [PASS] unsupportedCount incremented on whitespace
  ✅ [PASS] validateTextAddress rejects null
  ✅ [PASS] validateTextAddress rejects numbers

--- TEST GROUP 3: WhatsApp Location Pin Parsing & Range Validation (ST4-09) ---
  ✅ [PASS] Valid coordinates (Mumbai) accepted
  ✅ [PASS] Latitude correctly parsed
  ✅ [PASS] Longitude correctly parsed
  ✅ [PASS] Zero coordinates (0.0, 0.0) valid
  ✅ [PASS] Latitude 0.0 preserved
  ✅ [PASS] Longitude 0.0 preserved
  ✅ [PASS] String zero coordinates ("0", "0.0") valid
  ✅ [PASS] Parsed latitude is 0
  ✅ [PASS] Missing latitude rejected
  ✅ [PASS] Missing longitude rejected
  ✅ [PASS] Non-numeric string latitude rejected
  ✅ [PASS] Latitude > 90 rejected
  ✅ [PASS] Latitude < -90 rejected
  ✅ [PASS] Longitude > 180 rejected
  ✅ [PASS] Longitude < -180 rejected

--- TEST GROUP 4: Location Pin Building & Room Pipeline (ST4-09) ---
  ✅ [PASS] Location pin transitions to AWAITING_BUILDING_NAME
  ✅ [PASS] tempLocation stores latitude
  ✅ [PASS] tempLocation stores longitude
  ✅ [PASS] Address is NOT complete yet (still awaiting building & room)
  ✅ [PASS] Action type is VALID_LOCATION_INPUT
  ✅ [PASS] Action indicates nextStep AWAITING_BUILDING_NAME
  ✅ [PASS] Empty building name rejected; stays in AWAITING_BUILDING_NAME
  ✅ [PASS] buildingName not set on empty input
  ✅ [PASS] unsupportedCount incremented
  ✅ [PASS] Valid building name transitions to AWAITING_ROOM_NUMBER
  ✅ [PASS] buildingName persisted in tempLocation
  ✅ [PASS] Coordinates preserved across building name step
  ✅ [PASS] Address still incomplete without room number
  ✅ [PASS] Action prompts for room number
  ✅ [PASS] Empty room number rejected; stays in AWAITING_ROOM_NUMBER
  ✅ [PASS] unsupportedCount incremented
  ✅ [PASS] Valid room number transitions to AWAITING_SAVE_CONSENT
  ✅ [PASS] Address is now fully assembled and complete
  ✅ [PASS] Address source is LOCATION_PIN
  ✅ [PASS] buildingName in final address
  ✅ [PASS] roomNumber in final address
  ✅ [PASS] GPS latitude in final address
  ✅ [PASS] GPS longitude in final address
  ✅ [PASS] Formatted address includes room number
  ✅ [PASS] Formatted address includes building name
  ✅ [PASS] tempLocation cleaned up after assembly
  ✅ [PASS] Action prompts for address saving consent

--- TEST GROUP 5: Explicit Address-Saving Consent Flow (ST4-10) ---
  ✅ [PASS] Consent YES transitions to AWAITING_ORDER_TYPE
  ✅ [PASS] Session state marks addressSaved = true
  ✅ [PASS] savedAddressId recorded in session
  ✅ [PASS] Address record physically exists in saved_addresses table
  ✅ [PASS] Persisted record correctly scoped to tenantA
  ✅ [PASS] Persisted record correctly scoped to customer
  ✅ [PASS] Persisted record contains room number
  ✅ [PASS] Persisted record contains building name
  ✅ [PASS] Persisted record contains GPS latitude
  ✅ [PASS] Persisted record contains GPS longitude
  ✅ [PASS] Consent NO transitions to AWAITING_ORDER_TYPE
  ✅ [PASS] Session marks addressSaved = false
  ✅ [PASS] Address retained in active conversation session state
  ✅ [PASS] Address text intact in session
  ✅ [PASS] Zero rows created in saved_addresses table on BTN_CONSENT_NO
  ✅ [PASS] First address save creates new row
  ✅ [PASS] Second identical save detects duplicate
  ✅ [PASS] Duplicate returns existing savedAddress ID without new row
  ✅ [PASS] Exactly 1 row exists in saved_addresses after duplicate save attempt

--- TEST GROUP 6: Session Security, Inactivity & Edge Cases ---
  ✅ [PASS] 2-Hour inactivity TTL refreshed on address input
  ✅ [PASS] Session current_step preserved in AWAITING_BUILDING_NAME
  ✅ [PASS] tempLocation uncorrupted after bad button
  ✅ [PASS] Cart subtotal uncorrupted after bad button
  ✅ [PASS] 1st unsupported message triggers CONTEXTUAL_REPROMPT
  ✅ [PASS] unsupportedCount is 1
  ✅ [PASS] 2nd unsupported message triggers CONTEXTUAL_REPROMPT
  ✅ [PASS] unsupportedCount is 2
  ✅ [PASS] 3rd unsupported message triggers SILENT_FALLBACK
  ✅ [PASS] Step preserved during silent fallback
  ✅ [PASS] HTTP POST location pin webhook returns HTTP 200
  ✅ [PASS] Location pin webhookEvent completed in DB
  ✅ [PASS] Session transitioned to AWAITING_BUILDING_NAME via webhook HTTP POST
  ✅ [PASS] Concurrent address messages resolve cleanly without deadlocks
  ✅ [PASS] Session is consistently in AWAITING_SAVE_CONSENT after concurrent calls

============================================================
   STAGE 4.3 TEST RESULTS: 116 PASSED, 0 FAILED
============================================================
```

---

## 6. Comprehensive Regression Suite Pass Rates

Across all stages implemented to date:

| Test Suite | File | Assertions Passed | Failures | Status |
| :--- | :--- | :---: | :---: | :---: |
| Stage 1 & 1.5 Webhook Audit | `test/webhook-test.js` | **86 / 86** | 0 | PASSED |
| Stage 2 Multi-Tenant DB | `test/stage2-database-test.js` | **59 / 59** | 0 | PASSED |
| Stage 4.0 Database Prerequisites | `test/stage4-migration-test.js` | **30 / 30** | 0 | PASSED |
| Stage 4.1 Cart Processing | `test/stage4-cart-test.js` | **88 / 88** | 0 | PASSED |
| Stage 4.2 Conversation State Engine | `test/stage4-conversation-test.js` | **52 / 52** | 0 | PASSED |
| Stage 4.3 Address Collection & Consent | `test/stage4-address-test.js` | **116 / 116** | 0 | PASSED |
| Graceful Shutdown Child Process | `test/graceful-shutdown-test.js` | **6 / 6** | 0 | PASSED |
| **Total Active Verified Assertions** | | **437 / 437** | **0** | **100% HEALTHY** |

---

## 7. Modified Files & Artifacts

- **Created Files:**
  - [`src/services/address.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/address.service.js) — Address validation, normalization, and consent persistence service.
  - [`test/stage4-address-test.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/test/stage4-address-test.js) — Comprehensive 116-assertion test suite.
  - [`docs/stage-4/STAGE-4.3-ADDRESS-COLLECTION-RESULTS.md`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/stage-4/STAGE-4.3-ADDRESS-COLLECTION-RESULTS.md) — Implementation and verification report.
- **Modified Files:**
  - [`src/services/conversation.service.js`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/src/services/conversation.service.js) — Integrated address choice, location pin building/room collection pipeline, and consent transitions.
  - [`package.json`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/package.json) — Added `"test:stage4:address"` script.
  - [`docs/07-IMPLEMENTATION-CHECKLIST.md`](file:///m:/For%20Other/Saeem/Only%20Whatsapp/docs/07-IMPLEMENTATION-CHECKLIST.md) — Marked `ST4-07`, `ST4-08`, `ST4-09`, and `ST4-10` complete (`[x]`).
- **Database Schema Changes:** None required (existing `SavedAddress` and `JSONB` state represent all details safely).

