# Confetti Cleanup Tool — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a confetti cleanup tool to the pattern editor that detects isolated single-stitch color clusters and replaces them with their most common neighbor color.

**Architecture:** Pure client-side. All logic lives in `static/editor.js` — a new `_findConfetti()` pure function for detection, a `_drawConfettiPreview()` for overlay rendering, and a floating options bar (slider + apply/cancel) following the replace panel pattern. One shortcut entry added to `static/shortcut-help.js`.

**Tech Stack:** Vanilla JavaScript, Canvas 2D API, existing editor.js infrastructure.

**Spec:** `docs/superpowers/specs/2026-03-14-confetti-cleanup-design.md`

**Note:** Line numbers reference the file state before any changes. As earlier tasks add code, line numbers drift. Use the surrounding code context (function names, unique strings) to locate insertion points — not exact line numbers.

---

## Chunk 1: Core Algorithm + State Variables

### Task 1: Add confetti state variables

**Files:**
- Modify: `static/editor.js:60-62` (after `_clearFillPreview`)

- [ ] **Step 1: Add state variables after the fill preview state block**

After line 62 (`function _clearFillPreview() { ... }`), add:

```javascript
    /* Confetti cleanup state */
    let _confettiThreshold = 3;        // cluster size threshold (1-10)
    let _confettiMap       = null;     // Map<cellIndex, replacementColor> or null
    let _confettiBar       = null;     // floating options bar DOM element
    let _confettiDebounce  = null;     // debounce timer ID
    function _clearConfetti() {
        _confettiMap = null;
        if (_confettiDebounce) { clearTimeout(_confettiDebounce); _confettiDebounce = null; }
    }
```

- [ ] **Step 2: Commit**

```bash
git add static/editor.js
git commit -m "Add confetti cleanup state variables"
```

---

### Task 2: Implement `_findConfetti()` detection algorithm

**Files:**
- Modify: `static/editor.js` (after the new state variables, before the `_debounce` function at line ~363)

- [ ] **Step 1: Add the `_findConfetti` pure function**

Insert before `function _debounce(fn, ms)` (line 363):

```javascript
    /* ═══════════════════════════════════════════
       Confetti Detection
       ═══════════════════════════════════════════ */

    /**
     * Detect confetti stitches — small connected components of same-color cells.
     * @param {string[]} grid - flat array of DMC codes ('BG' for background)
     * @param {number} w - grid width
     * @param {number} h - grid height
     * @param {number} threshold - max component size to flag as confetti (1-10)
     * @returns {Map<number, string>} map of cellIndex → replacement DMC code
     */
    function _findConfetti(grid, w, h, threshold) {
        const n = w * h;
        const visited = new Uint8Array(n);       // 0 = unvisited
        const isConfetti = new Uint8Array(n);     // 1 = confetti cell
        const components = [];                    // array of arrays of cell indices

        // Pass 1: find connected components via flood-fill, flag small ones as confetti
        const queue = [];
        for (let i = 0; i < n; i++) {
            if (visited[i] || grid[i] === 'BG') continue;
            const color = grid[i];
            const component = [];
            queue.push(i);
            visited[i] = 1;
            while (queue.length) {
                const ci = queue.pop();
                component.push(ci);
                const cx = ci % w, cy = (ci - cx) / w;
                // 4-neighbor: up, right, down, left
                const neighbors = [];
                if (cy > 0)     neighbors.push(ci - w);
                if (cx < w - 1) neighbors.push(ci + 1);
                if (cy < h - 1) neighbors.push(ci + w);
                if (cx > 0)     neighbors.push(ci - 1);
                for (const ni of neighbors) {
                    if (!visited[ni] && grid[ni] === color) {
                        visited[ni] = 1;
                        queue.push(ni);
                    }
                }
            }
            if (component.length <= threshold) {
                for (const ci of component) isConfetti[ci] = 1;
                components.push(component);
            }
        }

        // Pass 2: compute replacement color for each confetti cell
        const result = new Map();
        for (const component of components) {
            for (const ci of component) {
                const cx = ci % w, cy = (ci - cx) / w;
                // Collect non-BG, non-confetti neighbor colors (clockwise: top, right, bottom, left)
                const neighborIndices = [];
                if (cy > 0)     neighborIndices.push(ci - w);     // top
                if (cx < w - 1) neighborIndices.push(ci + 1);     // right
                if (cy < h - 1) neighborIndices.push(ci + w);     // bottom
                if (cx > 0)     neighborIndices.push(ci - 1);     // left

                const counts = {};
                let firstSeen = {};   // tracks clockwise order for tie-breaking
                let order = 0;
                for (const ni of neighborIndices) {
                    const nc = grid[ni];
                    if (nc === 'BG' || isConfetti[ni]) continue;
                    counts[nc] = (counts[nc] || 0) + 1;
                    if (!(nc in firstSeen)) firstSeen[nc] = order;
                    order++;
                }

                // Find most common; ties broken by earliest clockwise occurrence
                let bestColor = null, bestCount = 0, bestOrder = Infinity;
                for (const c in counts) {
                    if (counts[c] > bestCount || (counts[c] === bestCount && firstSeen[c] < bestOrder)) {
                        bestColor = c;
                        bestCount = counts[c];
                        bestOrder = firstSeen[c];
                    }
                }
                if (bestColor) result.set(ci, bestColor);
            }
        }
        return result;
    }
```

