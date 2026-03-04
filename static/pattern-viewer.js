/* ——— CALCULATE DROPDOWN ——— */
function toggleCalcMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('calc-menu');
    const btn = document.getElementById('calc-toggle');
    const wasOpen = menu.classList.contains('open');

    // Close first
    menu.classList.remove('open');
    btn.classList.remove('open');

    if (!wasOpen) {
        // Position the fixed menu below the button
        const rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 6) + 'px';
        menu.style.right = (window.innerWidth - rect.right) + 'px';
        menu.classList.add('open');
        btn.classList.add('open');
    }
}
document.addEventListener('click', function () {
    document.getElementById('calc-menu').classList.remove('open');
    document.getElementById('calc-toggle').classList.remove('open');
});

/* ——— ZEN MENU DROPDOWN ——— */
function toggleZenMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('zen-menu');
    const btn  = document.getElementById('zen-menu-btn');
    const wasOpen = menu.classList.contains('open');

    menu.classList.remove('open');
    btn.classList.remove('open');

    if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        menu.style.top  = (rect.bottom + 6) + 'px';
        menu.style.left = rect.left + 'px';
        menu.classList.add('open');
        btn.classList.add('open');
        // Keep toolbar visible while menu is open
        clearTimeout(_zenMoveTimer);
    }
}

document.addEventListener('click', function () {
    var menu = document.getElementById('zen-menu');
    var btn  = document.getElementById('zen-menu-btn');
    if (menu) menu.classList.remove('open');
    if (btn)  btn.classList.remove('open');
});

function zenMenuAction(action) {
    // Close menu first
    document.getElementById('zen-menu').classList.remove('open');
    document.getElementById('zen-menu-btn').classList.remove('open');

    if (action === 'mark-complete') {
        toggleCellMarkMode();
        _syncZenMenuLabels();
    } else if (action === 'view-mode') {
        toggleViewMode();
        _syncZenMenuLabels();
    } else if (action === 'edit') {
        exitZenMode();
        setTimeout(function() { toggleEditMode(); }, 80);
    } else if (action === 'theme') {
        toggleTheme();
    } else if (action === 'shortcuts') {
        showShortcutHelp(typeof editMode !== 'undefined' && editMode && typeof editor !== 'undefined' && editor && editor.isActive());
    }
}

function _syncZenMenuLabels() {
    var markLabel = document.getElementById('zen-mark-label');
    if (markLabel) markLabel.textContent = _cellMarkMode ? 'Stop Marking' : 'Mark Complete';

    var viewLabel = document.getElementById('zen-view-label');
    var viewIcon  = document.getElementById('zen-view-icon');
    if (viewLabel) viewLabel.textContent = viewMode === 'chart' ? 'Thread View' : 'Chart View';
    if (viewIcon)  viewIcon.className = viewMode === 'chart' ? 'ti ti-needle' : 'ti ti-grid-dots';
}

/* ——— STATE ——— */
const PATTERN_SLUG = window._PAGE_CONFIG.patternSlug;
let patternData = null;   // { grid, grid_w, grid_h, legend, brand }
let patternBrand = 'DMC'; // 'DMC' | 'Anchor'
let lookup = {};          // dmc → { hex, symbol, name, count }
let cellPx = 19;          // canvas px per stitch
let scale  = 1.0;         // CSS transform scale
let panX = 0, panY = 0;   // CSS transform translate (px)
let highlightDmc = null;  // currently highlighted DMC number, or null
let completedDmcs  = new Set();   // DMC numbers (as strings) marked complete
let _progressTimer = null;        // debounce handle for auto-save

/* ——— CELL-LEVEL PROGRESS ——— */
let stitchedCells    = new Set();   // Set<number> of flat cell indices (row*grid_w+col)
let _cellMarkMode    = false;       // true when stitch-marking mode is active
let _cellDragActive  = false;       // true while mouse button held in mark mode
let _cellDragToggle  = null;        // bool: true=marking, false=unmarking
let _cellDragStart   = null;        // {col, row} for rectangle start
let _cellDragEnd     = null;        // {col, row} for rectangle end

/* ——— SESSION TIMER ——— */
let _timerAccumSecs   = 0;     // total seconds loaded from DB
let _timerSessionStart = null; // Date.now() when current session started, null if paused
let _timerInterval     = null; // setInterval handle for UI tick (1s)
let _timerFlushInterval = null; // setInterval handle for DB flush (30s)
let _timerDirty        = false; // true if unsaved seconds exist
let legendSort = 'number';        // 'number' | 'stitches'
let legendFilter = '';            // search query for legend filtering
const MAX_CELL_PX = 80;           // cap re-render resolution when zooming in
let _snapTimer = null;
let viewMode = localStorage.getItem('pv-viewMode') || 'chart';  // 'chart' | 'thread'

/* ——— EDITOR (shared module) ——— */
let editMode = false;
let isForked = false;
let editor   = null;      // set in init() after pattern loads
let _editSnapshot = null; // snapshot of grid/legend/lookup before editing
const _PATTERN_SYMBOLS = window._PAGE_CONFIG.patternSymbols;

// Gutter sizes, proportional to cellPx (same ratio as in PDF renderer)
const ROW_LBL_MM  = 12;
const COL_LBL_MM  = 8;
const CELL_MM_EQ  = 2.5;
function gX() { return Math.round(ROW_LBL_MM * cellPx / CELL_MM_EQ); }
function gY() { return Math.round(COL_LBL_MM * cellPx / CELL_MM_EQ); }

