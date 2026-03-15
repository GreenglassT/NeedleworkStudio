# Chart Image Export Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Export PNG" button to the Saved Patterns page that renders the chart to an offscreen canvas and downloads it as a PNG image.

**Architecture:** New `static/chart-image-export.js` file (~120 lines) with a single `generateChartPNG()` function that creates an offscreen canvas, renders the chart using existing `stitch-renderer.js` primitives with `gutX`/`gutY` for rulers, and exports via `canvas.toDataURL()`. Integrated into `saved-patterns.html` via existing `_withExport()` helper.

**Tech Stack:** Canvas 2D API, existing stitch-renderer.js drawing functions, existing utils.js helpers

**Spec:** `docs/superpowers/specs/2026-03-14-chart-image-export-design.md`

---

## Task 1: Create `chart-image-export.js`

**Files:**
- Create: `static/chart-image-export.js`

**Dependencies (all globally available on saved-patterns page):**
- `stitch-renderer.js`: `drawChartPartStitch`, `drawChartBackstitch`, `drawChartFrenchKnot`, `drawChartBead`, `stitchIntersectionPx`, `stitchCellCenterPx`, `_resolvePartFields`, `drawStitch`, `drawThreadPartStitch`, `drawBackstitch`, `drawFrenchKnot`, `drawBead`
- `utils.js`: `contrastColor`, `downloadBlob`, `drawStitchFabric`, `drawStitch`, `patternSlug`

- [ ] **Step 1: Create the file with the `generateChartPNG` function**

