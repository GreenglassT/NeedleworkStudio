# Enhanced Selection Tool Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating selection bar with Rect/Wand mode toggle, visible Flip H / Flip V / Rotate buttons, and a Magic Wand selection sub-mode.

**Architecture:** All changes are in the existing `static/editor.js` editor module (inside the `createPatternEditor` IIFE) plus `static/shortcut-help.js`. The floating selection bar follows the same pattern as the existing confetti bar (`.ed-confetti-bar`): positioned with `_subTop`, registered in `isUIElement`, shown/hidden in `_setTool`, cleaned up in `deactivate`/`reset`/`removeUI`. The Magic Wand reuses the existing `_bfsRegion` BFS flood-fill function.

**Tech Stack:** Vanilla JavaScript, CSS-in-JS (inline `<style>` in editor.js), HTML DOM manipulation.

**Spec:** `docs/superpowers/specs/2026-03-14-enhanced-selection-design.md`

---

## Chunk 1: Enhanced Selection Tool

### Task 1: Add selection bar CSS

**Files:**
- Modify: `static/editor.js:175-185` (CSS style block, after `.confetti-scope-btn.active`)

- [ ] **Step 1: Add `.ed-select-bar` CSS rules after the confetti bar CSS**

After line 185 (`.confetti-scope-btn.active{...}`), add:

```css
.ed-select-bar{position:absolute;left:50%;transform:translateX(-50%);z-index:16;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);padding:6px 12px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:nowrap;font-size:10px;font-family:'IBM Plex Mono',monospace;color:var(--text-muted)}
.ed-select-bar button{padding:4px 10px;border:1px solid var(--border-2);border-radius:var(--r);cursor:pointer;font-size:10px;font-family:inherit;background:var(--surface-2);color:var(--text)}
.ed-select-bar button:disabled{opacity:0.4;cursor:not-allowed}
.ed-select-bar .select-dims{color:var(--text);font-weight:600;min-width:50px}
```

- [ ] **Step 2: Verify the CSS renders**

Open the app, enter edit mode, visually confirm no style errors in DevTools console.

- [ ] **Step 3: Commit**

```bash
git add static/editor.js
git commit -m "feat(select): add selection bar CSS rules"
```

---

### Task 2: Add state variables and create selection bar DOM

**Files:**
- Modify: `static/editor.js:82-92` (state variables section)
- Modify: `static/editor.js:~3509-3555` (after confetti bar creation, inside `createPatternEditor`)

- [ ] **Step 1: Add state variables**

After the existing selection state variables (around line 92, after `let _pasteLoc = null;`), add:

```javascript
let _selectMode    = 'rect';       // 'rect' or 'wand'
let _wandMask      = null;         // Set<index> for wand selections, null for rect
let _selectBar     = null;         // floating selection bar DOM element
```

- [ ] **Step 2: Create selection bar DOM element**

After the confetti bar creation block (after line 3555, after `_confettiBar.addEventListener('click', ...)`), add:

```javascript
/* ── Selection bar (Rect/Wand toggle + transforms + dimensions) ── */
_selectBar = document.createElement('div');
_selectBar.className = 'ed-select-bar';
_selectBar.style.display = 'none';
_selectBar.innerHTML = `
    <span class="confetti-scope"><button class="confetti-scope-btn active" data-mode="rect">Rect</button><button class="confetti-scope-btn" data-mode="wand">Wand</button></span>
    <span style="width:1px;height:16px;background:var(--border-2)"></span>
    <button class="select-flip-h" disabled>Flip Horizontal</button>
    <button class="select-flip-v" disabled>Flip Vertical</button>
    <button class="select-rotate" disabled>Rotate</button>
    <span style="width:1px;height:16px;background:var(--border-2)"></span>
    <span class="select-dims"></span>
