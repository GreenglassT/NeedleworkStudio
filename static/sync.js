/**
 * Sync UI — desktop mode only.
 * Handles: sync settings modal, pairing, manual sync, auto-sync on launch.
 */
(function () {
    'use strict';

    // ── State ───────────────────────────────────────────────────────
    let syncState = {
        paired: false,
        serverUrl: '',
        username: '',
        lastSyncAt: '',
        syncing: false,
    };

    // ── DOM refs (set on init) ──────────────────────────────────────
    let btnSync, overlay, modalBody, errorEl;

    // ── Init ────────────────────────────────────────────────────────
    function init() {
        btnSync = document.getElementById('sync-header-btn');
        if (!btnSync) return; // not in desktop mode

        overlay = document.getElementById('sync-overlay');
        errorEl = document.getElementById('sync-error');

        btnSync.addEventListener('click', openModal);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });

        // Load current config
        loadConfig().then(function () {
            // Auto-sync on launch if paired
            if (syncState.paired) {
                triggerSync(true);
            }
        });
    }

    // ── Load config from local Flask ────────────────────────────────
    async function loadConfig() {
        try {
            const resp = await fetch('/api/sync-config');
            if (!resp.ok) return;
            const data = await resp.json();
            syncState.paired = data.paired;
            syncState.serverUrl = data.server_url;
            syncState.username = data.username;
            syncState.lastSyncAt = data.last_sync_at;
            updateDot();
        } catch (e) {
            // ignore
        }
    }

    // ── Update status dot ──────────────────────────────────────────
    function updateDot() {
        const dot = btnSync.querySelector('.sync-dot');
        dot.className = 'sync-dot';
        if (syncState.syncing) {
            dot.classList.add('syncing');
            btnSync.classList.add('syncing');
        } else {
            btnSync.classList.remove('syncing');
            if (syncState.paired) dot.classList.add('paired');
        }
    }

    // ── Open / Close modal ─────────────────────────────────────────
    function openModal() {
        renderModal();
        overlay.hidden = false;
    }

    function closeModal() {
        overlay.hidden = true;
    }

    // ── Render modal content based on state ────────────────────────
    function renderModal() {
        modalBody = document.getElementById('sync-modal-body');
        const footer = document.getElementById('sync-modal-footer');
        errorEl = document.getElementById('sync-error');
        errorEl.textContent = '';

        if (syncState.paired) {
            // Paired view: status + sync now + unpair
            modalBody.innerHTML =
                '<div class="sync-status">' +
                    '<div class="sync-status-row"><span>Server</span><span class="val">' + escHtml(syncState.serverUrl) + '</span></div>' +
                    '<div class="sync-status-row"><span>User</span><span class="val">' + escHtml(syncState.username) + '</span></div>' +
                    '<div class="sync-status-row"><span>Last sync</span><span class="val" id="sync-last-time">' + (formatLocalTime(syncState.lastSyncAt) || 'Never') + '</span></div>' +
                '</div>' +
                '<div id="sync-results" class="sync-results"></div>';
            footer.innerHTML =
                '<button class="sync-btn-action danger" id="sync-unpair-btn">Unpair</button>' +
                '<button class="sync-btn-action primary" id="sync-now-btn">Sync Now</button>';
            document.getElementById('sync-unpair-btn').addEventListener('click', unpair);
            document.getElementById('sync-now-btn').addEventListener('click', function () { triggerSync(false); });
        } else {
            // Unpaired view: pairing form
            modalBody.innerHTML =
                '<div class="sync-field"><label for="sync-server-url">Server URL</label>' +
                '<input type="url" id="sync-server-url" placeholder="https://needlework.example.com" value="' + escAttr(syncState.serverUrl) + '"></div>' +
                '<div class="sync-field"><label for="sync-username">Username</label>' +
                '<input type="text" id="sync-username" placeholder="your username" value="' + escAttr(syncState.username) + '"></div>' +
                '<div class="sync-field"><label for="sync-password">Password</label>' +
                '<input type="password" id="sync-password" placeholder="your password"></div>';
            footer.innerHTML =
                '<button class="sync-btn-action" id="sync-cancel-btn">Cancel</button>' +
                '<button class="sync-btn-action primary" id="sync-pair-btn">Pair</button>';
            document.getElementById('sync-cancel-btn').addEventListener('click', closeModal);
            document.getElementById('sync-pair-btn').addEventListener('click', pair);
        }
    }

    // ── Pair with server ───────────────────────────────────────────
    async function pair() {
        const serverUrl = document.getElementById('sync-server-url').value.trim();
        const username = document.getElementById('sync-username').value.trim();
        const password = document.getElementById('sync-password').value;

        if (!serverUrl || !username || !password) {
            showError('All fields are required');
            return;
        }

        const btn = document.getElementById('sync-pair-btn');
        btn.disabled = true;
        btn.textContent = 'Pairing...';
        showError('');

        try {
            const resp = await fetch('/api/sync-config/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server_url: serverUrl, username: username, password: password }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                showError(data.error || 'Pairing failed');
                btn.disabled = false;
                btn.textContent = 'Pair';
                return;
            }
            syncState.paired = true;
            syncState.serverUrl = serverUrl;
            syncState.username = data.username || username;
            syncState.lastSyncAt = '';
            updateDot();
            renderModal();
            if (typeof Notify !== 'undefined') Notify.toast('Paired with server', 'success');
        } catch (e) {
            showError('Network error: ' + e.message);
            btn.disabled = false;
            btn.textContent = 'Pair';
        }
    }

    // ── Unpair ─────────────────────────────────────────────────────
    async function unpair() {
        const btn = document.getElementById('sync-unpair-btn');
        btn.disabled = true;
        btn.textContent = 'Unpairing...';

        try {
            await fetch('/api/sync-config/unpair', { method: 'POST' });
        } catch (e) {
            // best-effort
        }
        syncState.paired = false;
        syncState.serverUrl = '';
        syncState.username = '';
        syncState.lastSyncAt = '';
        updateDot();
        renderModal();
        if (typeof Notify !== 'undefined') Notify.toast('Unpaired from server', 'info');
    }

    // ── Trigger sync ───────────────────────────────────────────────
    async function triggerSync(silent) {
        if (syncState.syncing || !syncState.paired) return;
        syncState.syncing = true;
        updateDot();

        const nowBtn = document.getElementById('sync-now-btn');
        if (nowBtn) { nowBtn.disabled = true; nowBtn.textContent = 'Syncing...'; }

        try {
            const resp = await fetch('/api/sync-config/sync', { method: 'POST' });
            const data = await resp.json();

            if (!resp.ok || data.error) {
                const msg = data.error || 'Sync failed';
                if (!silent) {
                    showError(msg);
                    if (typeof Notify !== 'undefined') Notify.toast('Sync failed: ' + msg, 'error');
                }
                const dot = btnSync.querySelector('.sync-dot');
                dot.className = 'sync-dot error';
            } else {
                syncState.lastSyncAt = data.server_time || '';
                const lastEl = document.getElementById('sync-last-time');
                if (lastEl) lastEl.textContent = formatLocalTime(syncState.lastSyncAt) || 'Just now';

                // Show results
                showResults(data);
                if (!silent && typeof Notify !== 'undefined') Notify.toast('Sync complete', 'success');
            }
        } catch (e) {
            if (!silent) {
                showError('Network error: ' + e.message);
                if (typeof Notify !== 'undefined') Notify.toast('Sync failed', 'error');
            }
        } finally {
            syncState.syncing = false;
            updateDot();
            if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = 'Sync Now'; }
        }
    }

    // ── Show sync results ──────────────────────────────────────────
    function showResults(data) {
        const el = document.getElementById('sync-results');
        if (!el) return;

        const pull = data.pull || {};
        const push = data.push || {};
        const lines = [];

        const pp = (pull.patterns_pulled || 0);
        const pd = (pull.patterns_deleted || 0);
        const tp = (pull.threads_pulled || 0);
        const td = (pull.threads_deleted || 0);
        if (pp || pd || tp || td) {
            lines.push('Pulled: <span class="num">' + pp + '</span> patterns, <span class="num">' + tp + '</span> threads');
        }

        const pc = (push.patterns_created || 0);
        const pu = (push.patterns_updated || 0);
        const tc = (push.threads_created || 0);
        const tu = (push.threads_updated || 0);
        if (pc || pu || tc || tu) {
            lines.push('Pushed: <span class="num">' + (pc + pu) + '</span> patterns, <span class="num">' + (tc + tu) + '</span> threads');
        }

        if (lines.length === 0) lines.push('Everything is in sync');
        el.innerHTML = lines.join('<br>');
    }

    // ── Helpers ─────────────────────────────────────────────────────
    function showError(msg) {
        if (errorEl) errorEl.textContent = msg;
    }

    // ── Bootstrap ──────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
