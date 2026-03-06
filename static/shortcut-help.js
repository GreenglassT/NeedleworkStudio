/* ===== shortcut-help.js — Keyboard shortcut cheat sheet ===== */
/* Exposes: window.showShortcutHelp(isEditMode) */
(function () {
    'use strict';

    var VIEWER_SHORTCUTS = [
        { key: '?',      desc: 'Show this help' },
        { key: 'F',      desc: 'Toggle fullscreen / zen mode' },
        { key: 'M',      desc: 'Toggle stitch marking mode' },
        { key: 'Esc',    desc: 'Exit fullscreen · clear highlight · close search' },
        { key: 'Scroll', desc: 'Zoom in / out' },
        { key: 'Drag',   desc: 'Pan canvas' },
    ];

    var EDITOR_SHORTCUTS = [
        { key: 'H',          desc: 'Pan / hand' },
        { key: 'P',          desc: 'Full stitch (pencil)' },
        { key: 'E',          desc: 'Eraser' },
        { key: 'F',          desc: 'Flood fill' },
        { key: 'I',          desc: 'Eyedropper' },
        { key: 'L',          desc: 'Line' },
        { key: 'T',          desc: 'Rectangle' },
        { key: 'O',          desc: 'Ellipse' },
        { key: 'X',          desc: 'Text tool' },
        { key: 'R',          desc: 'Color replace' },
        { key: 'S',          desc: 'Selection' },
        { key: 'W',          desc: 'Full stitch (alias for P)' },
        { key: 'M',          desc: 'Cycle mirror mode' },
        { key: 'Space',      desc: 'Temporary pan (hold)' },
        { key: 'Ctrl+Z',     desc: 'Undo' },
        { key: 'Ctrl+Y',     desc: 'Redo' },
        { key: 'Ctrl+S',     desc: 'Save' },
        { key: 'Ctrl+\u21e7+R', desc: 'Resize canvas' },
        { key: 'Ctrl+\u21e7+I', desc: 'Insert / delete row or column' },
        { key: 'Ctrl+\u21e7+O', desc: 'Auto-outline' },
        { key: '[ / ]',     desc: 'Cycle brush size down / up' },
        { key: '1\u20137',   desc: 'Stitch: Half/Quarter/\u00be/Petite/Back/Knot/Bead' },
        { key: '`',          desc: 'Toggle half-stitch direction' },
        { key: 'Del',        desc: 'Clear selection' },
        { key: 'Ctrl+C',     desc: 'Copy selection (click to stamp)' },
        { key: 'Ctrl+X',     desc: 'Cut selection (click to place)' },
        { key: 'Esc',        desc: 'Cancel paste / draw / deselect' },
    ];

    function _buildRows(shortcuts) {
        return shortcuts.map(function (s) {
            return '<div class="ks-row">' +
                '<kbd class="ks-key">' + escHtml(s.key) + '</kbd>' +
                '<span class="ks-desc">' + escHtml(s.desc) + '</span>' +
                '</div>';
        }).join('');
    }

    /* Register the ? key globally — pages just include this script.
       Optional: call initShortcutHelp(editModeFn) to provide a callback
       that returns true when the editor is active (defaults to false). */
    var _editModeFn = function () { return false; };
    window.initShortcutHelp = function (editModeFn) {
        if (typeof editModeFn === 'function') _editModeFn = editModeFn;
    };

    document.addEventListener('keydown', function (e) {
        if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (document.querySelector('.notify-overlay')) return;
        var tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
        e.preventDefault();
        showShortcutHelp(_editModeFn());
    });

    window.showShortcutHelp = function (isEditMode) {
        if (document.getElementById('ks-overlay')) return;

        var overlay = document.createElement('div');
        overlay.className = 'ks-overlay notify-overlay';
        overlay.id = 'ks-overlay';

        var dialog = document.createElement('div');
        dialog.className = 'ks-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', 'Keyboard shortcuts');

        var title = isEditMode ? 'Editor Shortcuts' : 'Viewer Shortcuts';
        var rows  = isEditMode ? _buildRows(EDITOR_SHORTCUTS) : _buildRows(VIEWER_SHORTCUTS);

        dialog.innerHTML =
            '<div class="ks-header">' +
                '<h2 class="ks-title">' + escHtml(title) + '</h2>' +
                '<button class="ks-close" aria-label="Close">' +
                    '<i class="ti ti-x" aria-hidden="true"></i>' +
                '</button>' +
            '</div>' +
            '<div class="ks-body">' + rows + '</div>' +
            '<div class="ks-footer">' +
                '<span class="ks-hint">Press <kbd class="ks-key">?</kbd> or <kbd class="ks-key">Esc</kbd> to close</span>' +
            '</div>';

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        function close() {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
        }

        dialog.querySelector('.ks-close').addEventListener('click', close);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) close();
        });

        function onKey(e) {
            if (e.key === 'Escape' || e.key === '?') {
                e.preventDefault();
                e.stopPropagation();
                close();
            }
        }
        document.addEventListener('keydown', onKey);

        dialog.querySelector('.ks-close').focus();
    };
})();
