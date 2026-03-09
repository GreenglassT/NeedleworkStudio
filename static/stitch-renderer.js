/* stitch-renderer.js — Canvas drawing primitives for all stitch types.
 * Requires: darkenHex(), lightenHex(), contrastColor() from utils.js
 * Loaded after utils.js, before page scripts.
 */

/* ── Coordinate helpers ────────────────────────────────── */

/** Convert grid intersection (col, row) to canvas pixel position. */
function stitchIntersectionPx(col, row, gutX, gutY, cellPx) {
    return { x: gutX + col * cellPx, y: gutY + row * cellPx };
}

/** Convert cell (col, row) to its center canvas pixel position. */
function stitchCellCenterPx(col, row, gutX, gutY, cellPx) {
    return { x: gutX + col * cellPx + cellPx / 2, y: gutY + row * cellPx + cellPx / 2 };
}

/* ── Full stitch ───────────────────────────────────────── */

/**
 * Draw a full stitch (colored rectangle + optional symbol).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x  — top-left pixel X of cell
 * @param {number} y  — top-left pixel Y of cell
 * @param {number} cp — cell size in pixels
 * @param {string} hex — fill color
 * @param {string} [symbol] — symbol character
 * @param {Object} [opts]
 * @param {boolean} [opts.showSymbol=true]
 * @param {string}  [opts.symbolFont]
 */
function drawFullStitch(ctx, x, y, cp, hex, symbol, opts) {
    ctx.fillStyle = hex;
    ctx.fillRect(x, y, cp, cp);
    if ((opts?.showSymbol !== false) && symbol && cp >= 8) {
        const fontSize = Math.max(6, Math.floor(cp * 0.72));
        ctx.save();
        ctx.font = (opts?.symbolFont) ||
            (fontSize + 'px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols","IBM Plex Mono",sans-serif');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = contrastColor(hex);
        ctx.fillText(symbol, x + cp / 2, y + cp / 2);
        ctx.restore();
    }
}

/* ── Half stitch ───────────────────────────────────────── */

/**
 * Draw a half stitch (single diagonal thread).
 * @param {string} direction — 'fwd' (/) or 'bwd' (\)
 */
