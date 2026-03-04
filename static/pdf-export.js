/* ── Shared PDF Export for Cross-Stitch Patterns ────────────── */
/* Used by saved-patterns.html and image-to-pattern.html.       */
/* Requires: jsPDF (window.jspdf), contrastColor() from utils.js */

/**
 * Generate and save a PDF chart for a cross-stitch pattern.
 *
 * @param {string} patternName  — Title for cover page and filename.
 * @param {Object} patternData  — { grid, grid_w, grid_h, legend }.
 * @param {Object} [opts]       — Optional overrides.
 * @param {boolean} [opts.skipBG=false] — Skip cells with dmc === 'BG'.
 * @param {number}  [opts.symbolScale=0.6] — Symbol font multiplier (0–1).
 * @param {function} [opts.onProgress] — Called with (current, total) page counts.
 */
async function generatePatternPDF(patternName, patternData, opts) {
    const { jsPDF } = window.jspdf;
    const { grid, grid_w, grid_h, legend } = patternData;
    const skipBG      = opts?.skipBG ?? false;
    const symbolScale = opts?.symbolScale ?? 0.6;
    const onProgress  = opts?.onProgress;

    const lookup = {};
    for (const e of legend) lookup[e.dmc] = { hex: e.hex || '#888888', symbol: e.symbol || '?' };

    // Layout constants
    const CELL_PX    = 48;
    const CELL_MM    = 2.5;
    const ROW_LBL_MM = 12;
    const COL_LBL_MM = 8;
    const ROW_LBL_PX = Math.round(ROW_LBL_MM * CELL_PX / CELL_MM);
    const COL_LBL_PX = Math.round(COL_LBL_MM * CELL_PX / CELL_MM);
    const ML = 20, MR = 15, MT = 15, MB = 15;
    const PW = 210, PH = 297;
    const colsPerPage = Math.floor((PW - ML - MR - ROW_LBL_MM) / CELL_MM);
    const rowsPerPage = Math.floor((PH - MT - MB - COL_LBL_MM) / CELL_MM);
    const colTiles    = Math.ceil(grid_w / colsPerPage);
    const rowTiles    = Math.ceil(grid_h / rowsPerPage);

    const legendEntries = legend.slice().sort((a, b) => b.stitches - a.stitches);

    const LEG_ROW_H   = 7;
    const LEG_START_Y = 42;
    let legendPageCount = 1;
    { let y = LEG_START_Y;
      for (const e of legendEntries) { if (y > 270) { legendPageCount++; y = LEG_START_Y; } y += LEG_ROW_H; } }

    const totalPages = 1 + rowTiles * colTiles + legendPageCount;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

    // ── PAGE 1: COVER ──────────────────────────────────────────
    pdf.setTextColor(40, 30, 20);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(22);
    pdf.text(patternName, 105, 30, { align: 'center' });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(13);
    pdf.text('Cross stitch chart', 105, 39, { align: 'center' });
    pdf.setDrawColor(180, 150, 100);
    pdf.line(20, 43, 190, 43);

    // Preview image (realistic stitch rendering)
    const prevCellPx = 19;
    const prevCanvas = document.createElement('canvas');
    prevCanvas.width  = grid_w * prevCellPx;
    prevCanvas.height = grid_h * prevCellPx;
    const prevCtx = prevCanvas.getContext('2d');
    const fabColor = '#F5F0E8';
    prevCtx.fillStyle = fabColor;
    prevCtx.fillRect(0, 0, prevCanvas.width, prevCanvas.height);
    // Fabric texture: weave + aida dots (before stitches so it's behind them)
    drawStitchFabric(prevCtx, prevCanvas.width, prevCanvas.height, prevCellPx, grid_w, grid_h, fabColor);
    for (let r = 0; r < grid_h; r++) {
        for (let c = 0; c < grid_w; c++) {
            const dmc = grid[r * grid_w + c];
            if (dmc === 'BG') continue;
            const hex = (lookup[dmc] || { hex: '#888888' }).hex;
            drawStitch(prevCtx, c * prevCellPx, r * prevCellPx, prevCellPx, hex, fabColor);
        }
    }
    // Paint BG cells with fabric color
    for (let r = 0; r < grid_h; r++) {
        for (let c = 0; c < grid_w; c++) {
            if (grid[r * grid_w + c] === 'BG') {
                prevCtx.fillStyle = fabColor;
                prevCtx.fillRect(c * prevCellPx, r * prevCellPx, prevCellPx, prevCellPx);
            }
        }
    }
    // Gridlines
    prevCtx.strokeStyle = 'rgba(0,0,0,0.4)';
    prevCtx.lineWidth = 1;
    for (let c = 0; c <= grid_w; c++) {
        const x = c * prevCellPx;
        prevCtx.beginPath(); prevCtx.moveTo(x, 0); prevCtx.lineTo(x, prevCanvas.height); prevCtx.stroke();
    }
    for (let r = 0; r <= grid_h; r++) {
        const y = r * prevCellPx;
        prevCtx.beginPath(); prevCtx.moveTo(0, y); prevCtx.lineTo(prevCanvas.width, y); prevCtx.stroke();
    }
    const boxW = 150, boxH = 100;
    const asp = grid_h / grid_w;
    let iW = boxW, iH = boxW * asp;
    if (iH > boxH) { iH = boxH; iW = boxH / asp; }
    const iX = (PW - iW) / 2, iY = 48;
    pdf.addImage(prevCanvas.toDataURL('image/png'), 'PNG', iX, iY, iW, iH, undefined, 'FAST');
    const prevBot = iY + iH;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor(40, 30, 20);
    pdf.text(`Design size: ${grid_w} \u00d7 ${grid_h} stitches`, 105, prevBot + 8, { align: 'center' });
    pdf.text('Chart imported from image', 20, prevBot + 15);

    // ── PAGES 2–N: GRID TILES ──────────────────────────────────
    let pageNum = 1;
    const gridTileCount = rowTiles * colTiles;
    if (onProgress) onProgress(0, gridTileCount);
    for (let rowTile = 0; rowTile < rowTiles; rowTile++) {
        for (let colTile = 0; colTile < colTiles; colTile++) {
            pageNum++;
            const sc = colTile * colsPerPage;
            const sr = rowTile * rowsPerPage;
            const tw = Math.min(colsPerPage, grid_w - sc);
            const th = Math.min(rowsPerPage, grid_h - sr);
            const tileCanvas = _pdfRenderGridTile(
                sc, sr, tw, th, grid, grid_w, lookup,
                ROW_LBL_PX, COL_LBL_PX, CELL_PX, skipBG, symbolScale,
                patternData.part_stitches, patternData.backstitches, patternData.knots
            );
            pdf.addPage();
            pdf.addImage(tileCanvas.toDataURL('image/png'), 'PNG',
                ML, MT,
                ROW_LBL_MM + tw * CELL_MM,
                COL_LBL_MM + th * CELL_MM,
                undefined, 'FAST');
            _pdfAddFooter(pdf, pageNum, totalPages);
            // Yield to browser so UI can repaint progress
            if (onProgress) onProgress(pageNum - 1, gridTileCount);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    // ── LEGEND PAGE(S) ─────────────────────────────────────────
    pdf.addPage();
    pageNum++;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(40, 30, 20);
    pdf.text('Use 2 strands of thread for cross stitch', 105, 22, { align: 'center' });

    const CL_N = 20, CL_SW = 29, CL_DMC = 38, CL_NAME = 58, CL_ST = 149;

    function drawLegendHeaders(y) {
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        pdf.setTextColor(40, 30, 20);
        pdf.text('#',        CL_N + 6,   y, { align: 'right' });
        pdf.text('Symbol',   CL_SW + 3,  y, { align: 'center' });
        pdf.text((patternData.brand || 'DMC') + ' #', CL_DMC, y);
        pdf.text('Name',     CL_NAME,    y);
        pdf.text('Stitches', CL_ST + 18, y, { align: 'right' });
        pdf.setDrawColor(150, 130, 100);
        pdf.line(20, y + 3, 190, y + 3);
    }

    drawLegendHeaders(32);

    const swCanvas = document.createElement('canvas');
    swCanvas.width = swCanvas.height = 24;
    const swCtx = swCanvas.getContext('2d');

    let yL = LEG_START_Y;
    for (let i = 0; i < legendEntries.length; i++) {
        if (yL > 270) {
            _pdfAddFooter(pdf, pageNum, totalPages);
            pdf.addPage();
            pageNum++;
            drawLegendHeaders(20);
            yL = 28;
        }
        const e = legendEntries[i];
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8);
        pdf.setTextColor(40, 30, 20);
        pdf.text(String(i + 1), CL_N + 6, yL, { align: 'right' });

        swCtx.clearRect(0, 0, 24, 24);
        swCtx.fillStyle = e.hex || '#888888';
        swCtx.fillRect(0, 0, 24, 24);
        swCtx.fillStyle = contrastColor(e.hex || '#888888');
        swCtx.font = '13px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols",sans-serif';
        swCtx.textAlign = 'center';
        swCtx.textBaseline = 'middle';
        swCtx.fillText(e.symbol || '?', 12, 12);
        pdf.addImage(swCanvas.toDataURL('image/png'), 'PNG', CL_SW, yL - 4.5, 6, 6, undefined, 'FAST');

        pdf.text(String(e.dmc || '\u2014'), CL_DMC, yL);
        pdf.text((e.name || '\u2014').slice(0, 35), CL_NAME, yL);
        pdf.text(fmtStitches(e.stitches || 0), CL_ST + 18, yL, { align: 'right' });
        yL += LEG_ROW_H;
    }
    _pdfAddFooter(pdf, pageNum, totalPages);

    const filename = (patternName.replace(/[^a-zA-Z0-9_\-]/g, '_') || 'pattern') + '.pdf';
    pdf.save(filename);
}

function _pdfRenderGridTile(startCol, startRow, tileW, tileH, grid, grid_w, lookup,
                             ROW_LBL_PX, COL_LBL_PX, CELL_PX, skipBG, symbolScale,
                             partStitches, backstitches, knots) {
    const cW = ROW_LBL_PX + tileW * CELL_PX;
    const cH = COL_LBL_PX + tileH * CELL_PX;
    const cv = document.createElement('canvas');
    cv.width = cW; cv.height = cH;
    const ctx = cv.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cW, cH);

    const lblFontSize = Math.max(8, Math.round(CELL_PX / 3));
    ctx.fillStyle = '#999999';
    ctx.font = lblFontSize + 'px "IBM Plex Mono",monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < tileW; i++) {
        const absCol = startCol + i;
        if (absCol % 10 === 0) {
            ctx.fillText(String(absCol), ROW_LBL_PX + i * CELL_PX + CELL_PX / 2, COL_LBL_PX / 2);
        }
    }
    ctx.textAlign = 'right';
    for (let j = 0; j < tileH; j++) {
        const absRow = startRow + j;
        if (absRow % 10 === 0) {
            ctx.fillText(String(absRow), ROW_LBL_PX - 3, COL_LBL_PX + j * CELL_PX + CELL_PX / 2);
        }
    }

    const symFontSize = Math.floor(CELL_PX * symbolScale);
    ctx.font = `${symFontSize}px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols","IBM Plex Mono",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let j = 0; j < tileH; j++) {
        for (let i = 0; i < tileW; i++) {
            const dmc  = grid[(startRow + j) * grid_w + (startCol + i)];
            if (dmc === 'BG') continue;
            const info = lookup[dmc] || { hex: '#888888', symbol: '?' };
            const x = ROW_LBL_PX + i * CELL_PX;
            const y = COL_LBL_PX + j * CELL_PX;
            ctx.fillStyle = info.hex;
            ctx.fillRect(x, y, CELL_PX, CELL_PX);
            ctx.fillStyle = contrastColor(info.hex);
            ctx.fillText(info.symbol, x + CELL_PX / 2, y + CELL_PX / 2);
        }
    }

    // ── Part stitches in this tile ──
    if (partStitches) {
        for (const s of partStitches) {
            const { sx, sy } = _resolvePartFields(s);
            if (sx < startCol || sx >= startCol + tileW ||
                sy < startRow || sy >= startRow + tileH) continue;
            const info = lookup[s.dmc];
            if (!info) continue;
            const px = ROW_LBL_PX + (sx - startCol) * CELL_PX;
            const py = COL_LBL_PX + (sy - startRow) * CELL_PX;
            drawChartPartStitch(ctx, px, py, CELL_PX, s, info.hex, info.symbol);
        }
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= tileW; i++) {
        const x = ROW_LBL_PX + i * CELL_PX;
        ctx.beginPath(); ctx.moveTo(x, COL_LBL_PX); ctx.lineTo(x, cH); ctx.stroke();
    }
    for (let j = 0; j <= tileH; j++) {
        const y = COL_LBL_PX + j * CELL_PX;
        ctx.beginPath(); ctx.moveTo(ROW_LBL_PX, y); ctx.lineTo(cW, y); ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(1, Math.round(CELL_PX / 16));
    for (let i = 0; i <= tileW; i++) {
        if ((startCol + i) % 10 === 0) {
            const x = ROW_LBL_PX + i * CELL_PX;
            ctx.beginPath(); ctx.moveTo(x, COL_LBL_PX); ctx.lineTo(x, cH); ctx.stroke();
        }
    }
    for (let j = 0; j <= tileH; j++) {
        if ((startRow + j) % 10 === 0) {
            const y = COL_LBL_PX + j * CELL_PX;
            ctx.beginPath(); ctx.moveTo(ROW_LBL_PX, y); ctx.lineTo(cW, y); ctx.stroke();
        }
    }

    // ── Backstitches in this tile ──
    if (backstitches) {
        for (const b of backstitches) {
            // Check if either endpoint falls within this tile (with 1 cell margin)
            const bMinX = Math.min(b.x1, b.x2), bMaxX = Math.max(b.x1, b.x2);
            const bMinY = Math.min(b.y1, b.y2), bMaxY = Math.max(b.y1, b.y2);
            if (bMaxX < startCol || bMinX > startCol + tileW ||
                bMaxY < startRow || bMinY > startRow + tileH) continue;
            const info = lookup[b.dmc];
            if (!info) continue;
            const px1 = ROW_LBL_PX + (b.x1 - startCol) * CELL_PX;
            const py1 = COL_LBL_PX + (b.y1 - startRow) * CELL_PX;
            const px2 = ROW_LBL_PX + (b.x2 - startCol) * CELL_PX;
            const py2 = COL_LBL_PX + (b.y2 - startRow) * CELL_PX;
            drawBackstitch(ctx, px1, py1, px2, py2, info.hex, CELL_PX);
        }
    }

    // ── French knots in this tile ──
    if (knots) {
        for (const k of knots) {
            if (k.x < startCol || k.x > startCol + tileW ||
                k.y < startRow || k.y > startRow + tileH) continue;
            const info = lookup[k.dmc];
            if (!info) continue;
            const kpx = ROW_LBL_PX + (k.x - startCol) * CELL_PX;
            const kpy = COL_LBL_PX + (k.y - startRow) * CELL_PX;
            drawFrenchKnot(ctx, kpx, kpy, info.hex, CELL_PX);
        }
    }

    const arrowY = COL_LBL_PX + Math.floor(tileH / 2) * CELL_PX + CELL_PX / 2;
    ctx.fillStyle = '#555555';
    ctx.font = Math.max(6, Math.round(CELL_PX / 4)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u25b7', ROW_LBL_PX / 2, arrowY);
    ctx.fillText('\u25c1', cW - CELL_PX / 2, arrowY);

    return cv;
}

function _pdfAddFooter(pdf, n, total) {
    const yr = new Date().getFullYear();
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(120, 100, 80);
    pdf.text('\u00a9' + yr, 20, 287);
    pdf.text('Generated by Needlework Studio', 105, 287, { align: 'center' });
    pdf.text(n + ' / ' + total, 190, 287, { align: 'right' });
    pdf.setTextColor(40, 30, 20);
}
