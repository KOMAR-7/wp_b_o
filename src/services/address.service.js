/**
 * RESTOPRO — Address Collection & Saved Address Service
 * Stage 4.3: Address Collection, Normalization, and Consent Persistence
 *
 * Implements:
 * - Scoped saved address lookup and reuse (ST4-07)
 * - Text address validation with minimum length defense (ST4-08)
 * - WhatsApp location pin parsing with 0.0 preservation & building/room collection (ST4-09)
 * - Explicit customer consent flow & duplicate prevention (ST4-10)
 * - Strict multi-tenant and cross-customer isolation
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { safeParseCoordinate } = require('../parsers/webhook-parser');

const MIN_ADDRESS_LENGTH = 10;
const MAX_ADDRESS_LENGTH = 500;
const MIN_BUILDING_NAME_LENGTH = 1;
const MAX_BUILDING_NAME_LENGTH = 120;
const MIN_ROOM_NUMBER_LENGTH = 1;
const MAX_ROOM_NUMBER_LENGTH = 60;

/**
 * Validates manual text address.
 * Rejects empty, whitespace-only, or text shorter than 10 characters.
 *
 * @param {string} text - Raw address input
 * @returns {{isValid: boolean, error?: string, addressText?: string}}
 */
function validateTextAddress(text) {
  if (typeof text !== 'string') {
    return {
      isValid: false,
      error: 'Address must be a valid text string.'
    };
  }

  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return {
      isValid: false,
      error: 'Address cannot be empty.'
    };
  }

  if (trimmed.length < MIN_ADDRESS_LENGTH) {
    return {
      isValid: false,
      error: `Address is too short (${trimmed.length} characters). Please provide a complete address with at least ${MIN_ADDRESS_LENGTH} characters.`
    };
  }

  if (trimmed.length > MAX_ADDRESS_LENGTH) {
    return {
      isValid: false,
      error: `Address is too long (${trimmed.length} characters). Maximum allowed is ${MAX_ADDRESS_LENGTH} characters.`
    };
  }

  // Defense: Never mistake a customer's phone number or phone_number_id for a delivery address
  const digitsOnly = trimmed.replace(/[\s\-\+\(\)]/g, '');
  if (/^\d{7,16}$/.test(digitsOnly) && !/[a-zA-Z]/.test(trimmed)) {
    return {
      isValid: false,
      error: 'A phone number cannot be used as a delivery address. Please provide your complete street address.'
    };
  }

  return {
    isValid: true,
    addressText: trimmed
  };
}

/**
 * Validates geographic coordinates.
 * Preserves 0.0 (Equator / Prime Meridian) without falsy coercion.
 * Validates latitude in [-90, 90] and longitude in [-180, 180].
 *
 * @param {number|string} lat - Latitude
 * @param {number|string} lng - Longitude
 * @returns {{isValid: boolean, error?: string, latitude?: number, longitude?: number}}
 */
function validateCoordinates(lat, lng) {
  const parsedLat = safeParseCoordinate(lat);
  const parsedLng = safeParseCoordinate(lng);

  if (parsedLat === null || typeof parsedLat !== 'number' || isNaN(parsedLat)) {
    return {
      isValid: false,
      error: 'Invalid or missing latitude coordinate.'
    };
  }

  if (parsedLng === null || typeof parsedLng !== 'number' || isNaN(parsedLng)) {
    return {
      isValid: false,
      error: 'Invalid or missing longitude coordinate.'
    };
  }

  if (parsedLat < -90 || parsedLat > 90) {
    return {
      isValid: false,
      error: `Latitude ${parsedLat} is out of valid range [-90, 90].`
    };
  }

  if (parsedLng < -180 || parsedLng > 180) {
    return {
      isValid: false,
      error: `Longitude ${parsedLng} is out of valid range [-180, 180].`
    };
  }

  return {
    isValid: true,
    latitude: parsedLat,
    longitude: parsedLng
  };
}

