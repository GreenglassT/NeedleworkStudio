# Chart Image Export — Design Spec

**Date**: 2026-03-14
**Status**: Approved

## Goal

Add a one-click "Export PNG" option to the Saved Patterns page that downloads a clean chart image (no UI) suitable for printing or sharing.

## User Flow

1. User opens Saved Patterns page
2. Clicks three-dot overflow menu on a pattern card
3. Clicks "Export PNG"
4. Button shows spinner while rendering
5. Browser downloads `{pattern-name}-chart.png`

Also available via bulk export dropdown when multiple patterns are selected.

## What Gets Rendered

- Full grid with colored cells + symbols (chart mode rendering)
- Row/column ruler labels along edges (numbered every 10 cells)
- Grid lines: thin every cell, bold every 10
- All stitch types: full, half, quarter, three-quarter, petite, backstitch, French knots, beads
- Fabric color background
- **Not included**: UI elements, legend sidebar, toolbar, any overlays

## Technical Approach

**Client-side rendering** — same pattern as existing PDF/SVG/OXS exports:

1. Fetch pattern data from `GET /api/saved-patterns/<slug>` (existing endpoint)
2. Create offscreen `<canvas>` sized to `(gutX + grid_w * cellPx + gutX) × (gutY + grid_h * cellPx + gutY)`
3. Render using existing `stitch-renderer.js` drawing primitives
4. Export via `canvas.toDataURL('image/png')`
5. Download via existing `downloadBlob()` utility

**Fixed cell size**: 32px per cell (no user picker — keeps UX dead simple).

**Gutter calculation** (matches pattern-viewer for ruler labels):
- `gutX = Math.round(12 * cellPx / 2.5)` — row label area
- `gutY = Math.round(8 * cellPx / 2.5)` — column label area

## New File

`static/chart-image-export.js` (~100-150 lines)

```
generateChartPNG(patternName, patternData, opts)
```

**Parameters**:
- `patternName` — string, used for filename
- `patternData` — `{ grid, grid_w, grid_h, legend, brand, fabric_color, part_stitches, backstitches, knots, beads }`
- `opts` — `{ cellPx?: 32 }` (extensible for future options)

**Rendering sequence**:
1. Create offscreen canvas
2. Fill background with `fabric_color` (default `#F5F0E8`)
3. Build lookup map from legend (dmc → {hex, symbol, name})
4. Draw cells: fill rect with hex color, draw symbol text with `contrastColor()`
5. Draw part stitches via `drawChartPartStitch()` / `drawChartHalfStitch()` etc.
6. Draw grid lines (thin + bold every 10)
7. Draw ruler labels (row/column numbers)
8. Draw backstitches via `drawChartBackstitch()`
9. Draw French knots via `drawChartFrenchKnot()`
10. Draw beads via `drawChartBead()`
11. Convert to PNG blob and trigger download

## UI Changes

### `templates/saved-patterns.html`

1. **Load script**: `<script src="{{ url_for('static', filename='chart-image-export.js') }}"></script>`

2. **Card overflow menu** — add after existing Export OXS button:
   ```html
   <button onclick="exportPNG('${p.slug}', this)">
     <i class="ti ti-photo-down"></i> Export PNG
   </button>
   ```

3. **Bulk export dropdown** — add PNG option:
   ```html
   <button onclick="bulkExport('png')">
     <i class="ti ti-photo-down"></i> PNG
   </button>
   ```

4. **`exportPNG()` function** — uses existing `_withExport()` helper:
   ```javascript
   function exportPNG(patternId, btn) {
       _withExport(patternId, btn, 'Export PNG', function(p) {
           generateChartPNG(p.name, _exportData(p));
       });
   }
   ```

5. **Bulk export handler** — add `'png'` case in `bulkExport()` switch.

## Dependencies

- `stitch-renderer.js` — chart drawing primitives (already loaded on saved-patterns page? If not, add it)
- `utils.js` — `contrastColor()`, `downloadBlob()`, `escHtml()` (already loaded)

## No Server Changes

All rendering is client-side. Uses existing `/api/saved-patterns/<slug>` endpoint.

## Rendering Functions Reused

| Function | Source | Purpose |
|----------|--------|---------|
| `drawChartPartStitch()` | stitch-renderer.js | Half/quarter/petite/three-quarter stitches |
| `drawChartBackstitch()` | stitch-renderer.js | Backstitch lines with dash patterns |
| `drawChartFrenchKnot()` | stitch-renderer.js | Knot circles with symbols |
| `drawChartBead()` | stitch-renderer.js | Bead ovals with symbols |
| `contrastColor()` | utils.js | Symbol text color (black/white) for cell background |
| `downloadBlob()` | utils.js | Trigger browser file download |
| `stitchIntersectionPx()` | stitch-renderer.js | Grid coord → canvas pixel mapping |

## Output

For a 200×113 pattern at 32px cells:
- Canvas size: ~6707 × 4078 px (including rulers)
- PNG file: ~2-5 MB (depends on complexity)
- Suitable for printing at 150+ DPI on letter/A4 paper