/* ——— RENDER MAIN CANVAS ——— */
function renderMain() {
    const { grid, grid_w, grid_h } = patternData;
    const gutX = gX(), gutY = gY();
    const gridEndX = gutX + grid_w * cellPx;
    const gridEndY = gutY + grid_h * cellPx;
    const W = gridEndX + gutX;
    const H = gridEndY + gutY;

    const canvas  = document.getElementById('main-canvas');
    const overlay = document.getElementById('overlay-canvas');
    canvas.width  = W;  canvas.height  = H;
    overlay.width = W;  overlay.height = H;

    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Ruler labels — every 10th col/row on all four sides
    const lblSize = Math.max(7, Math.round(cellPx * 0.5));
    ctx.fillStyle = '#999999';
    ctx.font = `${lblSize}px "IBM Plex Mono",monospace`;
    ctx.textBaseline = 'middle';

    // Top + bottom col labels
    ctx.textAlign = 'center';
    for (let col = 0; col < grid_w; col++) {
        if (col % 10 === 0) {
            const cx = gutX + col * cellPx + cellPx / 2;
            ctx.fillText(String(col), cx, gutY / 2);
            ctx.fillText(String(col), cx, gridEndY + gutY / 2);
        }
    }

    // Left + right row labels
    for (let row = 0; row < grid_h; row++) {
        if (row % 10 === 0) {
            const cy = gutY + row * cellPx + cellPx / 2;
            ctx.textAlign = 'right';
            ctx.fillText(String(row), gutX - 3, cy);
            ctx.textAlign = 'left';
            ctx.fillText(String(row), gridEndX + 3, cy);
        }
    }

    // Cells: thread-mode or chart-mode
    if (viewMode === 'thread') {
        const fabColor = '#F5F0E8';
        ctx.fillStyle = fabColor;
        ctx.fillRect(gutX, gutY, grid_w * cellPx, grid_h * cellPx);
        drawStitchFabric(ctx, canvas.width, canvas.height, cellPx, grid_w, grid_h, fabColor, gutX, gutY);
        for (let row = 0; row < grid_h; row++) {
            for (let col = 0; col < grid_w; col++) {
                const dmc = grid[row * grid_w + col];
                if (dmc === 'BG') continue;
                const info = lookup[dmc];
                if (!info) continue;
                drawStitch(ctx, gutX + col * cellPx, gutY + row * cellPx, cellPx, info.hex, fabColor);
            }
        }
    } else {
        const symSize = Math.max(6, Math.floor(cellPx * 0.72));
        ctx.font = `${symSize}px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols","IBM Plex Mono",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let row = 0; row < grid_h; row++) {
            for (let col = 0; col < grid_w; col++) {
                const dmc  = grid[row * grid_w + col];
                if (dmc === 'BG') continue;
                const info = lookup[dmc];
                if (!info) continue;
                const x = gutX + col * cellPx;
                const y = gutY + row * cellPx;
                ctx.fillStyle = info.hex;
                ctx.fillRect(x, y, cellPx, cellPx);
                if (cellPx >= 8) {
                    ctx.fillStyle = contrastColor(info.hex);
                    ctx.fillText(info.symbol, x + cellPx / 2, y + cellPx / 2);
                }
            }
        }
    }

    // Completion overlay: wash out completed colors
    if (completedDmcs.size > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.58)';
        for (let row = 0; row < grid_h; row++) {
            for (let col = 0; col < grid_w; col++) {
                if (completedDmcs.has(String(grid[row * grid_w + col]))) {
                    ctx.fillRect(gutX + col * cellPx, gutY + row * cellPx, cellPx, cellPx);
                }
            }
        }
    }

    // Cell-level progress wash — individually marked stitched cells
    if (stitchedCells.size > 0 && !editMode) {
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        for (let row = 0; row < grid_h; row++) {
            for (let col = 0; col < grid_w; col++) {
                if (stitchedCells.has(row * grid_w + col)) {
                    ctx.fillRect(gutX + col * cellPx, gutY + row * cellPx, cellPx, cellPx);
                }
            }
        }
    }

    // Part stitches (half, quarter, three-quarter)
    if (patternData.part_stitches && patternData.part_stitches.length > 0 && cellPx >= 3) {
        for (const ps of patternData.part_stitches) {
            const info = lookup[ps.dmc];
            if (!info) continue;
            const faded = !editMode && completedDmcs.has(String(ps.dmc));
            if (faded) ctx.globalAlpha = 0.42;
            const { sx, sy } = _resolvePartFields(ps);
            const px = gutX + sx * cellPx;
            const py = gutY + sy * cellPx;
            if (viewMode === 'thread') {
                drawThreadPartStitch(ctx, px, py, cellPx, ps, info.hex);
            } else {
                drawChartPartStitch(ctx, px, py, cellPx, ps, info.hex, info.symbol);
            }
            if (faded) ctx.globalAlpha = 1.0;
        }
    }

    // Thin gridlines every cell — clipped to grid bounds
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.5;
    for (let col = 0; col <= grid_w; col++) {
        const x = gutX + col * cellPx;
        ctx.beginPath(); ctx.moveTo(x, gutY); ctx.lineTo(x, gridEndY); ctx.stroke();
    }
    for (let row = 0; row <= grid_h; row++) {
        const y = gutY + row * cellPx;
        ctx.beginPath(); ctx.moveTo(gutX, y); ctx.lineTo(gridEndX, y); ctx.stroke();
    }

    // Bold gridlines every 10th absolute col/row — clipped to grid bounds
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(1, cellPx / 7);
    for (let col = 0; col <= grid_w; col++) {
        if (col % 10 === 0) {
            const x = gutX + col * cellPx;
            ctx.beginPath(); ctx.moveTo(x, gutY); ctx.lineTo(x, gridEndY); ctx.stroke();
        }
    }
    for (let row = 0; row <= grid_h; row++) {
        if (row % 10 === 0) {
            const y = gutY + row * cellPx;
            ctx.beginPath(); ctx.moveTo(gutX, y); ctx.lineTo(gridEndX, y); ctx.stroke();
        }
    }

    // Backstitches — on top of gridlines
    if (patternData.backstitches && patternData.backstitches.length > 0) {
        for (const bs of patternData.backstitches) {
            const info = lookup[bs.dmc];
            if (!info) continue;
            const faded = !editMode && completedDmcs.has(String(bs.dmc));
            if (faded) ctx.globalAlpha = 0.42;
            const p1 = stitchIntersectionPx(bs.x1, bs.y1, gutX, gutY, cellPx);
            const p2 = stitchIntersectionPx(bs.x2, bs.y2, gutX, gutY, cellPx);
            if (viewMode === 'chart') {
                drawChartBackstitch(ctx, p1.x, p1.y, p2.x, p2.y, info.hex, cellPx, info.dashIdx);
            } else {
                drawBackstitch(ctx, p1.x, p1.y, p2.x, p2.y, info.hex, cellPx);
            }
            if (faded) ctx.globalAlpha = 1.0;
        }
    }

    // French knots — topmost layer
    if (patternData.knots && patternData.knots.length > 0) {
        for (const k of patternData.knots) {
            const info = lookup[k.dmc];
            if (!info) continue;
            const faded = !editMode && completedDmcs.has(String(k.dmc));
            if (faded) ctx.globalAlpha = 0.42;
            const pt = stitchIntersectionPx(k.x, k.y, gutX, gutY, cellPx);
            if (viewMode === 'chart') {
                drawChartFrenchKnot(ctx, pt.x, pt.y, info.hex, cellPx, info.symbol);
            } else {
                drawFrenchKnot(ctx, pt.x, pt.y, info.hex, cellPx);
            }
            if (faded) ctx.globalAlpha = 1.0;
        }
    }

    // Clear overlay; re-apply highlight if one was active
    document.getElementById('overlay-canvas').getContext('2d')
        .clearRect(0, 0, W, H);
    if (highlightDmc !== null) _drawHighlight(highlightDmc);
}

/* ——— MINI-MAP ——— */
const MM_CELL = 2; // px per stitch in minimap (before display scaling)

function renderMinimap() {
    const { grid, grid_w, grid_h } = patternData;
    const mmW = grid_w * MM_CELL;
    const mmH = grid_h * MM_CELL;

    // Scale to fit within 200×120 px
    const mmS = Math.min(200 / mmW, 120 / mmH, 1.0);
    const dispW = Math.max(1, Math.round(mmW * mmS));
    const dispH = Math.max(1, Math.round(mmH * mmS));

    const canvas = document.getElementById('mini-canvas');
    canvas.width  = dispW;
    canvas.height = dispH;
    canvas._mmS = mmS; // pixels-per-stitch on the displayed minimap

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dispW, dispH);

    const cellDisp = MM_CELL * mmS; // each stitch occupies this many display px
    for (let row = 0; row < grid_h; row++) {
        for (let col = 0; col < grid_w; col++) {
            const dmc  = grid[row * grid_w + col];
            const info = lookup[dmc] || { hex: '#888888' };
            ctx.fillStyle = info.hex;
            ctx.fillRect(
                Math.floor(col * cellDisp),
                Math.floor(row * cellDisp),
                Math.ceil(cellDisp),
                Math.ceil(cellDisp)
            );
        }
    }

    // Save pattern pixels (no viewport rect yet)
    canvas._patternImg = ctx.getImageData(0, 0, dispW, dispH);
}

function updateMinimapViewport() {
    const canvas = document.getElementById('mini-canvas');
    if (!canvas._patternImg || !patternData) return;

    const area  = document.getElementById('canvas-area');
    const areaW = area.clientWidth;
    const areaH = area.clientHeight;
    const { grid_w, grid_h } = patternData;
    const gutX = gX(), gutY = gY();

    // Visible canvas-pixel region
    const visLeft = -panX / scale;
    const visTop  = -panY / scale;
    const visW    = areaW / scale;
    const visH    = areaH / scale;

    // Convert to stitch coordinates (subtract gutter, divide by cellPx)
    const sX = (visLeft - gutX) / cellPx;
    const sY = (visTop  - gutY) / cellPx;
    const sW = visW / cellPx;
    const sH = visH / cellPx;

    // Convert to minimap display coordinates
    const ms = canvas._mmS * MM_CELL; // minimap px per stitch
    const rx = sX * ms;
    const ry = sY * ms;
    const rw = sW * ms;
    const rh = sH * ms;

    // Restore clean pattern pixels, then draw viewport rect on top
    const ctx = canvas.getContext('2d');
    ctx.putImageData(canvas._patternImg, 0, 0);

    ctx.strokeStyle = 'rgba(200,145,58,0.9)';
    ctx.lineWidth   = 1.5;
    ctx.fillStyle   = 'rgba(200,145,58,0.15)';
    const rx2 = Math.max(0, rx);
    const ry2 = Math.max(0, ry);
    const rw2 = Math.min(rw, canvas.width  - rx2);
    const rh2 = Math.min(rh, canvas.height - ry2);
    if (rw2 > 0 && rh2 > 0) {
        ctx.fillRect(rx2, ry2, rw2, rh2);
        ctx.strokeRect(rx2, ry2, rw2, rh2);
    }
}

/* ——— HIGHLIGHT ——— */
function _drawHighlight(dmc) {
    const overlay = document.getElementById('overlay-canvas');
    const ctx = overlay.getContext('2d');
    const { grid, grid_w, grid_h } = patternData;
    const gutX = gX(), gutY = gY();
    const W = overlay.width, H = overlay.height;

    ctx.clearRect(0, 0, W, H);

    // Dark semi-transparent overlay
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, W, H);

    // Punch out the highlighted cells using destination-out
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    // Full stitches
    for (let row = 0; row < grid_h; row++) {
        for (let col = 0; col < grid_w; col++) {
            if (String(grid[row * grid_w + col]) === String(dmc)) {
                ctx.fillRect(gutX + col * cellPx, gutY + row * cellPx, cellPx, cellPx);
            }
        }
    }
    // Part stitches
    if (patternData.part_stitches) {
        for (const ps of patternData.part_stitches) {
            if (String(ps.dmc) !== String(dmc)) continue;
            const { sx, sy } = _resolvePartFields(ps);
            ctx.fillRect(gutX + sx * cellPx, gutY + sy * cellPx, cellPx, cellPx);
        }
    }
    // Backstitches — punch out a thick line along the segment
    if (patternData.backstitches) {
        for (const bs of patternData.backstitches) {
            if (String(bs.dmc) !== String(dmc)) continue;
            const p1 = stitchIntersectionPx(bs.x1, bs.y1, gutX, gutY, cellPx);
            const p2 = stitchIntersectionPx(bs.x2, bs.y2, gutX, gutY, cellPx);
            ctx.lineWidth = Math.max(cellPx * 0.5, 4);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }
    }
    // French knots
    if (patternData.knots) {
        for (const k of patternData.knots) {
            if (String(k.dmc) !== String(dmc)) continue;
            const pt = stitchIntersectionPx(k.x, k.y, gutX, gutY, cellPx);
            const r = Math.max(cellPx * 0.4, 4);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.globalCompositeOperation = 'source-over';
}

function applyHighlight(dmc) {
    const dmcStr = String(dmc);
    if (highlightDmc !== null && String(highlightDmc) === dmcStr) {
        clearHighlight();
        return;
    }
    highlightDmc = dmcStr;
    _drawHighlight(dmcStr);
    document.querySelectorAll('.legend-row').forEach(r => {
        r.classList.toggle('active', r.dataset.dmc === dmcStr);
    });
}

function clearHighlight() {
    if (highlightDmc === null) return;
    const overlay = document.getElementById('overlay-canvas');
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    highlightDmc = null;
    document.querySelectorAll('.legend-row').forEach(r => r.classList.remove('active'));
}

/* ——— PROGRESS TRACKING ——— */
function toggleColorComplete(dmc) {
    dmc = String(dmc);
    const wasComplete = completedDmcs.has(dmc);
    if (wasComplete) completedDmcs.delete(dmc);
    else completedDmcs.add(dmc);
    // Bidirectional sync: toggle all grid cells of this color
    const { grid } = patternData;
    for (let i = 0; i < grid.length; i++) {
        if (String(grid[i]) === dmc) {
            if (wasComplete) stitchedCells.delete(i);
            else stitchedCells.add(i);
        }
    }
    renderMain();
    renderLegend();
    _updateCellProgressBar();
    _scheduleProgressSave();
}

function _scheduleProgressSave() {
    clearTimeout(_progressTimer);
    _progressTimer = setTimeout(() => {
        fetch('/api/saved-patterns/' + PATTERN_SLUG, {
            method: 'PATCH', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ progress_data: {
                completed_dmcs: [...completedDmcs],
                stitched_cells: [...stitchedCells].sort((a, b) => a - b),
                accumulated_seconds: _timerCurrentSeconds()
            }})
        });
    }, 800);
}

/* ——— CELL-LEVEL PROGRESS TRACKING ——— */
function _canvasEventToCell(e) {
    const area = document.getElementById('canvas-area');
    const rect = area.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left - panX) / scale;
    const canvasY = (e.clientY - rect.top  - panY) / scale;
    const col = Math.floor((canvasX - gX()) / cellPx);
    const row = Math.floor((canvasY - gY()) / cellPx);
    if (col < 0 || col >= patternData.grid_w || row < 0 || row >= patternData.grid_h) return null;
    return { col, row };
}

function toggleCellMarkMode() {
    _cellMarkMode = !_cellMarkMode;
    const btn = document.getElementById('cell-mark-btn');
    if (btn) btn.classList.toggle('active', _cellMarkMode);
    const area = document.getElementById('canvas-area');
    area.classList.toggle('cell-mark-mode', _cellMarkMode);
    if (_cellMarkMode && highlightDmc !== null) clearHighlight();
}

function _updateCellProgressBar() {
    const { grid, grid_w, grid_h } = patternData;
    let total = 0;
    for (const dmc of grid) { if (dmc !== 'BG') total++; }
    let done = 0;
    for (const idx of stitchedCells) { if (grid[idx] !== 'BG') done++; }
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    const bar = document.getElementById('cell-progress-bar');
    const label = document.getElementById('cell-progress-label');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent =
        `${pct}% \u00b7 ${done.toLocaleString()} / ${total.toLocaleString()} stitches`;
}

function _syncColorsFromCells() {
    const { grid, grid_w } = patternData;
    // Build per-color totals and stitched counts
    const colorTotals = {};
    const colorStitched = {};
    for (let i = 0; i < grid.length; i++) {
        const dmc = grid[i];
        if (dmc === 'BG') continue;
        const key = String(dmc);
        colorTotals[key] = (colorTotals[key] || 0) + 1;
        if (stitchedCells.has(i)) colorStitched[key] = (colorStitched[key] || 0) + 1;
    }
    // Auto-complete / un-complete based on cell coverage
    for (const dmc of Object.keys(colorTotals)) {
        const stitched = colorStitched[dmc] || 0;
        if (stitched >= colorTotals[dmc]) completedDmcs.add(dmc);
        else completedDmcs.delete(dmc);
    }
}

function _applyCellDragRect() {
    if (!_cellDragStart || !_cellDragEnd) return;
    const minR = Math.min(_cellDragStart.row, _cellDragEnd.row);
    const maxR = Math.max(_cellDragStart.row, _cellDragEnd.row);
    const minC = Math.min(_cellDragStart.col, _cellDragEnd.col);
    const maxC = Math.max(_cellDragStart.col, _cellDragEnd.col);
    const w = patternData.grid_w;
    const grid = patternData.grid;
    for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
            const idx = r * w + c;
            if (grid[idx] === 'BG') continue;
            if (_cellDragToggle) stitchedCells.add(idx);
            else stitchedCells.delete(idx);
        }
    }
}

function _drawCellMarkPreview() {
    const overlay = document.getElementById('overlay-canvas');
    if (!overlay || !_cellDragStart || !_cellDragEnd) return;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const minR = Math.min(_cellDragStart.row, _cellDragEnd.row);
    const maxR = Math.max(_cellDragStart.row, _cellDragEnd.row);
    const minC = Math.min(_cellDragStart.col, _cellDragEnd.col);
    const maxC = Math.max(_cellDragStart.col, _cellDragEnd.col);
    const gutXv = gX(), gutYv = gY();
    const x = gutXv + minC * cellPx;
    const y = gutYv + minR * cellPx;
    const w = (maxC - minC + 1) * cellPx;
    const h = (maxR - minR + 1) * cellPx;
    ctx.strokeStyle = 'rgba(200,145,58,0.9)';
    ctx.lineWidth = 2 / scale;
    ctx.fillStyle = 'rgba(200,145,58,0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
}

function _startCellMark(clientX, clientY) {
    const cell = _canvasEventToCell({ clientX, clientY });
    if (!cell) return false;
    _cellDragActive = true;
    const idx = cell.row * patternData.grid_w + cell.col;
    _cellDragToggle = !stitchedCells.has(idx);
    _cellDragStart = cell;
    _cellDragEnd = cell;
    // Don't apply here — _applyCellDragRect handles the write on mouseup
    return true;
}

function _moveCellMark(clientX, clientY) {
    const cell = _canvasEventToCell({ clientX, clientY });
    if (cell && _cellDragStart) {
        _cellDragEnd = cell;
        _drawCellMarkPreview();
    }
}

function _endCellMark() {
    _cellDragActive = false;
    _applyCellDragRect();
    _syncColorsFromCells();
    _cellDragStart = null;
    _cellDragEnd = null;
    const overlay = document.getElementById('overlay-canvas');
    if (overlay) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    if (highlightDmc !== null) _drawHighlight(highlightDmc);
    renderMain();
    renderLegend();
    _updateCellProgressBar();
    _scheduleProgressSave();
}

/* ——— SESSION TIMER ——— */
function _timerCurrentSeconds() {
    if (_timerSessionStart === null) return _timerAccumSecs;
    return _timerAccumSecs + Math.floor((Date.now() - _timerSessionStart) / 1000);
}

function _timerStart() {
    if (_timerSessionStart !== null) return;
    _timerSessionStart = Date.now();
    _timerInterval = setInterval(_timerTick, 1000);
}

function _timerPause() {
    if (_timerSessionStart === null) return;
    _timerAccumSecs += Math.floor((Date.now() - _timerSessionStart) / 1000);
    _timerSessionStart = null;
    clearInterval(_timerInterval);
    _timerInterval = null;
    _timerDirty = true;
}

function _timerTick() {
    _timerDirty = true;
    _renderTimerDisplay();
}

function _fmtTime(s) {
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h === 0) return m + 'm';
    return h + 'h ' + m + 'm';
}

function _renderTimerDisplay() {
    const el = document.getElementById('timer-display');
    if (!el) return;
    const secs = _timerCurrentSeconds();
    if (secs > 0) {
        el.innerHTML = '<i class="ti ti-clock" aria-hidden="true"></i> ' + escHtml(_fmtTime(secs));
        el.style.display = '';
    } else {
        el.style.display = 'none';
    }
}

function _timerFlush() {
    if (!_timerDirty || !PATTERN_SLUG) return;
    _timerDirty = false;
    fetch('/api/saved-patterns/' + PATTERN_SLUG, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        keepalive: true,
        body: JSON.stringify({ progress_data: {
            completed_dmcs: [...completedDmcs],
            stitched_cells: [...stitchedCells].sort((a, b) => a - b),
            accumulated_seconds: _timerCurrentSeconds()
        }})
    }).catch(() => { _timerDirty = true; });
}

function _timerInit(accSeconds) {
    _timerAccumSecs = accSeconds || 0;
    _timerFlushInterval = setInterval(function() {
        if (_timerDirty) _timerFlush();
    }, 30000);
    _timerStart();
    _renderTimerDisplay();
}

/* ——— RECOUNT STITCHES (client-side, includes all stitch types) ——— */
function _recountLegend() {
    const pd = patternData;
    const counts = {};
    // Full stitches (weight: 1.0)
    for (const dmc of pd.grid) {
        if (dmc === 'BG') continue;
        counts[dmc] = (counts[dmc] || 0) + 1;
    }
    // Part stitches (half=0.5, quarter=0.25, three-quarter=0.75)
    const partWeights = { half: 0.5, quarter: 0.25, three_quarter: 0.75 };
    for (const ps of (pd.part_stitches || [])) {
        counts[ps.dmc] = (counts[ps.dmc] || 0) + (partWeights[ps.type] || 0.5);
    }
    // Backstitches (1 per segment)
    for (const bs of (pd.backstitches || [])) {
        counts[bs.dmc] = (counts[bs.dmc] || 0) + 1;
    }
    // French knots (1 each)
    for (const k of (pd.knots || [])) {
        counts[k.dmc] = (counts[k.dmc] || 0) + 1;
    }
    // Update legend entries
    for (const e of pd.legend) {
        e.stitches = counts[e.dmc] || 0;
    }
    // Rebuild lookup counts
    for (const e of pd.legend) {
        if (lookup[e.dmc]) lookup[e.dmc].count = e.stitches;
    }
    // Reassign backstitch dash indices (so new colors get indices during editing)
    for (const e of pd.legend) {
        if (lookup[e.dmc]) lookup[e.dmc].dashIdx = 0;
    }
    if (pd.backstitches && pd.backstitches.length > 0) {
        const bsDmcs = [...new Set(pd.backstitches.map(bs => bs.dmc))];
        bsDmcs.forEach((dmc, i) => { if (lookup[dmc]) lookup[dmc].dashIdx = i + 1; });
    }
}

/* ——— LEGEND ——— */
function toggleLegendPanel() {
    const panel = document.getElementById('legend-panel');
    const btn = document.getElementById('legend-toggle-btn');
    const isOpen = panel.classList.toggle('open');
    btn.innerHTML = isOpen ? 'Legend <i class="ti ti-chevron-down"></i>' : 'Legend <i class="ti ti-chevron-up"></i>';
}

function setLegendSort(mode) {
    legendSort = mode;
    document.getElementById('sort-btn-number').classList.toggle('active', mode === 'number');
    document.getElementById('sort-btn-stitches').classList.toggle('active', mode === 'stitches');
    renderLegend();
}

function filterLegend() {
    legendFilter = document.getElementById('legend-search').value.trim();
    renderLegend();
}

function _dmcSortKey(dmc) {
    const n = parseInt(dmc, 10);
    return isNaN(n) ? Infinity : n;
}

function renderLegend() {
    const { legend, grid } = patternData;
    const totalSt = legend.reduce((s, e) => s + (e.stitches || 0), 0);
    document.getElementById('legend-totals').textContent =
        `${legend.length} color${legend.length === 1 ? '' : 's'} · ${fmtStitches(totalSt)} stitch${totalSt === 1 ? '' : 'es'}`;

    // Per-color stitched cell counts for fractional display
    const colorStitched = {};
    if (stitchedCells.size > 0) {
        for (const idx of stitchedCells) {
            const dmc = String(grid[idx]);
            if (dmc !== 'BG') colorStitched[dmc] = (colorStitched[dmc] || 0) + 1;
        }
    }

    const sorted = [...legend].sort(legendSort === 'stitches'
        ? (a, b) => (b.stitches || 0) - (a.stitches || 0)
        : (a, b) => _dmcSortKey(a.dmc) - _dmcSortKey(b.dmc) || String(a.dmc).localeCompare(String(b.dmc))
    );
    const q = legendFilter.toLowerCase();
    const filtered = q
        ? sorted.filter(e => String(e.dmc).toLowerCase().includes(q) || (e.name || '').toLowerCase().includes(q))
        : sorted;
    const scroll = document.getElementById('legend-scroll');
    const active = highlightDmc;
    scroll.innerHTML = filtered.map(e => {
        const hex = safeHex(e.hex);
        const sym = e.symbol || '?';
        const fg  = contrastColor(hex);
        const dmcStr = escHtml(String(e.dmc));
        const done = completedDmcs.has(String(e.dmc));
        const di = lookup[e.dmc] ? lookup[e.dmc].dashIdx : 0;
        const dashHtml = (di > 0 && viewMode === 'chart')
            ? `<canvas class="leg-dash" data-dash-idx="${di}" data-hex="${hex}" width="40" height="10"></canvas>`
            : '';
        const stitched = colorStitched[String(e.dmc)] || 0;
        const total = e.stitches || 0;
        const countHtml = stitched > 0
            ? `<span class="lc-done">${fmtStitches(stitched)}</span> / ${fmtStitches(total)}`
            : fmtStitches(total);
        return `<div class="legend-row${done ? ' completed' : ''}${active === String(e.dmc) ? ' active' : ''}" data-dmc="${dmcStr}">
                    <div class="leg-check${done ? ' checked' : ''}" data-dmc="${dmcStr}"><i class="ti ti-check"></i></div>
                    <div class="legend-swatch" style="background:${hex};color:${fg}"><span>${escHtml(sym)}</span></div>
                    ${dashHtml}
                    <div class="legend-info">
                        <div class="legend-dmc">${dmcStr}</div>
                        <div class="legend-name" title="${escHtml(e.name || '')}">${escHtml(e.name || '')}</div>
                    </div>
                    <div class="legend-count">${countHtml}</div>
                    <button class="leg-replace-btn" data-dmc="${dmcStr}" title="Replace this color"><i class="ti ti-replace"></i></button>
                </div>`;
    }).join('');

    if (q && filtered.length === 0) {
        scroll.innerHTML = '<div style="padding:18px 12px;text-align:center;color:var(--muted)">No colors match \u201c' + escHtml(q) + '\u201d</div>';
    }

    // Draw dash patterns on backstitch legend canvases
    for (const c of scroll.querySelectorAll('.leg-dash')) {
        const dCtx = c.getContext('2d');
        const di = parseInt(c.dataset.dashIdx, 10);
        const pat = _BS_DASH_PATTERNS[di % _BS_DASH_PATTERNS.length] || [];
        dCtx.strokeStyle = c.dataset.hex;
        dCtx.lineWidth = 2;
        dCtx.lineCap = 'butt';
        dCtx.setLineDash(pat);
        dCtx.beginPath();
        dCtx.moveTo(2, 5);
        dCtx.lineTo(38, 5);
        dCtx.stroke();
    }

    // Auto-highlight when search narrows to exactly one color
    if (q && filtered.length === 1 && String(highlightDmc) !== String(filtered[0].dmc)) {
        applyHighlight(filtered[0].dmc);
    } else if (q && filtered.length !== 1 && highlightDmc !== null) {
        clearHighlight();
    }
}

/* ——— TRANSFORM ——— */
const _initCellPx = cellPx;
function _updateZoomLabel() {
    const pct = Math.round(cellPx * scale / _initCellPx * 100);
    const el = document.getElementById('zoom-level');
    if (el) el.textContent = pct + '%';
}
function applyTransform() {
    document.getElementById('canvas-wrapper').style.transform =
        `translate(${panX}px,${panY}px) scale(${scale})`;
    updateMinimapViewport();
    _updateZoomLabel();
}

function fitToScreen() {
    const area   = document.getElementById('canvas-area');
    const canvas = document.getElementById('main-canvas');
    if (!canvas.width || !canvas.height) return;
    const areaW = area.clientWidth;
    const areaH = area.clientHeight;
    scale = Math.min(areaW / canvas.width, areaH / canvas.height, 1.0);
    panX  = (areaW - canvas.width  * scale) / 2;
    panY  = (areaH - canvas.height * scale) / 2;
    applyTransform();
}

/* ——— SHARP ZOOM: snap cellPx to canvas resolution after gesture settles ——— */
function scheduleSnap() {
    if (_snapTimer) clearTimeout(_snapTimer);
    _snapTimer = setTimeout(snapCellPx, 150);
}

function snapCellPx() {
    const newCellPx = Math.max(2, Math.min(MAX_CELL_PX, Math.round(cellPx * scale)));
    if (newCellPx === cellPx && Math.abs(scale - 1.0) < 0.001) return;
    const ratio = newCellPx / cellPx;
    const area  = document.getElementById('canvas-area');
    const scx   = area.clientWidth  / 2;
    const scy   = area.clientHeight / 2;
    // Keep the viewport centre fixed through the cellPx change
    panX  = scx - (scx - panX) * ratio / scale;
    panY  = scy - (scy - panY) * ratio / scale;
    scale = 1.0;
    cellPx = newCellPx;
    renderMain();
    applyTransform();
}

/* ——— EDITOR: Page-specific integration ——— */

function _initEditor() {
    editor = createPatternEditor({
        brand:            patternBrand,
        container:        document.getElementById('canvas-area'),
        getPatternData:   () => patternData,
        getLookup:        () => lookup,
        setLookup:        (l) => { lookup = l; },
        eventToStitch:    (e) => _canvasEventToCell(e),
        eventToSubCell:   (e) => {
            const area = document.getElementById('canvas-area');
            const rect = area.getBoundingClientRect();
            const canvasX = (e.clientX - rect.left - panX) / scale;
            const canvasY = (e.clientY - rect.top  - panY) / scale;
            const gx = (canvasX - gX()) / cellPx;
            const gy = (canvasY - gY()) / cellPx;
            if (gx < 0 || gx > patternData.grid_w || gy < 0 || gy > patternData.grid_h) return null;
            return { gx, gy };
        },
        renderSingleCell: (col, row) => {
            // If backstitches/knots exist, fall back to full render (they cross cell boundaries)
            if ((patternData.backstitches && patternData.backstitches.length > 0) ||
                (patternData.knots && patternData.knots.length > 0)) {
                renderMain();
                return;
            }
            const canvas = document.getElementById('main-canvas');
            const ctx = canvas.getContext('2d');
            const gutXv = gX(), gutYv = gY();
            const x = gutXv + col * cellPx;
            const y = gutYv + row * cellPx;
            const dmc = patternData.grid[row * patternData.grid_w + col];
            if (viewMode === 'thread') {
                const fabColor = '#F5F0E8';
                ctx.fillStyle = fabColor;
                ctx.fillRect(x, y, cellPx, cellPx);
                if (dmc !== 'BG') {
                    const info = lookup[dmc];
                    if (info) drawStitch(ctx, x, y, cellPx, info.hex, fabColor);
                }
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(x, y, cellPx, cellPx);
                if (dmc !== 'BG') {
                    const info = lookup[dmc];
                    if (info) {
                        ctx.fillStyle = info.hex;
                        ctx.fillRect(x, y, cellPx, cellPx);
                        if (cellPx >= 8) {
                            const symSize = Math.max(6, Math.floor(cellPx * 0.72));
                            ctx.font = `${symSize}px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols","IBM Plex Mono",sans-serif`;
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.fillStyle = contrastColor(info.hex);
                            ctx.fillText(info.symbol, x + cellPx / 2, y + cellPx / 2);
                        }
                    }
                }
            }
            // Part stitches in this cell
            if (patternData.part_stitches && cellPx >= 3) {
                for (const ps of patternData.part_stitches) {
                    const { sx: psx, sy: psy } = _resolvePartFields(ps);
                    if (psx !== col || psy !== row) continue;
                    const info = lookup[ps.dmc];
                    if (!info) continue;
                    if (viewMode === 'thread') {
                        drawThreadPartStitch(ctx, x, y, cellPx, ps, info.hex);
                    } else {
                        drawChartPartStitch(ctx, x, y, cellPx, ps, info.hex, info.symbol);
                    }
                }
            }
            ctx.strokeStyle = 'rgba(0,0,0,0.15)';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(x, y, cellPx, cellPx);
            const bw = Math.max(1, cellPx / 7);
            if (col % 10 === 0 || row % 10 === 0 || (col+1) % 10 === 0 || (row+1) % 10 === 0) {
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = bw;
                if (col % 10 === 0)       { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y+cellPx); ctx.stroke(); }
                if (row % 10 === 0)       { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x+cellPx, y); ctx.stroke(); }
                if ((col+1) % 10 === 0)   { ctx.beginPath(); ctx.moveTo(x+cellPx, y); ctx.lineTo(x+cellPx, y+cellPx); ctx.stroke(); }
                if ((row+1) % 10 === 0)   { ctx.beginPath(); ctx.moveTo(x, y+cellPx); ctx.lineTo(x+cellPx, y+cellPx); ctx.stroke(); }
            }
        },
        renderAll:        () => { renderMain(); renderMinimap(); updateMinimapViewport(); },
        renderLegend:     () => { renderLegend(); },
        getOverlayCanvas: () => document.getElementById('overlay-canvas'),
        getCellPx:        () => cellPx,
        getGridOffset:    () => ({ x: gX(), y: gY() }),
        onDirty:          () => {
            const saveBtn = document.getElementById('save-btn');
            if (saveBtn && !saveBtn.textContent.includes('\u25cf')) saveBtn.textContent = '\u25cf Save';
        },
        onClean:          () => { document.getElementById('save-btn').textContent = 'Save'; },
        onOverlayClear:   () => { if (highlightDmc !== null) _drawHighlight(highlightDmc); },
        onSave:           () => savePattern(),
        symbolSet:        _PATTERN_SYMBOLS,
    });
    editor.injectUI();
}