/**
 * Validates building / apartment name.
 * Must be non-empty and within reasonable bounds.
 *
 * @param {string} buildingName
 * @returns {{isValid: boolean, error?: string, buildingName?: string}}
 */
function validateBuildingName(buildingName) {
  if (typeof buildingName !== 'string') {
    return {
      isValid: false,
      error: 'Building name must be a text string.'
    };
  }

  const trimmed = buildingName.trim();

  if (trimmed.length < MIN_BUILDING_NAME_LENGTH) {
    return {
      isValid: false,
      error: 'Building name cannot be empty.'
    };
  }

  if (trimmed.length > MAX_BUILDING_NAME_LENGTH) {
    return {
      isValid: false,
      error: `Building name is too long (${trimmed.length} characters). Maximum is ${MAX_BUILDING_NAME_LENGTH}.`
    };
  }

  return {
    isValid: true,
    buildingName: trimmed
  };
}

/**
 * Validates room / flat / floor number.
 * Must be non-empty and within reasonable bounds.
 *
 * @param {string} roomNumber
 * @returns {{isValid: boolean, error?: string, roomNumber?: string}}
 */
function validateRoomNumber(roomNumber) {
  if (typeof roomNumber !== 'string') {
    return {
      isValid: false,
      error: 'Room or flat number must be a text string.'
    };
  }

  const trimmed = roomNumber.trim();

  if (trimmed.length < MIN_ROOM_NUMBER_LENGTH) {
    return {
      isValid: false,
      error: 'Room or flat number cannot be empty.'
    };
  }

  if (trimmed.length > MAX_ROOM_NUMBER_LENGTH) {
    return {
      isValid: false,
      error: `Room or flat number is too long (${trimmed.length} characters). Maximum is ${MAX_ROOM_NUMBER_LENGTH}.`
    };
  }

  return {
    isValid: true,
    roomNumber: trimmed
  };
}

/**
 * Safely combines and normalizes multiple address components (e.g. customer-entered room/flat/building details,
 * and WhatsApp location pin name/address) into a single clean string.
 *
 * Rules:
 * 1. Normalizes whitespace, tabs, and newlines to a single space.
 * 2. Normalizes separators, trimming leading/trailing commas and periods.
 * 3. Prevents duplicate components (e.g. when WhatsApp sends identical strings in location.name and location.address).
 * 4. Deduplicates identical or redundant comma-separated segments while preserving distinct details:
 *    flat number, building name, landmark, street, locality, city, state, postal code.
 * 5. Preserves similar but distinct elements (e.g. "Sector 14" vs "Sector 14A", "Maulana Azad Rd" vs "Maulana Azad Cross Rd").
 *
 * @param {...(string|null|undefined)} components - Address parts to combine
 * @returns {string} Formatted, deduplicated address string
 */
function combineAddressComponents(...components) {
  // 1. Flatten arrays if passed and filter valid string inputs
  const rawParts = components
    .flat()
    .filter(c => typeof c === 'string' && c.trim().length > 0)
    .map(c => {
      // Normalize internal whitespace and strip outer punctuation
      return c
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[,\s\-\.\;]+|[,\s\-\.\;]+$/g, '')
        .trim();
    })
    .filter(c => c.length > 0);

  if (rawParts.length === 0) return '';

  // 2. Component-level deduplication: drop components that are exact normalized duplicates
  const uniqueParts = [];
  const seenComponentKeys = new Set();

  for (const part of rawParts) {
    const key = part.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) continue;
    if (seenComponentKeys.has(key)) {
      continue; // Skip exact duplicate component
    }
    seenComponentKeys.add(key);
    uniqueParts.push(part);
  }

  // 3. Segment-level extraction and deduplication:
  // Split each unique part by commas into individual address segments
  const finalSegments = [];
  const seenSegmentKeys = new Set();

  for (const part of uniqueParts) {
    const segments = part
      .split(/,\s*/)
      .map(s => s.replace(/^[,\s\-\.\;]+|[,\s\-\.\;]+$/g, '').trim())
      .filter(s => s.length > 0);

    for (const seg of segments) {
      const segKey = seg.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!segKey) continue;

      if (!seenSegmentKeys.has(segKey)) {
        seenSegmentKeys.add(segKey);
        finalSegments.push(seg);
      }
    }
  }

  return finalSegments.join(', ');
}