`;
container.appendChild(_selectBar);

_selectBar.querySelectorAll('.confetti-scope-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _selectMode = btn.dataset.mode;
        _selectBar.querySelectorAll('.confetti-scope-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

_selectBar.querySelector('.select-flip-h').addEventListener('click', (e) => {
    e.stopPropagation();
    if (_selRect) { _flipBufferH(); _updateSelectBarState(); }
});
_selectBar.querySelector('.select-flip-v').addEventListener('click', (e) => {
    e.stopPropagation();
    if (_selRect) { _flipBufferV(); _updateSelectBarState(); }
});
_selectBar.querySelector('.select-rotate').addEventListener('click', (e) => {
    e.stopPropagation();
    if (_selRect) { _rotateBufferCW(); _updateSelectBarState(); }
});
_selectBar.addEventListener('mousedown', (e) => e.stopPropagation());
_selectBar.addEventListener('click', (e) => e.stopPropagation());
```

- [ ] **Step 3: Verify the bar DOM is created**

Open the app, enter edit mode, check in DevTools Elements panel that `.ed-select-bar` exists in the DOM (hidden).

- [ ] **Step 4: Commit**

```bash
git add static/editor.js
git commit -m "feat(select): add selection bar state vars and DOM creation"
```

---

### Task 3: Add `_updateSelectBarState` helper and wire into `_setTool`

**Files:**
- Modify: `static/editor.js` (new helper function near selection functions ~line 860, and `_setTool` ~line 2095)

- [ ] **Step 1: Add `_updateSelectBarState` helper**

Add this function near the existing selection helper functions (around line 860, before `_captureSelectionBuffer`):

```javascript
function _updateSelectBarState() {
    if (!_selectBar) return;
    const hasSelection = !!_selRect;
    _selectBar.querySelector('.select-flip-h').disabled = !hasSelection;
    _selectBar.querySelector('.select-flip-v').disabled = !hasSelection;
    _selectBar.querySelector('.select-rotate').disabled = !hasSelection;
    const dims = _selectBar.querySelector('.select-dims');
    if (hasSelection) {
        const w = (_selBuffer ? _selBuffer.w : _selRect.c2 - _selRect.c1 + 1);
        const h = (_selBuffer ? _selBuffer.h : _selRect.r2 - _selRect.r1 + 1);
        dims.textContent = w + ' \u00d7 ' + h;
    } else {
        dims.textContent = '';
    }
}
```

- [ ] **Step 2: Wire selection bar show/hide into `_setTool`**

In the `_setTool` function, find the section where confetti bar is shown/hidden (around lines 2100-2122). After the confetti bar logic block (after `if (tool !== 'confetti') { _clearConfetti(); if (_confettiBar) _confettiBar.style.display = 'none'; }`), add:

```javascript
if (tool === 'select') {
    _selectBar.style.display = 'flex';
    _selectBar.style.top = _subTop;
    // Sync mode toggle to current _selectMode
    _selectBar.querySelectorAll('.confetti-scope-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === _selectMode));
    _updateSelectBarState();
} else {
    // Switching away from select: commit pending move, hide bar
    if (activeTool === 'select') _commitMovedSelection();
    if (_selectBar) _selectBar.style.display = 'none';
}
```

Note: The `else` block runs for all non-select tools. `_commitMovedSelection()` is a no-op when there's no pending move (it returns early if `!_selBuffer || !_selRect` or offset is zero), so it's safe to call unconditionally when leaving select.

- [ ] **Step 3: Test bar visibility**

Open the app, enter edit mode, click the Selection tool (S key). Verify the selection bar appears below the toolbar. Switch to Pencil tool — verify the bar disappears.

- [ ] **Step 4: Commit**

```bash
git add static/editor.js
git commit -m "feat(select): add _updateSelectBarState helper and wire into _setTool"
```

---

### Task 4: Wire `_updateSelectBarState` into all selection state change points

**Files:**
- Modify: `static/editor.js` (mouseup, keyboard handlers, transforms, commitMovedSelection)

- [ ] **Step 1: Add call in mouseup handler for select (after drag end)**

In the mouseup handler (around line 3099), after the `_selDragging = false` block that calls `_startMarchingAnts()`, add `_updateSelectBarState();` right after `_redrawOverlay();` inside the `if (_selDragging)` block:

```javascript
if (_selDragging) {
    _selDragging = false;
    if (_selRect && (_selRect.c1 !== _selRect.c2 || _selRect.r1 !== _selRect.r2)) {
        _startMarchingAnts();
    } else {
        _selRect = null;
    }
    _redrawOverlay();
    _updateSelectBarState();  // ← ADD THIS
}
```

- [ ] **Step 2: Add call in Delete/Backspace handler**

