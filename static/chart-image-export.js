/* ===== chart-image-export.js — Export chart as PNG image ===== */
/* Exposes: generateChartPNG(patternName, patternData, opts) */

function generateChartPNG(patternName, patternData, opts) {
    opts = opts || {};
    var cellPx = opts.cellPx || 32;
    var mode   = opts.viewMode || 'chart';

    var grid   = patternData.grid;
    var grid_w = patternData.grid_w;
    var grid_h = patternData.grid_h;
    var legend = patternData.legend;
    var fabColor = patternData.fabric_color || '#F5F0E8';

    // Gutter sizes for ruler labels (matches pattern-viewer formula)
    var gutX = Math.round(12 * cellPx / 2.5);
    var gutY = Math.round(8  * cellPx / 2.5);
    var gridEndX = gutX + grid_w * cellPx;
    var gridEndY = gutY + grid_h * cellPx;
    var W = gridEndX + gutX;
    var H = gridEndY + gutY;

    // Build lookup: dmc → { hex, symbol, name, dashIdx }
    var lookup = {};
    for (var li = 0; li < legend.length; li++) {
        var e = legend[li];
        lookup[String(e.dmc)] = {
            hex: e.hex || '#888888',
            symbol: e.symbol || '?',
            name: e.name || '',
            dashIdx: 0,
        };
    }

    // Assign backstitch dash indices
    var bsDmcs = [];
    var bsList = patternData.backstitches || [];
    for (var bdi = 0; bdi < bsList.length; bdi++) {
        var d = String(bsList[bdi].dmc);
        if (bsDmcs.indexOf(d) === -1) bsDmcs.push(d);
    }
    for (var di = 0; di < bsDmcs.length; di++) {
        if (lookup[bsDmcs[di]]) lookup[bsDmcs[di]].dashIdx = di + 1;
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
        if (!blob) { alert('Chart too large to export as PNG.'); return; }
        downloadBlob(blob, patternSlug(patternName) + '-chart.png', 'image/png');
    }, 'image/png');
}