- [ ] **Step 2: Commit**

```bash
git add static/editor.js
git commit -m "Add _findConfetti() connected component detection algorithm"
```

---

## Chunk 2: UI — Toolbar Button + Options Bar + Preview

### Task 3: Add confetti button to toolbar

**Files:**
- Modify: `static/editor.js:3208` (after Select button in 3rd tool-group)

- [ ] **Step 1: Add the confetti button after the Select button**

After this line:
```html
<button class="tool-btn" data-tool="select" title="Selection (S)"><i class="ti ti-marquee-2"></i><span class="tool-lbl">Select</span></button>
```

Add:
```html
<button class="tool-btn" data-tool="confetti" title="Confetti Cleanup (C)"><i class="ti ti-sparkles"></i><span class="tool-lbl">Confetti</span></button>
```

- [ ] **Step 2: Commit**

```bash
git add static/editor.js
git commit -m "Add confetti cleanup button to editor toolbar"
```

---

### Task 4: Create the floating options bar

**Files:**
- Modify: `static/editor.js` (after the replace panel creation in `injectUI()`, around line 3275)

- [ ] **Step 1: Add confetti bar CSS to `EDITOR_CSS`**

In the `EDITOR_CSS` template string (starts at line 108), add after the existing `.replace-panel` styles (or at the end of the CSS block):

```css
.ed-confetti-bar{position:absolute;left:50%;transform:translateX(-50%);z-index:16;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);padding:6px 12px;display:flex;align-items:center;gap:10px;box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:nowrap;font-size:13px}
.ed-confetti-bar label{display:flex;align-items:center;gap:6px;color:var(--text-muted)}
.ed-confetti-bar input[type=range]{width:100px;accent-color:var(--gold)}
.ed-confetti-bar .confetti-count{color:var(--text);font-weight:600;min-width:60px}
.ed-confetti-bar button{padding:4px 12px;border:1px solid var(--border-2);border-radius:var(--r);cursor:pointer;font-size:13px}
.ed-confetti-bar .confetti-apply{background:var(--gold);color:#1a1208;border-color:var(--gold)}
.ed-confetti-bar .confetti-cancel{background:var(--surface-2);color:var(--text)}
```

- [ ] **Step 2: Create the confetti bar DOM element in `injectUI()`**

After the replace panel creation block (after `container.appendChild(_replacePanel);` at line 3275), add:

```javascript
        // Confetti cleanup options bar
        _confettiBar = document.createElement('div');
        _confettiBar.className = 'ed-confetti-bar';
        _confettiBar.style.display = 'none';
        _confettiBar.innerHTML = `
            <label>Max cluster: <input type="range" class="confetti-slider" min="1" max="10" value="3"><span class="confetti-thresh-label">3</span></label>
            <span class="confetti-count">0 cells</span>
            <button class="confetti-apply">Apply</button>
            <button class="confetti-cancel">Cancel</button>
        `;
        container.appendChild(_confettiBar);

        // Confetti bar event handlers
        const _confettiSlider = _confettiBar.querySelector('.confetti-slider');
        const _confettiThreshLabel = _confettiBar.querySelector('.confetti-thresh-label');
        const _confettiCountLabel = _confettiBar.querySelector('.confetti-count');

        _confettiSlider.addEventListener('input', () => {
            _confettiThreshold = parseInt(_confettiSlider.value);
            _confettiThreshLabel.textContent = _confettiThreshold;
            // Debounced recompute
            if (_confettiDebounce) clearTimeout(_confettiDebounce);
            _confettiDebounce = setTimeout(() => {
                _recomputeConfetti();
                _confettiDebounce = null;
            }, 100);
        });
        _confettiSlider.addEventListener('keydown', (e) => e.stopPropagation());

        _confettiBar.querySelector('.confetti-apply').addEventListener('click', (e) => {
            e.stopPropagation();
            _applyConfetti();
        });
        _confettiBar.querySelector('.confetti-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            _cancelConfetti();
        });
        _confettiBar.addEventListener('mousedown', (e) => e.stopPropagation());
        _confettiBar.addEventListener('click', (e) => e.stopPropagation());
```