In the Delete/Backspace keyboard handler (around line 3263), after `_redrawOverlay();` add:

```javascript
_updateSelectBarState();  // ← ADD after _redrawOverlay()
```

Also add `_wandMask = null;` after `_selRect = null; _selBuffer = null;` on line 3267:

```javascript
_selRect = null; _selBuffer = null; _wandMask = null;
```

- [ ] **Step 3: Add call in Escape handler**

In the Escape handler for `activeTool === 'select' && _selRect` (around line 3250), add `_wandMask = null;` after `_selRect = null;` and add `_updateSelectBarState();` after `_redrawOverlay();`:

```javascript
if (activeTool === 'select' && _selRect) {
    _commitMovedSelection();
    _selRect = null; _wandMask = null;
    _selOffset = { dc: 0, dr: 0 };
    _stopMarchingAnts();
    _redrawOverlay();
    _updateSelectBarState();
    return true;
}
```

- [ ] **Step 4: Add `_wandMask = null` in `_commitMovedSelection`**

In `_commitMovedSelection` (around line 1020), add `_wandMask = null;` after `_selBuffer = null;`:

```javascript
_selBuffer = null;
_selRect = null;
_wandMask = null;
```

Also add `_updateSelectBarState();` after `_redrawOverlay();`:

```javascript
_redrawOverlay();
_updateSelectBarState();
```

- [ ] **Step 5: Add `_wandMask = null` in `_enterPasteMode`**

In `_enterPasteMode` (around line 1036), add `_wandMask = null;` after `_selRect = null;`:

```javascript
_selRect = null; _wandMask = null;
```

- [ ] **Step 6: Add `_updateSelectBarState` calls after transform functions**

In the transform shortcuts keyboard handler (around line 3289), add `_updateSelectBarState();` after each transform call:

```javascript
if (sk === 'r') { e.preventDefault(); _rotateBufferCW(); _updateSelectBarState(); return true; }
if (sk === 'h') { e.preventDefault(); _flipBufferH(); _updateSelectBarState(); return true; }
if (sk === 'v') { e.preventDefault(); _flipBufferV(); _updateSelectBarState(); return true; }
```

- [ ] **Step 7: Test transform buttons and dimensions**

Open the app, enter edit mode, select tool, draw a rectangle selection. Verify:
- Dimensions show in the bar (e.g., "5 × 3")
- Flip H, Flip V, Rotate buttons become enabled
- Clicking Rotate changes dimensions (e.g., "3 × 5")
- Pressing Delete clears selection and dims/buttons reset

- [ ] **Step 8: Commit**

```bash
git add static/editor.js
git commit -m "feat(select): wire _updateSelectBarState into all state change points"
```

---

### Task 5: Add wand-aware `_captureSelectionBuffer`

**Files:**
- Modify: `static/editor.js:868-898` (`_captureSelectionBuffer` function)

- [ ] **Step 1: Add wand mask filtering to `_captureSelectionBuffer`**

Modify `_captureSelectionBuffer` to mask non-wand cells. Replace the grid data capture loop and V2 stitch filtering sections. The full updated function:

