# Enhanced Selection Tool — Design Spec

**Date**: 2026-03-14
**Status**: Approved

## Problem

The Select tool only supports rectangular selection and has hidden keyboard-only transforms (R/H/V for rotate/flip). Users don't know these exist. There's also no way to select by color region, which is the most natural operation in cross-stitch editing.

## Solution

1. Add a **floating selection bar** (same pattern as confetti bar) with a **Rect/Wand mode toggle** and visible **Flip Horizontal / Flip Vertical / Rotate** buttons.
2. Add a **Magic Wand** sub-mode that selects all contiguous cells of the same color via flood-fill.

## Decisions

| Decision | Choice |
|---|---|
| Selection shapes | Rectangle (existing) + Magic Wand (new) |
| Wand behavior | Contiguous only — BFS flood-fill from clicked cell, same color |
| Wand UI | Sub-mode of Select tool (Rect/Wand toggle in floating bar) |
| Wand shortcut | None — toggle via bar click only |
| Transform buttons | Flip Horizontal, Flip Vertical, Rotate (90 CW) |
| Transform UI | Floating context bar below toolbar (same pattern as confetti/replace) |
| Bar visibility | Shown when Select tool is active, hidden otherwise |
| Existing shortcuts | R / H / V keyboard shortcuts still work when selection active |
| Dimensions display | Bar shows selection size as "W x H" |

## UI Design

### Floating Selection Bar

When `activeTool === 'select'`, a floating bar appears below the toolbar (same positioning as confetti bar using `_subTop`):

```
[ Rect | Wand ]  |  [ Flip Horizontal ] [ Flip Vertical ] [ Rotate ]  |  12 x 8
```

