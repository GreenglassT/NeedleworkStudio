/* ── OXS (Open Cross Stitch) Export ───────────────────────── */
/* Used by saved-patterns.html.                                */
/* Requires: escHtml(), downloadBlob(), patternSlug()          */
/*           from utils.js                                     */
/* Spec: https://www.ursasoftware.com/OXSFormat/               */

/**
 * Generate and download an OXS file for a cross-stitch pattern.
 *
 * @param {string} patternName  — Chart title.
 * @param {Object} patternData  — { grid, grid_w, grid_h, legend }.
 * @param {Object} [opts]       — Reserved for future use.
 */
function generatePatternOXS(patternName, patternData, opts) {
    const { grid, grid_w, grid_h, legend } = patternData;
    if (!grid || !grid_w || !grid_h) throw new Error('Invalid pattern data');

    // Build palette index map: dmc → 1-based index
    const palMap = new Map();
    for (let i = 0; i < legend.length; i++) {
        palMap.set(legend[i].dmc, i + 1);
    }

    const x = []; // XML parts

    x.push('<?xml version="1.0" encoding="UTF-8"?>');
    x.push('<chart>');

    // ── Properties ──
    x.push('  <properties');
    x.push('    oxsversion="1.0"');
    x.push('    software="Needlework Studio"');
    x.push('    chartheight="' + grid_h + '"');
    x.push('    chartwidth="' + grid_w + '"');
    x.push('    charttitle="' + escHtml(patternName) + '"');
    x.push('    palettecount="' + legend.length + '"');
    x.push('  />');

    // ── Palette ──
    x.push('  <palette>');

    // Index 0 = cloth (white)
    x.push('    <palette_item index="0" number="cloth" name="cloth"');
    x.push('      color="FFFFFF" strands="2" symbol="0"/>');

    for (let i = 0; i < legend.length; i++) {
        const e = legend[i];
        const idx = i + 1;
        const hex = (e.hex || '#888888').replace(/^#/, '').toUpperCase();
        const number = (patternData.brand || 'DMC') + ' ' + e.dmc;
        x.push('    <palette_item index="' + idx + '"');
        x.push('      number="' + escHtml(number) + '"');
        x.push('      name="' + escHtml(e.name || '') + '"');
        x.push('      color="' + hex + '"');
        x.push('      strands="2"');
        x.push('      symbol="' + idx + '"/>');
    }

    x.push('  </palette>');

    // ── Full Stitches ──
    x.push('  <fullstitches>');

    for (let row = 0; row < grid_h; row++) {
        for (let col = 0; col < grid_w; col++) {
            const dmc = grid[row * grid_w + col];
            if (dmc === 'BG' || !dmc) continue;
            const palIdx = palMap.get(dmc);
            if (palIdx === undefined) continue;
            x.push('    <stitch x="' + col + '" y="' + row + '" palindex="' + palIdx + '"/>');
        }
    }

    x.push('  </fullstitches>');

    // ── Part Stitches ──
    const partStitches = patternData.part_stitches || [];
    if (partStitches.length > 0) {
        x.push('  <partstitches>');
        for (const s of partStitches) {
            const pi = palMap.get(s.dmc);
            if (pi === undefined) continue;
            const { sx, sy, dir } = _resolvePartFields(s);
            // Map our stitch types to OXS direction: 1=TL→center, 2=TR→center, 3=BR→center, 4=BL→center
            const qmap = { TL: 1, TR: 2, BR: 3, BL: 4 };
            let dirs = [];
            if (s.type === 'half') {
                if (dir === 'fwd') dirs = [2, 4]; // /
                else dirs = [1, 3]; // \\
            } else if (s.type === 'quarter') {
                dirs = [qmap[dir] || 1];
            } else if (s.type === 'three_quarter') {
                const parts = dir.split('_');
                const halfDirs = parts[0] === 'fwd' ? [2, 4] : [1, 3];
                const qDir = qmap[parts[1]] || 1;
                dirs = [...new Set([...halfDirs, qDir])];
            }
            for (const d of dirs) {
                x.push('    <stitch x="' + sx + '" y="' + sy + '" palindex="' + pi + '" direction="' + d + '"/>');
            }
        }
        x.push('  </partstitches>');
    } else {
        x.push('  <partstitches/>');
    }

    // ── Backstitches ──
    const backstitches = patternData.backstitches || [];
    if (backstitches.length > 0) {
        x.push('  <backstitches>');
        for (const b of backstitches) {
            const pi = palMap.get(b.dmc);
            if (pi === undefined) continue;
            x.push('    <stitch x1="' + b.x1 + '" y1="' + b.y1 + '" x2="' + b.x2 + '" y2="' + b.y2 + '" palindex="' + pi + '"/>');
        }
        x.push('  </backstitches>');
    } else {
        x.push('  <backstitches/>');
    }

    // ── Knots / Ornaments ──
    const knots = patternData.knots || [];
    if (knots.length > 0) {
        x.push('  <ornaments_inc_knots_and_beads>');
        for (const k of knots) {
            const pi = palMap.get(k.dmc);
            if (pi === undefined) continue;
            x.push('    <object x="' + k.x + '" y="' + k.y + '" palindex="' + pi + '" objecttype="knot"/>');
        }
        x.push('  </ornaments_inc_knots_and_beads>');
    } else {
        x.push('  <ornaments_inc_knots_and_beads/>');
    }

    x.push('  <commentboxes/>');

    x.push('</chart>');

    // Download
    const filename = patternSlug(patternName) + '_' + grid_w + 'x' + grid_h + '.oxs';
    downloadBlob(x.join('\n'), filename, 'application/xml');
}