function toggleEditMode() {
    if (editMode) {
        editMode = false;
        _editSnapshot = null;
        editor.deactivate();
        document.body.classList.remove('edit-mode-on');
        document.getElementById('edit-toggle-btn').textContent = 'Edit Pattern';
        document.getElementById('edit-toggle-btn').style.color = '';
        document.getElementById('edit-toggle-btn').style.display = '';
        document.getElementById('cancel-btn').style.display = 'none';
        document.getElementById('save-btn').style.display = 'none';
        renderMain();  // re-render in chart/thread view mode
    } else {
        if (!isForked) { showForkDialog(); return; }
        if (_cellMarkMode) toggleCellMarkMode();
        _editSnapshot = {
            grid: patternData.grid.slice(),
            legend: JSON.parse(JSON.stringify(patternData.legend)),
            lookup: JSON.parse(JSON.stringify(lookup)),
            part_stitches: JSON.parse(JSON.stringify(patternData.part_stitches || [])),
            backstitches: JSON.parse(JSON.stringify(patternData.backstitches || [])),
            knots: JSON.parse(JSON.stringify(patternData.knots || [])),
        };
        editMode = true;
        editor.activate();
        document.body.classList.add('edit-mode-on');
        document.getElementById('edit-toggle-btn').style.display = 'none';
        document.getElementById('cancel-btn').style.display = '';
        document.getElementById('save-btn').style.display = '';
        renderMain();  // re-render in thread mode for editing
    }
}