```javascript
/* ===== chart-image-export.js — Export chart as PNG image ===== */
/* Exposes: generateChartPNG(patternName, patternData, opts) */

function generateChartPNG(patternName, patternData, opts) {
    opts = opts || {};
    const cellPx = opts.cellPx || 32;
    const mode   = opts.viewMode || 'chart';  // 'chart' or 'thread'

    const { grid, grid_w, grid_h, legend, brand } = patternData;
    const fabColor = patternData.fabric_color || '#F5F0E8';

    // Gutter sizes for ruler labels (matches pattern-viewer formula)
    const gutX = Math.round(12 * cellPx / 2.5);
    const gutY = Math.round(8  * cellPx / 2.5);
    const gridEndX = gutX + grid_w * cellPx;
    const gridEndY = gutY + grid_h * cellPx;
    const W = gridEndX + gutX;
    const H = gridEndY + gutY;

    // Build lookup: dmc → { hex, symbol, name, dashIdx }
    const lookup = {};
    for (const e of legend) {
        lookup[String(e.dmc)] = {
            hex: e.hex || '#888888',
            symbol: e.symbol || '?',
            name: e.name || '',
            dashIdx: 0,
        };
    }
    // Assign backstitch dash indices
    const bsDmcs = [];
    if (patternData.backstitches) {
        for (const bs of patternData.backstitches) {
            const d = String(bs.dmc);
            if (!bsDmcs.includes(d)) bsDmcs.push(d);
        }
        bsDmcs.forEach(function(dmc, i) { if (lookup[dmc]) lookup[dmc].dashIdx = i + 1; });
    }

    // Create offscreen canvas
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');

    // White background (ruler area)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Ruler labels — every 10th col/row, all four sides
    var lblSize = Math.max(7, Math.round(cellPx * 0.5));
    ctx.fillStyle = '#999999';
    ctx.font = lblSize + 'px "IBM Plex Mono",monospace';
    ctx.textBaseline = 'middle';

    ctx.textAlign = 'center';
    for (var col = 0; col < grid_w; col++) {
        if (col % 10 === 0) {
            var cx = gutX + col * cellPx + cellPx / 2;
            ctx.fillText(String(col), cx, gutY / 2);
            ctx.fillText(String(col), cx, gridEndY + gutY / 2);
        }
    }
    for (var row = 0; row < grid_h; row++) {
        if (row % 10 === 0) {
            var cy = gutY + row * cellPx + cellPx / 2;
            ctx.textAlign = 'right';
            ctx.fillText(String(row), gutX - 3, cy);
            ctx.textAlign = 'left';
            ctx.fillText(String(row), gridEndX + 3, cy);
        }
    }

    // Cells
    if (mode === 'thread') {
        ctx.fillStyle = fabColor;
        ctx.fillRect(gutX, gutY, grid_w * cellPx, grid_h * cellPx);
        drawStitchFabric(ctx, W, H, cellPx, grid_w, grid_h, fabColor, gutX, gutY);
        for (var r = 0; r < grid_h; r++) {
            for (var c = 0; c < grid_w; c++) {
                var dmc = grid[r * grid_w + c];
                if (dmc === 'BG') continue;
                var info = lookup[String(dmc)];
                if (!info) continue;
                drawStitch(ctx, gutX + c * cellPx, gutY + r * cellPx, cellPx, info.hex, fabColor);
            }
        }
    } else {
        var symSize = Math.max(6, Math.floor(cellPx * 0.72));
        ctx.font = symSize + 'px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols","IBM Plex Mono",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (var r2 = 0; r2 < grid_h; r2++) {
            for (var c2 = 0; c2 < grid_w; c2++) {
                var dmc2 = grid[r2 * grid_w + c2];
                if (dmc2 === 'BG') continue;
                var info2 = lookup[String(dmc2)];
                if (!info2) continue;
                var x = gutX + c2 * cellPx, y = gutY + r2 * cellPx;
                ctx.fillStyle = info2.hex;
                ctx.fillRect(x, y, cellPx, cellPx);
                ctx.fillStyle = contrastColor(info2.hex);
                ctx.fillText(info2.symbol, x + cellPx / 2, y + cellPx / 2);
            }
        }
    }

    // Part stitches
    var parts = patternData.part_stitches || [];
    for (var pi = 0; pi < parts.length; pi++) {
        var ps = parts[pi];
        var pInfo = lookup[String(ps.dmc)];
        if (!pInfo) continue;
        var rf = _resolvePartFields(ps);
        var px = gutX + rf.sx * cellPx, py = gutY + rf.sy * cellPx;
        if (mode === 'thread') drawThreadPartStitch(ctx, px, py, cellPx, ps, pInfo.hex);
        else drawChartPartStitch(ctx, px, py, cellPx, ps, pInfo.hex, pInfo.symbol);
    }

    // Thin gridlines — batched
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (var gc = 0; gc <= grid_w; gc++) { var gx = gutX + gc * cellPx; ctx.moveTo(gx, gutY); ctx.lineTo(gx, gridEndY); }
    for (var gr = 0; gr <= grid_h; gr++) { var gy = gutY + gr * cellPx; ctx.moveTo(gutX, gy); ctx.lineTo(gridEndX, gy); }
    ctx.stroke();

    // Bold gridlines every 10 — batched
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(1, cellPx / 7);
    ctx.beginPath();
    for (var bc = 0; bc <= grid_w; bc += 10) { var bx = gutX + bc * cellPx; ctx.moveTo(bx, gutY); ctx.lineTo(bx, gridEndY); }
    for (var br = 0; br <= grid_h; br += 10) { var by = gutY + br * cellPx; ctx.moveTo(gutX, by); ctx.lineTo(gridEndX, by); }
    ctx.stroke();

    // Backstitches
    var bsList = patternData.backstitches || [];
    for (var bi = 0; bi < bsList.length; bi++) {
        var bs = bsList[bi];
        var bsInfo = lookup[String(bs.dmc)];
        if (!bsInfo) continue;
        var p1 = stitchIntersectionPx(bs.x1, bs.y1, gutX, gutY, cellPx);
        var p2 = stitchIntersectionPx(bs.x2, bs.y2, gutX, gutY, cellPx);
        if (mode === 'chart') drawChartBackstitch(ctx, p1.x, p1.y, p2.x, p2.y, bsInfo.hex, cellPx, bsInfo.dashIdx);
        else drawBackstitch(ctx, p1.x, p1.y, p2.x, p2.y, bsInfo.hex, cellPx);
    }

    // French knots
    var knotList = patternData.knots || [];
    for (var ki = 0; ki < knotList.length; ki++) {
        var k = knotList[ki];
        var kInfo = lookup[String(k.dmc)];
        if (!kInfo) continue;
        var kp = stitchIntersectionPx(k.x, k.y, gutX, gutY, cellPx);
        if (mode === 'chart') drawChartFrenchKnot(ctx, kp.x, kp.y, kInfo.hex, cellPx, kInfo.symbol);
        else drawFrenchKnot(ctx, kp.x, kp.y, kInfo.hex, cellPx);
    }

    // Beads
    var beadList = patternData.beads || [];
    for (var bei = 0; bei < beadList.length; bei++) {
        var b = beadList[bei];
        var bInfo = lookup[String(b.dmc)];
        if (!bInfo) continue;
        var bp = stitchCellCenterPx(b.x, b.y, gutX, gutY, cellPx);
        if (mode === 'chart') drawChartBead(ctx, bp.x, bp.y, bInfo.hex, cellPx, bInfo.symbol);
        else drawBead(ctx, bp.x, bp.y, bInfo.hex, cellPx);
    }

    // Export as PNG
    canvas.toBlob(function(blob) {
        downloadBlob(blob, patternSlug(patternName) + '-chart.png', 'image/png');
    }, 'image/png');
}
```