- **Rect / Wand toggle**: Segmented control (same style as confetti's Whole Pattern / Selection toggle). Rect is default and active on tool switch.
- **Flip Horizontal**: Calls `_flipBufferH()`. Disabled when no selection exists.
- **Flip Vertical**: Calls `_flipBufferV()`. Disabled when no selection exists.
- **Rotate**: Calls `_rotateBufferCW()`. Disabled when no selection exists.
- **Dimensions**: Shows `W x H` in stitches when selection exists, empty otherwise.
- Separator: Vertical 1px divider line between groups (same as confetti bar visual separators).

### CSS

New class `.ed-select-bar` following the confetti bar pattern:
- `position: absolute; left: 50%; transform: translateX(-50%); z-index: 16`
- `font-size: 10px; font-family: 'IBM Plex Mono', monospace; color: var(--text-muted)`
- Same background, border, border-radius, padding, shadow as `.ed-confetti-bar`

Reuse `.confetti-scope-btn` style for the Rect/Wand segmented toggle (same class, no extraction needed for now).

Transform buttons: same style as confetti Apply/Cancel buttons. Disabled state: `opacity: 0.4; cursor: not-allowed`.

Add `mousedown` and `click` `stopPropagation()` on `_selectBar` element (same pattern as confetti bar) to prevent bar clicks from being interpreted as canvas clicks.

### Magic Wand Mode

When Wand mode is active and the user clicks a cell:

1. Compute the contiguous region using `_bfsRegion(grid, grid_w, grid_h, clickedIndex, clickedColor)` — no limit parameter (select entire region).
2. Convert the resulting `Set<index>` to a bounding `_selRect` (min/max col/row of all indices).
3. Capture `_selBuffer` using `_captureSelectionBuffer()` — this captures everything within the bounding rect.
4. Store the wand region `Set` as `_wandMask` — used to constrain which cells are considered "selected" vs background within the bounding rect.
5. Start marching ants.

**Wand mask**: The `_wandMask` is a `Set<index>` of grid indices that are actually selected. For rectangular selections, `_wandMask` is null (all cells in rect are selected). When `_wandMask` is set:
- `_captureSelectionBuffer()` masks non-wand cells to `'BG'` in the buffer data array. Only cells whose grid index is in `_wandMask` are captured; all others become `'BG'`. For V2 stitches: `part_stitches` and `beads` are filtered to only include entries whose cell position maps to an index in `_wandMask`. `backstitches` are filtered to only include entries where both endpoints map to wand-mask indices. `knots` are filtered to only include entries at positions within wand-mask cells. This prevents transforms from corrupting neighboring cells that happen to fall within the bounding rect.
- `_clearSelectionSource()` only clears grid cells whose index is in `_wandMask`. For V2 stitches, applies the same filtering: only removes `part_stitches`, `beads`, `knots`, and `backstitches` that belong to wand-mask cells (same criteria as capture). Non-wand cells and their stitches within the bounding rect are left untouched. This prevents moving a wand selection from erasing unrelated cells.
- `_drawSelectionOutline` uses the bounding rect for marching ants (same as rect mode). Per-cell outline rendering is not needed for v1.
- Transforms (flip/rotate) operate on the bounding rect buffer as usual — since non-wand cells are already `'BG'` in the buffer, they are inert during transforms.
- `_wandMask` must be set to `null` whenever the selection is cleared — this includes: `reset()`, Delete/Backspace key handler, Escape key handler, `_commitMovedSelection()`, clicking outside selection in rect mode, clicking BG in wand mode, and entering copy/cut paste mode.

### Canvas Interaction

**Rect mode** (default): Same as current select tool behavior — click+drag to create rectangle, click inside to move, etc.

**Wand mode**:
- Click on a non-BG cell: BFS flood-fill to find contiguous same-color region, compute bounding rect, set `_selRect`, store `_wandMask`, capture buffer (masking non-wand cells to 'BG'), start marching ants.
- Click on BG cell: Clear selection (same as clicking outside in rect mode).
- Click inside existing selection: Starts a move (same as rect mode — reuse existing `_selMoving` logic). The wand mousedown handler must check for an existing `_selRect` and whether the click is inside it *before* running BFS. If inside, enter move mode; if outside, run BFS for a new wand selection.
- Mousemove: No rubber-band rectangle in wand mode (no drag-to-select). Move drag works normally when `_selMoving` is true.
- Mouseup: No special handling needed for wand mode beyond the existing move-end logic.
- After wand selection is made: Move, flip, rotate, copy, cut, paste all work identically to rect mode (operating on the bounding rect buffer, where non-wand cells are 'BG').

## Integration Points

### State Variables
- `_selectMode`: `'rect'` | `'wand'` — current sub-mode. Default `'rect'`.
- `_wandMask`: `Set<index>` | `null` — grid indices in the wand selection. `null` for rect selections.
- `_selectBar`: DOM reference to the floating bar element.
- No new state for transforms — reuse existing `_selBuffer`, `_selRect`, etc.

### Tool Activation in `_setTool`
When `tool === 'select'`:
- Show `_selectBar`, position with `_subTop`.
- Update mode toggle to reflect `_selectMode`.
- Update transform button disabled state based on `_selRect`.

When switching away from select:
- Hide `_selectBar`.
- Commit any pending move (`_commitMovedSelection()`).

### Mousedown Handler
Add wand logic before the existing select case:
```javascript
case 'select':
    if (_selectMode === 'wand') {
        // If clicking inside existing selection, start move (same as rect mode)
        if (_selRect && col >= _selRect.c1 && col <= _selRect.c2
                     && row >= _selRect.r1 && row <= _selRect.r2) {
            _selMoving = true;
            _selMoveStart = { col, row };
            break;
        }
        // Wand click outside existing selection: BFS from clicked cell
        const pd = getPatternData();
        const idx = row * pd.grid_w + col;
        const color = pd.grid[idx];
        if (color === 'BG') {
            // Click on BG: clear selection
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
        // Compute bounding rect from region
        let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
        for (const i of region) {
            const c = i % pd.grid_w, r = (i - c) / pd.grid_w;
            if (c < minC) minC = c; if (c > maxC) maxC = c;
            if (r < minR) minR = r; if (r > maxR) maxR = r;
        }
        _selRect = { c1: minC, r1: minR, c2: maxC, r2: maxR };
        _wandMask = region;
        _captureSelectionBuffer();  // masks non-wand cells to 'BG'
        _startMarchingAnts();
        _updateSelectBarState();
        _redrawOverlay();
        break;
    }
    // ... existing rect logic
```

### Transform Button State
After any operation that changes `_selRect` (drag end, wand click, clear, move commit):
- Update transform buttons: disabled if `!_selRect`, enabled if `_selRect` exists.
- Update dimensions label: show `W x H` or empty.

Helper function `_updateSelectBarState()` called from:
- `_setTool('select')`
- Mouseup (drag end)
- Wand click
- After flip/rotate (dimensions may change on rotate)
- Selection clear (Delete key, click outside)
- `_commitMovedSelection()` (after move finishes)

### Keyboard
- Existing R/H/V shortcuts continue to work unchanged.
- Add new entries alongside existing ones in `shortcut-help.js` editor section: `{ key: 'H', desc: 'Flip Horizontal (with selection)' }`, `{ key: 'V', desc: 'Flip Vertical (with selection)' }`, `{ key: 'R', desc: 'Rotate 90° CW (with selection)' }`. These appear in addition to existing H (Pan/Hand) and R (Color Replace) entries — the dual meaning is context-dependent (selection active vs not).

### `isUIElement`
Add `.ed-select-bar` to the selector string.

### `deactivate()`
Add: `if (_selectBar) _selectBar.style.display = 'none';`

### `reset()`
Add: `_selectMode = 'rect'; _wandMask = null; if (_selectBar) _selectBar.style.display = 'none';`

### `removeUI()`
Add: `if (_selectBar) { _selectBar.remove(); _selectBar = null; }`

## Edge Cases

- **Wand on BG cell**: Clears selection, does nothing else.
- **Wand on single isolated cell**: Creates a 1x1 selection. Transforms produce identical results on 1x1.
- **Wand on huge region**: `_bfsRegion` has no limit for wand (unlike fill preview which caps at 50k). A 100x100 grid is 10k cells max — acceptable.
- **Transform buttons when no selection**: Disabled (opacity 0.4, no click handler fires).
- **Rotate changes dimensions**: A 12x8 selection becomes 8x12 after rotate. `_selRect` is updated by `_rotateBufferCW()` already. Dimensions label updates.
- **Mode persists**: `_selectMode` persists when switching away and back to select tool. Reset to 'rect' only on `reset()`.

## Files Modified

- **`static/editor.js`**: Selection bar HTML/CSS, `_selectMode` state, wand click handler in mousedown, bar show/hide in `_setTool`, `_updateSelectBarState()` helper, `isUIElement`, `deactivate()`, `reset()`, `removeUI()`.
- **`static/shortcut-help.js`**: Add H/V/R selection transform shortcuts to editor section.

No backend changes. No new files.