function showForkDialog() {
    document.getElementById('fork-dialog').style.display = 'flex';
}
function closeForkDialog() {
    document.getElementById('fork-dialog').style.display = 'none';
}
function editOriginal() {
    closeForkDialog();
    isForked = true;
    toggleEditMode();
}
async function cancelEdit() {
    if (editor && editor.isDirty()) {
        const ok = await confirmDialog('Discard all unsaved changes?');
        if (!ok) return;
    }
    if (_editSnapshot) {
        patternData.grid = _editSnapshot.grid;
        patternData.legend = _editSnapshot.legend;
        lookup = _editSnapshot.lookup;
        patternData.part_stitches = _editSnapshot.part_stitches;
        patternData.backstitches = _editSnapshot.backstitches;
        patternData.knots = _editSnapshot.knots;
    }
    editor.clearDirty();
    toggleEditMode();
    renderMain();
    renderMinimap();
    updateMinimapViewport();
    renderLegend();
    _updateCellProgressBar();
}
async function confirmFork() {
    closeForkDialog();
    const name = (document.getElementById('pattern-title').textContent || 'Untitled') + ' (edited)';
    try {
        const resp = await fetch('/api/saved-patterns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name:          name,
                brand:         patternBrand,
                grid_w:        patternData.grid_w,
                grid_h:        patternData.grid_h,
                grid_data:     patternData.grid,
                legend_data:   patternData.legend,
                thumbnail:     patternData.thumbnail || null,
                part_stitches: patternData.part_stitches || [],
                backstitches:  patternData.backstitches  || [],
                knots:         patternData.knots         || [],
            })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        window.location.href = '/view/' + data.slug + '?edit=1';
    } catch (err) {
        await alertDialog('Failed to create copy: ' + err.message, { type: 'error' });
    }
}