- [ ] **Step 3: Add `_recomputeConfetti`, `_applyConfetti`, `_cancelConfetti` helper functions**

Add these before the `_setTool` function (around line 1900):

```javascript
    function _recomputeConfetti() {
        const pd = getPatternData();
        _confettiMap = _findConfetti(pd.grid, pd.grid_w, pd.grid_h, _confettiThreshold);
        // Update count label
        const countLabel = _confettiBar ? _confettiBar.querySelector('.confetti-count') : null;
        if (countLabel) {
            countLabel.textContent = _confettiMap.size + ' cell' + (_confettiMap.size !== 1 ? 's' : '');
        }
        _redrawOverlay();
    }

    function _applyConfetti() {
        if (!_confettiMap || _confettiMap.size === 0) {
            _cancelConfetti();
            return;
        }
        const pd = getPatternData();
        pushUndo();
        for (const [idx, color] of _confettiMap) {
            pd.grid[idx] = color;
        }
        _clearConfetti();
        _setTool('pan');
        _commitEdit();
    }

    function _cancelConfetti() {
        _clearConfetti();
        _setTool('pan');
    }
```

- [ ] **Step 4: Commit**

```bash
git add static/editor.js
git commit -m "Add confetti options bar with slider, apply, and cancel"
```

---

### Task 5: Add confetti preview overlay rendering

**Files:**
- Modify: `static/editor.js` (in `_redrawOverlay()`, around line 2117)

- [ ] **Step 1: Add `_drawConfettiPreview()` call in `_redrawOverlay()`**

In `_redrawOverlay()`, after the fill preview block (after line 2128 — the closing `}` of the fill preview `if` block), add:

```javascript
        // Confetti preview
        if (_confettiMap && _confettiMap.size > 0 && activeTool === 'confetti') {
            const cpd = getPatternData();
            ctx.save();
            ctx.fillStyle = 'rgba(255, 60, 60, 0.4)';
            for (const idx of _confettiMap.keys()) {
                const c = idx % cpd.grid_w;
                const r = (idx - c) / cpd.grid_w;
                ctx.fillRect(offset.x + c * cp, offset.y + r * cp, cp, cp);
            }
            ctx.restore();
        }
```

- [ ] **Step 2: Commit**

```bash
git add static/editor.js
git commit -m "Add confetti preview overlay rendering in _redrawOverlay"
```

---

## Chunk 3: Tool Integration — `_setTool`, Keyboard, Mousedown, Cleanup

### Task 6: Integrate confetti into `_setTool()`

**Files:**
- Modify: `static/editor.js:1902-1963` (`_setTool` function)

- [ ] **Step 1: Add confetti cleanup when switching away**

After the existing cleanup block for `fill` (line 1952: `if (tool !== 'fill') _clearFillPreview();`), add:

```javascript
        if (tool !== 'confetti') {
            _clearConfetti();
            if (_confettiBar) _confettiBar.style.display = 'none';
        }
```

- [ ] **Step 2: Add confetti bar show/position logic**

After the replace panel show/hide block (after `else _closeReplaceDropdown();` — this ensures `_subTop` is already declared), add:

```javascript
        if (_confettiBar) {
            if (tool === 'confetti') {
                _confettiBar.style.display = 'flex';
                _confettiBar.style.top = _subTop;
                // Initialize: set slider value, recompute
                const slider = _confettiBar.querySelector('.confetti-slider');
                if (slider) slider.value = _confettiThreshold;
                const label = _confettiBar.querySelector('.confetti-thresh-label');
                if (label) label.textContent = _confettiThreshold;
                _recomputeConfetti();
            } else {
                _confettiBar.style.display = 'none';
            }
        }
```

- [ ] **Step 3: Commit**

```bash
git add static/editor.js
git commit -m "Integrate confetti tool into _setTool show/hide/cleanup"
```

---

### Task 7: Add confetti to mousedown handler

**Files:**
- Modify: `static/editor.js:2553-2739` (switch statement in `_handleToolMouseDown`)

- [ ] **Step 1: Add `case 'confetti'` in the mousedown switch**