```javascript
function _captureSelectionBuffer(isCut) {
    if (!_selRect) return;
    const pd = getPatternData();
    const { c1, r1, c2, r2 } = _selRect;
    const w = c2 - c1 + 1, h = r2 - r1 + 1;
    // Grid cells — mask non-wand cells to 'BG'
    const data = new Array(w * h);
    for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++) {
            const gi = (r1 + r) * pd.grid_w + (c1 + c);
            if (_wandMask && !_wandMask.has(gi)) {
                data[r * w + c] = 'BG';
            } else {
                data[r * w + c] = pd.grid[gi];
            }
        }
    // Helper: check if a cell-coord stitch is in wand mask
    const _cellInWand = _wandMask
        ? (x, y) => _wandMask.has((r1 + y) * pd.grid_w + (c1 + x))
        : () => true;
    // Helper: check if an intersection-coord stitch is in wand mask (use floor to get containing cell)
    const _intInWand = _wandMask
        ? (x, y) => {
            const cx = Math.min(Math.floor(c1 + x), c2), cy = Math.min(Math.floor(r1 + y), r2);
            return _wandMask.has(cy * pd.grid_w + cx);
        }
        : () => true;
    // Part stitches (cell coords)
    const part_stitches = (pd.part_stitches || [])
        .filter(s => _cellInRect(s.x, s.y, c1, r1, c2, r2) && _cellInWand(s.x - c1, s.y - r1))
        .map(s => ({ x: s.x - c1, y: s.y - r1, type: s.type, dmc: s.dmc, dir: s.dir }));
    // Backstitches (intersection coords) — both ends must be inside and in wand
    const backstitches = (pd.backstitches || [])
        .filter(bs => _intersectionInRect(bs.x1, bs.y1, c1, r1, c2, r2) &&
                      _intersectionInRect(bs.x2, bs.y2, c1, r1, c2, r2) &&
                      _intInWand(bs.x1 - c1, bs.y1 - r1) && _intInWand(bs.x2 - c1, bs.y2 - r1))
        .map(bs => ({ x1: bs.x1 - c1, y1: bs.y1 - r1, x2: bs.x2 - c1, y2: bs.y2 - r1, dmc: bs.dmc }));
    // Knots (intersection coords)
    const knots = (pd.knots || [])
        .filter(k => _intersectionInRect(k.x, k.y, c1, r1, c2, r2) && _intInWand(k.x - c1, k.y - r1))
        .map(k => ({ x: k.x - c1, y: k.y - r1, dmc: k.dmc }));
    // Beads (cell coords)
    const beads = (pd.beads || [])
        .filter(b => _cellInRect(b.x, b.y, c1, r1, c2, r2) && _cellInWand(b.x - c1, b.y - r1))
        .map(b => ({ x: b.x - c1, y: b.y - r1, dmc: b.dmc }));
    _selBuffer = { w, h, data, part_stitches, backstitches, knots, beads,
                   isCut: !!isCut, cutSource: isCut ? { c1, r1, c2, r2 } : null };
}
```

- [ ] **Step 2: Verify existing rect selection still works**

Open the app, enter edit mode, draw some stitches, select a rectangle, press Ctrl+C, click to paste. Verify it copies/pastes correctly. (When `_wandMask` is null, the new code paths are no-ops — existing behavior is unchanged.)

- [ ] **Step 3: Commit**

```bash
git add static/editor.js
git commit -m "feat(select): add wand mask filtering to _captureSelectionBuffer"
```

---

### Task 6: Add wand-aware `_clearSelectionSource`

**Files:**
- Modify: `static/editor.js:961-978` (`_clearSelectionSource` function)

- [ ] **Step 1: Add wand mask filtering to `_clearSelectionSource`**

Replace the function with wand-aware version:

```javascript
function _clearSelectionSource(bounds) {
    const rect = bounds || _selRect;
    if (!rect) return;
    const pd = getPatternData();
    const { c1, r1, c2, r2 } = rect;
    // Clear grid cells — only wand-mask cells if wand is active
    for (let r = r1; r <= r2; r++)
        for (let c = c1; c <= c2; c++) {
            const gi = r * pd.grid_w + c;
            if (!_wandMask || _wandMask.has(gi))
                pd.grid[gi] = 'BG';
        }
    // Helper: check if a cell-coord stitch is in wand mask
    const inWand = _wandMask
        ? (x, y) => _wandMask.has(y * pd.grid_w + x)
        : () => true;
    // Helper: intersection-coord → containing cell check
    const intInWand = _wandMask
        ? (x, y) => {
            const cx = Math.min(Math.floor(x), c2), cy = Math.min(Math.floor(y), r2);
            return _wandMask.has(cy * pd.grid_w + cx);
        }
        : () => true;
    if (pd.part_stitches) pd.part_stitches = pd.part_stitches.filter(s =>
        !(_cellInRect(s.x, s.y, c1, r1, c2, r2) && inWand(s.x, s.y)));
    if (pd.backstitches) pd.backstitches = pd.backstitches.filter(bs =>
        !(_intersectionInRect(bs.x1, bs.y1, c1, r1, c2, r2) &&
          _intersectionInRect(bs.x2, bs.y2, c1, r1, c2, r2) &&
          intInWand(bs.x1, bs.y1) && intInWand(bs.x2, bs.y2)));
    if (pd.knots) pd.knots = pd.knots.filter(k =>
        !(_intersectionInRect(k.x, k.y, c1, r1, c2, r2) && intInWand(k.x, k.y)));
    if (pd.beads) pd.beads = pd.beads.filter(b =>
        !(_cellInRect(b.x, b.y, c1, r1, c2, r2) && inWand(b.x, b.y)));
}
```