function generateThumbnail() {
    if (!patternData) return null;
    const { grid, grid_w, grid_h, legend } = patternData;
    const rgbLookup = {};
    for (const e of legend) rgbLookup[e.dmc] = hexToRgb(e.hex || '#888888');
    const bgRgb = [255, 255, 255];
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

async function savePattern() {
    if (!editMode || !isForked) return;
    const saveBtn = document.getElementById('save-btn');
    const originalText = saveBtn.textContent;
    saveBtn.textContent = 'Saving\u2026';
    saveBtn.disabled = true;
    try {
        const thumbnail = generateThumbnail();
        const resp = await fetch('/api/saved-patterns/' + PATTERN_SLUG, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grid_data:     patternData.grid,
                legend_data:   patternData.legend,
                grid_w:        patternData.grid_w,
                grid_h:        patternData.grid_h,
                part_stitches: patternData.part_stitches || [],
                backstitches:  patternData.backstitches  || [],
                knots:         patternData.knots         || [],
                thumbnail:     thumbnail,
            })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        editor.clearDirty();
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        toggleEditMode();
        toast('Pattern saved.', { type: 'success' });
    } catch (err) {
        toast('Save failed: ' + err.message, { type: 'error' });
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
    }
}

/* ——— MOUSE WHEEL / TRACKPAD ——— */
document.getElementById('canvas-area').addEventListener('wheel', function(e) {
    e.preventDefault();
    if (e.ctrlKey) {
        // Pinch-to-zoom (trackpad) or Ctrl+wheel (mouse)
        const rect   = this.getBoundingClientRect();
        const mx     = e.clientX - rect.left;
        const my     = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
        panX   = mx - (mx - panX) * factor;
        panY   = my - (my - panY) * factor;
        scale  = Math.max(0.05, Math.min(MAX_CELL_PX / cellPx, scale * factor));
    } else {
        // Two-finger scroll (trackpad) or plain mouse wheel → pan
        panX -= e.deltaX;
        panY -= e.deltaY;
    }
    applyTransform();
    scheduleSnap();
}, { passive: false });

