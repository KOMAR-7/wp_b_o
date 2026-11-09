/**
 * RESTOPRO — Super Admin Portal Client Application
 * Clean, lightweight, dependency-free vanilla JavaScript controller.
 */

(function () {
  'use strict';

  // Application State
  const state = {
    user: null,
    token: null,
    currentTab: 'dashboard',
    restaurants: { page: 1, limit: 10, search: '', status: '' },
    subscriptions: { page: 1, limit: 10, search: '', status: '', restaurant_id: '' },
    payments: { page: 1, limit: 10, status: '', payment_mode: '', restaurant_id: '' },
    auditLogs: { page: 1, limit: 20, action: '', entity_type: '' },
    centralAccounts: { search: '', status: '', items: [], currentManagingAccountId: null }
  };

  // =========================================================================
  // UTILITY FUNCTIONS
  // =========================================================================

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatCurrency(amount, currency = 'INR') {
    const val = Number(amount) || 0;
    return '₹' + val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  /**
   * Universal API Client wrapper with credentials and CSRF defense headers.
   */
  async function apiCall(endpoint, options = {}) {
    const opts = {
      ...options,
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest', // CSRF defense
        ...(options.headers || {})
      }
    };

    // In-memory token fallback for active tab API calls if available
    if (state.token) {
      opts.headers['Authorization'] = `Bearer ${state.token}`;
      opts.headers['X-Admin-Token'] = state.token;
    }

    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }

    try {
      const res = await fetch(endpoint, opts);
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        // Session invalid or expired -> force login
        if (state.user) {
          showToast('Session expired. Please log in again.', 'error');
        }
        state.user = null;
        state.token = null;
        try { sessionStorage.removeItem('admin_token'); } catch (_) {}
        showView('login');
        throw new Error(data.error || 'Authentication required');
      }

      if (!res.ok) {
        throw new Error(data.error || `Request failed with HTTP ${res.status}`);
      }

      return data;
    } catch (err) {
      throw err;
    }
  }

  function showView(viewName) {
    const loginView = document.getElementById('login-view');
    const appView = document.getElementById('app-view');

    if (viewName === 'login') {
      loginView.style.display = 'flex';
      appView.style.display = 'none';
    } else {
      loginView.style.display = 'none';
      appView.style.display = 'flex';
    }
  }

  function switchTab(tabName) {
    state.currentTab = tabName;

    // Update nav links
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((link) => {
      if (link.dataset.tab === tabName) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });

    // Update tab panes
    document.querySelectorAll('.tab-pane').forEach((pane) => {
      if (pane.id === `tab-${tabName}`) {
        pane.classList.add('active');
      } else {
        pane.classList.remove('active');
      }
    });

    // Update page heading
    const heading = document.getElementById('page-heading');
    const titles = {
      dashboard: 'Dashboard Overview',
      restaurants: 'Restaurant Tenants',
      'central-accounts': 'Central WhatsApp Accounts',
      subscriptions: 'Client Subscriptions',
      payments: 'Manual Payment Records',
      'audit-logs': 'System Audit Logs',
      system: 'Database & System Diagnostics'
    };
    if (heading) heading.textContent = titles[tabName] || 'Dashboard';

    // Load active tab data
    if (tabName === 'dashboard') loadDashboard();
    else if (tabName === 'restaurants') loadRestaurants();
    else if (tabName === 'central-accounts') loadCentralAccounts();
    else if (tabName === 'subscriptions') loadSubscriptions();
    else if (tabName === 'payments') loadPayments();
    else if (tabName === 'audit-logs') loadAuditLogs();
    else if (tabName === 'system') loadSystemDiagnostics();
  }

  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'flex';
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
  }

  // =========================================================================
  // AUTHENTICATION FLOW
  // =========================================================================

  async function checkAuth() {
    try {
      const data = await apiCall('/api/admin/auth/me');
      if (data && data.admin) {
        state.user = data.admin;
        document.getElementById('header-admin-name').textContent = data.admin.name;
        document.getElementById('header-admin-email').textContent = data.admin.email;
        showView('app');

        const initialHash = window.location.hash.replace('#', '') || 'dashboard';
        switchTab(initialHash);
      }
    } catch (_) {
      state.user = null;
      state.token = null;
      try { sessionStorage.removeItem('admin_token'); } catch (_) {}
      showView('login');
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errorAlert = document.getElementById('login-error-alert');
    const submitBtn = document.getElementById('login-submit-btn');

    errorAlert.style.display = 'none';
    submitBtn.disabled = true;

    try {
      const res = await apiCall('/api/admin/auth/login', {
        method: 'POST',
        body: { email, password }
      });

      if (res && res.success) {
        state.user = res.admin;
        state.token = res.token || null;
        // Purge any storage token to ensure strict reliance on HttpOnly, SameSite cookies
        try { sessionStorage.removeItem('admin_token'); } catch (_) {}
        document.getElementById('header-admin-name').textContent = res.admin.name;
        document.getElementById('header-admin-email').textContent = res.admin.email;
        showView('app');
        switchTab('dashboard');
        showToast(`Welcome back, ${res.admin.name}!`, 'success');
      }
    } catch (err) {
      errorAlert.textContent = err.message || 'Invalid credentials';
      errorAlert.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function handleLogout() {
    try {
      await apiCall('/api/admin/auth/logout', { method: 'POST' });
    } catch (_) {
      // Continue cleanup on client
    }
    state.user = null;
    state.token = null;
    try { sessionStorage.removeItem('admin_token'); } catch (_) {}
    showView('login');
    showToast('Logged out successfully', 'info');
  }

  // =========================================================================
  // TAB 1: DASHBOARD
  // =========================================================================

  async function loadDashboard() {
    try {
      const [stats, activity] = await Promise.all([
        apiCall('/api/admin/dashboard/stats'),
        apiCall('/api/admin/dashboard/activity?limit=10')
      ]);

      // Metrics
      document.getElementById('stat-total-restaurants').textContent = stats.restaurants.total;
      document.getElementById('stat-active-restaurants').textContent = `${stats.restaurants.active} Active`;
      document.getElementById('stat-suspended-restaurants').textContent = `${stats.restaurants.suspended} Suspended`;

      document.getElementById('stat-active-subs').textContent = stats.subscriptions.active;
      document.getElementById('stat-expiring-soon').textContent = `${stats.subscriptions.expiring_soon} Expiring ≤30d`;

      document.getElementById('stat-total-payments').textContent = formatCurrency(stats.financials.total_recorded_payments);
      document.getElementById('stat-payments-count').textContent = `${stats.financials.recorded_payment_count} entries recorded`;

      document.getElementById('stat-outstanding-balance').textContent = formatCurrency(stats.financials.total_outstanding_balance);
      document.getElementById('stat-reversed-payments').textContent = `${formatCurrency(stats.financials.total_reversed_payments)} Reversed`;

      // Activity Table
      const tbody = document.getElementById('activity-table-body');
      if (activity.activities && activity.activities.length > 0) {
        tbody.innerHTML = activity.activities.map((a) => `
          <tr>
            <td class="text-muted">${formatDateTime(a.created_at)}</td>
            <td><span class="badge badge-info">${escapeHtml(a.action)}</span></td>
            <td><strong>${escapeHtml(a.entity_type)}</strong></td>
            <td><code>${escapeHtml((a.entity_id || '-').substring(0, 18))}</code></td>
            <td>${escapeHtml(a.admin ? a.admin.name : 'System')}</td>
            <td>
              <button class="btn btn-outline btn-sm view-audit-btn" data-json='${escapeHtml(JSON.stringify(a.metadata || {}))}'>View</button>
            </td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No recent activity recorded</td></tr>';
      }
    } catch (err) {
      showToast(`Failed to load dashboard: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // TAB 2: RESTAURANTS
  // =========================================================================

  async function loadRestaurants() {
    const { page, limit, search, status } = state.restaurants;
    const tbody = document.getElementById('restaurants-table-body');
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Loading restaurants...</td></tr>';

    try {
      const q = new URLSearchParams({
        page,
        limit,
        ...(search ? { search } : {}),
        ...(status ? { status } : {})
      });

      const data = await apiCall(`/api/admin/restaurants?${q.toString()}`);

      if (data.restaurants && data.restaurants.length > 0) {
        tbody.innerHTML = data.restaurants.map((r) => {
          const subInfo = r.current_subscription
            ? `<span class="badge badge-success">${escapeHtml(r.current_subscription.plan_name)}</span>`
            : '<span class="text-muted">No active plan</span>';

          const statusBadgeClass = {
            ACTIVE: 'badge-success',
            SUSPENDED: 'badge-danger',
            ONBOARDING: 'badge-warning',
            OFFBOARDED: 'badge-secondary'
          }[r.tenant_status] || 'badge-secondary';

          let waBadge = '';
          if (r.whatsapp_status === 'REQUIRES_REAUTH') {
            waBadge = `<div style="margin-top: 4px;"><span class="badge badge-danger">⚠️ 401 Re-Auth Required</span></div>`;
          } else if (r.whatsapp_status === 'BLOCKED_TEMPLATE_NOT_CONFIGURED') {
            waBadge = `<div style="margin-top: 4px;"><span class="badge badge-warning">⚠️ Template Not Configured</span></div>`;
          } else if (r.whatsapp_status === 'NOT_CONFIGURED') {
            waBadge = `<div style="margin-top: 4px;"><span class="badge badge-secondary">WA Not Configured</span></div>`;
          } else {
            waBadge = `<div style="margin-top: 4px;"><span class="badge badge-success">WA Connected</span></div>`;
          }

          const retryBtn = (r.failed_outbox_count > 0)
            ? `<button class="btn btn-warning btn-sm res-retry-btn" data-id="${r.id}" data-name="${escapeHtml(r.name)}" title="Retry ${r.failed_outbox_count} failed outbox messages">Retry (${r.failed_outbox_count})</button>`
            : '';

          return `
            <tr>
              <td>
                <div class="font-bold">${escapeHtml(r.name)}</div>
                <div class="small text-muted">${escapeHtml(r.owner_name || 'Owner')} • ${escapeHtml(r.owner_phone)}</div>
                ${waBadge}
              </td>
              <td>${escapeHtml(r.owner_name || '-')}</td>
              <td><code>${escapeHtml(r.phone_number_id)}</code></td>
              <td><code>${escapeHtml(r.waba_id)}</code></td>
              <td><span class="badge ${statusBadgeClass}">${escapeHtml(r.tenant_status)}</span></td>
              <td>
                ${r.is_active ? '<span class="badge badge-success">Online</span>' : '<span class="badge badge-danger">Dropped</span>'}
              </td>
              <td>${subInfo}</td>
              <td>
                <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                  <button class="btn btn-outline btn-sm res-view-btn" data-id="${r.id}">View</button>
                  <button class="btn btn-outline btn-sm res-edit-btn" data-id="${r.id}">Edit</button>
                  <button class="btn btn-outline btn-sm res-status-btn" data-id="${r.id}" data-name="${escapeHtml(r.name)}" data-status="${r.tenant_status}">Status</button>
                  ${retryBtn}
                </div>
              </td>
            </tr>
          `;
        }).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No restaurants match criteria</td></tr>';
      }

      renderPagination('restaurants-pagination', data.pagination, (newPage) => {
        state.restaurants.page = newPage;
        loadRestaurants();
      });
    } catch (err) {
      showToast(`Failed to load restaurants: ${err.message}`, 'error');
    }
  }

  async function handleViewRestaurant(id) {
    try {
      const data = await apiCall(`/api/admin/restaurants/${id}`);
      const r = data.restaurant;

      document.getElementById('view-res-title').textContent = r.name;
      document.getElementById('view-res-owner').textContent = r.owner_name || '-';
      document.getElementById('view-res-phone').textContent = r.owner_phone;
      document.getElementById('view-res-email').textContent = r.email || '-';
      document.getElementById('view-res-contact').textContent = r.contact_number || '-';
      document.getElementById('view-res-phoneid').textContent = r.phone_number_id;
      document.getElementById('view-res-wabaid').textContent = r.waba_id;
      document.getElementById('view-res-status').textContent = r.tenant_status;
      document.getElementById('view-res-active').textContent = r.is_active ? 'ENABLED (Receives Webhooks)' : 'DISABLED (Incoming Webhooks Dropped)';
      document.getElementById('view-res-address').textContent = r.address || 'None entered';
      document.getElementById('view-res-notes').textContent = r.internal_notes || 'None';

      const waStatusEl = document.getElementById('view-res-whatsapp-status');
      if (waStatusEl) {
        if (r.whatsapp_status === 'REQUIRES_REAUTH') {
          waStatusEl.innerHTML = '<span class="badge badge-danger">⚠️ 401 Re-Auth Required</span>';
        } else if (r.whatsapp_status === 'BLOCKED_TEMPLATE_NOT_CONFIGURED') {
          waStatusEl.innerHTML = '<span class="badge badge-warning">⚠️ Template Not Configured</span>';
        } else if (r.whatsapp_status === 'NOT_CONFIGURED') {
          waStatusEl.innerHTML = '<span class="badge badge-secondary">Not Configured</span>';
        } else {
          waStatusEl.innerHTML = '<span class="badge badge-success">Healthy</span>';
        }
      }

      const consentEl = document.getElementById('view-res-consent');
      if (consentEl) {
        if (r.owner_consent && r.owner_consent.optedIn && !r.owner_consent.revoked) {
          consentEl.innerHTML = `<span class="badge badge-success">✅ Consented (${escapeHtml(r.owner_consent.source || 'VERIFIED')})</span>`;
        } else if (r.owner_consent && r.owner_consent.revoked) {
          consentEl.innerHTML = `<span class="badge badge-danger">❌ Revoked (${escapeHtml(r.owner_consent.revokedReason || 'Admin')})</span>`;
        } else {
          consentEl.innerHTML = '<span class="badge badge-secondary">⚠️ Not Consented</span>';
        }
      }

      const outboxAlert = document.getElementById('view-res-outbox-alert');
      const retryModalBtn = document.getElementById('view-res-retry-outbox-btn');
      if (outboxAlert && retryModalBtn) {
        if (r.failed_outbox_count > 0) {
          outboxAlert.style.display = 'block';
          document.getElementById('view-res-outbox-msg').textContent = `${r.failed_outbox_count} failed outbox message(s) detected.`;
          retryModalBtn.onclick = async () => {
            try {
              const res = await apiCall(`/api/admin/restaurants/${r.id}/retry-outbox`, { method: 'POST' });
              showToast(res.message || 'Failed messages reset for retry', 'success');
              outboxAlert.style.display = 'none';
              loadRestaurants();
            } catch (err) {
              showToast(`Retry failed: ${err.message}`, 'error');
            }
          };
        } else {
          outboxAlert.style.display = 'none';
        }
      }

      document.getElementById('view-res-total-paid').textContent = formatCurrency(r.total_recorded_payments);
      document.getElementById('view-res-balance').textContent = formatCurrency(r.outstanding_balance);
      document.getElementById('view-res-current-sub').textContent = r.current_subscription ? `${r.current_subscription.plan_name} (${r.current_subscription.status})` : 'No active plan';

      // Subscriptions table
      const subsBody = document.getElementById('view-res-subs-body');
      if (r.subscriptions && r.subscriptions.length > 0) {
        subsBody.innerHTML = r.subscriptions.map((s) => `
          <tr>
            <td>${escapeHtml(s.plan_name)}</td>
            <td>${formatCurrency(s.amount)}</td>
            <td>${formatDate(s.start_date)}</td>
            <td>${formatDate(s.end_date)}</td>
            <td><span class="badge ${s.status === 'ACTIVE' ? 'badge-success' : 'badge-secondary'}">${s.status}</span></td>
          </tr>
        `).join('');
      } else {
        subsBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No subscriptions on record</td></tr>';
      }

      // Payments table
      const payBody = document.getElementById('view-res-payments-body');
      if (r.payments && r.payments.length > 0) {
        payBody.innerHTML = r.payments.map((p) => `
          <tr>
            <td>${formatDate(p.payment_date)}</td>
            <td>${formatCurrency(p.amount)}</td>
            <td>${escapeHtml(p.payment_mode)}</td>
            <td><code>${escapeHtml(p.transaction_reference || '-')}</code></td>
            <td><span class="badge ${p.status === 'RECORDED' ? 'badge-success' : 'badge-danger'}">${p.status}</span></td>
          </tr>
        `).join('');
      } else {
        payBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No payments on record</td></tr>';
      }

      openModal('modal-view-restaurant');
    } catch (err) {
      showToast(`Failed to load restaurant profile: ${err.message}`, 'error');
    }
  }

  async function handleEditRestaurant(id) {
    try {
      const data = await apiCall(`/api/admin/restaurants/${id}`);
      const r = data.restaurant;

      document.getElementById('edit-res-id').value = r.id;
      document.getElementById('edit-res-name').value = r.name;
      document.getElementById('edit-res-owner').value = r.owner_name || '';
      document.getElementById('edit-res-phone').value = r.owner_phone;
      document.getElementById('edit-res-email').value = r.email || '';
      document.getElementById('edit-res-contact').value = r.contact_number || '';
      document.getElementById('edit-res-address').value = r.address || '';
      document.getElementById('edit-res-phoneid').value = r.phone_number_id;
      document.getElementById('edit-res-wabaid').value = r.waba_id;
      document.getElementById('edit-res-notes').value = r.internal_notes || '';
      const tokenInput = document.getElementById('edit-res-token');
      if (tokenInput) tokenInput.value = '';

      const consentCheckbox = document.getElementById('edit-res-consent');
      if (consentCheckbox) {
        consentCheckbox.checked = Boolean(r.owner_consent && r.owner_consent.optedIn && !r.owner_consent.revoked);
      }

      openModal('modal-edit-restaurant');
    } catch (err) {
      showToast(`Failed to fetch restaurant for editing: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // TAB 3: SUBSCRIPTIONS
  // =========================================================================

  async function loadSubscriptions() {
    const { page, limit, search, status } = state.subscriptions;
    const tbody = document.getElementById('subscriptions-table-body');
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">Loading subscriptions...</td></tr>';

    try {
      const q = new URLSearchParams({
        page,
        limit,
        ...(search ? { search } : {}),
        ...(status ? { status } : {})
      });

      const data = await apiCall(`/api/admin/subscriptions?${q.toString()}`);

      if (data.subscriptions && data.subscriptions.length > 0) {
        tbody.innerHTML = data.subscriptions.map((s) => {
          const statusBadge = {
            ACTIVE: 'badge-success',
            PENDING: 'badge-warning',
            EXPIRED: 'badge-secondary',
            CANCELLED: 'badge-danger'
          }[s.status] || 'badge-secondary';

          return `
            <tr>
              <td>
                <div class="font-bold">${escapeHtml(s.restaurant ? s.restaurant.name : 'Unknown')}</div>
                <div class="small text-muted">${escapeHtml(s.restaurant ? s.restaurant.phone_number_id : '')}</div>
              </td>
              <td>${escapeHtml(s.plan_name)}</td>
              <td><strong>${formatCurrency(s.amount)}</strong></td>
              <td class="small">${formatDate(s.start_date)} — ${formatDate(s.end_date)}</td>
              <td>
                ${s.remaining_days > 0 ? `${s.remaining_days} days` : '<span class="text-muted">Expired</span>'}
              </td>
              <td><span class="badge ${statusBadge}">${s.status}</span></td>
              <td class="text-emerald">${formatCurrency(s.total_paid)}</td>
              <td class="${s.outstanding_balance > 0 ? 'text-amber' : 'text-muted'}">${formatCurrency(s.outstanding_balance)}</td>
              <td>
                <button class="btn btn-outline btn-sm sub-status-toggle" data-id="${s.id}" data-status="${s.status}">Toggle Status</button>
              </td>
            </tr>
          `;
        }).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No subscriptions found</td></tr>';
      }

      renderPagination('subscriptions-pagination', data.pagination, (newPage) => {
        state.subscriptions.page = newPage;
        loadSubscriptions();
      });
    } catch (err) {
      showToast(`Failed to load subscriptions: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // TAB 4: PAYMENTS
  // =========================================================================

  async function loadPayments() {
    const { page, limit, status, payment_mode } = state.payments;
    const tbody = document.getElementById('payments-table-body');
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">Loading payments...</td></tr>';

    try {
      const q = new URLSearchParams({
        page,
        limit,
        ...(status ? { status } : {}),
        ...(payment_mode ? { payment_mode } : {})
      });

      const data = await apiCall(`/api/admin/payments?${q.toString()}`);

      if (data.payments && data.payments.length > 0) {
        tbody.innerHTML = data.payments.map((p) => {
          const isReversed = p.status === 'REVERSED';
          const canReverse = !isReversed && p.original_payment_id === null;

          return `
            <tr>
              <td>${formatDate(p.payment_date)}</td>
              <td>
                <div class="font-bold">${escapeHtml(p.restaurant ? p.restaurant.name : 'Unknown')}</div>
              </td>
              <td>${escapeHtml(p.subscription ? p.subscription.plan_name : 'Standalone / General')}</td>
              <td><strong>${formatCurrency(p.amount)}</strong></td>
              <td><span class="badge badge-secondary">${escapeHtml(p.payment_mode)}</span></td>
              <td><code>${escapeHtml(p.transaction_reference || '-')}</code></td>
              <td>
                <span class="badge ${isReversed ? 'badge-danger' : 'badge-success'}">${p.status}</span>
              </td>
              <td>${escapeHtml(p.recorded_by ? p.recorded_by.name : 'System')}</td>
              <td>
                ${canReverse ? `
                  <button class="btn btn-danger btn-sm pay-reverse-btn" data-id="${p.id}" data-ref="${escapeHtml(p.transaction_reference || p.id.slice(0, 8))}" data-amt="${formatCurrency(p.amount)}">Reverse</button>
                ` : (isReversed ? '<span class="text-muted small">Reversed</span>' : '-')}
              </td>
            </tr>
          `;
        }).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No payments recorded</td></tr>';
      }

      renderPagination('payments-pagination', data.pagination, (newPage) => {
        state.payments.page = newPage;
        loadPayments();
      });
    } catch (err) {
      showToast(`Failed to load payments: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // TAB 5: AUDIT LOGS
  // =========================================================================

  async function loadAuditLogs() {
    const { page, limit, action, entity_type } = state.auditLogs;
    const tbody = document.getElementById('audit-logs-table-body');
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Loading audit logs...</td></tr>';

    try {
      const q = new URLSearchParams({
        page,
        limit,
        ...(action ? { action } : {}),
        ...(entity_type ? { entity_type } : {})
      });

      const data = await apiCall(`/api/admin/audit-logs?${q.toString()}`);

      if (data.audit_logs && data.audit_logs.length > 0) {
        tbody.innerHTML = data.audit_logs.map((log) => `
          <tr>
            <td class="text-muted">${formatDateTime(log.created_at)}</td>
            <td><span class="badge badge-info">${escapeHtml(log.action)}</span></td>
            <td><strong>${escapeHtml(log.entity_type)}</strong></td>
            <td><code>${escapeHtml((log.entity_id || '-').substring(0, 18))}</code></td>
            <td>${escapeHtml(log.admin_user ? log.admin_user.name : 'System')}</td>
            <td>
              <button class="btn btn-outline btn-sm view-audit-btn" data-json='${escapeHtml(JSON.stringify(log.metadata || {}))}'>Metadata</button>
            </td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No audit logs match criteria</td></tr>';
      }

      renderPagination('audit-logs-pagination', data.pagination, (newPage) => {
        state.auditLogs.page = newPage;
        loadAuditLogs();
      });
    } catch (err) {
      showToast(`Failed to load audit logs: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // TAB 6: SYSTEM & DATABASE DIAGNOSTICS
  // =========================================================================

  async function loadSystemDiagnostics() {
    try {
      const data = await apiCall('/api/admin/system/database');

      const isConnected = data.database.status === 'connected';
      const statusBadge = document.getElementById('sys-db-status');
      statusBadge.textContent = isConnected ? 'Connected' : 'Disconnected';
      statusBadge.className = isConnected ? 'badge badge-success' : 'badge badge-danger';

      document.getElementById('sys-db-latency').textContent = `${data.database.latency_ms} ms`;
      document.getElementById('sys-db-provider').textContent = `${data.database.provider} Database`;

      document.getElementById('sys-migrations-count').textContent = data.database.applied_migrations;
      document.getElementById('sys-node-version').textContent = data.system.node_version;

      const hours = Math.floor(data.system.uptime_seconds / 3600);
      const minutes = Math.floor((data.system.uptime_seconds % 3600) / 60);
      document.getElementById('sys-uptime').textContent = `${hours}h ${minutes}m`;
      document.getElementById('sys-memory').textContent = `RAM: ${data.system.memory_usage.rss_mb} MB (Heap: ${data.system.memory_usage.heap_used_mb} MB)`;

      // Render entity counts grid
      const container = document.getElementById('entity-counts-container');
      container.innerHTML = Object.entries(data.database.table_counts).map(([tableName, count]) => `
        <div class="entity-count-card">
          <div class="entity-count-label">${escapeHtml(tableName.replace(/_/g, ' '))}</div>
          <div class="entity-count-value">${count.toLocaleString()}</div>
        </div>
      `).join('');
    } catch (err) {
      showToast(`Failed to fetch system diagnostics: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // TAB 7: CENTRAL WHATSAPP ACCOUNTS
  // =========================================================================

  async function loadCentralAccounts() {
    try {
      const q = new URLSearchParams();
      if (state.centralAccounts.status) q.append('status', state.centralAccounts.status);
      if (state.centralAccounts.search) q.append('search', state.centralAccounts.search);

      const [accountsData, unassignedData] = await Promise.all([
        apiCall(`/api/admin/central-accounts?${q.toString()}`),
        apiCall('/api/admin/restaurants/unassigned-central-account').catch(() => ({ restaurants: [] }))
      ]);

      const accounts = accountsData.accounts || [];
      state.centralAccounts.items = accounts;

      // Update stat cards
      const totalAccounts = accounts.length;
      const activeAccounts = accounts.filter(a => a.is_active).length;
      const inactiveAccounts = totalAccounts - activeAccounts;
      const verifiedAccounts = accounts.filter(a => a.verification_status === 'CONNECTED').length;
      const unverifiedAccounts = totalAccounts - verifiedAccounts;
      const assignedCount = accounts.reduce((sum, a) => sum + (a.assigned_restaurants_count || 0), 0);
      const unassignedCount = (unassignedData.restaurants || []).length;

      const totalEl = document.getElementById('stat-central-total');
      if (totalEl) totalEl.textContent = totalAccounts;
      const activeEl = document.getElementById('stat-central-active');
      if (activeEl) activeEl.textContent = `${activeAccounts} Active`;
      const inactiveEl = document.getElementById('stat-central-inactive');
      if (inactiveEl) inactiveEl.textContent = `${inactiveAccounts} Inactive`;

      const verifiedEl = document.getElementById('stat-central-verified');
      if (verifiedEl) verifiedEl.textContent = verifiedAccounts;
      const unverifiedEl = document.getElementById('stat-central-unverified');
      if (unverifiedEl) unverifiedEl.textContent = `${unverifiedAccounts} Unverified`;

      const assignedEl = document.getElementById('stat-central-assigned-rests');
      if (assignedEl) assignedEl.textContent = assignedCount;
      const unassignedEl = document.getElementById('stat-central-unassigned-rests');
      if (unassignedEl) unassignedEl.textContent = `${unassignedCount} unassigned`;

      // Render table rows
      const tbody = document.getElementById('central-accounts-table-body');
      if (!tbody) return;

      if (accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No Central WhatsApp accounts found. Click "+ Add Central Account" to register one.</td></tr>';
        return;
      }

      tbody.innerHTML = accounts.map((a) => {
        let connBadge;
        if (a.verification_status === 'CONNECTED') {
          connBadge = '<span class="badge badge-success">Connected</span>';
        } else if (a.verification_status === 'DISCONNECTED') {
          connBadge = '<span class="badge badge-danger">Disconnected</span>';
        } else {
          connBadge = `<span class="badge badge-warning">${escapeHtml(a.verification_status || 'UNVERIFIED')}</span>`;
        }

        const activeBadge = a.is_active
          ? '<span class="badge badge-success">ACTIVE</span>'
          : '<span class="badge badge-secondary">INACTIVE</span>';

        return `
          <tr>
            <td>
              <strong>${escapeHtml(a.account_name)}</strong>
              ${a.description ? `<br><small class="text-muted">${escapeHtml(a.description)}</small>` : ''}
            </td>
            <td><code>${escapeHtml(a.display_phone_number || '-')}</code></td>
            <td><code>${escapeHtml(a.phone_number_id)}</code></td>
            <td><code>${escapeHtml(a.waba_id)}</code></td>
            <td>${connBadge}</td>
            <td>${activeBadge}</td>
            <td>
              <button class="btn btn-outline btn-xs central-manage-rests-btn" data-id="${a.id}" data-name="${escapeHtml(a.account_name)}">
                🏷️ ${a.assigned_restaurants_count || 0} Assigned
              </button>
            </td>
            <td class="text-muted small">${a.last_tested_at ? formatDateTime(a.last_tested_at) : 'Never'}</td>
            <td>
              <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                <button class="btn btn-outline btn-xs central-test-btn" data-id="${a.id}" title="Test Meta API Connection">⚡ Test</button>
                <button class="btn btn-outline btn-xs central-view-btn" data-id="${a.id}" title="View Details">👁️</button>
                <button class="btn btn-outline btn-xs central-edit-btn" data-id="${a.id}" title="Edit Account">✏️</button>
                <button class="btn ${a.is_active ? 'btn-warning' : 'btn-success'} btn-xs central-toggle-btn" data-id="${a.id}" data-active="${a.is_active}">
                  ${a.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button class="btn btn-danger btn-xs central-delete-btn" data-id="${a.id}" data-name="${escapeHtml(a.account_name)}" title="Delete Account">🗑️</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      showToast(`Failed to load Central WhatsApp accounts: ${err.message}`, 'error');
    }
  }

  async function handleViewCentralAccount(id) {
    try {
      const data = await apiCall(`/api/admin/central-accounts/${id}`);
      const a = data.account;
      const rests = data.restaurants || [];

      document.getElementById('view-central-name').textContent = a.account_name;
      document.getElementById('view-central-display').textContent = a.display_phone_number || '-';
      document.getElementById('view-central-phoneid').textContent = a.phone_number_id;
      document.getElementById('view-central-wabaid').textContent = a.waba_id;
      document.getElementById('view-central-status').textContent = a.is_active ? 'ACTIVE' : 'INACTIVE';
      document.getElementById('view-central-conn-status').textContent = a.verification_status;
      document.getElementById('view-central-tested').textContent = a.last_tested_at ? formatDateTime(a.last_tested_at) : 'Never';
      document.getElementById('view-central-count').textContent = `${rests.length} Assigned`;
      document.getElementById('view-central-desc').textContent = a.description || 'None';

      const alertEl = document.getElementById('view-central-error-alert');
      if (a.verification_error) {
        document.getElementById('view-central-error-msg').textContent = a.verification_error;
        alertEl.style.display = 'block';
      } else {
        alertEl.style.display = 'none';
      }

      const restsTbody = document.getElementById('view-central-rests-body');
      if (rests.length > 0) {
        restsTbody.innerHTML = rests.map(r => `
          <tr>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td><code>${escapeHtml(r.phone_number_id)}</code></td>
            <td>${escapeHtml(r.owner_name || '-')} (${escapeHtml(r.owner_phone || '-')})</td>
            <td><span class="badge ${r.is_active ? 'badge-success' : 'badge-secondary'}">${escapeHtml(r.tenant_status || (r.is_active ? 'ACTIVE' : 'INACTIVE'))}</span></td>
          </tr>
        `).join('');
      } else {
        restsTbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No restaurants currently assigned to this account</td></tr>';
      }

      openModal('modal-view-central-account');
    } catch (err) {
      showToast(`Failed to view account: ${err.message}`, 'error');
    }
  }

  async function handleEditCentralAccount(id) {
    try {
      const data = await apiCall(`/api/admin/central-accounts/${id}`);
      const a = data.account;

      document.getElementById('edit-central-id').value = a.id;
      document.getElementById('edit-central-name').value = a.account_name;
      document.getElementById('edit-central-display').value = a.display_phone_number || '';
      document.getElementById('edit-central-phoneid').value = a.phone_number_id;
      document.getElementById('edit-central-wabaid').value = a.waba_id;
      document.getElementById('edit-central-description').value = a.description || '';
      document.getElementById('edit-central-token').value = '';

      openModal('modal-edit-central-account');
    } catch (err) {
      showToast(`Failed to load account for editing: ${err.message}`, 'error');
    }
  }

  async function handleManageAssignments(accountId, accountName) {
    try {
      state.centralAccounts.currentManagingAccountId = accountId;
      document.getElementById('assign-modal-account-name').textContent = accountName;

      await refreshAssignmentsModal();
      openModal('modal-assign-central-restaurants');
    } catch (err) {
      showToast(`Failed to load assignments: ${err.message}`, 'error');
    }
  }

  async function refreshAssignmentsModal() {
    const accountId = state.centralAccounts.currentManagingAccountId;
    if (!accountId) return;

    const [assignedData, unassignedData] = await Promise.all([
      apiCall(`/api/admin/central-accounts/${accountId}/restaurants`),
      apiCall('/api/admin/restaurants/unassigned-central-account')
    ]);

    const assigned = assignedData.restaurants || [];
    const unassigned = unassignedData.restaurants || [];

    const dropdown = document.getElementById('assign-restaurant-dropdown');
    dropdown.innerHTML = '<option value="">Select unassigned restaurant...</option>' +
      unassigned.map(r => `<option value="${r.id}">${escapeHtml(r.name)} (${escapeHtml(r.phone_number_id)})</option>`).join('');

    const tbody = document.getElementById('assigned-restaurants-table-body');
    if (assigned.length > 0) {
      tbody.innerHTML = assigned.map(r => `
        <tr>
          <td><strong>${escapeHtml(r.name)}</strong></td>
          <td><code>${escapeHtml(r.phone_number_id)}</code></td>
          <td>${escapeHtml(r.owner_phone || '-')}</td>
          <td><span class="badge ${r.is_active ? 'badge-success' : 'badge-secondary'}">${escapeHtml(r.tenant_status || 'ACTIVE')}</span></td>
          <td>
            <button class="btn btn-outline btn-xs central-unassign-btn" data-id="${r.id}" data-name="${escapeHtml(r.name)}">
              Unassign
            </button>
          </td>
        </tr>
      `).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No restaurants currently assigned to this account</td></tr>';
    }
  }

  // =========================================================================
  // HELPER: RENDER PAGINATION
  // =========================================================================

  function renderPagination(elementId, pagination, onPageChange) {
    const container = document.getElementById(elementId);
    if (!container || !pagination) return;

    const { total, page, limit, totalPages } = pagination;
    const startItem = total === 0 ? 0 : (page - 1) * limit + 1;
    const endItem = Math.min(total, page * limit);

    container.innerHTML = `
      <div>Showing ${startItem} to ${endItem} of ${total} entries</div>
      <div style="display: flex; gap: 6px;">
        <button class="btn btn-outline btn-sm page-prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <span style="padding: 4px 8px; font-weight: 600;">Page ${page} of ${totalPages}</span>
        <button class="btn btn-outline btn-sm page-next" ${page >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    `;

    const prevBtn = container.querySelector('.page-prev');
    const nextBtn = container.querySelector('.page-next');

    if (prevBtn) prevBtn.addEventListener('click', () => onPageChange(page - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => onPageChange(page + 1));
  }

  // Populates restaurant select dropdowns for modals
  async function populateRestaurantDropdowns(selectElementIds) {
    try {
      const data = await apiCall('/api/admin/restaurants?limit=100');
      const optionsHtml = '<option value="">Select a restaurant...</option>' +
        data.restaurants.map((r) => `<option value="${r.id}">${escapeHtml(r.name)} (${escapeHtml(r.phone_number_id)})</option>`).join('');

      selectElementIds.forEach((id) => {
        const select = document.getElementById(id);
        if (select) select.innerHTML = optionsHtml;
      });
    } catch (_) {}
  }

  // Populates subscription dropdown when restaurant changes in payment modal
  async function populateRestaurantSubscriptions(restaurantId, subDropdownId) {
    const subDropdown = document.getElementById(subDropdownId);
    if (!subDropdown) return;

    if (!restaurantId) {
      subDropdown.innerHTML = '<option value="">Select subscription (or leave blank for standalone payment)...</option>';
      return;
    }

    try {
      const data = await apiCall(`/api/admin/subscriptions?restaurant_id=${restaurantId}&limit=50`);
      if (data.subscriptions && data.subscriptions.length > 0) {
        subDropdown.innerHTML = '<option value="">Standalone / Unlinked Payment</option>' +
          data.subscriptions.map((s) => `
            <option value="${s.id}">
              ${escapeHtml(s.plan_name)} (${formatCurrency(s.amount)} - ${s.status})
            </option>
          `).join('');
      } else {
        subDropdown.innerHTML = '<option value="">No subscriptions found for restaurant (Standalone Payment)</option>';
      }
    } catch (_) {
      subDropdown.innerHTML = '<option value="">Standalone / Unlinked Payment</option>';
    }
  }

  // =========================================================================
  // EVENT LISTENERS & INITIALIZATION
  // =========================================================================

  function setupEventListeners() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', handleLogin);

    // Password show/hide toggle
    document.getElementById('toggle-password-btn').addEventListener('click', () => {
      const input = document.getElementById('login-password');
      const btn = document.getElementById('toggle-password-btn');
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
      }
    });

    // Logout button
    document.getElementById('logout-btn').addEventListener('click', handleLogout);

    // Sidebar navigation
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = link.dataset.tab;
        window.location.hash = tab;
        switchTab(tab);
      });
    });

    // Hash change handler
    window.addEventListener('hashchange', () => {
      const tab = window.location.hash.replace('#', '') || 'dashboard';
      if (state.user) switchTab(tab);
    });

    // Refresh buttons
    document.getElementById('refresh-activity-btn').addEventListener('click', loadDashboard);
    document.getElementById('refresh-audit-logs-btn').addEventListener('click', loadAuditLogs);
    document.getElementById('refresh-system-btn').addEventListener('click', loadSystemDiagnostics);
    const refreshCentralBtn = document.getElementById('refresh-central-accounts-btn');
    if (refreshCentralBtn) refreshCentralBtn.addEventListener('click', loadCentralAccounts);

    // Generic modal close buttons
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeModal(btn.dataset.close);
      });
    });

    // Search & Filter listeners
    document.getElementById('restaurants-search-input').addEventListener('input', (e) => {
      state.restaurants.search = e.target.value;
      state.restaurants.page = 1;
      loadRestaurants();
    });

    document.getElementById('restaurants-status-filter').addEventListener('change', (e) => {
      state.restaurants.status = e.target.value;
      state.restaurants.page = 1;
      loadRestaurants();
    });

    document.getElementById('subscriptions-search-input').addEventListener('input', (e) => {
      state.subscriptions.search = e.target.value;
      state.subscriptions.page = 1;
      loadSubscriptions();
    });

    document.getElementById('subscriptions-status-filter').addEventListener('change', (e) => {
      state.subscriptions.status = e.target.value;
      state.subscriptions.page = 1;
      loadSubscriptions();
    });

    document.getElementById('payments-mode-filter').addEventListener('change', (e) => {
      state.payments.payment_mode = e.target.value;
      state.payments.page = 1;
      loadPayments();
    });

    document.getElementById('payments-status-filter').addEventListener('change', (e) => {
      state.payments.status = e.target.value;
      state.payments.page = 1;
      loadPayments();
    });

    document.getElementById('audit-action-filter').addEventListener('change', (e) => {
      state.auditLogs.action = e.target.value;
      state.auditLogs.page = 1;
      loadAuditLogs();
    });

    document.getElementById('audit-entity-filter').addEventListener('change', (e) => {
      state.auditLogs.entity_type = e.target.value;
      state.auditLogs.page = 1;
      loadAuditLogs();
    });

    // Central Accounts Search & Filter
    const centralSearch = document.getElementById('central-search-input');
    if (centralSearch) {
      centralSearch.addEventListener('input', (e) => {
        state.centralAccounts.search = e.target.value;
        loadCentralAccounts();
      });
    }

    const centralFilter = document.getElementById('central-status-filter');
    if (centralFilter) {
      centralFilter.addEventListener('change', (e) => {
        state.centralAccounts.status = e.target.value;
        loadCentralAccounts();
      });
    }

    // Modal Triggers
    const openCentralBtn = document.getElementById('open-create-central-account-btn');
    if (openCentralBtn) {
      openCentralBtn.addEventListener('click', () => {
        const form = document.getElementById('form-create-central-account');
        if (form) form.reset();
        openModal('modal-create-central-account');
      });
    }

    document.getElementById('open-create-restaurant-btn').addEventListener('click', () => {
      document.getElementById('form-create-restaurant').reset();
      openModal('modal-create-restaurant');
    });

    document.getElementById('open-create-sub-btn').addEventListener('click', () => {
      document.getElementById('form-create-subscription').reset();
      // Set default dates: 1 year from now
      const today = new Date().toISOString().split('T')[0];
      const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      document.getElementById('sub-start-date').value = today;
      document.getElementById('sub-end-date').value = nextYear;
      populateRestaurantDropdowns(['sub-res-dropdown']);
      openModal('modal-create-subscription');
    });

    document.getElementById('open-record-payment-btn').addEventListener('click', () => {
      document.getElementById('form-record-payment').reset();
      document.getElementById('payment-date-input').value = new Date().toISOString().split('T')[0];
      populateRestaurantDropdowns(['payment-res-dropdown']);
      openModal('modal-record-payment');
    });

    // When payment restaurant dropdown changes, load its subscriptions
    document.getElementById('payment-res-dropdown').addEventListener('change', (e) => {
      populateRestaurantSubscriptions(e.target.value, 'payment-sub-dropdown');
    });

    // Form Submissions
    document.getElementById('form-create-restaurant').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const payload = Object.fromEntries(formData.entries());
      payload.owner_consent_verified = document.getElementById('create-res-consent')
        ? document.getElementById('create-res-consent').checked
        : false;

      try {
        await apiCall('/api/admin/restaurants', {
          method: 'POST',
          body: payload
        });
        closeModal('modal-create-restaurant');
        showToast('Restaurant onboarded successfully!', 'success');
        loadRestaurants();
      } catch (err) {
        showToast(`Failed to onboard restaurant: ${err.message}`, 'error');
      }
    });

    document.getElementById('form-edit-restaurant').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('edit-res-id').value;
      const formData = new FormData(e.target);
      const payload = Object.fromEntries(formData.entries());
      payload.owner_consent_verified = document.getElementById('edit-res-consent')
        ? document.getElementById('edit-res-consent').checked
        : false;

      // If access_token empty or whitespace, remove so it is never sent or overwritten
      if (!payload.access_token || !payload.access_token.trim()) {
        delete payload.access_token;
      } else {
        payload.access_token = payload.access_token.trim();
      }

      try {
        await apiCall(`/api/admin/restaurants/${id}`, {
          method: 'PUT',
          body: payload
        });
        closeModal('modal-edit-restaurant');
        showToast('Restaurant profile updated successfully', 'success');
        loadRestaurants();
      } catch (err) {
        showToast(`Failed to update restaurant: ${err.message}`, 'error');
      }
    });

    document.getElementById('form-status-restaurant').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('status-res-id').value;
      const status = document.getElementById('status-res-select').value;

      try {
        await apiCall(`/api/admin/restaurants/${id}/status`, {
          method: 'PATCH',
          body: { status }
        });
        closeModal('modal-status-restaurant');
        showToast(`Restaurant status changed to ${status}`, 'success');
        loadRestaurants();
      } catch (err) {
        showToast(`Failed to update status: ${err.message}`, 'error');
      }
    });

    document.getElementById('form-create-subscription').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const payload = Object.fromEntries(formData.entries());

      try {
        await apiCall('/api/admin/subscriptions', {
          method: 'POST',
          body: payload
        });
        closeModal('modal-create-subscription');
        showToast('Subscription created successfully!', 'success');
        loadSubscriptions();
      } catch (err) {
        showToast(`Failed to create subscription: ${err.message}`, 'error');
      }
    });

    document.getElementById('form-record-payment').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const payload = Object.fromEntries(formData.entries());

      try {
        await apiCall('/api/admin/payments', {
          method: 'POST',
          body: payload
        });
        closeModal('modal-record-payment');
        showToast('Offline payment recorded successfully!', 'success');
        loadPayments();
      } catch (err) {
        showToast(`Failed to record payment: ${err.message}`, 'error');
      }
    });

    document.getElementById('form-reverse-payment').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('reverse-payment-id').value;
      const reason = document.getElementById('reverse-payment-reason').value;

      try {
        await apiCall(`/api/admin/payments/${id}/reverse`, {
          method: 'PATCH',
          body: { reason }
        });
        closeModal('modal-reverse-payment');
        showToast('Payment reversed successfully', 'success');
        loadPayments();
      } catch (err) {
        showToast(`Failed to reverse payment: ${err.message}`, 'error');
      }
    });

    // Central Accounts Form Submissions
    const formCreateCentral = document.getElementById('form-create-central-account');
    if (formCreateCentral) {
      formCreateCentral.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('create-central-submit-btn') || formCreateCentral.querySelector('button[type="submit"]');

        const formData = new FormData(e.target);
        const raw = Object.fromEntries(formData.entries());

        const nameInput = document.getElementById('create-central-name');
        const displayInput = document.getElementById('create-central-display');
        const phoneInput = document.getElementById('create-central-phoneid');
        const wabaInput = document.getElementById('create-central-wabaid');
        const tokenInput = document.getElementById('create-central-token');
        const descInput = document.getElementById('create-central-description');
        const activeInput = document.getElementById('create-central-active');

        const accountName = (nameInput ? nameInput.value : (raw.account_name || '')).trim();
        const displayPhoneNumber = (displayInput ? displayInput.value : (raw.display_phone_number || '')).trim() || null;
        const phoneNumberId = (phoneInput ? phoneInput.value : (raw.phone_number_id || '')).trim();
        const wabaId = (wabaInput ? wabaInput.value : (raw.waba_id || '')).trim();
        let accessToken = (tokenInput ? tokenInput.value : (raw.access_token || '')).trim();
        // Strip enclosing quotes if user accidentally pasted them
        accessToken = accessToken.replace(/^["']|["']$/g, '').trim();
        const description = (descInput ? descInput.value : (raw.description || '')).trim() || null;
        const isActive = activeInput ? activeInput.checked : (raw.is_active === 'true' || raw.is_active === true || raw.is_active === 'on');

        if (!accountName) {
          showToast('Account name is required', 'error');
          return;
        }
        if (!phoneNumberId) {
          showToast('Meta Phone Number ID is required', 'error');
          return;
        }
        if (!wabaId) {
          showToast('Meta WABA ID is required', 'error');
          return;
        }
        if (!accessToken) {
          showToast('System user access token is required', 'error');
          return;
        }
        if (!accessToken.startsWith('EAA') && !accessToken.startsWith('mock_')) {
          showToast('Invalid Meta token format: Access tokens must begin with "EAA"', 'error');
          return;
        }

        const payload = {
          accountName,
          account_name: accountName,
          displayPhoneNumber,
          display_phone_number: displayPhoneNumber,
          phoneNumberId,
          phone_number_id: phoneNumberId,
          wabaId,
          waba_id: wabaId,
          accessToken,
          access_token: accessToken,
          description,
          isActive,
          is_active: isActive
        };

        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Saving...';
        }

        try {
          await apiCall('/api/admin/central-accounts', {
            method: 'POST',
            body: payload
          });
          e.target.reset();
          closeModal('modal-create-central-account');
          showToast('Central WhatsApp account registered successfully!', 'success');
          await loadCentralAccounts();
        } catch (err) {
          showToast(`Failed to register account: ${err.message}`, 'error');
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save & Register';
          }
        }
      });
    }

    const formEditCentral = document.getElementById('form-edit-central-account');
    if (formEditCentral) {
      formEditCentral.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('edit-central-id').value;
        const payload = {
          accountName: document.getElementById('edit-central-name').value.trim(),
          displayPhoneNumber: document.getElementById('edit-central-display').value.trim() || null,
          phoneNumberId: document.getElementById('edit-central-phoneid').value.trim(),
          wabaId: document.getElementById('edit-central-wabaid').value.trim(),
          description: document.getElementById('edit-central-description').value.trim() || null
        };
        let token = document.getElementById('edit-central-token').value.trim();
        token = token.replace(/^["']|["']$/g, '').trim();
        if (token) {
          if (!token.startsWith('EAA') && !token.startsWith('mock_')) {
            showToast('Invalid Meta token format: Access tokens must begin with "EAA"', 'error');
            return;
          }
          payload.accessToken = token;
        }

        try {
          await apiCall(`/api/admin/central-accounts/${id}`, {
            method: 'PATCH',
            body: payload
          });
          closeModal('modal-edit-central-account');
          showToast('Central WhatsApp account updated successfully!', 'success');
          loadCentralAccounts();
        } catch (err) {
          showToast(`Failed to update account: ${err.message}`, 'error');
        }
      });
    }

    const formAssignRes = document.getElementById('form-assign-restaurant');
    if (formAssignRes) {
      formAssignRes.addEventListener('submit', async (e) => {
        e.preventDefault();
        const restaurantId = document.getElementById('assign-restaurant-dropdown').value;
        const centralAccountId = state.centralAccounts.currentManagingAccountId;
        if (!restaurantId || !centralAccountId) return;

        try {
          await apiCall(`/api/admin/restaurants/${restaurantId}/central-account`, {
            method: 'PUT',
            body: { centralAccountId }
          });
          showToast('Restaurant assigned successfully!', 'success');
          await refreshAssignmentsModal();
          loadCentralAccounts();
        } catch (err) {
          showToast(`Failed to assign restaurant: ${err.message}`, 'error');
        }
      });
    }

    const formDeleteCentral = document.getElementById('form-delete-central-account');
    if (formDeleteCentral) {
      formDeleteCentral.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('delete-central-id').value;

        try {
          const res = await apiCall(`/api/admin/central-accounts/${id}`, {
            method: 'DELETE'
          });
          closeModal('modal-delete-central-account');
          showToast(res.message || 'Account deleted successfully', 'success');
          loadCentralAccounts();
        } catch (err) {
          showToast(`Deletion failed: ${err.message}`, 'error');
        }
      });
    }

    // Delegated click handlers for dynamic table rows
    document.addEventListener('click', (e) => {
      // View Restaurant
      const viewResBtn = e.target.closest('.res-view-btn');
      if (viewResBtn) {
        handleViewRestaurant(viewResBtn.dataset.id);
        return;
      }

      // Edit Restaurant
      const editResBtn = e.target.closest('.res-edit-btn');
      if (editResBtn) {
        handleEditRestaurant(editResBtn.dataset.id);
        return;
      }

      // Status Restaurant
      const statusResBtn = e.target.closest('.res-status-btn');
      if (statusResBtn) {
        document.getElementById('status-res-id').value = statusResBtn.dataset.id;
        document.getElementById('status-res-name').textContent = statusResBtn.dataset.name;
        document.getElementById('status-res-select').value = statusResBtn.dataset.status;
        openModal('modal-status-restaurant');
        return;
      }

      // Retry Failed Outbox Messages
      const retryResBtn = e.target.closest('.res-retry-btn');
      if (retryResBtn) {
        const id = retryResBtn.dataset.id;
        const name = retryResBtn.dataset.name;
        if (confirm(`Retry all failed outbox messages for "${name}"?`)) {
          apiCall(`/api/admin/restaurants/${id}/retry-outbox`, { method: 'POST' })
            .then((res) => {
              showToast(res.message || 'Failed messages reset for retry', 'success');
              loadRestaurants();
            })
            .catch((err) => {
              showToast(`Retry failed: ${err.message}`, 'error');
            });
        }
        return;
      }

      // Reverse Payment
      const revPayBtn = e.target.closest('.pay-reverse-btn');
      if (revPayBtn) {
        document.getElementById('reverse-payment-id').value = revPayBtn.dataset.id;
        document.getElementById('reverse-payment-ref').textContent = revPayBtn.dataset.ref;
        document.getElementById('reverse-payment-amt').textContent = revPayBtn.dataset.amt;
        document.getElementById('reverse-payment-reason').value = '';
        openModal('modal-reverse-payment');
        return;
      }

      // Toggle Subscription Status
      const toggleSubBtn = e.target.closest('.sub-status-toggle');
      if (toggleSubBtn) {
        const id = toggleSubBtn.dataset.id;
        const current = toggleSubBtn.dataset.status;
        const nextStatus = current === 'ACTIVE' ? 'CANCELLED' : 'ACTIVE';
        if (confirm(`Change subscription status from ${current} to ${nextStatus}?`)) {
          apiCall(`/api/admin/subscriptions/${id}/status`, {
            method: 'PATCH',
            body: { status: nextStatus }
          }).then(() => {
            showToast(`Subscription status updated to ${nextStatus}`, 'success');
            loadSubscriptions();
          }).catch((err) => {
            showToast(`Failed to update status: ${err.message}`, 'error');
          });
        }
        return;
      }

      // View Audit Metadata
      const viewAuditBtn = e.target.closest('.view-audit-btn');
      if (viewAuditBtn) {
        try {
          const raw = JSON.parse(viewAuditBtn.dataset.json || '{}');
          document.getElementById('audit-meta-pre').textContent = JSON.stringify(raw, null, 2);
          openModal('modal-view-audit');
        } catch (_) {}
        return;
      }

      // View Central WhatsApp Account
      const viewCentralBtn = e.target.closest('.central-view-btn');
      if (viewCentralBtn) {
        handleViewCentralAccount(viewCentralBtn.dataset.id);
        return;
      }

      // Edit Central WhatsApp Account
      const editCentralBtn = e.target.closest('.central-edit-btn');
      if (editCentralBtn) {
        handleEditCentralAccount(editCentralBtn.dataset.id);
        return;
      }

      // Manage Assigned Restaurants
      const manageRestsBtn = e.target.closest('.central-manage-rests-btn');
      if (manageRestsBtn) {
        handleManageAssignments(manageRestsBtn.dataset.id, manageRestsBtn.dataset.name);
        return;
      }

      // Test Central Connection
      const testCentralBtn = e.target.closest('.central-test-btn');
      if (testCentralBtn) {
        const id = testCentralBtn.dataset.id;
        testCentralBtn.disabled = true;
        const originalText = testCentralBtn.innerHTML;
        testCentralBtn.textContent = '⏳ Testing...';

        apiCall(`/api/admin/central-accounts/${id}/test-connection`, { method: 'POST' })
          .then((res) => {
            if (res.verified) {
              showToast(`Connected! Meta Verified: ${res.verifiedName || 'Valid'} (Quality: ${res.qualityRating || 'GREEN'})`, 'success');
            } else {
              showToast(`Connection test failed: ${res.error}`, 'error');
            }
            loadCentralAccounts();
          })
          .catch((err) => {
            showToast(`Test error: ${err.message}`, 'error');
          })
          .finally(() => {
            testCentralBtn.disabled = false;
            testCentralBtn.innerHTML = originalText;
          });
        return;
      }

      // Activate / Deactivate Central Account
      const toggleCentralBtn = e.target.closest('.central-toggle-btn');
      if (toggleCentralBtn) {
        const id = toggleCentralBtn.dataset.id;
        const isActive = toggleCentralBtn.dataset.active === 'true';
        const action = isActive ? 'deactivate' : 'activate';

        apiCall(`/api/admin/central-accounts/${id}/${action}`, { method: 'POST' })
          .then((res) => {
            if (res.warning) {
              showToast(res.warning, 'warning');
            } else {
              showToast(`Central WhatsApp account ${isActive ? 'deactivated' : 'activated'} successfully`, 'success');
            }
            loadCentralAccounts();
          })
          .catch((err) => {
            showToast(`Action failed: ${err.message}`, 'error');
          });
        return;
      }

      // Delete Central Account
      const deleteCentralBtn = e.target.closest('.central-delete-btn');
      if (deleteCentralBtn) {
        document.getElementById('delete-central-id').value = deleteCentralBtn.dataset.id;
        document.getElementById('delete-central-name').textContent = deleteCentralBtn.dataset.name;
        openModal('modal-delete-central-account');
        return;
      }

      // Unassign Restaurant from Central Account
      const unassignBtn = e.target.closest('.central-unassign-btn');
      if (unassignBtn) {
        const resId = unassignBtn.dataset.id;
        const resName = unassignBtn.dataset.name;
        if (confirm(`Unassign "${resName}" from this Central WhatsApp account?`)) {
          apiCall(`/api/admin/restaurants/${resId}/central-account`, { method: 'DELETE' })
            .then(() => {
              showToast(`"${resName}" unassigned successfully`, 'success');
              refreshAssignmentsModal();
              loadCentralAccounts();
            })
            .catch((err) => {
              showToast(`Unassign failed: ${err.message}`, 'error');
            });
        }
        return;
      }
    });
  }

  // Initial Boot
  document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    checkAuth();
  });
})();

