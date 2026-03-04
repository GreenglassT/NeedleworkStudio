/* ── SVG Export for Cross-Stitch Patterns ─────────────────── */
/* Used by saved-patterns.html.                                */
/* Requires: contrastColor(), escHtml(), downloadBlob(),       */
/*           patternSlug(), fmtStitches() from utils.js        */

/**
 * Generate and download an SVG chart for a cross-stitch pattern.
 *
 * @param {string} patternName  — Title displayed above the grid.
 * @param {Object} patternData  — { grid, grid_w, grid_h, legend }.
 * @param {Object} [opts]       — Optional overrides.
 * @param {number} [opts.cellSize=16] — Pixels per stitch cell.
 */
function generatePatternSVG(patternName, patternData, opts) {
    const { grid, grid_w, grid_h, legend } = patternData;
    if (!grid || !grid_w || !grid_h) throw new Error('Invalid pattern data');

    const CELL = opts?.cellSize ?? 16;
    const RULER_W = 30;
    const RULER_H = 24;
    const TITLE_H = 20;
    const LEGEND_PAD = 20;
    const LEGEND_ROW_H = 20;
    const LEGEND_SWATCH = 14;
    const SYM_FONT = Math.max(7, Math.floor(CELL * 0.6));

    // Build lookup: dmc → { hex, symbol }
    const lookup = {};
    for (const e of legend) lookup[e.dmc] = { hex: e.hex || '#888888', symbol: e.symbol || '?' };

    // Sort legend by stitch count descending for the legend table
    const sortedLegend = legend.slice().sort((a, b) => (b.stitches || 0) - (a.stitches || 0));

    // Compute dimensions
    const gridPxW = grid_w * CELL;
    const gridPxH = grid_h * CELL;
    const legendH = 14 + sortedLegend.length * LEGEND_ROW_H + LEGEND_SWATCH + 4;
    const totalW = RULER_W + gridPxW;
    const totalH = TITLE_H + RULER_H + gridPxH + LEGEND_PAD + legendH;

    const p = []; // parts array — joined at end

    // SVG header
    p.push('<?xml version="1.0" encoding="UTF-8"?>');
    p.push('<svg xmlns="http://www.w3.org/2000/svg"');
    p.push(' width="' + totalW + '" height="' + totalH + '"');
    p.push(' viewBox="0 0 ' + totalW + ' ' + totalH + '">');

    // White background
    p.push('<rect width="' + totalW + '" height="' + totalH + '" fill="#ffffff"/>');

    // Offset for title
    const gridTop = TITLE_H + RULER_H;

    // Title
    p.push('<text x="' + (RULER_W + gridPxW / 2) + '" y="' + 15 + '"');
    p.push(' text-anchor="middle" font-family="serif" font-size="13" fill="#2a2218">');
    p.push(escHtml(patternName));
    p.push('</text>');

    // Ruler numbers — top (columns), every 10
    for (let c = 0; c <= grid_w; c += 10) {
        if (c === 0) continue;
        p.push('<text x="' + (RULER_W + c * CELL) + '" y="' + (TITLE_H + RULER_H - 6) + '"');
        p.push(' text-anchor="middle" font-family="monospace" font-size="8" fill="#888">');
        p.push(c + '</text>');
    }

    // Ruler numbers — left (rows), every 10
    for (let r = 0; r <= grid_h; r += 10) {
        if (r === 0) continue;
        p.push('<text x="' + (RULER_W - 4) + '" y="' + (gridTop + r * CELL + 1) + '"');
        p.push(' text-anchor="end" font-family="monospace" font-size="8" fill="#888">');
        p.push(r + '</text>');
    }

    // Colored cells + symbols
    for (let row = 0; row < grid_h; row++) {
        for (let col = 0; col < grid_w; col++) {
            const dmc = grid[row * grid_w + col];
            if (dmc === 'BG' || !dmc) continue;
            const info = lookup[dmc];
            if (!info) continue;

            const x = RULER_W + col * CELL;
            const y = gridTop + row * CELL;

            // Colored rectangle
            p.push('<rect x="' + x + '" y="' + y + '"');
            p.push(' width="' + CELL + '" height="' + CELL + '" fill="' + info.hex + '"/>');

            // Symbol text
            p.push('<text x="' + (x + CELL / 2) + '" y="' + (y + CELL / 2) + '"');
            p.push(' dy="0.35em" text-anchor="middle"');
            p.push(' font-family="sans-serif" font-size="' + SYM_FONT + '"');
            p.push(' fill="' + contrastColor(info.hex) + '">');
            p.push(escHtml(info.symbol));
            p.push('</text>');
        }
    }

    // ── Part stitches (half, quarter, three-quarter) ──
    const partStitches = patternData.part_stitches || [];
    for (const s of partStitches) {
        const info = lookup[s.dmc];
        if (!info) continue;
        const { sx, sy, dir } = _resolvePartFields(s);
        const cx = RULER_W + sx * CELL;
        const cy = gridTop + sy * CELL;
        const inset = CELL * 0.12;
        const lw = Math.max(1, CELL * 0.2);

        if (s.type === 'half') {
            let x1, y1, x2, y2;
            if (dir === 'fwd') {
                x1 = cx + inset; y1 = cy + CELL - inset;
                x2 = cx + CELL - inset; y2 = cy + inset;
            } else {
                x1 = cx + inset; y1 = cy + inset;
                x2 = cx + CELL - inset; y2 = cy + CELL - inset;
            }
            p.push('<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'"');
            p.push(' stroke="'+info.hex+'" stroke-width="'+lw+'" stroke-linecap="round"/>');
        } else if (s.type === 'quarter') {
            const corners = {
                TL: [cx + inset, cy + inset],
                TR: [cx + CELL - inset, cy + inset],
                BL: [cx + inset, cy + CELL - inset],
                BR: [cx + CELL - inset, cy + CELL - inset],
            };
            const [qx, qy] = corners[dir] || corners.TL;
            const mx = cx + CELL / 2, my = cy + CELL / 2;
            p.push('<line x1="'+qx+'" y1="'+qy+'" x2="'+mx+'" y2="'+my+'"');
            p.push(' stroke="'+info.hex+'" stroke-width="'+lw+'" stroke-linecap="round"/>');
        } else if (s.type === 'petite') {
            const half = CELL / 2;
            const offsets = { TL: [0, 0], TR: [half, 0], BL: [0, half], BR: [half, half] };
            const [ox, oy] = offsets[dir] || offsets.TL;
            const pi = CELL * 0.08;
            const x0 = cx + ox + pi, y0 = cy + oy + pi;
            const x1 = cx + ox + half - pi, y1 = cy + oy + half - pi;
            const plw = Math.max(0.5, CELL * 0.1);
            p.push('<line x1="'+x0+'" y1="'+y1+'" x2="'+x1+'" y2="'+y0+'"');
            p.push(' stroke="'+info.hex+'" stroke-width="'+plw+'" stroke-linecap="round"/>');
            p.push('<line x1="'+x0+'" y1="'+y0+'" x2="'+x1+'" y2="'+y1+'"');
            p.push(' stroke="'+info.hex+'" stroke-width="'+plw+'" stroke-linecap="round"/>');
        } else if (s.type === 'three_quarter') {
            const parts = dir.split('_');
            const halfDir = parts[0], shortCorner = parts[1];
            // Half part
            let x1, y1, x2, y2;
            if (halfDir === 'fwd') {
                x1 = cx + inset; y1 = cy + CELL - inset;
                x2 = cx + CELL - inset; y2 = cy + inset;
            } else {
                x1 = cx + inset; y1 = cy + inset;
                x2 = cx + CELL - inset; y2 = cy + CELL - inset;
            }
            p.push('<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'"');
            p.push(' stroke="'+info.hex+'" stroke-width="'+lw+'" stroke-linecap="round"/>');
            // Quarter part — single diagonal from corner to center
            const qCorners = {
                TL: [cx + inset, cy + inset],
                TR: [cx + CELL - inset, cy + inset],
                BL: [cx + inset, cy + CELL - inset],
                BR: [cx + CELL - inset, cy + CELL - inset],
            };
            const [qx, qy] = qCorners[shortCorner] || qCorners.TL;
            const mx = cx + CELL / 2, my = cy + CELL / 2;
            p.push('<line x1="'+qx+'" y1="'+qy+'" x2="'+mx+'" y2="'+my+'"');
            p.push(' stroke="'+info.hex+'" stroke-width="'+lw+'" stroke-linecap="round"/>');
        }
    }

    // Thin gridlines (every cell)
    for (let c = 0; c <= grid_w; c++) {
        const x = RULER_W + c * CELL;
        p.push('<line x1="' + x + '" y1="' + gridTop + '"');
        p.push(' x2="' + x + '" y2="' + (gridTop + gridPxH) + '"');
        p.push(' stroke="#000" stroke-opacity="0.15" stroke-width="0.5"/>');
    }
    for (let r = 0; r <= grid_h; r++) {
        const y = gridTop + r * CELL;
        p.push('<line x1="' + RULER_W + '" y1="' + y + '"');
        p.push(' x2="' + (RULER_W + gridPxW) + '" y2="' + y + '"');
        p.push(' stroke="#000" stroke-opacity="0.15" stroke-width="0.5"/>');
    }

    // Bold gridlines (every 10 stitches)
    for (let c = 0; c <= grid_w; c += 10) {
        const x = RULER_W + c * CELL;
        p.push('<line x1="' + x + '" y1="' + gridTop + '"');
        p.push(' x2="' + x + '" y2="' + (gridTop + gridPxH) + '"');
        p.push(' stroke="#000" stroke-opacity="0.55" stroke-width="1.5"/>');
    }
    for (let r = 0; r <= grid_h; r += 10) {
        const y = gridTop + r * CELL;
        p.push('<line x1="' + RULER_W + '" y1="' + y + '"');
        p.push(' x2="' + (RULER_W + gridPxW) + '" y2="' + y + '"');
        p.push(' stroke="#000" stroke-opacity="0.55" stroke-width="1.5"/>');
    }

    // ── Backstitches ──
    const backstitches = patternData.backstitches || [];
    for (const b of backstitches) {
        const info = lookup[b.dmc];
        if (!info) continue;
        const px1 = RULER_W + b.x1 * CELL;
        const py1 = gridTop + b.y1 * CELL;
        const px2 = RULER_W + b.x2 * CELL;
        const py2 = gridTop + b.y2 * CELL;
        const bsLw = Math.max(1.5, CELL * 0.16);
        p.push('<line x1="'+px1+'" y1="'+py1+'" x2="'+px2+'" y2="'+py2+'"');
        p.push(' stroke="'+info.hex+'" stroke-width="'+bsLw+'" stroke-linecap="round"/>');
    }

    // ── French knots ──
    const knots = patternData.knots || [];
    for (const k of knots) {
        const info = lookup[k.dmc];
        if (!info) continue;
        const kx = RULER_W + k.x * CELL;
        const ky = gridTop + k.y * CELL;
        const kr = Math.max(1.5, CELL * 0.18);
        p.push('<circle cx="'+kx+'" cy="'+ky+'" r="'+kr+'"');
        p.push(' fill="'+info.hex+'" stroke="'+darkenHex(info.hex,0.5)+'" stroke-width="0.5"/>');
    }

    // ── Beads ──
    const beads = patternData.beads || [];
    for (const b of beads) {
        const info = lookup[b.dmc];
        if (!info) continue;
        const bx = RULER_W + b.x * CELL + CELL / 2;
        const by = gridTop + b.y * CELL + CELL / 2;
        const brx = Math.max(1.5, CELL * 0.18);
        const bry = Math.max(2, CELL * 0.28);
        p.push('<ellipse cx="'+bx+'" cy="'+by+'" rx="'+brx+'" ry="'+bry+'"');
        p.push(' fill="'+info.hex+'" stroke="'+darkenHex(info.hex,0.5)+'" stroke-width="0.5"/>');
    }

    // ── Legend section ──
    const legendY = gridTop + gridPxH + LEGEND_PAD;

    p.push('<text x="' + RULER_W + '" y="' + (legendY + 2) + '"');
    p.push(' font-family="serif" font-size="11" font-weight="bold" fill="#555">Legend</text>');

    const COL_SYM = RULER_W;
    const COL_SWATCH = RULER_W + 20;
    const COL_DMC = COL_SWATCH + LEGEND_SWATCH + 6;
    const COL_NAME = COL_DMC + 46;
    const COL_STITCHES = Math.min(Math.max(COL_NAME + 120, totalW - 60), totalW - 10);

    for (let i = 0; i < sortedLegend.length; i++) {
        const e = sortedLegend[i];
        const ry = legendY + 14 + i * LEGEND_ROW_H;

        // Symbol
        p.push('<text x="' + (COL_SYM + 7) + '" y="' + (ry + LEGEND_SWATCH / 2) + '"');
        p.push(' dy="0.35em" text-anchor="middle"');
        p.push(' font-family="sans-serif" font-size="10" fill="#333">');
        p.push(escHtml(e.symbol || '?'));
        p.push('</text>');

        // Swatch
        p.push('<rect x="' + COL_SWATCH + '" y="' + ry + '"');
        p.push(' width="' + LEGEND_SWATCH + '" height="' + LEGEND_SWATCH + '"');
        p.push(' fill="' + (e.hex || '#888') + '" stroke="#ccc" stroke-width="0.5"/>');

        // DMC number
        p.push('<text x="' + COL_DMC + '" y="' + (ry + LEGEND_SWATCH / 2) + '"');
        p.push(' dy="0.35em" font-family="monospace" font-size="9" fill="#333">');
        p.push(escHtml(e.dmc));
        p.push('</text>');

        // Thread name
        p.push('<text x="' + COL_NAME + '" y="' + (ry + LEGEND_SWATCH / 2) + '"');
        p.push(' dy="0.35em" font-family="sans-serif" font-size="9" fill="#555">');
        p.push(escHtml(e.name || ''));
        p.push('</text>');

        // Stitch count
        p.push('<text x="' + COL_STITCHES + '" y="' + (ry + LEGEND_SWATCH / 2) + '"');
        p.push(' dy="0.35em" font-family="monospace" font-size="9" fill="#888">');
        p.push(fmtStitches(e.stitches || 0) + ' st');
        p.push('</text>');
    }

    p.push('</svg>');

    // Download
    const filename = patternSlug(patternName) + '_' + grid_w + 'x' + grid_h + '.svg';
    downloadBlob(p.join('\n'), filename, 'image/svg+xml');
}