/* ——— MOUSE PAN ——— */
let _dragging = false;
let _dragSX = 0, _dragSY = 0, _panSX = 0, _panSY = 0;

document.getElementById('canvas-area').addEventListener('mousedown', function(e) {
    if (e.target.id === 'mini-canvas') return;
    if (editor && editor.isUIElement(e.target)) return;
    e.preventDefault();
    // Cell marking mode — intercept before editor and pan
    if (_cellMarkMode && !editMode && e.button === 0) {
        _startCellMark(e.clientX, e.clientY);
        return;
    }
    if (editor && editor.isActive() && !editor.wantsPan() && e.button === 0) {
        editor.handleMouseDown(e);
        return;
    }
    _dragging = true;
    _dragSX = e.clientX; _dragSY = e.clientY;
    _panSX = panX;       _panSY = panY;
    this.classList.add('dragging');
});
document.addEventListener('mousemove', function(e) {
    if (_cellDragActive && _cellMarkMode && !editMode) {
        _moveCellMark(e.clientX, e.clientY);
        return;
    }
    if (editor && editor.isActive() && !editor.wantsPan()) {
        editor.handleMouseMove(e);
    }
    if (!_dragging) return;
    panX = _panSX + (e.clientX - _dragSX) * 0.65;
    panY = _panSY + (e.clientY - _dragSY) * 0.65;
    applyTransform();
});
document.addEventListener('mouseup', function() {
    if (_cellDragActive) {
        _endCellMark();
        return;
    }
    if (editor && editor.isActive()) editor.handleMouseUp();
    if (!_dragging) return;
    _dragging = false;
    document.getElementById('canvas-area').classList.remove('dragging');
});

// Hover cell highlight — clear on leave
document.getElementById('canvas-area').addEventListener('mouseleave', function() {
    if (editor && editor.isActive()) editor.handleMouseLeave();
});

/* ——— TOUCH PAN / PINCH ZOOM / EDITOR DRAW ——— */
let _t1 = null, _t2 = null;
let _tPanSX = 0, _tPanSY = 0, _tDragSX = 0, _tDragSY = 0;
let _tStartDist = 0, _tStartScale = 1;
let _tEditorDrawing = false;

function _touchToMouse(touch, target) {
    return { clientX: touch.clientX, clientY: touch.clientY, shiftKey: false, button: 0, target: target, preventDefault: function(){} };
}

document.getElementById('canvas-area').addEventListener('touchstart', function(e) {
    const touches = e.touches;
    if (touches.length === 1) {
        if (_cellMarkMode && !editMode) {
            e.preventDefault();
            _tEditorDrawing = false;
            _startCellMark(touches[0].clientX, touches[0].clientY);
            return;
        }
        if (editor && editor.isActive() && !editor.wantsPan()) {
            e.preventDefault();
            _tEditorDrawing = true;
            editor.handleMouseDown(_touchToMouse(touches[0], e.target));
            return;
        }
        _tEditorDrawing = false;
        _t1 = { x: touches[0].clientX, y: touches[0].clientY };
        _t2 = null;
        _tDragSX = touches[0].clientX; _tDragSY = touches[0].clientY;
        _tPanSX = panX; _tPanSY = panY;
        _dragging = true;
    } else if (touches.length >= 2) {
        e.preventDefault();
        _tEditorDrawing = false;
        _dragging = false;
        _tStartDist  = Math.hypot(
            touches[1].clientX - touches[0].clientX,
            touches[1].clientY - touches[0].clientY
        );
        _tStartScale = scale;
        _t1 = { x: touches[0].clientX, y: touches[0].clientY };
        _t2 = { x: touches[1].clientX, y: touches[1].clientY };
    }
}, { passive: false });

