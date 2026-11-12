/**
 * RESTOPRO — WhatsApp Web Catalogue Browser Companion Popup Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const statusIndicator = document.getElementById('statusIndicator');
  const waStatusText = document.getElementById('waStatusText');
  const btnScanNow = document.getElementById('btnScanNow');
  const catalogResultsCard = document.getElementById('catalogResultsCard');
  const itemCountBadge = document.getElementById('itemCountBadge');
  const productsTableBody = document.getElementById('productsTableBody');
  const btnConfirmSync = document.getElementById('btnConfirmSync');
  const syncLog = document.getElementById('syncLog');

  // Form Elements
  const settingsForm = document.getElementById('settingsForm');
  const backendUrlInput = document.getElementById('backendUrl');
  const restaurantIdInput = document.getElementById('restaurantId');
  const syncKeyInput = document.getElementById('syncKey');
  const syncModeInput = document.getElementById('syncMode');
  const btnTestConn = document.getElementById('btnTestConn');

  let scannedProducts = [];

  // Tab Switching
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');
    });
  });

  function log(msg) {
    syncLog.style.display = 'block';
    const entry = document.createElement('div');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    syncLog.appendChild(entry);
    syncLog.scrollTop = syncLog.scrollHeight;
  }

  // Load Saved Settings
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['backendUrl', 'restaurantId', 'syncKey', 'syncMode'], (items) => {
      if (items.backendUrl) backendUrlInput.value = items.backendUrl;
      if (items.restaurantId) restaurantIdInput.value = items.restaurantId;
      if (items.syncKey) syncKeyInput.value = items.syncKey;
      if (items.syncMode) syncModeInput.value = items.syncMode;

      if (items.backendUrl && items.restaurantId && items.syncKey) {
        checkBackendStatus(items.backendUrl, items.restaurantId, items.syncKey);
      }
    });
  }

  // Save Settings
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const config = {
      backendUrl: backendUrlInput.value.trim(),
      restaurantId: restaurantIdInput.value.trim(),
      syncKey: syncKeyInput.value.trim(),
      syncMode: syncModeInput.value
    };

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set(config, () => {
        log('Configuration saved successfully.');
        checkBackendStatus(config.backendUrl, config.restaurantId, config.syncKey);
      });
    }
  });

  // Test Connection
  btnTestConn.addEventListener('click', () => {
    const url = backendUrlInput.value.trim();
    const rId = restaurantIdInput.value.trim();
    const key = syncKeyInput.value.trim();

    if (!url || !rId || !key) {
      alert('Please fill in Backend URL, Restaurant ID, and Sync Key.');
      return;
    }

    log(`Testing connection to ${url}...`);
    checkBackendStatus(url, rId, key, true);
  });

  async function checkBackendStatus(backendUrl, restaurantId, syncKey, showAlert = false) {
    statusIndicator.className = 'status-badge pending';
    statusIndicator.textContent = 'Checking...';

    const endpoint = `${backendUrl.replace(/\/+$/, '')}/api/catalog/sync`;
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'X-Restaurant-Id': restaurantId,
          'X-Sync-Key': syncKey
        }
      });

      const data = await res.json();
      if (res.ok) {
        statusIndicator.className = 'status-badge connected';
        statusIndicator.textContent = 'Connected';
        log(`Connected to RestPro! Restaurant: ${data.restaurantName} (${data.totalCatalogCount || 0} items)`);
        if (showAlert) alert(`Connected to RestPro!\nRestaurant: ${data.restaurantName}\nCurrent catalogue: ${data.totalCatalogCount || 0} items`);
      } else {
        statusIndicator.className = 'status-badge disconnected';
        statusIndicator.textContent = 'Auth Failed';
        log(`Connection failed: ${data.error || res.statusText}`);
        if (showAlert) alert(`Authentication Failed: ${data.error || res.statusText}`);
      }
    } catch (err) {
      statusIndicator.className = 'status-badge disconnected';
      statusIndicator.textContent = 'Offline';
      log(`Network error: ${err.message}`);
      if (showAlert) alert(`Connection Error: ${err.message}`);
    }
  }

  // Check Active WhatsApp Web Tab
  async function checkWhatsAppTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      waStatusText.textContent = 'Companion running in preview mode.';
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('web.whatsapp.com')) {
      waStatusText.innerHTML = '⚠️ Active tab is not WhatsApp Web.<br>Please open <b>https://web.whatsapp.com</b> to sync.';
      btnScanNow.disabled = true;
      return;
    }

    btnScanNow.disabled = false;
    waStatusText.innerHTML = '✅ WhatsApp Web tab active.<br>Open your Business Profile > Catalogue view, then click Scan.';
  }

  checkWhatsAppTab();

  // Scan WhatsApp Catalogue
  btnScanNow.addEventListener('click', async () => {
    log('Sending scan request to WhatsApp Web tab...');
    btnScanNow.disabled = true;
    btnScanNow.textContent = 'Scanning Catalogue...';

    if (typeof chrome === 'undefined' || !chrome.tabs) {
      btnScanNow.disabled = false;
      btnScanNow.textContent = 'Scan & Sync WhatsApp Catalogue';
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.tabs.sendMessage(tab.id, { action: 'SCAN_CATALOG' }, (response) => {
      btnScanNow.disabled = false;
      btnScanNow.textContent = 'Scan & Sync WhatsApp Catalogue';

      if (chrome.runtime.lastError) {
        log(`Error: ${chrome.runtime.lastError.message}`);
        alert('Could not communicate with WhatsApp Web tab. Please refresh WhatsApp Web and ensure catalogue is open.');
        return;
      }

      if (response && response.success && response.products) {
        scannedProducts = response.products;
        renderProductsTable(scannedProducts);
      } else {
        log(`Scan failed: ${response?.error || 'No products found'}`);
        alert('No catalogue products found. Please open your Catalogue view in WhatsApp Web.');
      }
    });
  });

  function renderProductsTable(products) {
    productsTableBody.innerHTML = '';
    itemCountBadge.textContent = `${products.length} items`;

    if (products.length === 0) {
      catalogResultsCard.style.display = 'none';
      return;
    }

    products.forEach(p => {
      const tr = document.createElement('tr');
      const priceStr = p.price !== undefined ? `${p.currency || '₹'} ${p.price}` : '—';
      tr.innerHTML = `
        <td><code>${escapeHtml(p.productRetailerId)}</code></td>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>${priceStr}</td>
      `;
      productsTableBody.appendChild(tr);
    });

    catalogResultsCard.style.display = 'block';
    log(`Scanned ${products.length} products ready for sync.`);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Confirm Sync to RestPro
  btnConfirmSync.addEventListener('click', async () => {
    if (scannedProducts.length === 0) return;

    const backendUrl = backendUrlInput.value.trim();
    const restaurantId = restaurantIdInput.value.trim();
    const syncKey = syncKeyInput.value.trim();
    const syncMode = syncModeInput.value;

    if (!backendUrl || !restaurantId || !syncKey) {
      alert('Please configure Backend URL, Restaurant ID, and Sync Key first.');
      return;
    }

    btnConfirmSync.disabled = true;
    btnConfirmSync.textContent = 'Syncing to RestPro...';
    log(`Synchronizing ${scannedProducts.length} items to RestPro (${syncMode} mode)...`);

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
          products: scannedProducts,
          mode: syncMode,
          syncSource: 'BROWSER_COMPANION_POPUP'
        })
      });

      const data = await res.json();
      if (res.ok) {
        log(`✅ Success! Synced ${data.syncedCount} products. Total in RestPro catalogue: ${data.totalCatalogCount}`);
        alert(`Catalogue Synchronized Successfully!\n${data.syncedCount} items saved to RestPro.`);
      } else {
        log(`❌ Sync failed: ${data.error || res.statusText}`);
        alert(`Sync Failed: ${data.error || res.statusText}`);
      }
    } catch (err) {
      log(`❌ Network error: ${err.message}`);
      alert(`Sync Network Error: ${err.message}`);
    } finally {
      btnConfirmSync.disabled = false;
      btnConfirmSync.textContent = 'Sync These Products to RestPro';
    }
  });
});