After the last `case 'select':` block (line 2739: `break;`), before the closing `}` of the switch, add:

```javascript
            case 'confetti':
                break;
```

- [ ] **Step 2: Commit**

```bash
git add static/editor.js
git commit -m "Add no-op confetti case in mousedown handler"
```

---

### Task 8: Add keyboard shortcuts

**Files:**
- Modify: `static/editor.js:3084-3097` (bare key shortcuts)
- Modify: `static/editor.js:2992-3032` (Escape handler)

- [ ] **Step 1: Add `C` key shortcut**

After line 3097 (`if (k === 'm') { _cycleMirror(); return true; }`), add:

```javascript
        if (k === 'c') { _setTool('confetti');   return true; }
```

- [ ] **Step 2: Add Escape handler for confetti**

In the Escape handler chain (after the backstitch cancel block ending at line 3020), add:

```javascript
            if (activeTool === 'confetti') {
                _cancelConfetti();
                return true;
            }
```

- [ ] **Step 3: Commit**

```bash
git add static/editor.js
git commit -m "Add C shortcut and Escape cancel for confetti tool"
```

---

### Task 9: Update `isUIElement`, `reset()`, and `removeUI()`

**Files:**
- Modify: `static/editor.js:3443` (`isUIElement`)
- Modify: `static/editor.js:3127-3161` (`reset()`)
- Modify: `static/editor.js:3373-3395` (`removeUI()`)

- [ ] **Step 1: Add `.ed-confetti-bar` to `isUIElement` selector**

On line 3443, change:
```javascript
isUIElement: (el) => !!el.closest('.editor-toolbar,.ed-replace-panel,.ed-add-color-modal,.ed-resize-modal,.ed-resize-backdrop,.ed-text-panel,.stitch-mode-bar,.zoom-controls,.fabric-dropdown'),
```
to:
```javascript
isUIElement: (el) => !!el.closest('.editor-toolbar,.ed-replace-panel,.ed-confetti-bar,.ed-add-color-modal,.ed-resize-modal,.ed-resize-backdrop,.ed-text-panel,.stitch-mode-bar,.zoom-controls,.fabric-dropdown'),
```

- [ ] **Step 2: Add confetti cleanup to `reset()`**

In the `reset()` function, after `_clearFillPreview();` (line 3142), add:

```javascript
        _clearConfetti();
        _confettiThreshold = 3;
        if (_confettiBar) _confettiBar.style.display = 'none';
```

- [ ] **Step 3: Add confetti bar removal to `removeUI()`**

After `if (_textPanel) { ... }` (line 3383), add:

```javascript
        if (_confettiBar)    { _confettiBar.remove(); _confettiBar = null; }
```

- [ ] **Step 4: Commit**

```bash
git add static/editor.js
git commit -m "Add confetti bar to isUIElement, reset, and removeUI"
```

---

## Chunk 4: Shortcut Help + Final Commit

### Task 10: Add confetti to shortcut help

**Files:**
- Modify: `static/shortcut-help.js:31-32` (EDITOR_SHORTCUTS array)

- [ ] **Step 1: Add confetti entry to EDITOR_SHORTCUTS**

After line 32 (`{ key: 'S', desc: 'Selection' },`), add:

```javascript
        { key: 'C',          desc: 'Confetti cleanup' },
```

- [ ] **Step 2: Commit**

```bash
git add static/shortcut-help.js
git commit -m "Add confetti cleanup shortcut to keyboard help"
```

---

### Task 11: Manual testing checklist

No code changes. Verify the following manually:

- [ ] **Step 1: Activate confetti tool via toolbar button** — click the sparkles button, verify options bar appears below toolbar with slider at 3, cell count shows.
- [ ] **Step 2: Activate via `C` key** — press `C`, verify same behavior.
- [ ] **Step 3: Adjust slider** — drag slider from 1 to 10, verify count updates live and red overlay cells appear/change.
- [ ] **Step 4: Apply** — click Apply, verify cells are recolored, undo reverts the entire operation.
- [ ] **Step 5: Cancel** — activate again, click Cancel, verify no changes made.
- [ ] **Step 6: Escape** — activate again, press Escape, verify same as Cancel.
- [ ] **Step 7: Switch tools** — activate confetti, then press `P` (pencil), verify options bar hides and preview clears.
- [ ] **Step 8: Single-color pattern** — open a pattern with one color, activate confetti, verify "0 cells" shown.
- [ ] **Step 9: Keyboard help** — press `?` in editor, verify "Confetti cleanup (C)" appears in the list.
