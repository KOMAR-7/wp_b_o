/**
 * RESTOPRO — WhatsApp Web Catalogue Browser Companion Content Script
 *
 * Runs strictly within the context of https://web.whatsapp.com/*
 *
 * Responsibilities:
 * 1. Detect active WhatsApp Web session.
 * 2. Locate rendered catalogue products in the DOM.
 * 3. Extract genuine product name, productRetailerId, price, and currency.
 * 4. Support pagination / lazy loading via smooth auto-scroll scanning.
 * 5. Transmit extracted items to the RestPro backend with tenant authentication.
 *
 * Security & Privacy:
 * - Strictly restricted to catalogue views.
 * - Does not read personal chat messages, contacts, or encryption keys.
 * - Authenticated with restaurant-specific sync token.
 */

(function () {
  'use strict';

  // Prevent duplicate script injection
  if (window.__RESTOPRO_COMPANION_INITIALIZED__) return;
  window.__RESTOPRO_COMPANION_INITIALIZED__ = true;

  console.log('[RestPro Companion] Initialized on WhatsApp Web');

  /**
   * Currency symbol mapper.
   */
  const CURRENCY_MAP = {
    '₹': 'INR',
    'rs': 'INR',
    'rs.': 'INR',
    '$': 'USD',
    '€': 'EUR',
    '£': 'GBP',
    'aed': 'AED',
    'sar': 'SAR'
  };

  /**
   * Parses price and currency from text string (e.g. "₹180.00" or "INR 180" or "180 ₹").
   * @param {string} text
   * @returns {{price?: number, currency?: string}}
   */
  function parsePriceAndCurrency(text) {
    if (!text || typeof text !== 'string') return {};
    const clean = text.trim();

    let currency = 'INR'; // default currency for RestPro
    for (const [sym, code] of Object.entries(CURRENCY_MAP)) {
      if (clean.toLowerCase().includes(sym.toLowerCase())) {
        currency = code;
        break;
      }
    }

    // Extract numerical digits with optional decimal
    const match = clean.replace(/,/g, '').match(/\d+(\.\d{1,2})?/);
    if (match) {
      const val = parseFloat(match[0]);
      if (!isNaN(val) && val >= 0) {
        return { price: val, currency };
      }
    }

    return { currency };
  }

  /**
   * Scans the rendered DOM to extract all visible catalogue products.
   *
   * @returns {Array<{productRetailerId: string, name: string, price?: number, currency?: string, description?: string}>}
   */
  function extractRenderedCatalogProducts() {
    const productsMap = new Map();

    // 1. Scan for product links (e.g. href containing /product/<id> or wa.me/p/<id>)
    const productLinks = document.querySelectorAll('a[href*="/product/"], a[href*="wa.me/p/"]');
    productLinks.forEach(link => {
      const href = link.getAttribute('href') || '';
      let retailerId = '';
      const prodMatch = href.match(/\/product\/([a-zA-Z0-9_-]+)/i);
      const waMatch = href.match(/wa\.me\/p\/([a-zA-Z0-9_-]+)/i);

      if (prodMatch) retailerId = prodMatch[1];
      else if (waMatch) retailerId = waMatch[1];

      if (retailerId) {
        const textElements = Array.from(link.querySelectorAll('span, div, p'))
          .map(el => el.textContent.trim())
          .filter(t => t.length > 0);

        let candidateName = '';
        let price = undefined;
        let currency = 'INR';

        for (const t of textElements) {
          const parsed = parsePriceAndCurrency(t);
          if (parsed.price !== undefined && price === undefined) {
            price = parsed.price;
            if (parsed.currency) currency = parsed.currency;
          } else if (!candidateName && t.length > 1 && !t.includes('₹') && !t.includes('$')) {
            candidateName = t;
          }
        }

        if (candidateName && retailerId && candidateName.toLowerCase() !== retailerId.toLowerCase()) {
          productsMap.set(retailerId, {
            productRetailerId: retailerId,
            name: candidateName,
            price,
            currency
          });
        }
      }
    });

    // 2. Scan catalogue card containers (WhatsApp Web list items & drawer items)
    const catalogCards = document.querySelectorAll(
      '[data-testid*="catalog"], [data-testid*="product"], div[role="listitem"], div[role="row"]'
    );

    catalogCards.forEach(card => {
      // Find retailer ID from data attributes if present
      let retailerId = card.getAttribute('data-product-id') ||
        card.getAttribute('data-retailer-id') ||
        card.getAttribute('data-id') || '';

      // Clean prefix if internal WhatsApp ID (e.g. "product_zfzb9a6ptg")
      if (retailerId.includes('_')) {
        const parts = retailerId.split('_');
        retailerId = parts[parts.length - 1];
      }

      // Find Title / Name
      const titleEl = card.querySelector('[title], [role="heading"], strong, h2, h3, span[dir="auto"]');
      let name = titleEl ? (titleEl.getAttribute('title') || titleEl.textContent).trim() : '';

      // Find Price
      let price = undefined;
      let currency = 'INR';
      const allTexts = Array.from(card.querySelectorAll('span, div'))
        .map(el => el.textContent.trim())
        .filter(t => t.length > 0);

      for (const t of allTexts) {
        const parsed = parsePriceAndCurrency(t);
        if (parsed.price !== undefined) {
          price = parsed.price;
          if (parsed.currency) currency = parsed.currency;
          break;
        }
      }

      // Check if text inside card reveals retailer ID (e.g. "Item code: zfzb9a6ptg")
      if (!retailerId) {
        for (const t of allTexts) {
          const idMatch = t.match(/(?:Item code|SKU|ID|code):\s*([a-zA-Z0-9_-]+)/i);
          if (idMatch) {
            retailerId = idMatch[1].trim();
            break;
          }
        }
      }

      if (retailerId && name && name.toLowerCase() !== retailerId.toLowerCase()) {
        if (!productsMap.has(retailerId)) {
          productsMap.set(retailerId, {
            productRetailerId: retailerId,
            name,
            price,
            currency
          });
        }
      }
    });

    // 3. Inspect open Product Detail Modal if currently open
    const detailModal = document.querySelector('[data-testid="product-detail"], [role="dialog"]');
    if (detailModal) {
      const modalTexts = Array.from(detailModal.querySelectorAll('span, div, h1, h2, p'))
        .map(el => el.textContent.trim())
        .filter(t => t.length > 0);

      let modalRetailerId = '';
      let modalName = '';
      let modalPrice = undefined;
      let modalCurrency = 'INR';

      for (const t of modalTexts) {
        const idMatch = t.match(/(?:Item code|SKU|ID|code):\s*([a-zA-Z0-9_-]+)/i);
        if (idMatch) modalRetailerId = idMatch[1].trim();

        const priceParsed = parsePriceAndCurrency(t);
        if (priceParsed.price !== undefined && modalPrice === undefined) {
          modalPrice = priceParsed.price;
          if (priceParsed.currency) modalCurrency = priceParsed.currency;
        }
      }

      const modalTitleEl = detailModal.querySelector('h1, h2, [role="heading"]');
      if (modalTitleEl) modalName = modalTitleEl.textContent.trim();

      if (modalRetailerId && modalName) {
        productsMap.set(modalRetailerId, {
          productRetailerId: modalRetailerId,
          name: modalName,
          price: modalPrice,
          currency: modalCurrency
        });
      }
    }

    return Array.from(productsMap.values());
  }

  /**
   * Smoothly scrolls the catalogue container to load lazy-rendered items.
   *
   * @param {number} maxScrollAttempts
   * @returns {Promise<Array<Object>>}
   */
  async function scrollAndCollectAllProducts(maxScrollAttempts = 8) {
    const scrollContainers = Array.from(document.querySelectorAll('div[tabindex="-1"], div[role="region"], div[data-testid*="catalog"]'))
      .filter(el => el.scrollHeight > el.clientHeight);

    const targetContainer = scrollContainers[0] || window;

    let previousCount = 0;
    let attempts = 0;

    while (attempts < maxScrollAttempts) {
      attempts++;
      if (targetContainer.scrollBy) {
        targetContainer.scrollBy(0, 500);
      } else {
        window.scrollBy(0, 500);
      }
      await new Promise(r => setTimeout(r, 400));

      const currentProducts = extractRenderedCatalogProducts();
      if (currentProducts.length > previousCount) {
        previousCount = currentProducts.length;
      }
    }

    // Scroll back to top
    if (targetContainer.scrollTo) targetContainer.scrollTo(0, 0);
    else window.scrollTo(0, 0);

    return extractRenderedCatalogProducts();
  }

  /**
   * Shows a floating status toast on WhatsApp Web.
   *
   * @param {string} message
   * @param {'info'|'warning'|'error'} [type='info']
   */
  function showToast(message, type = 'info') {
    let toast = document.getElementById('restopro-companion-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'restopro-companion-toast';
      document.body.appendChild(toast);
    }

    toast.className = `restopro-toast ${type} show`;
    toast.textContent = message;

    setTimeout(() => {
      toast.classList.remove('show');
    }, 4500);
  }

  /**
   * Synchronizes extracted products to the RestPro backend API.
   *
   * @param {Array<Object>} products
   * @returns {Promise<Object>}
   */
  async function syncToBackend(products) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return reject(new Error('Extension storage API unavailable'));
      }

      chrome.storage.local.get(['backendUrl', 'restaurantId', 'syncKey', 'syncMode'], async (config) => {
        const { backendUrl, restaurantId, syncKey, syncMode = 'MERGE' } = config;

        if (!backendUrl || !restaurantId || !syncKey) {
          return reject(new Error('RestPro extension configuration missing. Please click the RestPro extension icon to enter your Restaurant ID and Sync Key.'));
        }

        const endpoint = `${backendUrl.replace(/\/+$/, '')}/api/catalog/sync`;

        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Restaurant-Id': restaurantId,
              'X-Sync-Key': syncKey
            },
            body: JSON.stringify({
              restaurantId,
              products,
              mode: syncMode,
              syncSource: 'WHATSAPP_WEB_COMPANION'
            })
          });

          const data = await res.json();
          if (!res.ok) {
            return reject(new Error(data.error || `Sync failed with HTTP ${res.status}`));
          }
          resolve(data);
        } catch (err) {
          reject(new Error(`Network error connecting to RestPro backend: ${err.message}`));
        }
      });
    });
  }

  /**
   * Triggers the full scan and sync workflow.
   */
  async function performScanAndSync() {
    const pill = document.getElementById('restopro-sync-pill');
    if (pill) pill.classList.add('syncing');

    showToast('RestPro: Scanning WhatsApp Web catalogue...', 'info');

    try {
      const products = await scrollAndCollectAllProducts();

      if (!products || products.length === 0) {
        showToast('No catalogue products found. Please open your WhatsApp Business Catalogue view in WhatsApp Web first.', 'warning');
        return;
      }

      showToast(`Found ${products.length} catalogue products. Synchronizing to RestPro...`, 'info');

      const syncResult = await syncToBackend(products);
      showToast(`✅ Successfully synced ${syncResult.syncedCount} products to RestPro!`, 'info');
      console.log('[RestPro Companion] Sync complete:', syncResult);
    } catch (err) {
      console.error('[RestPro Companion] Sync failed:', err);
      showToast(`❌ RestPro Sync Failed: ${err.message}`, 'error');
    } finally {
      if (pill) pill.classList.remove('syncing');
    }
  }

  /**
   * Injects the floating sync button into WhatsApp Web.
   */
  function injectFloatingPill() {
    if (document.getElementById('restopro-sync-pill')) return;

    const pill = document.createElement('div');
    pill.id = 'restopro-sync-pill';
    pill.className = 'restopro-floating-pill';
    pill.title = 'Click to extract & sync WhatsApp Business Catalogue to RestPro';
    pill.innerHTML = `
      <svg class="restopro-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
      </svg>
      <span>Sync Menu to RestPro</span>
    `;

    pill.addEventListener('click', () => {
      performScanAndSync();
    });

    document.body.appendChild(pill);
  }

  // Inject floating UI once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectFloatingPill);
  } else {
    injectFloatingPill();
  }

  // Listen for messages from popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'GET_STATUS') {
        const isWhatsAppWeb = window.location.hostname === 'web.whatsapp.com';
        const hasCatalog = document.querySelector('[data-testid*="catalog"], [data-testid*="product"], a[href*="/product/"]') !== null;
        sendResponse({
          isWhatsAppWeb,
          hasCatalog,
          url: window.location.href
        });
      } else if (request.action === 'SCAN_CATALOG') {
        scrollAndCollectAllProducts()
          .then(products => sendResponse({ success: true, products }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // asynchronous response
      } else if (request.action === 'TRIGGER_SYNC') {
        performScanAndSync()
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
      }
    });
  }
})();