function drawHalfStitch(ctx, x, y, cp, hex, direction) {
    const lw = Math.max(1.0, cp * 0.325);
    const inset = Math.max(cp * 0.12, lw / 2);
    let x0, y0, x1, y1;
    if (direction === 'fwd') {
        x0 = x + inset; y0 = y + cp - inset;
        x1 = x + cp - inset; y1 = y + inset;
    } else {
        x0 = x + inset; y0 = y + inset;
        x1 = x + cp - inset; y1 = y + cp - inset;
    }
    ctx.save();
    ctx.lineCap = 'round';
    if (cp >= 6) {
        _drawMatteFiber(ctx, x0, y0, x1, y1, hex, lw, cp);
    } else {
        ctx.strokeStyle = hex;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.restore();
}

/* ── Quarter stitch ────────────────────────────────────── */

/**
 * Draw a quarter stitch (single diagonal from corner to cell center).
 * @param {string} corner — 'TL' | 'TR' | 'BL' | 'BR'
 */
function drawQuarterStitch(ctx, x, y, cp, hex, corner) {
    const lw = Math.max(1.0, cp * 0.325);
    const inset = Math.max(cp * 0.12, lw / 2);
    const mx = x + cp / 2, my = y + cp / 2;
    const pts = {
        TL: { x0: x + inset,      y0: y + inset },
        TR: { x0: x + cp - inset, y0: y + inset },
        BL: { x0: x + inset,      y0: y + cp - inset },
        BR: { x0: x + cp - inset, y0: y + cp - inset },
    };
    const p = pts[corner] || pts.TL;
    ctx.save();
    ctx.lineCap = 'round';
    if (cp >= 6) {
        _drawMatteFiber(ctx, p.x0, p.y0, mx, my, hex, lw, cp);
    } else {
        ctx.strokeStyle = hex;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(mx, my); ctx.stroke();
    }
    ctx.restore();
}

/* ── Petite stitch ────────────────────────────────────── */

/**
 * Draw a petite stitch (miniature X within one quadrant of a cell).
 * @param {string} corner — 'TL' | 'TR' | 'BL' | 'BR'
 */
function drawPetiteStitch(ctx, x, y, cp, hex, corner) {
    const lw = Math.max(0.8, cp * 0.18);
    const half = cp / 2;
    const inset = Math.max(cp * 0.08, lw / 2);
    const offsets = { TL: [0, 0], TR: [half, 0], BL: [0, half], BR: [half, half] };
    const [ox, oy] = offsets[corner] || offsets.TL;
    const x0 = x + ox + inset, y0 = y + oy + inset;
    const x1 = x + ox + half - inset, y1 = y + oy + half - inset;
    ctx.save();
    ctx.lineCap = 'round';
    if (cp >= 12) {
        _drawMatteFiber(ctx, x0, y1, x1, y0, hex, lw, cp); // fwd diagonal
        _drawMatteFiber(ctx, x0, y0, x1, y1, hex, lw, cp); // bwd diagonal (on top)
    } else {
        ctx.strokeStyle = hex;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1, y0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.restore();
}

/* ── Three-quarter stitch ──────────────────────────────── */

/**
 * Draw a three-quarter stitch (full half diagonal + quarter X in one corner).
 * @param {string} halfDir — 'fwd' (/) or 'bwd' (\)
 * @param {string} shortCorner — 'TL' | 'TR' | 'BL' | 'BR'
 */
function drawThreeQuarterStitch(ctx, x, y, cp, hex, halfDir, shortCorner) {
    drawHalfStitch(ctx, x, y, cp, hex, halfDir);
    drawQuarterStitch(ctx, x, y, cp, hex, shortCorner);
}

/* ── Backstitch ────────────────────────────────────────── */

/** Dash patterns for chart-mode backstitches, scaled by cell size. */
const _BS_DASH_PATTERNS = [
    [],               // solid
    [6, 3],           // dashed
    [2, 3],           // dotted
    [6, 3, 2, 3],    // dash-dot
    [8, 2, 2, 2, 2, 2], // dash-dot-dot
    [4, 4],           // even dash
];

/**
 * Draw a backstitch line between two grid intersections.
 * @param {number} ix1,iy1 — pixel coords of start intersection
 * @param {number} ix2,iy2 — pixel coords of end intersection
 */
function drawBackstitch(ctx, ix1, iy1, ix2, iy2, hex, cp) {
    const lw = cp >= 4 ? Math.max(1.5, cp * 0.225) : 1.0;
    ctx.save();
    ctx.lineCap = 'round';
    if (cp >= 6) {
        _drawMatteFiber(ctx, ix1, iy1, ix2, iy2, hex, lw, cp);
    } else {
        ctx.strokeStyle = hex;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(ix1, iy1); ctx.lineTo(ix2, iy2); ctx.stroke();
    }
    ctx.restore();
}

/**
 * Chart-mode backstitch: colored line with a per-color dash pattern.
 * @param {number} dashIdx — index into _BS_DASH_PATTERNS (0 = solid, 1 = dashed, …)
 */
function drawChartBackstitch(ctx, ix1, iy1, ix2, iy2, hex, cp, dashIdx) {
    const lw = cp >= 4 ? Math.max(1.5, cp * 0.18) : 1.0;
    const scale = Math.max(1, cp / 12);
    const pattern = _BS_DASH_PATTERNS[dashIdx % _BS_DASH_PATTERNS.length] || [];
    const scaled = pattern.map(v => v * scale);
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.setLineDash(scaled);
    ctx.strokeStyle = hex;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(ix1, iy1);
    ctx.lineTo(ix2, iy2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
}

/* ── French knot ───────────────────────────────────────── */

/**
 * Draw a French knot at a grid intersection.
 * @param {number} ix,iy — pixel coords of the intersection
 */
function drawFrenchKnot(ctx, ix, iy, hex, cp) {
    const r = Math.max(1.5, cp * 0.22);
    ctx.save();
    if (cp >= 8) {
        // Same t-based scaling as _drawMatteFiber for visual consistency
        const t = Math.min(1, Math.max(0, (cp - 8) / 17));
        const outlineDk = 0.72 - t * 0.22;
        const edgeFactor = 0.82 - t * 0.14;

        // Dark outline ring
        ctx.beginPath();
        ctx.arc(ix, iy, r, 0, Math.PI * 2);
        ctx.fillStyle = darkenHex(hex, outlineDk);
        ctx.fill();

        // Matte radial gradient fill (slightly smaller to reveal outline)
        const rg = ctx.createRadialGradient(ix, iy, 0, ix, iy, r * 0.85);
        rg.addColorStop(0, hex);
        rg.addColorStop(0.55, hex);
        rg.addColorStop(1, darkenHex(hex, edgeFactor));
        ctx.beginPath();
        ctx.arc(ix, iy, r * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = rg;
        ctx.fill();

        // Twist texture: two thin arcs at larger sizes
        if (cp >= 15) {
            ctx.lineWidth = Math.max(0.5, cp * 0.025);
            ctx.strokeStyle = 'rgba(0,0,0,0.12)';
            ctx.beginPath();
            ctx.arc(ix, iy, r * 0.55, -0.8, 0.8);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            ctx.arc(ix, iy, r * 0.55, Math.PI - 0.8, Math.PI + 0.8);
            ctx.stroke();
        }
    } else {
        ctx.beginPath();
        ctx.arc(ix, iy, r, 0, Math.PI * 2);
        ctx.fillStyle = hex;
        ctx.fill();
    }
    ctx.restore();
}

/**
 * Chart-mode French knot: colored circle with symbol inside.
 * Slightly larger than thread-mode to fit the symbol legibly.
 */
function drawChartFrenchKnot(ctx, ix, iy, hex, cp, symbol, opts) {
    const r = Math.max(2.5, cp * 0.24);
    ctx.save();
    ctx.beginPath();
    ctx.arc(ix, iy, r, 0, Math.PI * 2);
    ctx.fillStyle = hex;
    ctx.fill();
    ctx.strokeStyle = darkenHex(hex, 0.55);
    ctx.lineWidth = Math.max(0.5, cp * 0.05);
    ctx.stroke();
    if ((opts?.showSymbol !== false) && symbol && r >= 3.5) {
        const fontSize = Math.max(5, Math.floor(r * 1.3));
        ctx.font = (opts?.symbolFont) ||
            (fontSize + 'px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols","IBM Plex Mono",sans-serif');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = contrastColor(hex);
        ctx.fillText(symbol, ix, iy);
    }
    ctx.restore();
}

/* ── Bead ─────────────────────────────────────────────── */

/**
 * Draw a bead at a cell center (thread-mode: glossy vertical oval).
 * @param {number} cx,cy — pixel coords of the cell center
 */
function drawBead(ctx, cx, cy, hex, cp) {
    const rX = Math.max(1.5, cp * 0.18);
    const rY = Math.max(2, cp * 0.28);
    ctx.save();
    if (cp >= 8) {
        // Dark outline
        ctx.beginPath();
        ctx.ellipse(cx, cy, rX, rY, 0, 0, Math.PI * 2);
        ctx.fillStyle = darkenHex(hex, 0.65);
        ctx.fill();
        // Glossy gradient fill
        const rg = ctx.createRadialGradient(cx - rX * 0.2, cy - rY * 0.2, 0, cx, cy, rY);
        rg.addColorStop(0, lightenHex(hex, 1.3));
        rg.addColorStop(0.5, hex);
        rg.addColorStop(1, darkenHex(hex, 0.7));
        ctx.beginPath();
        ctx.ellipse(cx, cy, rX * 0.88, rY * 0.88, 0, 0, Math.PI * 2);
        ctx.fillStyle = rg;
        ctx.fill();
        // Highlight spot
        if (cp >= 15) {
            ctx.beginPath();
            ctx.ellipse(cx - rX * 0.15, cy - rY * 0.25, rX * 0.25, rY * 0.15, -0.3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fill();
        }
    } else {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rX, rY, 0, 0, Math.PI * 2);
        ctx.fillStyle = hex;
        ctx.fill();
    }
    ctx.restore();
}

/**
 * Chart-mode bead: colored vertical oval with symbol inside.
 */
function drawChartBead(ctx, cx, cy, hex, cp, symbol, opts) {
    const rX = Math.max(2, cp * 0.2);
    const rY = Math.max(3, cp * 0.3);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rX, rY, 0, 0, Math.PI * 2);
    ctx.fillStyle = hex;
    ctx.fill();
    ctx.strokeStyle = darkenHex(hex, 0.55);
    ctx.lineWidth = Math.max(0.5, cp * 0.05);
    ctx.stroke();
    if ((opts?.showSymbol !== false) && symbol && rX >= 3.5) {
        const fontSize = Math.max(5, Math.floor(rX * 1.2));
        ctx.font = (opts?.symbolFont) ||
            (fontSize + 'px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols","IBM Plex Mono",sans-serif');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = contrastColor(hex);
        ctx.fillText(symbol, cx, cy);
    }
    ctx.restore();
}

/* ── Chart-mode rendering ────────────────────────────── */

/** Quadrant corner offsets within a cell. */
const _QUAD_OFFSETS = {
    TL: (cp, gap, qw) => ({ qx: 0,          qy: 0 }),
    TR: (cp, gap, qw) => ({ qx: qw + gap,   qy: 0 }),
    BL: (cp, gap, qw) => ({ qx: 0,          qy: qw + gap }),
    BR: (cp, gap, qw) => ({ qx: qw + gap,   qy: qw + gap }),
};

/** Half stitch direction → which two diagonal quadrants to fill. */
const _HALF_CORNERS = { fwd: ['BL', 'TR'], bwd: ['TL', 'BR'] };

/**
 * Draw a single colored quadrant square within a cell.
 * @param {string} corner — 'TL' | 'TR' | 'BL' | 'BR'
 */
function drawChartQuadrant(ctx, x, y, cp, hex, corner, symbol, opts) {
    const gap = Math.max(1, Math.round(cp * 0.04));
    const qw  = (cp - gap) / 2;
    const off = _QUAD_OFFSETS[corner] || _QUAD_OFFSETS.TL;
    const { qx, qy } = off(cp, gap, qw);
    ctx.fillStyle = hex;
    ctx.fillRect(x + qx, y + qy, qw, qw);
    if ((opts?.showSymbol !== false) && symbol && qw >= 6) {
        const fontSize = Math.max(5, Math.floor(qw * 0.72));
        ctx.save();
        ctx.font = (opts?.symbolFont) ||
            (fontSize + 'px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols","IBM Plex Mono",sans-serif');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = contrastColor(hex);
        ctx.fillText(symbol, x + qx + qw / 2, y + qy + qw / 2);
        ctx.restore();
    }
}

/** Chart-mode half stitch: two quadrant squares on a diagonal. */
function drawChartHalfStitch(ctx, x, y, cp, hex, direction, symbol, opts) {
    const corners = _HALF_CORNERS[direction] || _HALF_CORNERS.fwd;
    for (const c of corners) drawChartQuadrant(ctx, x, y, cp, hex, c, symbol, opts);
}

/** Chart-mode quarter stitch: one quadrant square. */
function drawChartQuarterStitch(ctx, x, y, cp, hex, corner, symbol, opts) {
    drawChartQuadrant(ctx, x, y, cp, hex, corner, symbol, opts);
}

/** Chart-mode petite stitch: colored quadrant with tiny X overlay. */
function drawChartPetiteStitch(ctx, x, y, cp, hex, corner, symbol, opts) {
    drawChartQuadrant(ctx, x, y, cp, hex, corner, symbol, opts);
    // Overlay tiny X marker to distinguish from quarter stitch
    const gap = Math.max(1, Math.round(cp * 0.04));
    const qw  = (cp - gap) / 2;
    if (qw >= 8) {
        const off = (_QUAD_OFFSETS[corner] || _QUAD_OFFSETS.TL)(cp, gap, qw);
        const ins = qw * 0.22;
        const qx = x + off.qx, qy = y + off.qy;
        ctx.save();
        ctx.strokeStyle = contrastColor(hex);
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = Math.max(0.5, qw * 0.07);
        ctx.beginPath();
        ctx.moveTo(qx + ins, qy + ins); ctx.lineTo(qx + qw - ins, qy + qw - ins);
        ctx.moveTo(qx + qw - ins, qy + ins); ctx.lineTo(qx + ins, qy + qw - ins);
        ctx.stroke();
        ctx.restore();
    }
}

/** Chart-mode three-quarter stitch: three quadrant squares (or two + dot for on-diagonal). */
function drawChartThreeQuarterStitch(ctx, x, y, cp, hex, halfDir, shortCorner, symbol, opts) {
    const halfCorners = _HALF_CORNERS[halfDir] || _HALF_CORNERS.fwd;
    const corners = new Set([...halfCorners, shortCorner]);
    for (const c of corners) drawChartQuadrant(ctx, x, y, cp, hex, c, symbol, opts);
    // On-diagonal: shortCorner overlaps with half — draw ring marker to distinguish from plain half
    if (halfCorners.includes(shortCorner)) {
        const gap = Math.max(1, Math.round(cp * 0.04));
        const qw  = (cp - gap) / 2;
        if (qw >= 6) {
            const off = _QUAD_OFFSETS[shortCorner](cp, gap, qw);
            const r = Math.max(2, qw * 0.18);
            ctx.save();
            ctx.strokeStyle = contrastColor(hex);
            ctx.globalAlpha = 0.45;
            ctx.lineWidth = Math.max(1, qw * 0.08);
            ctx.beginPath();
            ctx.arc(x + off.qx + qw / 2, y + off.qy + qw / 2, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }
}

/* ── Dispatchers ──────────────────────────────────────── */

/** Resolve backward-compat fields from a part stitch object. */
function _resolvePartFields(ps) {
    const sx = (ps.x !== undefined ? ps.x : ps.col);
    const sy = (ps.y !== undefined ? ps.y : ps.row);
    let dir;
    if (ps.type === 'half')          dir = ps.dir || ps.direction || 'fwd';
    else if (ps.type === 'quarter')  dir = ps.dir || ps.corner || 'TL';
    else if (ps.type === 'petite')   dir = ps.dir || ps.corner || 'TL';
    else if (ps.type === 'three_quarter') {
        dir = ps.dir || (ps.halfDir && ps.shortCorner ? ps.halfDir + '_' + ps.shortCorner : 'fwd_TL');
    }
    return { sx, sy, dir };
}

/**
 * Dispatch a part stitch to chart-mode rendering (quadrant squares + symbols).
 * @param {Object} ps — part stitch data object
 */
function drawChartPartStitch(ctx, x, y, cp, ps, hex, symbol, opts) {
    const { dir } = _resolvePartFields(ps);
    if (ps.type === 'half') {
        drawChartHalfStitch(ctx, x, y, cp, hex, dir, symbol, opts);
    } else if (ps.type === 'quarter') {
        drawChartQuarterStitch(ctx, x, y, cp, hex, dir, symbol, opts);
    } else if (ps.type === 'petite') {
        drawChartPetiteStitch(ctx, x, y, cp, hex, dir, symbol, opts);
    } else if (ps.type === 'three_quarter') {
        const parts = dir.split('_');
        drawChartThreeQuarterStitch(ctx, x, y, cp, hex, parts[0], parts[1], symbol, opts);
    }
}

/**
 * Dispatch a part stitch to thread-mode rendering (diagonal lines).
 * @param {Object} ps — part stitch data object
 */
function drawThreadPartStitch(ctx, x, y, cp, ps, hex) {
    const { dir } = _resolvePartFields(ps);
    if (ps.type === 'half') {
        drawHalfStitch(ctx, x, y, cp, hex, dir);
    } else if (ps.type === 'quarter') {
        drawQuarterStitch(ctx, x, y, cp, hex, dir);
    } else if (ps.type === 'petite') {
        drawPetiteStitch(ctx, x, y, cp, hex, dir);
    } else if (ps.type === 'three_quarter') {
        const parts = dir.split('_');
        drawThreeQuarterStitch(ctx, x, y, cp, hex, parts[0], parts[1]);
    }
}