- [ ] **Step 2: Verify existing Delete/move still works**

Open the app, enter edit mode, draw stitches, select a rectangle, press Delete. Verify it clears correctly. Select, move, release — verify the move commits correctly. (When `_wandMask` is null, the helpers always return true — existing behavior is unchanged.)

- [ ] **Step 3: Commit**

```bash
git add static/editor.js
git commit -m "feat(select): add wand mask filtering to _clearSelectionSource"
```

---

### Task 7: Add wand mousedown handler

**Files:**
- Modify: `static/editor.js:2899-2922` (mousedown handler, `case 'select'`)

- [ ] **Step 1: Add wand mode handling in mousedown**

Replace the `case 'select':` block in the mousedown handler with:

```javascript
case 'select':
    if (_pasteMode) {
        if (_pasteLoc) _commitPaste(_pasteLoc.col, _pasteLoc.row);
        return;
    }
    if (_selectMode === 'wand') {
        // If clicking inside existing selection, start move (same as rect mode)
        if (_selRect && _isInsideSelection(col, row)) {
            _selMoving = true;
            _selMoveOrigin = { col, row };
            if (!_selBuffer) _captureSelectionBuffer();
            break;
        }
        // Wand click: BFS from clicked cell
        const pd = getPatternData();
        const idx = row * pd.grid_w + col;
        const color = pd.grid[idx];
        if (color === 'BG') {
            _commitMovedSelection();
            _selRect = null; _selBuffer = null; _wandMask = null;
            _stopMarchingAnts();
            _updateSelectBarState();
            _redrawOverlay();
            break;
        }
        _commitMovedSelection();
        _wandMask = null;
        const region = _bfsRegion(pd.grid, pd.grid_w, pd.grid_h, idx, color);
        let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
        for (const i of region) {
            const c = i % pd.grid_w, r = (i - c) / pd.grid_w;
            if (c < minC) minC = c; if (c > maxC) maxC = c;
            if (r < minR) minR = r; if (r > maxR) maxR = r;
        }
        _selRect = { c1: minC, r1: minR, c2: maxC, r2: maxR };
        _wandMask = region;
        _captureSelectionBuffer();
        _startMarchingAnts();
        _updateSelectBarState();
        _redrawOverlay();
        break;
    }
    // Rect mode (existing behavior)
    if (_selRect && _isInsideSelection(col, row)) {
        _selMoving = true;
        _selMoveOrigin = { col, row };
        if (!_selBuffer) {
            _captureSelectionBuffer();
        }
    } else {
        _commitMovedSelection();
        _selStart = { col, row };
        _selDragging = true;
        _selRect = null;
        _selBuffer = null;
        _wandMask = null;
        _selOffset = { dc: 0, dr: 0 };
        _stopMarchingAnts();
    }
    break;
```

- [ ] **Step 2: Test wand click on colored cells**

Open the app, enter edit mode, draw a contiguous block of one color (e.g., 5-6 cells). Switch to Select tool, click Wand in the bar, click one of the colored cells. Verify:
- Marching ants appear around the bounding rect of the contiguous region
- Dimensions show in the bar
- Transform buttons become enabled

- [ ] **Step 3: Test wand click on BG**

Click on an empty (BG) cell in wand mode. Verify:
- Selection clears
- Dimensions and buttons reset

- [ ] **Step 4: Test wand selection move**

Make a wand selection, then click inside it and drag. Verify the selection moves. Release — verify it commits correctly.

- [ ] **Step 5: Commit**

```bash
git add static/editor.js
git commit -m "feat(select): add magic wand mousedown handler with BFS selection"
```

---

### Task 8: Register selection bar in lifecycle hooks

**Files:**
- Modify: `static/editor.js` (`isUIElement`, `deactivate`, `reset`, `removeUI`)

- [ ] **Step 1: Add `.ed-select-bar` to `isUIElement`**

