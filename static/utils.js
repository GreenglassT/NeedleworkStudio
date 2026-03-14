function linearize(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function contrastColor(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16) / 255;
    const g = parseInt(c.slice(2, 4), 16) / 255;
    const b = parseInt(c.slice(4, 6), 16) / 255;
    const lum = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
    return lum > 0.179 ? '#000000' : '#ffffff';
}

function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
    return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatLocalTime(utcStr) {
    if (!utcStr) return '';
    var d = new Date(utcStr.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return utcStr;
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function safeHex(val) {
    const s = String(val || '').trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : '#888888';
}

const _darkenCache = new Map();
function darkenHex(hex, factor) {
    const key = hex + '|' + factor;
    let v = _darkenCache.get(key);
    if (v !== undefined) return v;
    const c = hex.replace('#', '');
    const r = Math.round(parseInt(c.slice(0, 2), 16) * factor);
    const g = Math.round(parseInt(c.slice(2, 4), 16) * factor);
    const b = Math.round(parseInt(c.slice(4, 6), 16) * factor);
    v = `rgb(${r},${g},${b})`;
    _darkenCache.set(key, v);
    return v;
}

const _lightenCache = new Map();
function lightenHex(hex, factor) {
    const key = hex + '|' + factor;
    let v = _lightenCache.get(key);
    if (v !== undefined) return v;
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    v = `rgb(${Math.round(r + (255 - r) * factor)},${Math.round(g + (255 - g) * factor)},${Math.round(b + (255 - b) * factor)})`;
    _lightenCache.set(key, v);
    return v;
}

function hexToRgb(hex) {
    const c = hex.replace('#', '');
    return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

/**
 * Shared matte fiber renderer — dark outline, matte gradient, twist bands.
 * Gracefully degrades at small cell sizes to preserve color accuracy.
 */
function _drawMatteFiber(ctx, x0, y0, x1, y1, hex, lw, cp) {
    // Small cells: flat color only — preserves vibrancy at zoomed-out views
    if (cp < 8) {
        ctx.strokeStyle = hex;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        return;
    }

    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;

    // Scale outline darkness and gradient intensity by cell size.
    // At cp=8 outline is subtle (0.72), ramping to full darkness (0.50) at cp>=25.
    const t = Math.min(1, Math.max(0, (cp - 8) / 17));
    const outlineDk = 0.72 - t * 0.22;     // 0.72 → 0.50
    const edgeFactor = 0.82 - t * 0.14;     // 0.82 → 0.68
    const midFactor  = 0.95 - t * 0.05;     // 0.95 → 0.90
    const fillRatio  = 0.88 - t * 0.10;     // 0.88 → 0.78

    // Dark outline (full width)
    ctx.strokeStyle = darkenHex(hex, outlineDk);
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();

    // Matte gradient fill (narrower, on top of outline)
    const g = ctx.createLinearGradient(
        mx + nx * lw * 0.5, my + ny * lw * 0.5,
        mx - nx * lw * 0.5, my - ny * lw * 0.5
    );
    const edgeDk = darkenHex(hex, edgeFactor);
    g.addColorStop(0, edgeDk);
    g.addColorStop(0.20, darkenHex(hex, midFactor));
    g.addColorStop(0.40, hex);
    g.addColorStop(0.60, hex);
    g.addColorStop(0.80, darkenHex(hex, midFactor));
    g.addColorStop(1, edgeDk);
    ctx.strokeStyle = g;
    ctx.lineWidth = lw * fillRatio;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();

    // Twist bands (diagonal texture lines) — only at larger sizes
    if (cp >= 15) {
        const bandSpacing = lw * 0.55;
        const bandCount = Math.floor(len / bandSpacing);
        const halfW = lw * 0.35;
        const tx = dx / len, ty = dy / len;
        const bx = nx * 0.85 + tx * 0.5;
        const by = ny * 0.85 + ty * 0.5;
        ctx.lineWidth = Math.max(0.6, cp * 0.03);
        for (let i = 1; i < bandCount; i++) {
            const tt = i / bandCount;
            const px = x0 + dx * tt, py = y0 + dy * tt;
            ctx.strokeStyle = i % 2 === 0 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            ctx.moveTo(px - bx * halfW, py - by * halfW);
            ctx.lineTo(px + bx * halfW, py + by * halfW);
            ctx.stroke();
        }
    }
}

/**
 * Improved fiber renderer — matte asymmetric gradient with visible twist texture.
 * Drop-in replacement for _drawMatteFiber with more realistic thread appearance.
 * To revert: replace all _drawCylinderFiber calls with _drawMatteFiber and
 * restore the diamond fabric gap in drawStitch.
 */
function _drawCylinderFiber(ctx, x0, y0, x1, y1, hex, lw, cp) {
    if (cp < 8) {
        ctx.strokeStyle = hex; ctx.lineWidth = lw; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        return;
    }

    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var tx = dx / len, ty = dy / len;
    var nx = -dy / len, ny = dx / len;
    var hw = lw * 0.5;
    var mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    var lightDot = nx * (-0.707) + ny * (-0.707);

    ctx.save();
    ctx.lineCap = 'round';

    // 1. Dark outline stroke
    ctx.strokeStyle = darkenHex(hex, 0.50);
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();

    // 2. Main body — matte asymmetric gradient
    var g = ctx.createLinearGradient(
        mx + nx * hw, my + ny * hw,
        mx - nx * hw, my - ny * hw
    );
    if (lightDot >= 0) {
        g.addColorStop(0,    lightenHex(hex, 0.12));
        g.addColorStop(0.15, lightenHex(hex, 0.04));
        g.addColorStop(0.35, hex);
        g.addColorStop(0.55, darkenHex(hex, 0.90));
        g.addColorStop(0.75, darkenHex(hex, 0.75));
        g.addColorStop(1,    darkenHex(hex, 0.60));
    } else {
        g.addColorStop(0,    darkenHex(hex, 0.60));
        g.addColorStop(0.25, darkenHex(hex, 0.75));
        g.addColorStop(0.45, darkenHex(hex, 0.90));
        g.addColorStop(0.65, hex);
        g.addColorStop(0.85, lightenHex(hex, 0.04));
        g.addColorStop(1,    lightenHex(hex, 0.12));
    }
    ctx.strokeStyle = g;
    ctx.lineWidth = lw * 0.90;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();

    // 3. Fiber twist bands
    var detail = Math.min(1, Math.max(0, (cp - 10) / 16));
    if (detail > 0 && len > lw * 0.5) {
        var bandPitch = Math.max(1.8, cp * 0.07);
        var bandCount = Math.max(4, Math.floor(len / bandPitch));
        var twistAngle = 0.32;
        var bx = nx * Math.cos(twistAngle) + tx * Math.sin(twistAngle);
        var by = ny * Math.cos(twistAngle) + ty * Math.sin(twistAngle);
        var bandHW = hw * 0.80;

        ctx.lineCap = 'butt';
        for (var i = 0; i <= bandCount; i++) {
            var t = i / bandCount;
            var px = x0 + dx * t, py = y0 + dy * t;
            var phase = i % 4;
            var color, alpha;
            if (phase === 0) {
                color = '255,255,255'; alpha = detail * 0.14;
            } else if (phase === 1) {
                color = '0,0,0'; alpha = detail * 0.20;
            } else if (phase === 2) {
                color = '255,255,255'; alpha = detail * 0.06;
            } else {
                color = '0,0,0'; alpha = detail * 0.10;
            }
            ctx.strokeStyle = 'rgba(' + color + ',' + alpha + ')';
            ctx.lineWidth = bandPitch * 0.35;
            ctx.beginPath();
            ctx.moveTo(px - bx * bandHW, py - by * bandHW);
            ctx.lineTo(px + bx * bandHW, py + by * bandHW);
            ctx.stroke();
        }
        ctx.lineCap = 'round';
    }

    ctx.restore();
}

function drawStitch(ctx, x, y, cp, hex, fabColor) {
    const lw = cp * 0.52;
    const inset = lw / 2;
    ctx.lineCap = 'round';

    // / thread (bottom-left to top-right, underneath)
    _drawCylinderFiber(ctx, x + inset, y + cp - inset, x + cp - inset, y + inset, hex, lw, cp);

    // Crossing shadow (replaces old diamond fabric gap)
    if (cp >= 10) {
        const cx = x + cp / 2, cy = y + cp / 2;
        const detail = Math.min(1, Math.max(0, (cp - 10) / 20));
        const sr = lw * 0.38;
        const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, sr);
        sg.addColorStop(0, 'rgba(0,0,0,' + (0.25 + detail * 0.12) + ')');
        sg.addColorStop(0.4, 'rgba(0,0,0,0.08)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(cx - sr - 1, cy - sr - 1, sr * 2 + 2, sr * 2 + 2);
    }

    // \ thread (top-left to bottom-right, on top)
    _drawCylinderFiber(ctx, x + inset, y + inset, x + cp - inset, y + cp - inset, hex, lw, cp);
}

function drawStitchFabric(ctx, W, H, cp, gridW, gridH, fabColor, ox, oy) {
    ox = ox || 0;
    oy = oy || 0;
    const [fr, fg, fb] = hexToRgb(fabColor);

    // Fabric weave (ImageData for speed)
    const gw = Math.min(W - ox, gridW * cp);
    const gh = Math.min(H - oy, gridH * cp);
    const imgData = ctx.getImageData(ox, oy, gw, gh);
    const d = imgData.data;
    const dkR = Math.max(0, fr - 20), dkG = Math.max(0, fg - 20), dkB = Math.max(0, fb - 20);
    const ltR = Math.min(255, fr + 15), ltG = Math.min(255, fg + 15), ltB = Math.min(255, fb + 15);
    for (let y = 0; y < gh; y += 2) {
        for (let x = 0; x < gw; x += 2) {
            const i = (y * gw + x) * 4;
            if ((x + y) % 4 === 0) {
                d[i]   = Math.round(d[i]   * 0.7 + dkR * 0.3);
                d[i+1] = Math.round(d[i+1] * 0.7 + dkG * 0.3);
                d[i+2] = Math.round(d[i+2] * 0.7 + dkB * 0.3);
            } else {
                d[i]   = Math.round(d[i]   * 0.75 + ltR * 0.25);
                d[i+1] = Math.round(d[i+1] * 0.75 + ltG * 0.25);
                d[i+2] = Math.round(d[i+2] * 0.75 + ltB * 0.25);
            }
        }
    }
    ctx.putImageData(imgData, ox, oy);

    // Aida dots at grid intersections
    ctx.fillStyle = `rgba(${Math.max(0,fr-40)},${Math.max(0,fg-40)},${Math.max(0,fb-40)},0.2)`;
    const dotR = Math.max(0.5, cp * 0.04);
    for (let row = 0; row <= gridH; row++) {
        for (let col = 0; col <= gridW; col++) {
            ctx.beginPath();
            ctx.arc(ox + col * cp, oy + row * cp, dotR, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function patternSlug(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pattern';
}

function fmtStitches(n) {
    if (Number.isInteger(n)) return n.toLocaleString();
    const int = Math.floor(n);
    const frac = Math.round((n - int) * 10);
    return int.toLocaleString() + '.' + frac;
}

const STATUS_LABEL = { own: 'Owned', need: 'Need', dont_own: "Don't Own", not_found: 'Not Found' };
const STATUS_CLASS = { own: 'status-own', need: 'status-need', dont_own: 'status-dont_own', not_found: 'status-not_found' };

function dmcSortKey(dmc) {
    const n = parseInt(dmc, 10);
    return isNaN(n) ? Infinity : n;
}

function generateThumbnail(patternData) {
    if (!patternData) return null;
    const { grid, grid_w, grid_h, legend } = patternData;
    const rgbLookup = {};
    for (const e of legend) rgbLookup[e.dmc] = hexToRgb(e.hex || '#888888');
    const bgRgb = hexToRgb(patternData.fabric_color || '#F5F0E8');
    const maxW = 120, maxH = 120;
    const sc = Math.min(maxW / grid_w, maxH / grid_h, 1);
    const outW = Math.max(1, Math.round(grid_w * sc));
    const outH = Math.max(1, Math.round(grid_h * sc));
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(outW, outH);
    const d = imgData.data;
    for (let py = 0; py < outH; py++) {
        for (let px = 0; px < outW; px++) {
            const gx = Math.min(grid_w - 1, Math.floor(px / sc));
            const gy = Math.min(grid_h - 1, Math.floor(py / sc));
            const gVal = grid[gy * grid_w + gx];
            const rgb = gVal === 'BG' ? bgRgb : (rgbLookup[gVal] || bgRgb);
            const i = (py * outW + px) * 4;
            d[i] = rgb[0]; d[i+1] = rgb[1]; d[i+2] = rgb[2]; d[i+3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
}

function createAutosaver(key, getPatternData, onRecover) {
    let timer = null;
    function getKey() { return typeof key === 'function' ? key() : key; }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(() => {
            const pd = getPatternData();
            if (!pd) return;
            try {
                localStorage.setItem(getKey(), JSON.stringify({
                    grid: pd.grid, legend: pd.legend,
                    grid_w: pd.grid_w, grid_h: pd.grid_h,
                    part_stitches: pd.part_stitches || [],
                    backstitches: pd.backstitches || [],
                    knots: pd.knots || [], beads: pd.beads || [],
                    fabric_color: pd.fabric_color || '#F5F0E8',
                    timestamp: Date.now()
                }));
            } catch (e) { /* localStorage full */ }
        }, 5000);
    }

    function clear() {
        clearTimeout(timer);
        localStorage.removeItem(getKey());
    }

    function checkRecovery() {
        const k = getKey();
        const raw = localStorage.getItem(k);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            const age = Date.now() - data.timestamp;
            if (age > 7 * 24 * 60 * 60 * 1000) { localStorage.removeItem(k); return; }
            toast('Unsaved edits found from ' + new Date(data.timestamp).toLocaleString(), {
                type: 'info', duration: 0,
                actions: [
                    { label: 'Recover', onClick: () => {
                        const pd = getPatternData();
                        pd.grid = data.grid;
                        pd.legend = data.legend;
                        pd.grid_w = data.grid_w;
                        pd.grid_h = data.grid_h;
                        pd.part_stitches = data.part_stitches || [];
                        pd.backstitches = data.backstitches || [];
                        pd.knots = data.knots || [];
                        pd.beads = data.beads || [];
                        onRecover(data);
                        toast('Edits recovered.', { type: 'success' });
                    }},
                    { label: 'Discard', onClick: () => { localStorage.removeItem(k); } }
                ]
            });
        } catch (e) { localStorage.removeItem(k); }
    }

    return { schedule, clear, checkRecovery };
}

const MM_CELL = 2; // px per stitch in minimap (before display scaling)

function renderMinimapCanvas(grid, gridW, gridH, colorLookup) {
    const mmW = gridW * MM_CELL, mmH = gridH * MM_CELL;
    const mmS = Math.min(200 / mmW, 120 / mmH, 1.0);
    const dispW = Math.max(1, Math.round(mmW * mmS));
    const dispH = Math.max(1, Math.round(mmH * mmS));
    const canvas = document.getElementById('mini-canvas');
    canvas.width = dispW; canvas.height = dispH;
    canvas._mmS = mmS;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dispW, dispH);
    const cellDisp = MM_CELL * mmS;
    for (let row = 0; row < gridH; row++) {
        for (let col = 0; col < gridW; col++) {
            const dmc = grid[row * gridW + col];
            if (dmc === 'BG') continue;
            const info = colorLookup[dmc] || { hex: '#888888' };
            ctx.fillStyle = info.hex;
            ctx.fillRect(Math.floor(col * cellDisp), Math.floor(row * cellDisp), Math.ceil(cellDisp), Math.ceil(cellDisp));
        }
    }
    canvas._patternImg = ctx.getImageData(0, 0, dispW, dispH);
}

function updateMinimapRect(gridW, gridH, vScale, vPanX, vPanY, vCellPx, gutX, gutY) {
    const canvas = document.getElementById('mini-canvas');
    if (!canvas._patternImg) return;
    const area = document.getElementById('canvas-area');
    const areaW = area.clientWidth, areaH = area.clientHeight;
    const visLeft = -vPanX / vScale, visTop = -vPanY / vScale;
    const visW = areaW / vScale, visH = areaH / vScale;
    const sX = (visLeft - gutX) / vCellPx, sY = (visTop - gutY) / vCellPx;
    const sW = visW / vCellPx, sH = visH / vCellPx;
    const wrap = document.getElementById('minimap-wrap');
    if (sX <= 0 && sY <= 0 && sW >= gridW && sH >= gridH) { wrap.style.display = 'none'; return; }
    else { wrap.style.display = ''; }
    const ms = canvas._mmS * MM_CELL;
    const rx = sX * ms, ry = sY * ms, rw = sW * ms, rh = sH * ms;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(canvas._patternImg, 0, 0);
    ctx.strokeStyle = 'rgba(200,145,58,0.9)'; ctx.lineWidth = 1.5;
    ctx.fillStyle = 'rgba(200,145,58,0.15)';
    const rx2 = Math.max(0, rx), ry2 = Math.max(0, ry);
    const rw2 = Math.min(rw, canvas.width - rx2), rh2 = Math.min(rh, canvas.height - ry2);
    if (rw2 > 0 && rh2 > 0) { ctx.fillRect(rx2, ry2, rw2, rh2); ctx.strokeRect(rx2, ry2, rw2, rh2); }
}

function renderRulers(gridW, gridH, cellPx, scale, panX, panY) {
    const area = document.getElementById('canvas-area');
    const areaW = area.clientWidth;
    const areaH = area.clientHeight;
    const isDark = document.documentElement.dataset.theme !== 'light';
    const dpr = window.devicePixelRatio || 1;

    const effectiveCell = cellPx * scale;
    let step = 10;
    if (effectiveCell < 3) step = 50;
    else if (effectiveCell < 6) step = 20;

    const bgColor = isDark ? 'rgba(28,26,24,0.88)' : 'rgba(252,250,247,0.88)';
    const textColor = isDark ? '#8a8580' : '#999';
    const lineColor = isDark ? 'rgba(138,133,128,0.25)' : 'rgba(136,136,136,0.2)';

    const RULER_H = 18, RULER_W = 26;

    const topC = document.getElementById('ruler-top');
    topC.width = areaW * dpr;
    topC.height = RULER_H * dpr;
    topC.style.width = areaW + 'px';
    topC.style.height = RULER_H + 'px';
    const tCtx = topC.getContext('2d');
    tCtx.scale(dpr, dpr);
    tCtx.fillStyle = bgColor;
    tCtx.fillRect(0, 0, areaW, RULER_H);
    tCtx.strokeStyle = lineColor;
    tCtx.lineWidth = 1;
    tCtx.beginPath(); tCtx.moveTo(0, RULER_H - 0.5); tCtx.lineTo(areaW, RULER_H - 0.5); tCtx.stroke();
    tCtx.font = '9px "IBM Plex Mono", monospace';
    tCtx.fillStyle = textColor;
    tCtx.textAlign = 'center';
    tCtx.textBaseline = 'bottom';
    for (let col = step; col <= gridW; col += step) {
        const screenX = panX + (col - 0.5) * cellPx * scale;
        if (screenX < RULER_W || screenX > areaW + 20) continue;
        tCtx.fillText(col.toString(), screenX, RULER_H - 3);
    }

    const leftC = document.getElementById('ruler-left');
    leftC.width = RULER_W * dpr;
    leftC.height = areaH * dpr;
    leftC.style.width = RULER_W + 'px';
    leftC.style.height = areaH + 'px';
    const lCtx = leftC.getContext('2d');
    lCtx.scale(dpr, dpr);
    lCtx.fillStyle = bgColor;
    lCtx.fillRect(0, 0, RULER_W, areaH);
    lCtx.strokeStyle = lineColor;
    lCtx.lineWidth = 1;
    lCtx.beginPath(); lCtx.moveTo(RULER_W - 0.5, 0); lCtx.lineTo(RULER_W - 0.5, areaH); lCtx.stroke();
    lCtx.font = '9px "IBM Plex Mono", monospace';
    lCtx.fillStyle = textColor;
    lCtx.textAlign = 'right';
    lCtx.textBaseline = 'middle';
    for (let row = step; row <= gridH; row += step) {
        const screenY = panY + (row - 0.5) * cellPx * scale;
        if (screenY < RULER_H || screenY > areaH + 10) continue;
        lCtx.fillText(row.toString(), RULER_W - 4, screenY);
    }
}

function _pref(k, fb) {
    var v = (window.__PREFS__ && window.__PREFS__[k] !== undefined) ? window.__PREFS__[k] : localStorage.getItem(k);
    if (v === null || v === undefined) return fb;
    // Normalize boolean strings from localStorage
    if (typeof fb === 'boolean') {
        if (v === 'true' || v === true) return true;
        if (v === 'false' || v === false) return false;
    }
    return v;
}

function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
