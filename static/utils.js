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

function drawStitch(ctx, x, y, cp, hex, fabColor) {
    const lw = cp * 0.50;
    const inset = lw / 2;
    ctx.lineCap = 'round';

    // / thread (bottom-left to top-right, underneath)
    _drawMatteFiber(ctx, x + inset, y + cp - inset, x + cp - inset, y + inset, hex, lw, cp);

    // Crossing gap — mask center of / with fabric (skip at tiny sizes)
    if (cp >= 8) {
        const cx = x + cp / 2, cy = y + cp / 2;
        const gap = lw * 0.45;
        ctx.fillStyle = fabColor;
        ctx.beginPath();
        ctx.moveTo(cx, cy - gap);
        ctx.lineTo(cx + gap, cy);
        ctx.lineTo(cx, cy + gap);
        ctx.lineTo(cx - gap, cy);
        ctx.closePath();
        ctx.fill();
    }

    // \ thread (top-left to bottom-right, on top)
    _drawMatteFiber(ctx, x + inset, y + inset, x + cp - inset, y + cp - inset, hex, lw, cp);
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

function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