In the `isUIElement` function (line 3724), add `.ed-select-bar` to the selector string:

```javascript
isUIElement: (el) => !!el.closest('.editor-toolbar,.ed-replace-panel,.ed-confetti-bar,.ed-select-bar,.ed-add-color-modal,.ed-resize-modal,.ed-resize-backdrop,.ed-text-panel,.stitch-mode-bar,.zoom-controls,.fabric-dropdown'),
```

- [ ] **Step 2: Add to `deactivate()`**

In `deactivate()` (around line 3147), after the confetti bar hide line, add:

```javascript
if (_selectBar) _selectBar.style.display = 'none';
```

- [ ] **Step 3: Add to `reset()`**

In `reset()` (around line 3353), in the section where confetti state is reset, add:

```javascript
_selectMode = 'rect';
_wandMask = null;
if (_selectBar) _selectBar.style.display = 'none';
```

- [ ] **Step 4: Add to `removeUI()`**

In `removeUI()` (around line 3664), after the confetti bar removal line, add:

```javascript
if (_selectBar) { _selectBar.remove(); _selectBar = null; }
```

- [ ] **Step 5: Test lifecycle**

Open the app, enter edit mode, switch to Select tool (bar visible). Click Cancel to exit edit mode — verify bar disappears. Re-enter edit mode — verify bar reappears when Select tool is chosen.

- [ ] **Step 6: Commit**

```bash
git add static/editor.js
git commit -m "feat(select): register selection bar in lifecycle hooks"
```

---

### Task 9: Add shortcut help entries

**Files:**
- Modify: `static/shortcut-help.js:21-51` (EDITOR_SHORTCUTS array)

- [ ] **Step 1: Add selection transform shortcuts**

In the `EDITOR_SHORTCUTS` array, after the line `{ key: 'Del',  desc: 'Clear selection' },` (line 47), add:

```javascript
{ key: 'H',          desc: 'Flip Horizontal (with selection)' },
{ key: 'V',          desc: 'Flip Vertical (with selection)' },
{ key: 'R',          desc: 'Rotate 90\u00b0 CW (with selection)' },
```

- [ ] **Step 2: Test shortcut help**

Open the app, enter edit mode, press `?`. Verify the three new entries appear in the shortcuts list.

- [ ] **Step 3: Commit**

```bash
git add static/shortcut-help.js
git commit -m "feat(select): add H/V/R transform shortcuts to shortcut help"
```

---

### Task 10: Final integration test

**Files:** None (manual testing only)

- [ ] **Step 1: Test full rect workflow**

1. Enter edit mode, draw stitches in several colors
2. Select tool → Rect mode (default)
3. Drag to create rectangle selection
4. Verify: dimensions show, transform buttons enabled
5. Click Flip H → verify buffer flips
6. Click Rotate → verify buffer rotates and dimensions swap
7. Move selection by clicking inside and dragging
8. Press Delete → verify clears and bar resets

- [ ] **Step 2: Test full wand workflow**

1. Draw a contiguous block of one color (5+ cells)
2. Select tool → click Wand in bar
3. Click on a colored cell → verify BFS selects entire contiguous region
4. Verify marching ants on bounding rect
5. Click Flip V → verify transform applies
6. Click inside selection and drag → verify move works
7. Click on BG → verify selection clears

- [ ] **Step 3: Test wand with neighboring non-selected cells**

1. Draw two different-colored regions sharing a bounding rect (e.g., blue L-shape with red cells adjacent)
2. Wand-click on the blue region
3. Move the selection → verify red cells within bounding rect are NOT erased
4. Undo and verify the pattern restores correctly

- [ ] **Step 4: Test keyboard shortcuts still work**

1. Make a rect selection
2. Press R → verify rotate
3. Press H → verify flip horizontal
4. Press V → verify flip vertical
5. Press Delete → verify clear
6. Press Escape → verify deselect

- [ ] **Step 5: Test mode persistence and switching**

1. Switch to Wand mode
2. Switch to Pencil tool, draw something
3. Switch back to Select tool → verify still in Wand mode
4. Exit edit mode (Cancel) and re-enter → switch to Select tool → verify Wand mode persists (until full reset)

- [ ] **Step 6: Verify clean working tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean` (all changes were committed in Tasks 1-9).