document.getElementById('canvas-area').addEventListener('touchmove', function(e) {
    const touches = e.touches;
    if (_cellDragActive && _cellMarkMode && touches.length === 1) {
        e.preventDefault();
        _moveCellMark(touches[0].clientX, touches[0].clientY);
        return;
    }
    if (_tEditorDrawing && touches.length === 1) {
        e.preventDefault();
        editor.handleMouseMove(_touchToMouse(touches[0], e.target));
        return;
    }
    if (touches.length === 1 && _dragging) {
        e.preventDefault();
        panX = _tPanSX + (touches[0].clientX - _tDragSX);
        panY = _tPanSY + (touches[0].clientY - _tDragSY);
        applyTransform();
    } else if (touches.length >= 2 && _tStartDist) {
        e.preventDefault();
        const dist = Math.hypot(
            touches[1].clientX - touches[0].clientX,
            touches[1].clientY - touches[0].clientY
        );
        const newScale = Math.max(0.05, Math.min(MAX_CELL_PX / cellPx, _tStartScale * dist / _tStartDist));
        const rect = this.getBoundingClientRect();
        const mx = ((touches[0].clientX + touches[1].clientX) / 2) - rect.left;
        const my = ((touches[0].clientY + touches[1].clientY) / 2) - rect.top;
        const factor = newScale / scale;
        panX = mx - (mx - panX) * factor;
        panY = my - (my - panY) * factor;
        scale = newScale;
        applyTransform();
        scheduleSnap();
    }
}, { passive: false });

document.getElementById('canvas-area').addEventListener('touchend', function() {
    if (_cellDragActive) { _endCellMark(); return; }
    if (_tEditorDrawing) { editor.handleMouseUp(); _tEditorDrawing = false; return; }
    _dragging = false;
    if (_tStartDist) scheduleSnap();
    _tStartDist = 0;
}, { passive: true });

/* ——— MINIMAP CLICK — jump pan ——— */
document.getElementById('minimap-wrap').addEventListener('click', function(e) {
    const canvas = document.getElementById('mini-canvas');
    if (!canvas._mmS || !patternData) return;
    const rect  = canvas.getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const my    = e.clientY - rect.top;
    const ms    = canvas._mmS * MM_CELL; // minimap px per stitch
    const sX    = mx / ms;              // stitch coordinate
    const sY    = my / ms;
    const area  = document.getElementById('canvas-area');
    panX = area.clientWidth  / 2 - (gX() + sX * cellPx) * scale;
    panY = area.clientHeight / 2 - (gY() + sY * cellPx) * scale;
    applyTransform();
});

/* ——— ZOOM +/- BUTTONS ——— */
document.getElementById('zoom-in-btn').addEventListener('click', function() {
    const area = document.getElementById('canvas-area');
    const cx = area.clientWidth / 2, cy = area.clientHeight / 2;
    const factor = 1.3;
    panX = cx - (cx - panX) * factor;
    panY = cy - (cy - panY) * factor;
    scale = Math.max(0.05, Math.min(MAX_CELL_PX / cellPx, scale * factor));
    applyTransform();
    scheduleSnap();
});
document.getElementById('zoom-out-btn').addEventListener('click', function() {
    const area = document.getElementById('canvas-area');
    const cx = area.clientWidth / 2, cy = area.clientHeight / 2;
    const factor = 1 / 1.3;
    panX = cx - (cx - panX) * factor;
    panY = cy - (cy - panY) * factor;
    scale = Math.max(0.05, Math.min(MAX_CELL_PX / cellPx, scale * factor));
    applyTransform();
    scheduleSnap();
});

/* ——— ZEN / FULLSCREEN MODE ——— */
let zenMode = false;
let _zenMoveTimer = null;

function toggleZenMode() {
    if (zenMode) exitZenMode();
    else enterZenMode();
}

function enterZenMode() {
    zenMode = true;
    clearTimeout(_zenMoveTimer);
    // Close any open dropdowns
    document.getElementById('calc-menu').classList.remove('open');
    document.getElementById('calc-toggle').classList.remove('open');
    document.getElementById('zen-menu').classList.remove('open');
    document.getElementById('zen-menu-btn').classList.remove('open');
    document.body.classList.add('zen-mode');
    // Try browser fullscreen (may be denied, that's OK — zen mode still works)
    if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(function() {});
    } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen();
    }
    _updateZenUI();
    _syncZenMenuLabels();
    // Reflow canvas after header hides (non-fullscreen case — immediate DOM change)
    setTimeout(function() { fitToScreen(); updateMinimapViewport(); }, 50);
}

function exitZenMode() {
    zenMode = false;
    document.body.classList.remove('zen-mode');
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen().catch(function() {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
    _updateZenUI();
    setTimeout(function() { fitToScreen(); updateMinimapViewport(); }, 50);
}

function _updateZenUI() {
    const btn = document.getElementById('zen-btn');
    if (btn) {
        btn.innerHTML = zenMode ? '<i class="ti ti-arrows-minimize"></i> Exit Zen' : 'Zen Mode';
        btn.title = zenMode ? 'Exit Zen (F)' : 'Zen Mode (F)';
    }
    // Drive zen menu button visibility
    var menuBtn = document.getElementById('zen-menu-btn');
    if (menuBtn) menuBtn.classList.toggle('visible', zenMode);
    // Close menu if exiting
    if (!zenMode) {
        document.getElementById('zen-menu').classList.remove('open');
        if (menuBtn) menuBtn.classList.remove('open');
    }
}

// Sync zen mode with browser fullscreen state changes
function _onFullscreenChange() {
    if ((document.fullscreenElement || document.webkitFullscreenElement) && zenMode) {
        // Just entered fullscreen — reflow now that dimensions are final
        fitToScreen(); updateMinimapViewport();
    } else if (!document.fullscreenElement && !document.webkitFullscreenElement && zenMode) {
        // Exited fullscreen (e.g. browser Escape) — also exit zen mode
        zenMode = false;
        document.body.classList.remove('zen-mode');
        _updateZenUI();
        setTimeout(function() { fitToScreen(); updateMinimapViewport(); }, 50);
    }
}
document.addEventListener('fullscreenchange', _onFullscreenChange);
document.addEventListener('webkitfullscreenchange', _onFullscreenChange);

// Show zen toolbar on mouse movement, auto-hide after 2s idle
document.addEventListener('mousemove', function() {
    if (!zenMode) return;
    var menuBtn = document.getElementById('zen-menu-btn');
    if (menuBtn) menuBtn.classList.add('visible');
    clearTimeout(_zenMoveTimer);
    _zenMoveTimer = setTimeout(function() {
        if (!zenMode) return;
        // Don't hide while menu is open
        if (document.getElementById('zen-menu').classList.contains('open')) return;
        var menuBtn = document.getElementById('zen-menu-btn');
        if (menuBtn) menuBtn.classList.remove('visible');
    }, 2000);
});

/* ——— KEYBOARD ——— */
document.addEventListener('keydown', function(e) {
    // Suppress editor shortcuts when dialogs are open
    if (document.querySelector('.notify-overlay')) return;
    const forkDlg = document.getElementById('fork-dialog');
    if (forkDlg && forkDlg.style.display !== 'none') return;
    if (editor && editor.isActive()) {
        if (editor.handleKeyDown(e)) return;
    }
    if (e.key === 'Escape') {
        if (zenMode) { exitZenMode(); return; }
        const searchEl = document.getElementById('legend-search');
        if (searchEl && searchEl.value) {
            searchEl.value = '';
            filterLegend();
            searchEl.blur();
            return;
        }
        clearHighlight();
        return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    const inInput = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    // ? key — show shortcut cheat sheet
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!inInput) {
            e.preventDefault();
            showShortcutHelp(editMode && editor && editor.isActive());
            return;
        }
    }
    // F key — toggle zen/fullscreen
    if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!inInput) {
            e.preventDefault();
            toggleZenMode();
            return;
        }
    }
    // M key — toggle cell mark mode (viewer only)
    if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!inInput && !editMode) {
            e.preventDefault();
            toggleCellMarkMode();
            return;
        }
    }
});
document.addEventListener('keyup', function(e) {
    if (editor && editor.isActive()) editor.handleKeyUp(e);
});

// Timer: pause on tab hidden, resume on visible
document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
        _timerPause();
        _timerFlush();
    } else {
        _timerStart();
        _renderTimerDisplay();
    }
});

window.addEventListener('beforeunload', function() {
    _timerPause();
    _timerFlush();
});