- [ ] **Step 2: Commit**

```bash
git add static/chart-image-export.js
git commit -m "feat: add chart-image-export.js for PNG chart export"
```

---

## Task 2: Wire up UI in `saved-patterns.html`

**Files:**
- Modify: `templates/saved-patterns.html`
  - Line ~794: Add script tag (after `oxs-export.js`)
  - Line ~1201: Add "Export PNG" to card overflow menu (after Export JSON)
  - Line ~875: Add PNG option to bulk export dropdown (after JSON)
  - Line ~1413: Add `exportPNG()` function (after `exportOXS`)
  - Line ~1871: Add PNG case in `bulkExport()` loop

- [ ] **Step 1: Add script tag**

After `oxs-export.js` script tag (line ~794), add:
```html
<script src="{{ url_for('static', filename='chart-image-export.js') }}"></script>
```

- [ ] **Step 2: Add "Export PNG" to card overflow menu**

After the Export JSON button (line ~1201), add:
```html
<button onclick="exportPNG('${p.slug}', this)">Export PNG</button>
```

- [ ] **Step 3: Add PNG to bulk export dropdown**

After the JSON button (line ~875), add:
```html
<button onclick="bulkExport('png')">PNG</button>
```

- [ ] **Step 4: Add `exportPNG()` function**

After the `exportOXS` function (line ~1413), add:
```javascript
function exportPNG(patternId, btn) {
    return _withExport(patternId, btn, 'PNG', function(p) {
        generateChartPNG(p.name, _exportData(p));
    });
}
```

- [ ] **Step 5: Add PNG case in `bulkExport()` loop**

In the `bulkExport()` function's sequential export loop (line ~1871), add a PNG case:

Change:
```javascript
else if (format === 'oxs') generatePatternOXS(p.name, data);
```
To:
```javascript
else if (format === 'oxs') generatePatternOXS(p.name, data);
else if (format === 'png') generateChartPNG(p.name, data);
```

- [ ] **Step 6: Commit**

```bash
git add templates/saved-patterns.html
git commit -m "feat: wire up Export PNG button on saved patterns page"
```

---

## Task 3: Manual verification

- [ ] **Step 1: Restart prod**

```bash
kill -HUP $(pgrep -f 'gunicorn.*app:app' | head -1)
```
Wait 2 seconds for worker respawn.

- [ ] **Step 2: Test single export**

Open saved patterns page. Click three-dot menu on a pattern card. Click "Export PNG". Verify:
- Button shows "…" spinner while rendering
- PNG file downloads with correct name (`{slug}-chart.png`)
- Image contains chart grid with colors, symbols, ruler labels, grid lines
- No UI elements in the image

- [ ] **Step 3: Test bulk export**

Select multiple patterns. Click Export dropdown in bulk bar. Click PNG. Verify each pattern downloads as a separate PNG.

- [ ] **Step 4: Verify large pattern**

Test with a large pattern (200×113) to confirm canvas renders without hitting browser limits at 32px cells (~6700×4100 px).
