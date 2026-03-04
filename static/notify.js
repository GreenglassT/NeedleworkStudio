/* ===== notify.js — toast + dialog system ===== */
/* Requires escHtml() from utils.js (loaded before this file). */
(function () {
    'use strict';

    var container = null;
    var ICONS = { success: '\u2713', error: '\u2717', info: '\u2139' };

    function ensureContainer() {
        if (container) return container;
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
        return container;
    }

    /**
     * toast(message, opts?)
     *   opts.type     — 'success' | 'error' | 'info'  (default 'info')
     *   opts.duration — ms before auto-dismiss          (default 3000, 0 = persistent)
     *   opts.actions  — [{label, onClick}] action buttons (auto-dismiss on click)
     */
    window.toast = function (message, opts) {
        opts = opts || {};
        var type = opts.type || 'info';
        var duration = opts.duration !== undefined ? opts.duration : 3000;

        var c = ensureContainer();
        var el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.innerHTML =
            '<span class="toast-icon">' + (ICONS[type] || '') + '</span>' +
            '<span class="toast-msg">' + escHtml(message) + '</span>';

        // Action buttons
        if (opts.actions && opts.actions.length) {
            var actWrap = document.createElement('div');
            actWrap.className = 'toast-actions';
            opts.actions.forEach(function(a) {
                var btn = document.createElement('button');
                btn.className = 'toast-action-btn';
                btn.textContent = a.label;
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    dismiss();
                    if (a.onClick) a.onClick();
                });
                actWrap.appendChild(btn);
            });
            el.appendChild(actWrap);
            el.style.cursor = 'default';
        } else {
            el.addEventListener('click', function () { dismiss(); });
        }

        c.appendChild(el);

        var timer = duration > 0 ? setTimeout(dismiss, duration) : null;

        function dismiss() {
            if (timer) clearTimeout(timer);
            if (!el.parentNode) return;
            el.classList.add('toast-out');
            setTimeout(function () { el.remove(); }, 220);
        }

        return el;
    };

    /**
     * confirmDialog(message, opts?)
     *   opts.confirmText — label for confirm button (default 'Confirm')
     *   opts.cancelText  — label for cancel button  (default 'Cancel')
     *   opts.danger      — if true, confirm button is red (default false)
     *
     * Returns Promise<boolean>
     */
    window.confirmDialog = function (message, opts) {
        opts = opts || {};
        var confirmText = opts.confirmText || 'Confirm';
        var cancelText  = opts.cancelText  || 'Cancel';
        var danger      = opts.danger || false;

        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'notify-overlay';

            var dialog = document.createElement('div');
            dialog.className = 'notify-dialog';
            dialog.setAttribute('role', 'alertdialog');

            var body = document.createElement('div');
            body.className = 'notify-dialog-body';
            body.textContent = message;

            var footer = document.createElement('div');
            footer.className = 'notify-dialog-footer';

            var cancelBtn = document.createElement('button');
            cancelBtn.className = 'notify-btn';
            cancelBtn.textContent = cancelText;

            var confirmBtn = document.createElement('button');
            confirmBtn.className = 'notify-btn' + (danger ? ' notify-btn-danger' : ' notify-btn-primary');
            confirmBtn.textContent = confirmText;

            footer.appendChild(cancelBtn);
            footer.appendChild(confirmBtn);
            dialog.appendChild(body);
            dialog.appendChild(footer);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            confirmBtn.focus();

            function close(result) {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                resolve(result);
            }

            cancelBtn.addEventListener('click', function () { close(false); });
            confirmBtn.addEventListener('click', function () { close(true); });
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) close(false);
            });

            function onKey(e) {
                if (e.key === 'Escape') close(false);
            }
            document.addEventListener('keydown', onKey);
        });
    };

    /**
     * alertDialog(message, opts?)
     *   opts.buttonText — label for OK button (default 'OK')
     *   opts.type       — 'error' | 'info'   (default 'info')
     *
     * Returns Promise<void>
     */
    window.alertDialog = function (message, opts) {
        opts = opts || {};
        var buttonText = opts.buttonText || 'OK';
        var type       = opts.type || 'info';

        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'notify-overlay';

            var dialog = document.createElement('div');
            dialog.className = 'notify-dialog';
            dialog.setAttribute('role', 'alert');

            var body = document.createElement('div');
            body.className = 'notify-dialog-body';
            body.textContent = message;

            var footer = document.createElement('div');
            footer.className = 'notify-dialog-footer';

            var btn = document.createElement('button');
            btn.className = 'notify-btn' + (type === 'error' ? ' notify-btn-danger' : ' notify-btn-primary');
            btn.textContent = buttonText;

            footer.appendChild(btn);
            dialog.appendChild(body);
            dialog.appendChild(footer);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            btn.focus();

            function close() {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                resolve();
            }

            btn.addEventListener('click', close);
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) close();
            });

            function onKey(e) {
                if (e.key === 'Escape' || e.key === 'Enter') close();
            }
            document.addEventListener('keydown', onKey);
        });
    };
})();
