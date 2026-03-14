# Confetti Cleanup Tool — Design Spec

**Date**: 2026-03-14
**Status**: Approved

## Problem

Image-to-pattern conversion produces "confetti" — isolated single stitches of a color surrounded by different colors. These are tedious to stitch and visually noisy. Users need a way to clean them up without manually recoloring each cell.

## Solution

A new editor tool that detects and removes confetti stitches, replacing them with their most common neighboring color.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Global (whole pattern) only |
| Detection | Connected component analysis, adjustable cluster threshold 1-10 |
| Adjacency | 4-neighbor (up/down/left/right) |
| Replacement | Most common non-BG neighbor color; ties broken clockwise from top |
| Preview | Overlay highlight on affected cells with count badge |
| UI | Toolbar tool button with inline options bar |
| Shortcut | `C` (bare key, lowercase) |
| Implementation | All in editor.js, no backend changes |

## UI Design

### Toolbar Button
- New button labeled "Confetti" in the utility tools group (3rd `tool-group` div, after Select).
- Icon: Tabler `ti-sparkles`.
- Keyboard shortcut: `C` (bare key). Added to `shortcut-help.js` cheat sheet.

### Options Bar
When the confetti tool is active, a floating options bar appears below the toolbar (same pattern as the replace panel — absolutely positioned using `_subTop`, shown/hidden via `_setTool`):

```
[ Max cluster: [===3====] ]  [ 47 cells ]  [ Apply ]  [ Cancel ]
```

- **Cluster slider**: Range 1-10, default 3. Label updates live: "Max cluster: N".
- **Cell count**: Shows how many cells will be replaced.
- **Apply**: Commits changes, pushes to undo stack, exits tool.
- **Cancel**: Clears preview, exits tool.

### Preview
- Confetti cells are highlighted on the overlay canvas with a semi-transparent red tint (`rgba(255, 60, 60, 0.4)`).
- Preview updates live as the slider changes, debounced at ~100ms.
- Escape key cancels (equivalent to clicking Cancel).

## Algorithm

### Detection: `_findConfetti(grid, w, h, threshold)`

Pure function. Returns `Map<cellIndex, replacementColor>`.

1. **Build visited set** — tracks which cells have been assigned to a component.
2. **For each unvisited non-BG cell**:
   a. Flood-fill (BFS/queue) using 4-neighbor adjacency to find all connected cells of the same color.
   b. If the component size <= `threshold`, mark all cells in the component as confetti.
3. **For each confetti cell**, compute replacement (two-pass: detect all confetti first, then compute replacements):
   a. Collect colors of 4-neighbors that are non-BG and not themselves confetti.
   b. Pick the most common. Break ties by first occurrence clockwise from top (top, right, bottom, left).
   c. If no valid neighbor exists (all BG or all confetti), skip the cell (leave unchanged).

### Complexity
- O(n) where n = total cells. Each cell visited at most once during component detection.

## Edge Cases

- **BG cells**: Never flagged as confetti.
- **Cells with only BG neighbors**: Left unchanged (no valid replacement color).
- **Part stitches** (half, quarter, 3/4, backstitch, knots, beads): Untouched. Confetti cleanup only operates on full stitches in `grid[]`.
- **Colors reduced to zero usage**: Stay in the legend. User can manually remove unused colors.
- **Entire pattern is one color**: No confetti detected, show "0 cells".

## Integration Points

### Tool State
- `activeTool === 'confetti'`
- State variables: `_confettiThreshold` (int), `_confettiMap` (Map), `_confettiBar` (options bar DOM reference).

### Tool Cleanup in `_setTool`
When switching away from confetti (i.e., `activeTool` was `'confetti'` before the switch):
- Clear `_confettiMap`.
- Hide and remove `_confettiBar` options bar.
- Clear confetti preview from overlay canvas.
This follows the same pattern as other tools (e.g., `_clearFillPreview()` for fill, `_hideTextPanel()` for text).

### Canvas Interaction
When `activeTool === 'confetti'`, mousedown on the canvas is a no-op (the tool is controlled entirely via the options bar slider/buttons, not canvas clicks). Add `case 'confetti': break;` in the mousedown handler.

### Keyboard
- `C` key: calls `_setTool('confetti')` (added in the bare-key shortcut block alongside p/e/f/etc.).
- `Escape` when confetti is active: cancels (clears preview, switches to pan).
- Add "Confetti Cleanup" entry to `shortcut-help.js` in the Tools section.

### Undo
- `pushUndo()` called before applying changes (single undo reverts the entire cleanup).

### Commit
- After applying, calls `_commitEdit()` which triggers re-render, legend recount, and auto-save.

### Other Integration Points
- **`isUIElement`**: Add `_confettiBar`'s class to the selector so clicks on the options bar don't trigger canvas interactions.
- **`reset()`**: Clear `_confettiMap`, hide `_confettiBar`, reset `_confettiThreshold` to default.
- **`removeUI()`**: Remove `_confettiBar` DOM element (same as `_replacePanel.remove()`).
- **`_redrawOverlay()`**: Call `_drawConfettiPreview()` from within the existing overlay redraw cycle (same pattern as fill preview, line preview, etc.).

## Files Modified

- **`static/editor.js`**: All new logic — `_findConfetti()`, `_drawConfettiPreview()`, tool activation/deactivation, cleanup in `_setTool`, `case 'confetti'` in mousedown, keyboard shortcut, options bar HTML, slider handling, apply/cancel handlers.
- **`static/shortcut-help.js`**: Add "Confetti Cleanup (C)" to the Tools section.

No backend changes. No new files beyond the above edits.