/* ——— LEGEND RESIZE ——— */
(function() {
    const handle = document.getElementById('legend-resize-handle');
    const panel  = document.getElementById('legend-panel');
    const MIN_W  = 150;
    const MAX_W  = 520;
    let _rDragging = false;
    let _rStartX   = 0;
    let _rStartW   = 220;

    function _applyWidth(w) {
        const clamped = Math.max(MIN_W, Math.min(MAX_W, w));
        panel.style.width = clamped + 'px';
        const ratio = clamped / 220;   // 1.0 at default, grows with panel
        // Scale swatches + checkboxes together
        const sw  = Math.max(20, Math.min(32, Math.round(20 * ratio)));
        const swF = Math.max(9,  Math.min(14, Math.round(9  * ratio)));
        const chk = Math.max(16, Math.min(26, Math.round(16 * ratio)));
        panel.style.setProperty('--sw',      sw  + 'px');
        panel.style.setProperty('--sw-font', swF + 'px');
        panel.style.setProperty('--chk',     chk + 'px');
        // Scale row text
        const dmcFs  = Math.max(10, Math.min(15, Math.round(10 * ratio)));
        const nameFs = Math.max(9,  Math.min(13, Math.round(9  * ratio)));
        const cntFs  = Math.max(9,  Math.min(13, Math.round(9  * ratio)));
        panel.style.setProperty('--leg-dmc',   dmcFs  + 'px');
        panel.style.setProperty('--leg-name',  nameFs + 'px');
        panel.style.setProperty('--leg-count', cntFs  + 'px');
        // Scale header elements
        const s = (base, min, max) => Math.max(min, Math.min(max, Math.round(base * ratio))) + 'px';
        panel.style.setProperty('--lh-title',      s(15, 12, 22));
        panel.style.setProperty('--lh-totals',     s(9,  7, 13));
        panel.style.setProperty('--lh-sort',       s(8,  6, 12));
        panel.style.setProperty('--lh-sort-py',    s(2,  2,  4));
        panel.style.setProperty('--lh-sort-px',    s(6,  4,  9));
        panel.style.setProperty('--lh-search',     s(10, 8, 14));
        panel.style.setProperty('--lh-search-py',  s(5,  4,  8));
        panel.style.setProperty('--lh-search-px',  s(8,  6, 12));
        panel.style.setProperty('--lh-pad-y',      s(12, 8, 16));
        panel.style.setProperty('--lh-pad-x',      s(14, 10, 20));
        panel.style.setProperty('--lh-pad-b',      s(9,  6, 13));
    }

    // Restore saved width
    const saved = parseInt(localStorage.getItem('dmc-legend-width'), 10);
    if (saved >= MIN_W && saved <= MAX_W) _applyWidth(saved);

    function _rStart(x) {
        _rDragging = true;
        _rStartX   = x;
        _rStartW   = panel.offsetWidth;
        handle.classList.add('resizing');
        document.body.style.userSelect = 'none';
        document.body.style.cursor     = 'col-resize';
    }
    function _rMove(x) {
        if (!_rDragging) return;
        _applyWidth(_rStartW + (_rStartX - x));
    }
    function _rEnd() {
        if (!_rDragging) return;
        _rDragging = false;
        handle.classList.remove('resizing');
        document.body.style.userSelect = '';
        document.body.style.cursor     = '';
        localStorage.setItem('dmc-legend-width', panel.offsetWidth);
    }

    handle.addEventListener('mousedown', function(e) { e.preventDefault(); _rStart(e.clientX); });
    document.addEventListener('mousemove', function(e) { _rMove(e.clientX); });
    document.addEventListener('mouseup', _rEnd);

    handle.addEventListener('touchstart', function(e) { e.preventDefault(); _rStart(e.touches[0].clientX); }, { passive: false });
    document.addEventListener('touchmove', function(e) { if (_rDragging) { e.preventDefault(); _rMove(e.touches[0].clientX); } }, { passive: false });
    document.addEventListener('touchend', _rEnd);
})();

/* ——— VIEW MODE TOGGLE (chart / thread) ——— */
function toggleViewMode() {
    viewMode = viewMode === 'chart' ? 'thread' : 'chart';
    localStorage.setItem('pv-viewMode', viewMode);
    updateViewModeBtn();
    renderMain();
    renderLegend();
}
function updateViewModeBtn() {
    const btn = document.getElementById('view-mode-btn');
    if (!btn) return;
    btn.innerHTML = viewMode === 'chart'
        ? '<i class="ti ti-needle"></i> Thread View'
        : '<i class="ti ti-grid-dots"></i> Chart View';
}

/* ——— INIT ——— */
async function init() {
    try {
        const resp = await fetch(`/api/saved-patterns/${PATTERN_SLUG}`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);

        patternBrand = data.brand || 'DMC';
        patternData = {
            grid:          data.grid_data,
            grid_w:        data.grid_w,
            grid_h:        data.grid_h,
            legend:        data.legend_data,
            thumbnail:     data.thumbnail || null,
            part_stitches: data.part_stitches || [],
            backstitches:  data.backstitches  || [],
            knots:         data.knots         || [],
            brand:         patternBrand,
        };

        // Update brand-dependent UI labels
        const sortNumBtn = document.getElementById('sort-btn-number');
        if (sortNumBtn) sortNumBtn.textContent = patternBrand + ' #';
        const searchInput = document.getElementById('legend-search');
        if (searchInput) searchInput.placeholder = 'Search ' + patternBrand + ' # or name\u2026';

        // Build lookup
        lookup = {};
        for (const e of patternData.legend) {
            lookup[e.dmc] = { hex: e.hex || '#888888', symbol: e.symbol || '?', name: e.name || '', count: e.stitches || 0, dashIdx: 0 };
        }
        // Assign dash pattern indices to backstitch colors
        if (patternData.backstitches && patternData.backstitches.length > 0) {
            const bsDmcs = [...new Set(patternData.backstitches.map(bs => bs.dmc))];
            bsDmcs.forEach((dmc, i) => { if (lookup[dmc]) lookup[dmc].dashIdx = i + 1; });
        }

        // Recount stitches to include part stitches, backstitches, and knots
        _recountLegend();

        // Load saved progress
        for (const dmc of (data.completed_dmcs || [])) completedDmcs.add(String(dmc));
        for (const idx of (data.stitched_cells || [])) {
            if (typeof idx === 'number' && patternData.grid[idx] !== 'BG') stitchedCells.add(idx);
        }

        // Update header
        document.getElementById('pattern-title').textContent = data.name;
        document.getElementById('pattern-meta').textContent =
            `${data.grid_w} × ${data.grid_h} · ${data.color_count} color${data.color_count === 1 ? '' : 's'}`;
        document.title = data.name + ' — Pattern Viewer — Needlework Studio';

        // Set up view mode button
        updateViewModeBtn();

        // Render everything
        renderMain();
        fitToScreen();
        renderMinimap();
        updateMinimapViewport();
        renderLegend();
        _updateCellProgressBar();
        _timerInit(data.accumulated_seconds || 0);

        // Initialise shared editor module
        _initEditor();

        // Delegated legend click handler (set up once here)
        document.getElementById('legend-scroll').addEventListener('click', function(e) {
            const replBtn = e.target.closest('.leg-replace-btn');
            if (replBtn) {
                e.stopPropagation();
                if (editMode && editor) editor.startReplace(replBtn.dataset.dmc);
                return;
            }
            const check = e.target.closest('.leg-check');
            if (check) {
                if (editMode) return;  // progress disabled in edit mode
                toggleColorComplete(check.dataset.dmc);
                return;
            }
            const row = e.target.closest('.legend-row');
            if (row) {
                if (editMode) editor.setActiveColor(row.dataset.dmc);
                else applyHighlight(row.dataset.dmc);
            }
        });

        // Hide loading overlay
        document.getElementById('loading-overlay').style.display = 'none';

        // Check for edit mode from fork redirect
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('edit') === '1') {
            isForked = true;
            toggleEditMode();
            window.history.replaceState({}, '', window.location.pathname);
        }
    } catch (err) {
        const el = document.getElementById('loading-overlay').querySelector('.loading-text');
        el.textContent = 'Error loading pattern: ' + err.message;
    }
}

window.addEventListener('load', init);
window.addEventListener('resize', function() {
    if (patternData) {
        fitToScreen();
        updateMinimapViewport();
    }
});
window.addEventListener('beforeunload', function(e) {
    if (editor && editor.isDirty()) {
        e.preventDefault();
        e.returnValue = '';
    }
});