/**
 * Normalizes address into a consistent internal structure.
 *
 * @param {Object} params
 * @param {string} params.source - 'MANUAL' | 'LOCATION_PIN' | 'SAVED'
 * @param {string} [params.addressText] - Complete address text
 * @param {string} [params.buildingName] - Building or complex name
 * @param {string} [params.roomNumber] - Flat, room, or floor number
 * @param {number} [params.latitude] - GPS latitude
 * @param {number} [params.longitude] - GPS longitude
 * @returns {Object} Normalized address object
 */
function normalizeAddress({
  source,
  addressText,
  buildingName = null,
  roomNumber = null,
  latitude = null,
  longitude = null
}) {
  let formattedText = addressText ? addressText.trim() : '';

  if (source === 'LOCATION_PIN') {
    if (buildingName && roomNumber) {
      const cleanBuilding = buildingName.trim();
      const cleanRoom = roomNumber.trim();
      formattedText = combineAddressComponents(
        `Room/Flat: ${cleanRoom}`,
        `Building: ${cleanBuilding}`,
        formattedText
      );
    } else if (!formattedText) {
      if (typeof latitude === 'number' && typeof longitude === 'number') {
        formattedText = `Pinned Location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
      } else {
        formattedText = 'Shared Location Pin';
      }
    } else {
      formattedText = combineAddressComponents(formattedText);
    }
  } else if (formattedText) {
    formattedText = combineAddressComponents(formattedText);
  }

  return {
    addressText: formattedText,
    buildingName: buildingName ? buildingName.trim() : null,
    roomNumber: roomNumber ? roomNumber.trim() : null,
    latitude: typeof latitude === 'number' ? latitude : null,
    longitude: typeof longitude === 'number' ? longitude : null,
    source
  };
}

/**
 * Looks up all saved addresses for a specific customer strictly scoped to a restaurant tenant.
 * Guarantees zero cross-tenant address leakage.
 *
 * @param {string} restaurantId - Verified tenant UUID
 * @param {string} customerPhone - Customer phone string
 * @returns {Promise<Array<Object>>}
 */
async function findCustomerSavedAddresses(restaurantId, customerPhone) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[TENANT ERROR] findCustomerSavedAddresses requires valid restaurantId');
  }

  if (!customerPhone || typeof customerPhone !== 'string') {
    throw new Error('[CUSTOMER ERROR] findCustomerSavedAddresses requires valid customerPhone');
  }

  return prisma.savedAddress.findMany({
    where: {
      restaurant_id: restaurantId,
      customer_phone: customerPhone.trim()
    },
    orderBy: { created_at: 'desc' }
  });
}

/**
 * Looks up a single saved address by ID, verifying tenant and customer ownership.
 * Returns null if the address does not belong to the restaurant and customer.
 *
 * @param {string} restaurantId - Verified tenant UUID
 * @param {string} customerPhone - Customer phone string
 * @param {string} addressId - Saved address UUID
 * @returns {Promise<Object|null>}
 */
async function findSavedAddressById(restaurantId, customerPhone, addressId) {
  if (!restaurantId || !customerPhone || !addressId) {
    return null;
  }

  return prisma.savedAddress.findFirst({
    where: {
      id: addressId,
      restaurant_id: restaurantId,
      customer_phone: customerPhone.trim()
    }
  });
}

/**
 * Persists an address to saved_addresses with explicit customer consent.
 * Deduplicates by matching exact address text and near-identical GPS coordinates for this customer.
 *
 * @param {string} restaurantId - Verified tenant UUID
 * @param {string} customerPhone - Customer phone string
 * @param {Object} normalizedAddress - Address from normalizeAddress()
 * @param {string} [label='Default'] - Optional address label
 * @param {Object} [dbClient=prisma] - Prisma client or transaction client
 * @returns {Promise<{savedAddress: Object, isDuplicate: boolean}>}
 */
async function saveConsentedAddress(restaurantId, customerPhone, normalizedAddress, label = 'Default', dbClient = prisma) {
  if (!restaurantId || typeof restaurantId !== 'string') {
    throw new Error('[TENANT ERROR] saveConsentedAddress requires valid restaurantId');
  }

  if (!customerPhone || typeof customerPhone !== 'string') {
    throw new Error('[CUSTOMER ERROR] saveConsentedAddress requires valid customerPhone');
  }

  if (!normalizedAddress || !normalizedAddress.addressText) {
    throw new Error('[ADDRESS ERROR] saveConsentedAddress requires valid normalizedAddress with addressText');
  }

  const phone = customerPhone.trim();
  const addressText = normalizedAddress.addressText.trim();
  const lat = typeof normalizedAddress.latitude === 'number' ? normalizedAddress.latitude : null;
  const lng = typeof normalizedAddress.longitude === 'number' ? normalizedAddress.longitude : null;

  // 1. Check for existing duplicate address for this customer and tenant
  const existingMatches = await dbClient.savedAddress.findMany({
    where: {
      restaurant_id: restaurantId,
      customer_phone: phone
    }
  });

  for (const existing of existingMatches) {
    const isTextMatch = existing.address.trim().toLowerCase() === addressText.toLowerCase();

    let isCoordMatch = false;
    if (lat !== null && lng !== null && existing.latitude !== null && existing.longitude !== null) {
      const dLat = Math.abs(Number(existing.latitude) - lat);
      const dLng = Math.abs(Number(existing.longitude) - lng);
      // Coordinate tolerance ~ 10 meters (~0.0001 deg)
      if (dLat < 0.0001 && dLng < 0.0001) {
        isCoordMatch = true;
      }
    }

    if (isTextMatch || (isCoordMatch && isTextMatch)) {
      logger.info('Duplicate saved address detected; reusing existing row', {
        restaurantId,
        customerPhone: phone,
        existingId: existing.id
      });
      return {
        savedAddress: existing,
        isDuplicate: true
      };
    }
  }

  // 2. Persist new consented address record
  const created = await dbClient.savedAddress.create({
    data: {
      restaurant_id: restaurantId,
      customer_phone: phone,
      label: label || 'Default',
      address: addressText,
      latitude: lat,
      longitude: lng
    }
  });

  logger.info('Consented address persisted to database', {
    restaurantId,
    customerPhone: phone,
    savedAddressId: created.id,
    hasCoordinates: lat !== null && lng !== null
  });

  return {
    savedAddress: created,
    isDuplicate: false
  };
}

/**
 * Formats an address for display in WhatsApp chat.
 *
 * @param {Object} addressObj - Normalized or saved address
 * @returns {string} Formatted display string
 */
function formatAddressForDisplay(addressObj) {
  if (!addressObj) return '';
  const text = addressObj.addressText || addressObj.address || '';
  return text;
}

module.exports = {
  MIN_ADDRESS_LENGTH,
  MAX_ADDRESS_LENGTH,
  MIN_BUILDING_NAME_LENGTH,
  MAX_BUILDING_NAME_LENGTH,
  MIN_ROOM_NUMBER_LENGTH,
  MAX_ROOM_NUMBER_LENGTH,
  validateTextAddress,
  validateCoordinates,
  validateBuildingName,
  validateRoomNumber,
  combineAddressComponents,
  normalizeAddress,
  findCustomerSavedAddresses,
  findSavedAddressById,
  saveConsentedAddress,
  formatAddressForDisplay
};

