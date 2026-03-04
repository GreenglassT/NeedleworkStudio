/* ===== dropdown.js — themed custom select replacement ===== */
/* Standalone IIFE. Loaded after tokens.css + dropdown.css.   */
(function () {
    'use strict';

    var _active = null; // currently open dropdown instance

    /* ——— PUBLIC API ——— */

    /**
     * Dropdown.init(selectEl, opts?)
     *   opts.variant    — 'default' | 'lg' | 'pill' | 'status'
     *   opts.fullWidth  — boolean (default false)
     *   opts.onClassUpdate(wrapperEl, value) — called after selection
     *
     * Returns instance { select, wrapper, trigger, menu, refresh(), destroy() }
     * Idempotent: returns existing instance if already wrapped.
     */

    /**
     * Dropdown.initAll(selector?, opts?)
     *   Upgrades all matching <select> elements.
     *   selector defaults to 'select.ctrl-select'
     */

    /**
     * Dropdown.closeAll()
     *   Closes any open dropdown.
     */

    window.Dropdown = { init: init, initAll: initAll, closeAll: closeAll };

    function init(selectEl, opts) {
        if (!selectEl || selectEl.tagName !== 'SELECT') return null;
        if (selectEl._dmcDropdown) return selectEl._dmcDropdown;

        opts = opts || {};
        var variant = opts.variant || 'default';
        var fullWidth = opts.fullWidth !== undefined ? opts.fullWidth : false;

        var inst = {
            select: selectEl,
            wrapper: null,
            trigger: null,
            menu: null,
            _opts: opts,
            _focusIdx: -1,
            refresh: null,
            destroy: null
        };

        _build(inst, variant, fullWidth);
        selectEl._dmcDropdown = inst;
        return inst;
    }

    function initAll(selector, opts) {
        selector = selector || 'select.ctrl-select';
        var results = [];
        document.querySelectorAll(selector).forEach(function (sel) {
            var inst = init(sel, opts);
            if (inst) results.push(inst);
        });
        return results;
    }

    function closeAll() {
        if (_active) _close(_active);
    }

    /* ——— BUILD ——— */
    function _build(inst, variant, fullWidth) {
        var sel = inst.select;
        var id = sel.id || ('dmc-dd-' + Math.random().toString(36).substr(2, 6));

        // Wrapper
        var wrap = document.createElement('div');
        wrap.className = 'dmc-dropdown'
            + (variant !== 'default' ? ' dmc-dropdown--' + variant : '')
            + (fullWidth ? ' dmc-dropdown--full' : '');

        sel.parentNode.insertBefore(wrap, sel);
        wrap.appendChild(sel);

        // Hide native select
        sel.style.display = 'none';
        sel.setAttribute('tabindex', '-1');
        sel.setAttribute('aria-hidden', 'true');

        // Trigger button
        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'dmc-dropdown-trigger';
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-controls', id + '--listbox');

        var label = document.createElement('span');
        label.className = 'dmc-dropdown-label';

        var arrow = document.createElement('span');
        arrow.className = 'dmc-dropdown-arrow';
        arrow.setAttribute('aria-hidden', 'true');

        trigger.appendChild(label);
        trigger.appendChild(arrow);
        wrap.appendChild(trigger);

        // Menu
        var menu = document.createElement('div');
        menu.className = 'dmc-dropdown-menu';
        menu.id = id + '--listbox';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('tabindex', '-1');
        wrap.appendChild(menu);

        inst.wrapper = wrap;
        inst.trigger = trigger;
        inst.menu = menu;
        inst._label = label;

        // Populate
        _syncOptions(inst);
        _syncLabel(inst);

        // Apply initial color class for status variant
        if (inst._opts.onClassUpdate) {
            inst._opts.onClassUpdate(wrap, sel.value);
        }

        // Observe dynamic option changes
        inst._observer = new MutationObserver(function () {
            _syncOptions(inst);
            _syncLabel(inst);
        });
        inst._observer.observe(sel, { childList: true, attributes: true, subtree: true });

        // Intercept programmatic .value = …
        _interceptValue(inst);

        // Events
        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            if (wrap.classList.contains('open')) _close(inst);
            else _open(inst);
        });

        trigger.addEventListener('keydown', function (e) {
            _handleKeydown(inst, e);
        });

        // Expose methods
        inst.refresh = function () {
            _syncOptions(inst);
            _syncLabel(inst);
            if (inst._opts.onClassUpdate) {
                inst._opts.onClassUpdate(wrap, sel.value);
            }
        };

        inst.destroy = function () {
            _destroy(inst);
        };
    }

    /* ——— SYNC ——— */
    function _syncOptions(inst) {
        var menu = inst.menu;
        var sel = inst.select;
        menu.innerHTML = '';
        inst._focusIdx = -1;

        Array.from(sel.options).forEach(function (opt) {
            var div = document.createElement('div');
            div.className = 'dmc-dropdown-option';
            div.setAttribute('role', 'option');
            div.setAttribute('data-value', opt.value);
            div.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
            div.textContent = opt.textContent;
            div.addEventListener('click', function (e) {
                e.stopPropagation();
                _selectOption(inst, opt.value);
            });
            menu.appendChild(div);
        });
    }

    function _syncLabel(inst) {
        var sel = inst.select;
        var selectedOpt = sel.options[sel.selectedIndex];
        inst._label.textContent = selectedOpt ? selectedOpt.textContent : '';

        // Update aria-selected on menu options
        inst.menu.querySelectorAll('.dmc-dropdown-option').forEach(function (o) {
            o.setAttribute('aria-selected',
                o.getAttribute('data-value') === sel.value ? 'true' : 'false');
        });
    }

    function _selectOption(inst, value) {
        // Use the native descriptor to bypass our interceptor (avoid double sync)
        var desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        desc.set.call(inst.select, value);

        _syncLabel(inst);
        _close(inst);

        if (inst._opts.onClassUpdate) {
            inst._opts.onClassUpdate(inst.wrapper, value);
        }

        // Fire native change event so all existing handlers work
        inst.select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /* ——— OPEN / CLOSE ——— */
    function _open(inst) {
        if (_active && _active !== inst) _close(_active);
        _active = inst;

        // Decide direction
        var rect = inst.wrapper.getBoundingClientRect();
        var spaceBelow = window.innerHeight - rect.bottom;
        inst.wrapper.classList.toggle('open-up', spaceBelow < 240);

        inst.wrapper.classList.add('open');
        inst.trigger.setAttribute('aria-expanded', 'true');

        // Scroll selected option into view
        var selected = inst.menu.querySelector('[aria-selected="true"]');
        if (selected) {
            selected.scrollIntoView({ block: 'nearest' });
            inst._focusIdx = Array.from(inst.menu.children).indexOf(selected);
        }
    }

    function _close(inst) {
        inst.wrapper.classList.remove('open', 'open-up');
        inst.trigger.setAttribute('aria-expanded', 'false');
        inst._focusIdx = -1;

        inst.menu.querySelectorAll('.dmc-dropdown-focused').forEach(function (o) {
            o.classList.remove('dmc-dropdown-focused');
        });

        if (_active === inst) _active = null;
    }

    /* ——— KEYBOARD ——— */
    function _handleKeydown(inst, e) {
        var opts = inst.menu.querySelectorAll('.dmc-dropdown-option');
        var isOpen = inst.wrapper.classList.contains('open');

        if (e.key === 'Escape') {
            if (isOpen) { _close(inst); inst.trigger.focus(); e.preventDefault(); }
            return;
        }

        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!isOpen) {
                _open(inst);
            } else if (inst._focusIdx >= 0 && inst._focusIdx < opts.length) {
                _selectOption(inst, opts[inst._focusIdx].getAttribute('data-value'));
                inst.trigger.focus();
            }
            return;
        }

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!isOpen) { _open(inst); return; }

            opts.forEach(function (o) { o.classList.remove('dmc-dropdown-focused'); });

            if (e.key === 'ArrowDown') {
                inst._focusIdx = Math.min(inst._focusIdx + 1, opts.length - 1);
            } else {
                inst._focusIdx = Math.max(inst._focusIdx - 1, 0);
            }

            opts[inst._focusIdx].classList.add('dmc-dropdown-focused');
            opts[inst._focusIdx].scrollIntoView({ block: 'nearest' });
            return;
        }

        // Type-ahead: jump to first option starting with typed character
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            var ch = e.key.toLowerCase();
            for (var i = 0; i < opts.length; i++) {
                if (opts[i].textContent.trim().toLowerCase().charAt(0) === ch) {
                    if (!isOpen) _open(inst);
                    opts.forEach(function (o) { o.classList.remove('dmc-dropdown-focused'); });
                    inst._focusIdx = i;
                    opts[i].classList.add('dmc-dropdown-focused');
                    opts[i].scrollIntoView({ block: 'nearest' });
                    break;
                }
            }
        }
    }

    /* ——— INTERCEPT PROGRAMMATIC .value SETS ——— */
    function _interceptValue(inst) {
        var sel = inst.select;
        var desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        Object.defineProperty(sel, 'value', {
            get: function () { return desc.get.call(this); },
            set: function (v) {
                desc.set.call(this, v);
                _syncLabel(inst);
                if (inst._opts.onClassUpdate) {
                    inst._opts.onClassUpdate(inst.wrapper, v);
                }
            },
            configurable: true
        });
    }

    /* ——— DESTROY ——— */
    function _destroy(inst) {
        if (inst._observer) inst._observer.disconnect();

        // Restore native .value descriptor
        delete inst.select.value;

        // Unwrap: move select back, remove wrapper
        var parent = inst.wrapper.parentNode;
        inst.select.style.display = '';
        inst.select.removeAttribute('aria-hidden');
        inst.select.removeAttribute('tabindex');
        parent.insertBefore(inst.select, inst.wrapper);
        inst.wrapper.remove();

        delete inst.select._dmcDropdown;
    }

    /* ——— GLOBAL LISTENERS ——— */
    document.addEventListener('click', function () {
        if (_active) _close(_active);
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && _active) _close(_active);
    });
})();
