/* editor.js — Shared cross-stitch pattern editor module
 *
 * Usage:
 *   const editor = createPatternEditor({ ...config });
 *   editor.injectUI();
 *   // later: editor.activate(), editor.deactivate()
 *
 * Config callbacks let each page supply its own coordinate math,
 * rendering, and overlay behaviour.  The editor owns tool state,
 * undo/redo, toolbar UI, add-color modal, and color-replace panel.
 */

function createPatternEditor(config) {
    const {
        container,        // HTMLElement — positioned ancestor for toolbar
        getPatternData,   // () => { grid, grid_w, grid_h, legend }
        getLookup,        // () => { [dmc]: { hex, symbol, name, count } }
        setLookup,        // (obj) => void
        eventToStitch,    // (MouseEvent) => { col, row } | null
        renderSingleCell, // (col, row) => void
        renderAll,        // () => void — full canvas + secondary views
        renderLegend,     // () => void — legend / key + progress bar
        getOverlayCanvas, // () => HTMLCanvasElement
        getCellPx,        // () => number
        getGridOffset,    // () => { x, y } — px offset from canvas origin to grid
        onDirty,          // () => void
        onClean,          // () => void (optional)
        onOverlayClear,   // () => void (optional) — redraw overlay after clear
        onSave,           // () => void (optional) — Ctrl+S handler
        symbolSet,        // string — e.g. "+×#@●■…"
        eventToSubCell,   // (MouseEvent) => { gx, gy } | null  — continuous grid coords (optional)
    } = config;

    let _brand = config.brand || 'DMC';   // 'DMC' | 'Anchor'

    /* ——— State ——— */
    let activeTool   = 'pan';
    let activeDmc    = null;
    let activeHex    = '#888888';

    let lineStart    = null;
    let _lineEnd     = null;
    let spaceHeld    = false;
    let _painting    = false;
    let _lastPaintCell = null;
    let undoStack    = [];
    let redoStack    = [];
    const MAX_UNDO   = 50;
    let allDmcThreads = null;
    let editorDirty  = false;
    let _active      = false;
    let _uiInjected  = false;

    /* Overlay state */
    let _hoverCell     = null;   // { col, row } or null
    let _rectStart     = null;   // { col, row } rect drag start
    let _rectPreview   = null;   // { c1, r1, c2, r2, outline } or null
    let _ellipseStart  = null;   // { col, row } ellipse drag start
    let _ellipsePreview = null;  // { c1, r1, c2, r2, outline } or null
    let _mirrorMode    = 'off';  // 'off' | 'horizontal' | 'vertical' | 'both'

    /* Brush size state */
    let _brushSize = 1;                          // 1 | 2 | 3 | 5 | 9
    const _BRUSH_SIZES = [1, 2, 3, 5, 9];

    /* Selection state */
    let _selStart      = null;
    let _selRect       = null;   // { c1, r1, c2, r2 } normalized
    let _selBuffer     = null;   // { w, h, data:[...] }
    let _selOffset     = { dc: 0, dr: 0 };
    let _selDragging   = false;
    let _selMoving     = false;
    let _selMoveOrigin = null;
    let _marchPhase    = 0;
    let _marchRAF      = null;
    let _eyedropTip    = null;

    /* Stitch tool state */
    let activeStitchMode = 'half';   // 'half'|'quarter'|'three_quarter'|'backstitch'|'knot'
    let _halfDir         = 'fwd';    // 'fwd' (/) or 'bwd' (\) — for half & three-quarter
    let _bsStart         = null;     // { ix, iy } backstitch drag start intersection
    let _bsPreviewEnd   = null;     // { ix, iy } backstitch preview end
    let _hoverIntersection = null;  // { ix, iy } for backstitch/knot hover
    // _stitchPanel removed — stitch types are now individual toolbar buttons

    /* ——— DOM references (set by injectUI) ——— */
    let _toolbar = null, _replacePanel = null;
    let _undoBtn = null, _redoBtn = null;
    let _activeSwatch = null, _activeLabel = null;
    let _replaceSrcSwatch = null;
    let _replaceTargetPicker = null, _replaceTargetTrigger = null;
    let _replaceTargetDropdown = null, _replaceTargetSearch = null;
    let _replaceTargetList = null, _replaceTargetSw = null, _replaceTargetLabel = null;
    let _replaceTargetDmc = null; // currently chosen target DMC number
    let _addColorDropdown = null, _addColorSearch = null, _addColorList = null;
    let _outsideClickHandler = null;
    let _dirToggle = null;
    let _brushBtns = null;
    let _styleEl = null;

    /* ——— CSS (injected once) ——— */
    const EDITOR_CSS = `
.editor-toolbar{position:absolute;top:24px;left:50%;transform:translateX(-50%);z-index:15;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);padding:4px 8px;display:flex;flex-direction:column;align-items:center;gap:2px;box-shadow:0 2px 12px rgba(0,0,0,.4);max-width:95vw}
.toolbar-row{display:flex;align-items:center;gap:2px;white-space:nowrap}
.tool-group{display:flex;gap:1px}
.tool-btn{font-size:18px;min-width:40px;padding:5px 3px 3px;border:1px solid transparent;border-radius:var(--r);background:transparent;color:var(--text-muted);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;transition:background var(--t),color var(--t),border-color var(--t);line-height:1}
.tool-lbl{font-family:'IBM Plex Mono',monospace;font-size:8px;letter-spacing:.02em;line-height:1;white-space:nowrap;pointer-events:none}
.tool-btn:hover:not(:disabled){background:var(--surface-2);color:var(--text)}
.tool-btn.active{background:var(--gold);color:#1a1208;border-color:var(--gold)}
.tool-btn:disabled{opacity:.3;cursor:default}
.tool-sep{width:1px;align-self:stretch;background:var(--border-2);margin:0 3px;flex-shrink:0}
.active-color-ind{display:flex;align-items:center;gap:6px}
.active-sw{width:24px;height:24px;border-radius:3px;border:1px solid var(--border-2);flex-shrink:0}
.active-lbl{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-muted);white-space:nowrap}
.edit-mode{cursor:crosshair}
.edit-mode.tool-eraser{cursor:cell}
.edit-mode.tool-eyedropper{cursor:copy}
.edit-mode.tool-pan{cursor:grab}
.edit-mode.tool-pan.dragging{cursor:grabbing}
.edit-mode.tool-select{cursor:crosshair}
.edit-mode.space-pan{cursor:grab}
.edit-mode.space-pan.dragging{cursor:grabbing}
.ed-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:flex;align-items:center;justify-content:center}
.ed-modal-card{background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r-lg);padding:24px;max-width:480px;width:90%;max-height:70vh;display:flex;flex-direction:column}
.ed-modal-card h3{font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:600;color:var(--text);margin-bottom:12px}
.ed-modal-card p{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:6px}
.ed-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.ed-modal-btn{font-family:'IBM Plex Mono',monospace;font-size:11px;padding:8px 16px;border-radius:var(--r);border:1px solid var(--border-2);background:transparent;color:var(--text-muted);cursor:pointer;transition:all var(--t)}
.ed-modal-btn:hover{background:var(--surface-2);color:var(--text)}
.ed-modal-btn.primary{border-color:var(--gold-dim);color:var(--gold)}
.ed-modal-btn.primary:hover{background:var(--gold-dim);color:var(--text)}
.add-color-wrapper{position:relative;display:inline-block}
.add-color-dropdown{display:none;position:absolute;top:calc(100% + 6px);right:0;width:280px;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:20;padding:6px;font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-muted)}
.add-color-dropdown.open{display:block}
.replace-panel{position:absolute;top:80px;left:50%;transform:translateX(-50%);z-index:14;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);padding:8px 12px;display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-muted);box-shadow:0 2px 8px rgba(0,0,0,.3)}
.replace-target-picker{position:relative;display:inline-block}
.replace-target-trigger{display:flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r);color:var(--text);padding:4px 8px;font-family:'IBM Plex Mono',monospace;font-size:10px;cursor:pointer;min-width:100px;transition:border-color var(--t)}
.replace-target-trigger:hover{border-color:var(--gold-dim)}
.replace-target-sw{width:14px;height:14px;border-radius:2px;border:1px solid var(--border-2);flex-shrink:0}
.replace-target-dropdown{display:none;position:absolute;top:calc(100% + 4px);left:0;width:280px;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:20;padding:6px}
.replace-target-dropdown.open{display:block}
.replace-target-search{width:100%;padding:6px 8px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r);color:var(--text);font-family:'IBM Plex Mono',monospace;font-size:10px;outline:none;box-sizing:border-box}
.replace-target-search:focus{border-color:var(--gold-dim)}
.replace-target-list{max-height:220px;overflow-y:auto;margin-top:4px}
.replace-target-list::-webkit-scrollbar{width:4px}
.replace-target-list::-webkit-scrollbar-track{background:transparent}
.replace-target-list::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:2px}
.replace-target-row{display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:var(--r);transition:background var(--t);font-size:10px}
.replace-target-row:hover{background:var(--surface-2)}
.replace-target-row.selected{color:var(--gold)}
.replace-target-row .rtr-sw{width:14px;height:14px;border-radius:2px;border:1px solid var(--border-2);flex-shrink:0}
.replace-target-row .rtr-num{color:var(--text);min-width:32px}
.replace-target-row .rtr-name{color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.replace-target-row .rtr-badge{font-size:8px;color:var(--gold);white-space:nowrap}
.ed-replace-apply-btn{font-family:'IBM Plex Mono',monospace;font-size:10px;padding:4px 10px;border-radius:var(--r);border:1px solid var(--border-2);background:transparent;color:var(--text-muted);cursor:pointer;transition:all var(--t)}
.ed-replace-apply-btn:hover{background:var(--surface-2);color:var(--text)}
@media(max-width:600px){.editor-toolbar{max-width:95vw}.toolbar-row{gap:1px}.tool-lbl{font-size:7px}}
.ed-resize-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5);z-index:200}
.ed-resize-modal{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r-lg);padding:20px;z-index:201;box-shadow:0 8px 32px rgba(0,0,0,.5);min-width:240px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text)}
.ed-resize-modal h3{font-family:'Cormorant Garamond',serif;font-size:16px;font-weight:600;margin:0 0 12px;color:var(--text)}
.ed-resize-modal label{display:block;font-size:10px;color:var(--text-muted);margin-bottom:3px}
.ed-resize-modal input[type=number]{width:80px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r);color:var(--text);font-family:inherit;font-size:11px;outline:none}
.ed-resize-modal input[type=number]:focus{border-color:var(--gold-dim)}
.ed-resize-dims{display:flex;align-items:flex-end;gap:0;margin-bottom:12px}
.ed-resize-dims>div{flex:1}
.ed-rz-lock{display:flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0 4px 1px;background:none;border:1px solid transparent;border-radius:3px;cursor:pointer;color:var(--text-dim);font-size:13px;transition:border-color .2s,color .2s;flex-shrink:0}
.ed-rz-lock:hover{border-color:var(--gold-dim);color:var(--gold)}
.ed-rz-lock.active{color:var(--gold)}
.ed-resize-anchor{display:grid;grid-template-columns:repeat(3,22px);gap:3px;margin:8px auto 12px;width:fit-content}
.ed-resize-anchor button{width:22px;height:22px;border:1px solid var(--border-2);border-radius:3px;background:var(--surface-2);cursor:pointer;padding:0;transition:all var(--t)}
.ed-resize-anchor button:hover{border-color:var(--gold-dim)}
.ed-resize-anchor button.active{background:var(--gold);border-color:var(--gold)}
.ed-resize-actions{display:flex;gap:8px;justify-content:flex-end}
.ed-resize-actions button{font-family:inherit;font-size:10px;padding:6px 14px;border-radius:var(--r);border:1px solid var(--border-2);background:transparent;color:var(--text-muted);cursor:pointer;transition:all var(--t)}
.ed-resize-actions button:hover{background:var(--surface-2);color:var(--text)}
.ed-resize-actions button.primary{border-color:var(--gold-dim);color:var(--gold)}
.ed-resize-actions button.primary:hover{background:var(--gold-dim);color:var(--text)}
.ed-rc-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5);z-index:200}
.ed-rc-modal{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r-lg);padding:20px;z-index:201;box-shadow:0 8px 32px rgba(0,0,0,.5);min-width:240px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text)}
.ed-rc-modal h3{font-family:'Cormorant Garamond',serif;font-size:16px;font-weight:600;margin:0 0 12px;color:var(--text)}
.ed-rc-toggle{display:flex;gap:0;margin-bottom:12px;border:1px solid var(--border-2);border-radius:var(--r);overflow:hidden}
.ed-rc-toggle button{flex:1;font-family:inherit;font-size:10px;padding:5px 0;border:none;background:transparent;color:var(--text-muted);cursor:pointer;transition:all var(--t)}
.ed-rc-toggle button:not(:last-child){border-right:1px solid var(--border-2)}
.ed-rc-toggle button.active{background:var(--gold);color:#1a1208}
.ed-rc-idx{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.ed-rc-idx label{font-size:10px;color:var(--text-muted);white-space:nowrap}
.ed-rc-idx input[type=number]{width:70px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r);color:var(--text);font-family:inherit;font-size:11px;outline:none}
.ed-rc-idx input[type=number]:focus{border-color:var(--gold-dim)}
.ed-rc-idx .ed-rc-max{font-size:9px;color:var(--text-dim)}
.ed-rc-actions{display:flex;gap:6px;flex-wrap:wrap}
.ed-rc-actions button{font-family:inherit;font-size:10px;padding:6px 12px;border-radius:var(--r);border:1px solid var(--border-2);background:transparent;color:var(--text-muted);cursor:pointer;transition:all var(--t)}
.ed-rc-actions button:hover{background:var(--surface-2);color:var(--text)}
.ed-rc-actions button.primary{border-color:var(--gold-dim);color:var(--gold)}
.ed-rc-actions button.primary:hover{background:var(--gold-dim);color:var(--text)}
.ed-rc-actions button.danger{border-color:var(--skip);color:var(--skip)}
.ed-rc-actions button.danger:hover{background:rgba(158,74,74,.15);color:var(--skip)}
.ed-text-panel{position:absolute;z-index:20;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);box-shadow:0 4px 16px rgba(0,0,0,.4);padding:8px;font-family:'IBM Plex Mono',monospace;font-size:10px;display:none}
.ed-text-panel input[type=text]{width:160px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r);color:var(--text);font-family:inherit;font-size:11px;outline:none}
.ed-text-panel input[type=text]:focus{border-color:var(--gold-dim)}
.ed-text-font-row{display:flex;gap:0;margin-top:6px;border:1px solid var(--border-2);border-radius:var(--r);overflow:hidden}
.ed-text-font-row button{flex:1;font-family:inherit;font-size:9px;padding:3px 0;border:none;background:transparent;color:var(--text-muted);cursor:pointer;transition:all var(--t)}
.ed-text-font-row button:not(:last-child){border-right:1px solid var(--border-2)}
.ed-text-font-row button.active{background:var(--gold);color:#1a1208}
.ed-text-scale-row{display:flex;align-items:center;gap:6px;margin-top:4px}
.ed-text-scale-row input[type=range]{flex:1;height:4px;accent-color:var(--gold);cursor:pointer}
.ed-text-scale-val{font-size:10px;color:var(--gold);min-width:20px;text-align:right}
.ed-eyedrop-tip{position:absolute;z-index:25;pointer-events:none;display:none;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);box-shadow:0 2px 8px rgba(0,0,0,.4);padding:4px 8px;font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-muted);white-space:nowrap;gap:6px;align-items:center}
.ed-eyedrop-tip .ed-et-sw{width:14px;height:14px;border-radius:2px;border:1px solid var(--border-2);flex-shrink:0}
.ed-text-mode-row{display:flex;gap:0;margin-top:6px;border:1px solid var(--border-2);border-radius:var(--r);overflow:hidden}
.ed-text-mode-row button{flex:1;font-family:inherit;font-size:9px;padding:3px 0;border:none;background:transparent;color:var(--text-muted);cursor:pointer;transition:all var(--t)}
.ed-text-mode-row button:not(:last-child){border-right:1px solid var(--border-2)}
.ed-text-mode-row button.active{background:var(--gold);color:#1a1208}
.ed-text-sysfont-row{position:relative;margin-top:4px}
.ed-font-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;padding:3px 6px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r);color:var(--text);font-family:inherit;font-size:10px;cursor:pointer;outline:none;transition:border-color var(--t)}
.ed-font-trigger:hover,.ed-font-trigger.open{border-color:var(--gold-dim)}
.ed-font-trigger .ed-ft-arrow{font-size:8px;color:var(--text-muted);margin-left:6px;transition:transform var(--t)}
.ed-font-trigger.open .ed-ft-arrow{transform:rotate(180deg)}
.ed-font-menu{position:absolute;bottom:100%;left:0;right:0;margin-bottom:2px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r);box-shadow:0 -4px 12px rgba(0,0,0,.35);max-height:160px;overflow-y:auto;z-index:30;display:none}
.ed-font-menu.open{display:block}
.ed-font-menu button{display:block;width:100%;padding:4px 8px;border:none;background:transparent;color:var(--text);font-size:10px;text-align:left;cursor:pointer;transition:background var(--t)}
.ed-font-menu button:hover{background:var(--gold-dim);color:var(--text)}
.ed-font-menu button.active{background:var(--gold);color:#1a1208}
.ed-text-dim{color:var(--gold);font-size:9px;margin-top:4px;min-height:13px}
.ed-text-hint{color:var(--text-muted);font-size:9px;margin-top:2px}
.stitch-dir-toggle{border-color:var(--border-2) !important;background:var(--surface-2) !important;color:var(--text-muted) !important}
.stitch-dir-toggle:hover{border-color:var(--gold-dim) !important;color:var(--text) !important}
.brush-size-group{display:flex;gap:1px;align-items:center}
.brush-pill{font-family:'IBM Plex Mono',monospace;font-size:10px;min-width:24px;height:24px;padding:0 4px;border:1px solid transparent;border-radius:var(--r);background:transparent;color:var(--text-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background var(--t),color var(--t),border-color var(--t);line-height:1}
.brush-pill:hover{background:var(--surface-2);color:var(--text)}
.brush-pill.active{background:var(--gold);color:#1a1208;border-color:var(--gold)}
.brush-lbl{font-family:'IBM Plex Mono',monospace;font-size:8px;color:var(--text-muted);margin-right:2px;white-space:nowrap}
`;

    /* ═══════════════════════════════════════════
       Core Utilities
       ═══════════════════════════════════════════ */

    function _snapshotState() {
        const pd = getPatternData();
        return {
            grid:          [...pd.grid],
            legend:        JSON.parse(JSON.stringify(pd.legend)),
            grid_w:        pd.grid_w,
            grid_h:        pd.grid_h,
            part_stitches: JSON.parse(JSON.stringify(pd.part_stitches || [])),
            backstitches:  JSON.parse(JSON.stringify(pd.backstitches  || [])),
            knots:         JSON.parse(JSON.stringify(pd.knots         || [])),
            beads:         JSON.parse(JSON.stringify(pd.beads         || [])),
        };
    }

    function _restoreSnapshot(snap) {
        const pd = getPatternData();
        pd.grid          = snap.grid;
        pd.legend        = snap.legend;
        pd.grid_w        = snap.grid_w;
        pd.grid_h        = snap.grid_h;
        pd.part_stitches = snap.part_stitches || [];
        pd.backstitches  = snap.backstitches  || [];
        pd.knots         = snap.knots         || [];
        pd.beads         = snap.beads         || [];
        _rebuildLookup();
        renderAll();
        renderLegend();
        _markDirty();
    }

    function pushUndo() {
        undoStack.push(_snapshotState());
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        if (_undoBtn) _undoBtn.disabled = false;
        if (_redoBtn) _redoBtn.disabled = true;
    }

    function undo() {
        if (undoStack.length === 0) return;
        redoStack.push(_snapshotState());
        _restoreSnapshot(undoStack.pop());
        if (_undoBtn) _undoBtn.disabled = undoStack.length === 0;
        if (_redoBtn) _redoBtn.disabled = false;
    }

    function redo() {
        if (redoStack.length === 0) return;
        undoStack.push(_snapshotState());
        _restoreSnapshot(redoStack.pop());
        if (_undoBtn) _undoBtn.disabled = false;
        if (_redoBtn) _redoBtn.disabled = redoStack.length === 0;
    }

    function _rebuildLookup() {
        const pd = getPatternData();
        const lu = {};
        for (const e of pd.legend) {
            lu[e.dmc] = {
                hex:    e.hex || '#888888',
                symbol: e.symbol || '?',
                name:   e.name || '',
                count:  e.stitches || 0,
                dashIdx: 0
            };
        }
        // Assign dash pattern indices to backstitch colors
        if (pd.backstitches && pd.backstitches.length > 0) {
            const bsDmcs = [...new Set(pd.backstitches.map(bs => bs.dmc))];
            bsDmcs.forEach((dmc, i) => { if (lu[dmc]) lu[dmc].dashIdx = i + 1; });
        }
        setLookup(lu);
    }

    function _recountStitches() {
        const pd = getPatternData();
        const counts = {};
        // Full stitches (weight: 1.0)
        for (const dmc of pd.grid) {
            if (dmc === 'BG') continue;
            counts[dmc] = (counts[dmc] || 0) + 1;
        }
        // Part stitches (half=0.5, quarter=0.25, three-quarter=0.75)
        const partWeights = { half: 0.5, quarter: 0.25, three_quarter: 0.75, petite: 0.25 };
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
        // Beads (1 each)
        for (const b of (pd.beads || [])) {
            counts[b.dmc] = (counts[b.dmc] || 0) + 1;
        }
        // Keep active color even if count is 0 (just added)
        pd.legend = pd.legend.filter(e =>
            (counts[e.dmc] || 0) > 0 || String(e.dmc) === String(activeDmc));
        for (const e of pd.legend) {
            e.stitches = counts[e.dmc] || 0;
        }
        _rebuildLookup();
    }

    function _debounce(fn, ms) { let t; return function() { clearTimeout(t); t = setTimeout(fn, ms); }; }

    function _markDirty() {
        editorDirty = true;
        if (onDirty) onDirty();
    }

    function _commitEdit() {
        _recountStitches(); renderAll(); renderLegend(); _markDirty();
    }

    /* ═══════════════════════════════════════════
       Tools
       ═══════════════════════════════════════════ */

    function pencilAt(col, row) {
        if (!activeDmc) return;
        const pd  = getPatternData();
        const idx = row * pd.grid_w + col;
        if (pd.grid[idx] === activeDmc) return;
        pd.grid[idx] = activeDmc;
        renderSingleCell(col, row);
    }

    function eraserAt(col, row) {
        const pd  = getPatternData();
        const idx = row * pd.grid_w + col;
        let changed = false;
        let needFullRender = false;
        if (pd.grid[idx] !== 'BG') { pd.grid[idx] = 'BG'; changed = true; }
        // Remove part stitches at this cell
        if (pd.part_stitches) {
            const before = pd.part_stitches.length;
            pd.part_stitches = pd.part_stitches.filter(s => {
                const sx = (s.x !== undefined ? s.x : s.col);
                const sy = (s.y !== undefined ? s.y : s.row);
                return !(sx === col && sy === row);
            });
            if (pd.part_stitches.length !== before) { changed = true; needFullRender = true; }
        }
        // Remove backstitches near any of this cell's four corners
        if (pd.backstitches) {
            const before = pd.backstitches.length;
            const corners = [[col, row], [col + 1, row], [col, row + 1], [col + 1, row + 1]];
            pd.backstitches = pd.backstitches.filter(b => {
                for (const [cx, cy] of corners) {
                    if (_ptSegDist(cx, cy, b.x1, b.y1, b.x2, b.y2) < 0.5) return false;
                }
                return true;
            });
            if (pd.backstitches.length !== before) { changed = true; needFullRender = true; }
        }
        // Remove knots at this cell's four corners
        if (pd.knots) {
            const before = pd.knots.length;
            pd.knots = pd.knots.filter(k => {
                return !((k.x === col || k.x === col + 1) && (k.y === row || k.y === row + 1));
            });
            if (pd.knots.length !== before) { changed = true; needFullRender = true; }
        }
        // Remove beads at this cell
        if (pd.beads) {
            const before = pd.beads.length;
            pd.beads = pd.beads.filter(b => !(b.x === col && b.y === row));
            if (pd.beads.length !== before) { changed = true; needFullRender = true; }
        }
        if (changed) {
            if (needFullRender) renderAll();
            else renderSingleCell(col, row);
        }
    }

    /* ═══════════════════════════════════════════
       Stitch placement helpers
       ═══════════════════════════════════════════ */

    /** Get continuous grid coordinates from mouse event. */
    function _getGridCoords(e) {
        if (eventToSubCell) return eventToSubCell(e);
        // Fallback: center of the cell from eventToStitch
        const s = eventToStitch(e);
        return s ? { gx: s.col + 0.5, gy: s.row + 0.5 } : null;
    }

    /** Snap continuous grid coords to nearest intersection. */
    function _nearestIntersection(gx, gy) {
        const pd = getPatternData();
        return {
            ix: Math.max(0, Math.min(pd.grid_w, Math.round(gx))),
            iy: Math.max(0, Math.min(pd.grid_h, Math.round(gy))),
        };
    }

    /** Determine which quadrant of a cell the click is in. */
    function _cellQuadrant(gx, gy) {
        const col = Math.floor(gx);
        const row = Math.floor(gy);
        const fx = gx - col;
        const fy = gy - row;
        return { col, row, corner: (fy < 0.5 ? 'T' : 'B') + (fx < 0.5 ? 'L' : 'R') };
    }

    /** Place a part stitch (half, quarter, or three-quarter).
     *  Stored format matches pattern-viewer: { x, y, type, dmc, dir }
     *  - half:          dir = 'fwd' | 'bwd'
     *  - quarter:       dir = 'TL' | 'TR' | 'BL' | 'BR'
     *  - three_quarter: dir = 'fwd_TL' | 'bwd_TR' | etc.
     */
    function _placePartStitch(col, row, type, extra) {
        if (!activeDmc) return;
        const pd = getPatternData();
        if (col < 0 || col >= pd.grid_w || row < 0 || row >= pd.grid_h) return;
        if (!pd.part_stitches) pd.part_stitches = [];
        // Normalize direction into a single `dir` field
        let dir;
        if (type === 'half')               dir = extra.direction;
        else if (type === 'quarter')        dir = extra.corner;
        else if (type === 'petite')         dir = extra.corner;
        else if (type === 'three_quarter')  dir = extra.halfDir + '_' + extra.shortCorner;
        const entry = { x: col, y: row, type, dmc: activeDmc, dir };
        // Remove any existing stitch that conflicts
        pd.part_stitches = pd.part_stitches.filter(s => {
            if (s.x !== col || s.y !== row) return true;
            if (type === 'half' && s.type === 'half' && s.dir === dir) return false;
            if (type === 'quarter' && s.type === 'quarter' && s.dir === dir) return false;
            if (type === 'petite' && s.type === 'petite' && s.dir === dir) return false;
            if (type === 'three_quarter' && s.type === 'three_quarter') return false;
            return true;
        });
        pd.part_stitches.push(entry);
    }

    /** Place a backstitch between two intersections. */
    function _placeBackstitch(ix1, iy1, ix2, iy2) {
        if (!activeDmc) return;
        if (ix1 === ix2 && iy1 === iy2) return;
        const pd = getPatternData();
        if (!pd.backstitches) pd.backstitches = [];
        // Normalize so smaller coord comes first
        let x1 = ix1, y1 = iy1, x2 = ix2, y2 = iy2;
        if (y1 > y2 || (y1 === y2 && x1 > x2)) { x1 = ix2; y1 = iy2; x2 = ix1; y2 = iy1; }
        // Remove duplicate
        pd.backstitches = pd.backstitches.filter(b =>
            !(b.x1 === x1 && b.y1 === y1 && b.x2 === x2 && b.y2 === y2));
        pd.backstitches.push({ x1, y1, x2, y2, dmc: activeDmc });
    }

    /** Place a French knot at an intersection. */
    function _placeKnot(ix, iy) {
        if (!activeDmc) return;
        const pd = getPatternData();
        if (!pd.knots) pd.knots = [];
        // Replace existing at same position
        pd.knots = pd.knots.filter(k => !(k.x === ix && k.y === iy));
        pd.knots.push({ x: ix, y: iy, dmc: activeDmc });
    }

    /** Place a bead at a cell position. */
    function _placeBead(col, row) {
        if (!activeDmc) return;
        const pd = getPatternData();
        if (col < 0 || col >= pd.grid_w || row < 0 || row >= pd.grid_h) return;
        if (!pd.beads) pd.beads = [];
        pd.beads = pd.beads.filter(b => !(b.x === col && b.y === row));
        pd.beads.push({ x: col, y: row, dmc: activeDmc });
    }

    /** Erase a backstitch near an intersection point. */
    function _eraseBackstitchNear(ix, iy) {
        const pd = getPatternData();
        if (!pd.backstitches || pd.backstitches.length === 0) return false;
        // Find and remove backstitch closest to this intersection
        let bestIdx = -1, bestDist = Infinity;
        for (let i = 0; i < pd.backstitches.length; i++) {
            const b = pd.backstitches[i];
            // Distance from point to line segment
            const d = _ptSegDist(ix, iy, b.x1, b.y1, b.x2, b.y2);
            if (d < bestDist && d < 0.6) { bestDist = d; bestIdx = i; }
        }
        if (bestIdx >= 0) {
            pd.backstitches.splice(bestIdx, 1);
            return true;
        }
        return false;
    }

    /** Erase a French knot at an intersection. */
    function _eraseKnot(ix, iy) {
        const pd = getPatternData();
        if (!pd.knots || pd.knots.length === 0) return false;
        const before = pd.knots.length;
        pd.knots = pd.knots.filter(k => !(k.x === ix && k.y === iy));
        return pd.knots.length !== before;
    }

    /** Point-to-segment distance in grid units. */
    function _ptSegDist(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    /** BFS flood — returns Set of grid indices matching targetColor from startIdx */
    function _bfsRegion(grid, grid_w, grid_h, startIdx, targetColor) {
        const region  = new Set();
        const visited = new Uint8Array(grid_w * grid_h);
        const queue   = [startIdx];
        let   head    = 0;
        visited[startIdx] = 1;
        while (head < queue.length) {
            const i = queue[head++];
            region.add(i);
            const c = i % grid_w;
            const r = (i - c) / grid_w;
            if (c > 0          && !visited[i - 1]      && grid[i - 1]      === targetColor) { visited[i - 1]      = 1; queue.push(i - 1); }
            if (c < grid_w - 1 && !visited[i + 1]      && grid[i + 1]      === targetColor) { visited[i + 1]      = 1; queue.push(i + 1); }
            if (r > 0          && !visited[i - grid_w]  && grid[i - grid_w]  === targetColor) { visited[i - grid_w]  = 1; queue.push(i - grid_w); }
            if (r < grid_h - 1 && !visited[i + grid_w]  && grid[i + grid_w]  === targetColor) { visited[i + grid_w]  = 1; queue.push(i + grid_w); }
        }
        return region;
    }

    function floodFill(col, row) {
        if (!activeDmc) return;
        const pd = getPatternData();
        const { grid, grid_w, grid_h } = pd;
        const idx    = row * grid_w + col;
        const target = grid[idx];
        if (target === activeDmc) return;
        pushUndo();
        for (const i of _bfsRegion(grid, grid_w, grid_h, idx, target)) grid[i] = activeDmc;
        _commitEdit();
    }

    function bresenhamLine(x0, y0, x1, y1) {
        const cells = [];
        const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        while (true) {
            cells.push({ col: x0, row: y0 });
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx)  { err += dx; y0 += sy; }
        }
        return cells;
    }

    /* ── Mirror helper ── */
    function _withMirror(col, row, fn) {
        const pd = getPatternData();
        fn(col, row);
        if (_mirrorMode === 'horizontal' || _mirrorMode === 'both') {
            fn(pd.grid_w - 1 - col, row);
        }
        if (_mirrorMode === 'vertical' || _mirrorMode === 'both') {
            fn(col, pd.grid_h - 1 - row);
        }
        if (_mirrorMode === 'both') {
            fn(pd.grid_w - 1 - col, pd.grid_h - 1 - row);
        }
    }

    /* ── Stitch mirror helpers ── */
    function _mirrorHalfDir(dir, axis) {
        // Horizontal or vertical flip reverses fwd↔bwd; both flips = identity
        if (axis === 'h' || axis === 'v') return dir === 'fwd' ? 'bwd' : 'fwd';
        return dir;
    }
    function _mirrorCorner(corner, axis) {
        if (axis === 'h') return corner.replace(/L/, '§').replace(/R/, 'L').replace('§', 'R');
        if (axis === 'v') return corner.replace(/T/, '§').replace(/B/, 'T').replace('§', 'B');
        // both: flip horizontal then vertical
        let c = corner.replace(/L/, '§').replace(/R/, 'L').replace('§', 'R');
        return c.replace(/T/, '§').replace(/B/, 'T').replace('§', 'B');
    }
    /** Get mirrored cell positions with their mirror axis. */
    function _mirrorCellPositions(col, row) {
        const pd = getPatternData();
        const out = [{ col, row, axis: null }];
        if (_mirrorMode === 'horizontal' || _mirrorMode === 'both')
            out.push({ col: pd.grid_w - 1 - col, row, axis: 'h' });
        if (_mirrorMode === 'vertical' || _mirrorMode === 'both')
            out.push({ col, row: pd.grid_h - 1 - row, axis: 'v' });
        if (_mirrorMode === 'both')
            out.push({ col: pd.grid_w - 1 - col, row: pd.grid_h - 1 - row, axis: 'b' });
        return out;
    }
    /** Get mirrored intersection positions with their mirror axis. */
    function _mirrorIntersectionPositions(ix, iy) {
        const pd = getPatternData();
        const out = [{ ix, iy, axis: null }];
        if (_mirrorMode === 'horizontal' || _mirrorMode === 'both')
            out.push({ ix: pd.grid_w - ix, iy, axis: 'h' });
        if (_mirrorMode === 'vertical' || _mirrorMode === 'both')
            out.push({ ix, iy: pd.grid_h - iy, axis: 'v' });
        if (_mirrorMode === 'both')
            out.push({ ix: pd.grid_w - ix, iy: pd.grid_h - iy, axis: 'b' });
        return out;
    }

    /* ── Brush size helpers ── */
    /** Expand a single cell to the NxN brush area, bounds-checked. */
    function _getBrushCells(col, row) {
        if (_brushSize === 1) return [{ col, row }];
        const pd = getPatternData();
        const cells = [];
        const half = Math.floor(_brushSize / 2);
        // Even sizes (2): click = top-left; Odd sizes: click = center
        const start = (_brushSize % 2 === 0) ? 0 : -half;
        const end = start + _brushSize;
        for (let dr = start; dr < end; dr++) {
            for (let dc = start; dc < end; dc++) {
                const c = col + dc, r = row + dr;
                if (c >= 0 && c < pd.grid_w && r >= 0 && r < pd.grid_h) {
                    cells.push({ col: c, row: r });
                }
            }
        }
        return cells;
    }

    /** Does the current tool+mode combo use the brush size? */
    function _toolUsesBrush() {
        if (activeTool === 'pencil' || activeTool === 'eraser') return true;
        if (activeTool === 'stitch') {
            return activeStitchMode === 'half' || activeStitchMode === 'quarter' ||
                   activeStitchMode === 'three_quarter' || activeStitchMode === 'petite' ||
                   activeStitchMode === 'bead';
        }
        return false;
    }

    /* ── Flood fill without undo/render (for mirrored fills) ── */
    function _floodFillNoUndo(col, row) {
        if (!activeDmc) return;
        const pd = getPatternData();
        const { grid, grid_w, grid_h } = pd;
        const idx = row * grid_w + col;
        if (idx < 0 || idx >= grid.length) return;
        const target = grid[idx];
        if (target === activeDmc) return;
        for (const i of _bfsRegion(grid, grid_w, grid_h, idx, target)) grid[i] = activeDmc;
    }

    /* ── Selection helpers ── */
    function _isInsideSelection(col, row) {
        if (!_selRect) return false;
        const dc = _selOffset.dc, dr = _selOffset.dr;
        return col >= _selRect.c1 + dc && col <= _selRect.c2 + dc &&
               row >= _selRect.r1 + dr && row <= _selRect.r2 + dr;
    }

    function _captureSelectionBuffer() {
        if (!_selRect) return;
        const pd = getPatternData();
        const { c1, r1, c2, r2 } = _selRect;
        const w = c2 - c1 + 1, h = r2 - r1 + 1;
        const data = new Array(w * h);
        for (let r = 0; r < h; r++) {
            for (let c = 0; c < w; c++) {
                data[r * w + c] = pd.grid[(r1 + r) * pd.grid_w + (c1 + c)];
            }
        }
        _selBuffer = { w, h, data };
    }

    function _rotateBufferCW() {
        if (!_selBuffer) _captureSelectionBuffer();
        if (!_selBuffer) return;
        const { w, h, data } = _selBuffer;
        const nW = h, nH = w;
        const nd = new Array(nW * nH);
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                nd[c * nW + (h - 1 - r)] = data[r * w + c];
        _selBuffer = { w: nW, h: nH, data: nd };
        _selRect.c2 = _selRect.c1 + nW - 1;
        _selRect.r2 = _selRect.r1 + nH - 1;
        _redrawOverlay();
    }

    function _flipBufferH() {
        if (!_selBuffer) _captureSelectionBuffer();
        if (!_selBuffer) return;
        const { w, h, data } = _selBuffer;
        const nd = new Array(w * h);
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                nd[r * w + (w - 1 - c)] = data[r * w + c];
        _selBuffer = { w, h, data: nd };
        _redrawOverlay();
    }

    function _flipBufferV() {
        if (!_selBuffer) _captureSelectionBuffer();
        if (!_selBuffer) return;
        const { w, h, data } = _selBuffer;
        const nd = new Array(w * h);
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                nd[(h - 1 - r) * w + c] = data[r * w + c];
        _selBuffer = { w, h, data: nd };
        _redrawOverlay();
    }

    function _clearSelectionSource() {
        const pd = getPatternData();
        const { c1, r1, c2, r2 } = _selRect;
        for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
                pd.grid[r * pd.grid_w + c] = 'BG';
            }
        }
    }

    function _commitMovedSelection() {
        if (!_selBuffer || !_selRect) return;
        if (_selOffset.dc === 0 && _selOffset.dr === 0) return;
        const pd = getPatternData();
        const { c1, r1 } = _selRect;
        const dc = _selOffset.dc, dr = _selOffset.dr;
        pushUndo();
        // Clear source
        _clearSelectionSource();
        // Write buffer at offset
        for (let r = 0; r < _selBuffer.h; r++) {
            for (let c = 0; c < _selBuffer.w; c++) {
                const destR = r1 + dr + r, destC = c1 + dc + c;
                if (destR >= 0 && destR < pd.grid_h && destC >= 0 && destC < pd.grid_w) {
                    const val = _selBuffer.data[r * _selBuffer.w + c];
                    if (val !== 'BG') pd.grid[destR * pd.grid_w + destC] = val;
                }
            }
        }
        _selBuffer = null;
        _selRect = null;
        _selOffset = { dc: 0, dr: 0 };
        _commitEdit();
        _stopMarchingAnts();
        _redrawOverlay();
    }

    function _cycleMirror() {
        const modes = ['off', 'horizontal', 'vertical', 'both'];
        const i = modes.indexOf(_mirrorMode);
        _mirrorMode = modes[(i + 1) % modes.length];
        _updateMirrorButton();
        _redrawOverlay();
    }

    function _updateMirrorButton() {
        const btn = _toolbar ? _toolbar.querySelector('.ed-mirror-btn') : null;
        if (!btn) return;
        btn.classList.toggle('active', _mirrorMode !== 'off');
        const icons = { off: 'ti-flip-horizontal', horizontal: 'ti-flip-horizontal', vertical: 'ti-flip-vertical', both: 'ti-arrows-maximize' };
        btn.innerHTML = '<i class="ti ' + (icons[_mirrorMode] || 'ti-flip-horizontal') + '"></i><span class="tool-lbl">Mirror</span>';
        btn.title = 'Mirror: ' + _mirrorMode + ' (M)';
    }

    /* ── Brush size controls ── */
    function _setBrushSize(size) {
        if (!_BRUSH_SIZES.includes(size)) return;
        _brushSize = size;
        _updateBrushButtons();
        _redrawOverlay();
    }

    function _cycleBrushSize(direction) {
        const idx = _BRUSH_SIZES.indexOf(_brushSize);
        let next;
        if (direction > 0) {
            next = idx < _BRUSH_SIZES.length - 1 ? _BRUSH_SIZES[idx + 1] : _BRUSH_SIZES[0];
        } else {
            next = idx > 0 ? _BRUSH_SIZES[idx - 1] : _BRUSH_SIZES[_BRUSH_SIZES.length - 1];
        }
        _setBrushSize(next);
    }

    function _updateBrushButtons() {
        if (!_brushBtns) return;
        _brushBtns.forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.brush) === _brushSize);
        });
    }

    /* ═══════════════════════════════════════════
       Canvas Resize
       ═══════════════════════════════════════════ */

    let _resizeModal = null, _resizeBackdrop = null;

    function _resizeCanvas(newW, newH, anchorX, anchorY) {
        const pd = getPatternData();
        const oldW = pd.grid_w, oldH = pd.grid_h;
        if (newW === oldW && newH === oldH) return;
        pushUndo();
        const offsetCol = Math.round((newW - oldW) * anchorX);
        const offsetRow = Math.round((newH - oldH) * anchorY);
        const newGrid = new Array(newW * newH).fill('BG');
        for (let r = 0; r < oldH; r++) {
            for (let c = 0; c < oldW; c++) {
                const destC = c + offsetCol, destR = r + offsetRow;
                if (destC >= 0 && destC < newW && destR >= 0 && destR < newH) {
                    newGrid[destR * newW + destC] = pd.grid[r * oldW + c];
                }
            }
        }
        pd.grid_w = newW;
        pd.grid_h = newH;
        pd.grid = newGrid;

        // Translate and clip part stitches
        if (pd.part_stitches) {
            pd.part_stitches = pd.part_stitches.filter(ps => {
                const x = (ps.x !== undefined ? ps.x : ps.col);
                const y = (ps.y !== undefined ? ps.y : ps.row);
                const nx = x + offsetCol, ny = y + offsetRow;
                if (nx < 0 || nx >= newW || ny < 0 || ny >= newH) return false;
                if (ps.x !== undefined) ps.x = nx; else ps.col = nx;
                if (ps.y !== undefined) ps.y = ny; else ps.row = ny;
                return true;
            });
        }

        // Translate and clip backstitches
        if (pd.backstitches) {
            pd.backstitches = pd.backstitches.filter(bs => {
                const nx1 = bs.x1 + offsetCol, ny1 = bs.y1 + offsetRow;
                const nx2 = bs.x2 + offsetCol, ny2 = bs.y2 + offsetRow;
                // Keep if both endpoints are within bounds (0..newW for x, 0..newH for y — backstitch coords are on grid intersections)
                if (nx1 < 0 || nx1 > newW || ny1 < 0 || ny1 > newH) return false;
                if (nx2 < 0 || nx2 > newW || ny2 < 0 || ny2 > newH) return false;
                bs.x1 = nx1; bs.y1 = ny1;
                bs.x2 = nx2; bs.y2 = ny2;
                return true;
            });
        }

        // Translate and clip knots
        if (pd.knots) {
            pd.knots = pd.knots.filter(k => {
                const nx = k.x + offsetCol, ny = k.y + offsetRow;
                // Knot coords are on grid intersections (0..newW, 0..newH)
                if (nx < 0 || nx > newW || ny < 0 || ny > newH) return false;
                k.x = nx; k.y = ny;
                return true;
            });
        }

        // Translate and clip beads
        if (pd.beads) {
            pd.beads = pd.beads.filter(b => {
                const nx = b.x + offsetCol, ny = b.y + offsetRow;
                if (nx < 0 || nx >= newW || ny < 0 || ny >= newH) return false;
                b.x = nx; b.y = ny;
                return true;
            });
        }

        _commitEdit();
    }

    /* ═══════════════════════════════════════════
       Row / Column Insert & Delete
       ═══════════════════════════════════════════ */

    let _rcModal = null, _rcBackdrop = null;

    function _rowColHasContent(axis, idx) {
        const pd = getPatternData();
        const { grid, grid_w, grid_h } = pd;
        if (axis === 'row') {
            for (let c = 0; c < grid_w; c++) { if (grid[idx * grid_w + c] !== 'BG') return true; }
        } else {
            for (let r = 0; r < grid_h; r++) { if (grid[r * grid_w + idx] !== 'BG') return true; }
        }
        if (pd.part_stitches) for (const ps of pd.part_stitches) {
            const x = ps.x !== undefined ? ps.x : ps.col;
            const y = ps.y !== undefined ? ps.y : ps.row;
            if (axis === 'row' ? y === idx : x === idx) return true;
        }
        if (pd.backstitches) for (const bs of pd.backstitches) {
            if (axis === 'row') { if (bs.y1 === idx || bs.y2 === idx || (bs.y1 < idx && bs.y2 > idx) || (bs.y2 < idx && bs.y1 > idx)) return true; }
            else { if (bs.x1 === idx || bs.x2 === idx || (bs.x1 < idx && bs.x2 > idx) || (bs.x2 < idx && bs.x1 > idx)) return true; }
        }
        if (pd.knots) for (const k of pd.knots) {
            if (axis === 'row' ? k.y === idx : k.x === idx) return true;
        }
        if (pd.beads) for (const b of pd.beads) {
            if (axis === 'row' ? b.y === idx : b.x === idx) return true;
        }
        return false;
    }

    function _insertRow(idx) {
        const pd = getPatternData();
        const oldW = pd.grid_w, oldH = pd.grid_h;
        const newH = oldH + 1;
        if (newH > 500) return;
        pushUndo();
        // Rebuild grid: copy rows before idx, insert BG row, copy rows from idx onward
        const newGrid = new Array(oldW * newH).fill('BG');
        for (let r = 0; r < oldH; r++) {
            const destR = r < idx ? r : r + 1;
            for (let c = 0; c < oldW; c++) newGrid[destR * oldW + c] = pd.grid[r * oldW + c];
        }
        pd.grid_h = newH;
        pd.grid = newGrid;
        // Shift stitches
        if (pd.part_stitches) pd.part_stitches.forEach(ps => {
            const y = ps.y !== undefined ? ps.y : ps.row;
            if (y >= idx) { if (ps.y !== undefined) ps.y = y + 1; else ps.row = y + 1; }
        });
        if (pd.backstitches) pd.backstitches.forEach(bs => {
            if (bs.y1 >= idx) bs.y1++;
            if (bs.y2 >= idx) bs.y2++;
        });
        if (pd.knots) pd.knots.forEach(k => { if (k.y >= idx) k.y++; });
        if (pd.beads) pd.beads.forEach(b => { if (b.y >= idx) b.y++; });
        _commitEdit();
    }

    function _insertCol(idx) {
        const pd = getPatternData();
        const oldW = pd.grid_w, oldH = pd.grid_h;
        const newW = oldW + 1;
        if (newW > 500) return;
        pushUndo();
        const newGrid = new Array(newW * oldH).fill('BG');
        for (let r = 0; r < oldH; r++) {
            for (let c = 0; c < oldW; c++) {
                const destC = c < idx ? c : c + 1;
                newGrid[r * newW + destC] = pd.grid[r * oldW + c];
            }
        }
        pd.grid_w = newW;
        pd.grid = newGrid;
        if (pd.part_stitches) pd.part_stitches.forEach(ps => {
            const x = ps.x !== undefined ? ps.x : ps.col;
            if (x >= idx) { if (ps.x !== undefined) ps.x = x + 1; else ps.col = x + 1; }
        });
        if (pd.backstitches) pd.backstitches.forEach(bs => {
            if (bs.x1 >= idx) bs.x1++;
            if (bs.x2 >= idx) bs.x2++;
        });
        if (pd.knots) pd.knots.forEach(k => { if (k.x >= idx) k.x++; });
        if (pd.beads) pd.beads.forEach(b => { if (b.x >= idx) b.x++; });
        _commitEdit();
    }

    function _deleteRow(idx) {
        const pd = getPatternData();
        const oldW = pd.grid_w, oldH = pd.grid_h;
        if (oldH <= 1) return;
        const newH = oldH - 1;
        pushUndo();
        const newGrid = new Array(oldW * newH);
        for (let r = 0; r < oldH; r++) {
            if (r === idx) continue;
            const destR = r < idx ? r : r - 1;
            for (let c = 0; c < oldW; c++) newGrid[destR * oldW + c] = pd.grid[r * oldW + c];
        }
        pd.grid_h = newH;
        pd.grid = newGrid;
        // Remove stitches on deleted row, shift those below up
        if (pd.part_stitches) pd.part_stitches = pd.part_stitches.filter(ps => {
            const y = ps.y !== undefined ? ps.y : ps.row;
            if (y === idx) return false;
            if (y > idx) { if (ps.y !== undefined) ps.y = y - 1; else ps.row = y - 1; }
            return true;
        });
        if (pd.backstitches) pd.backstitches = pd.backstitches.filter(bs => {
            // Remove if both endpoints are on the deleted row intersection
            if (bs.y1 === idx && bs.y2 === idx) return false;
            // Remove if it crosses the deleted row (segment spans across)
            if ((bs.y1 <= idx && bs.y2 > idx) || (bs.y2 <= idx && bs.y1 > idx)) return false;
            if (bs.y1 > idx) bs.y1--;
            if (bs.y2 > idx) bs.y2--;
            return true;
        });
        if (pd.knots) pd.knots = pd.knots.filter(k => {
            if (k.y === idx) return false;
            if (k.y > idx) k.y--;
            return true;
        });
        if (pd.beads) pd.beads = pd.beads.filter(b => {
            if (b.y === idx) return false;
            if (b.y > idx) b.y--;
            return true;
        });
        _commitEdit();
    }

    function _deleteCol(idx) {
        const pd = getPatternData();
        const oldW = pd.grid_w, oldH = pd.grid_h;
        if (oldW <= 1) return;
        const newW = oldW - 1;
        pushUndo();
        const newGrid = new Array(newW * oldH);
        for (let r = 0; r < oldH; r++) {
            for (let c = 0; c < oldW; c++) {
                if (c === idx) continue;
                const destC = c < idx ? c : c - 1;
                newGrid[r * newW + destC] = pd.grid[r * oldW + c];
            }
        }
        pd.grid_w = newW;
        pd.grid = newGrid;
        if (pd.part_stitches) pd.part_stitches = pd.part_stitches.filter(ps => {
            const x = ps.x !== undefined ? ps.x : ps.col;
            if (x === idx) return false;
            if (x > idx) { if (ps.x !== undefined) ps.x = x - 1; else ps.col = x - 1; }
            return true;
        });
        if (pd.backstitches) pd.backstitches = pd.backstitches.filter(bs => {
            if (bs.x1 === idx && bs.x2 === idx) return false;
            if ((bs.x1 <= idx && bs.x2 > idx) || (bs.x2 <= idx && bs.x1 > idx)) return false;
            if (bs.x1 > idx) bs.x1--;
            if (bs.x2 > idx) bs.x2--;
            return true;
        });
        if (pd.knots) pd.knots = pd.knots.filter(k => {
            if (k.x === idx) return false;
            if (k.x > idx) k.x--;
            return true;
        });
        if (pd.beads) pd.beads = pd.beads.filter(b => {
            if (b.x === idx) return false;
            if (b.x > idx) b.x--;
            return true;
        });
        _commitEdit();
    }

    function _showRowColModal() {
        if (_rcModal) return;
        const pd = getPatternData();
        let axis = 'row'; // 'row' | 'col'

        _rcBackdrop = document.createElement('div');
        _rcBackdrop.className = 'ed-rc-backdrop';

        _rcModal = document.createElement('div');
        _rcModal.className = 'ed-rc-modal';
        _rcModal.innerHTML = `
            <h3>Insert / Delete</h3>
            <div class="ed-rc-toggle">
                <button data-axis="row" class="active">Row</button>
                <button data-axis="col">Column</button>
            </div>
            <div class="ed-rc-idx">
                <label class="ed-rc-label">Row #</label>
                <input type="number" class="ed-rc-input" min="1" max="${pd.grid_h}" value="1">
                <span class="ed-rc-max">of ${pd.grid_h}</span>
            </div>
            <div class="ed-rc-actions">
                <button class="ed-rc-ins-before primary">Insert Before</button>
                <button class="ed-rc-ins-after primary">Insert After</button>
                <button class="ed-rc-delete danger">Delete</button>
                <button class="ed-rc-cancel">Close</button>
            </div>
        `;
        container.appendChild(_rcBackdrop);
        container.appendChild(_rcModal);

        const idxInput = _rcModal.querySelector('.ed-rc-input');
        const maxLabel = _rcModal.querySelector('.ed-rc-max');
        const axisLabel = _rcModal.querySelector('.ed-rc-label');

        function updateAxisUI() {
            const pd2 = getPatternData();
            const maxVal = axis === 'row' ? pd2.grid_h : pd2.grid_w;
            axisLabel.textContent = axis === 'row' ? 'Row #' : 'Col #';
            idxInput.max = maxVal;
            maxLabel.textContent = 'of ' + maxVal;
            if (parseInt(idxInput.value) > maxVal) idxInput.value = maxVal;
            _rcModal.querySelectorAll('.ed-rc-toggle button').forEach(b => {
                b.classList.toggle('active', b.dataset.axis === axis);
            });
        }

        _rcModal.querySelectorAll('.ed-rc-toggle button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                axis = btn.dataset.axis;
                updateAxisUI();
            });
        });

        const close = () => {
            _rcBackdrop.remove();
            _rcModal.remove();
            _rcBackdrop = null;
            _rcModal = null;
        };

        function getIdx() {
            const pd2 = getPatternData();
            const maxVal = axis === 'row' ? pd2.grid_h : pd2.grid_w;
            return Math.max(0, Math.min(maxVal - 1, (parseInt(idxInput.value) || 1) - 1));
        }

        _rcModal.querySelector('.ed-rc-ins-before').addEventListener('click', () => {
            const idx = getIdx();
            if (axis === 'row') _insertRow(idx); else _insertCol(idx);
            updateAxisUI();
        });

        _rcModal.querySelector('.ed-rc-ins-after').addEventListener('click', () => {
            const idx = getIdx();
            if (axis === 'row') _insertRow(idx + 1); else _insertCol(idx + 1);
            updateAxisUI();
        });

        _rcModal.querySelector('.ed-rc-delete').addEventListener('click', () => {
            const pd2 = getPatternData();
            const maxVal = axis === 'row' ? pd2.grid_h : pd2.grid_w;
            if (maxVal <= 1) return;
            const idx = getIdx();
            if (_rowColHasContent(axis, idx)) {
                const label = axis === 'row' ? `row ${idx + 1}` : `column ${idx + 1}`;
                if (!confirm(`${label.charAt(0).toUpperCase() + label.slice(1)} contains stitches. Delete anyway?`)) return;
            }
            if (axis === 'row') _deleteRow(idx); else _deleteCol(idx);
            updateAxisUI();
        });

        _rcBackdrop.addEventListener('click', close);
        _rcModal.querySelector('.ed-rc-cancel').addEventListener('click', close);
        _rcModal.addEventListener('mousedown', (e) => e.stopPropagation());
        _rcModal.addEventListener('click', (e) => e.stopPropagation());

        idxInput.addEventListener('keydown', (e) => e.stopPropagation());
        idxInput.focus({ preventScroll: true });
        idxInput.select();
    }

    function _outlineRegionAt(col, row) {
        const pd = getPatternData();
        const { grid, grid_w, grid_h } = pd;
        const targetColor = grid[row * grid_w + col] || 'BG';
        const outlineColor = targetColor === 'BG' ? activeDmc : targetColor;
        if (targetColor === 'BG' && !activeDmc) return;

        const regionSet = _bfsRegion(grid, grid_w, grid_h, row * grid_w + col, targetColor);

        if (!pd.backstitches) pd.backstitches = [];
        const existing = new Set();
        for (const b of pd.backstitches) {
            existing.add(b.x1 + ',' + b.y1 + ',' + b.x2 + ',' + b.y2);
        }

        pushUndo();
        let added = 0;

        for (const i of regionSet) {
            const c = i % grid_w;
            const r = (i - c) / grid_w;
            // Top edge
            if (r === 0 || !regionSet.has((r-1) * grid_w + c)) {
                const key = c + ',' + r + ',' + (c+1) + ',' + r;
                if (!existing.has(key)) { pd.backstitches.push({x1:c,y1:r,x2:c+1,y2:r,dmc:outlineColor}); existing.add(key); added++; }
            }
            // Bottom edge
            if (r === grid_h-1 || !regionSet.has((r+1) * grid_w + c)) {
                const key = c + ',' + (r+1) + ',' + (c+1) + ',' + (r+1);
                if (!existing.has(key)) { pd.backstitches.push({x1:c,y1:r+1,x2:c+1,y2:r+1,dmc:outlineColor}); existing.add(key); added++; }
            }
            // Left edge
            if (c === 0 || !regionSet.has(r * grid_w + (c-1))) {
                const key = c + ',' + r + ',' + c + ',' + (r+1);
                if (!existing.has(key)) { pd.backstitches.push({x1:c,y1:r,x2:c,y2:r+1,dmc:outlineColor}); existing.add(key); added++; }
            }
            // Right edge
            if (c === grid_w-1 || !regionSet.has(r * grid_w + (c+1))) {
                const key = (c+1) + ',' + r + ',' + (c+1) + ',' + (r+1);
                if (!existing.has(key)) { pd.backstitches.push({x1:c+1,y1:r,x2:c+1,y2:r+1,dmc:outlineColor}); existing.add(key); added++; }
            }
        }

        if (added > 0) {
            _commitEdit();
        }
    }

    function _showResizeModal() {
        if (_resizeModal) return; // already open
        const pd = getPatternData();

        _resizeBackdrop = document.createElement('div');
        _resizeBackdrop.className = 'ed-resize-backdrop';

        _resizeModal = document.createElement('div');
        _resizeModal.className = 'ed-resize-modal';
        const aspect = pd.grid_w / pd.grid_h;
        _resizeModal.innerHTML = `
            <h3>Resize Canvas</h3>
            <div class="ed-resize-dims">
                <div><label>Width</label><input type="number" class="ed-rz-w" min="1" max="500" value="${pd.grid_w}"></div>
                <button type="button" class="ed-rz-lock active" title="Locked: height auto from aspect ratio. Click to unlock."><i class="ti ti-lock"></i></button>
                <div><label>Height</label><input type="number" class="ed-rz-h" min="1" max="500" value="${pd.grid_h}"></div>
            </div>
            <label style="text-align:center;display:block">Anchor</label>
            <div class="ed-resize-anchor"></div>
            <div class="ed-resize-actions">
                <button class="ed-rz-cancel">Cancel</button>
                <button class="ed-rz-apply primary">Apply</button>
            </div>
        `;
        container.appendChild(_resizeBackdrop);
        container.appendChild(_resizeModal);

        // Build 3×3 anchor grid
        const anchorGrid = _resizeModal.querySelector('.ed-resize-anchor');
        let selectedAnchor = { x: 0.5, y: 0.5 };
        const anchors = [
            { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 },
            { x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.5 },
            { x: 0, y: 1 }, { x: 0.5, y: 1 }, { x: 1, y: 1 }
        ];
        anchors.forEach(a => {
            const btn = document.createElement('button');
            btn.type = 'button';
            if (a.x === 0.5 && a.y === 0.5) btn.classList.add('active');
            btn.addEventListener('click', () => {
                selectedAnchor = a;
                anchorGrid.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
            anchorGrid.appendChild(btn);
        });

        const wInput = _resizeModal.querySelector('.ed-rz-w');
        const hInput = _resizeModal.querySelector('.ed-rz-h');
        const lockBtn = _resizeModal.querySelector('.ed-rz-lock');
        let locked = true;
        const initW = pd.grid_w, initH = pd.grid_h;
        const isDirty = () => {
            const w = parseInt(wInput.value), h = parseInt(hInput.value);
            return (!isNaN(w) && w !== initW) || (!isNaN(h) && h !== initH);
        };

        function applyLockState() {
            if (locked) {
                lockBtn.classList.add('active');
                lockBtn.title = 'Locked: height auto from aspect ratio. Click to unlock.';
                lockBtn.innerHTML = '<i class="ti ti-lock"></i>';
                hInput.disabled = true;
                hInput.style.opacity = '0.5';
            } else {
                lockBtn.classList.remove('active');
                lockBtn.title = 'Unlocked: manual height. Click to lock to aspect ratio.';
                lockBtn.innerHTML = '<i class="ti ti-lock-open"></i>';
                hInput.disabled = false;
                hInput.style.opacity = '';
            }
        }

        lockBtn.addEventListener('click', () => {
            locked = !locked;
            applyLockState();
            if (locked) {
                const w = parseInt(wInput.value) || pd.grid_w;
                hInput.value = Math.max(1, Math.round(w / aspect));
            }
        });

        wInput.addEventListener('input', () => {
            if (locked) {
                const w = parseInt(wInput.value) || 1;
                hInput.value = Math.max(1, Math.min(500, Math.round(w / aspect)));
            }
        });

        applyLockState();

        const close = () => {
            _resizeBackdrop.remove();
            _resizeModal.remove();
            _resizeBackdrop = null;
            _resizeModal = null;
        };

        _resizeBackdrop.addEventListener('click', () => {
            if (isDirty() && !confirm('Discard resize changes?')) return;
            close();
        });
        _resizeModal.querySelector('.ed-rz-cancel').addEventListener('click', close);
        _resizeModal.querySelector('.ed-rz-apply').addEventListener('click', () => {
            const newW = Math.max(1, Math.min(500, parseInt(wInput.value) || pd.grid_w));
            const newH = Math.max(1, Math.min(500, parseInt(hInput.value) || pd.grid_h));
            close();
            _resizeCanvas(newW, newH, selectedAnchor.x, selectedAnchor.y);
        });

        wInput.focus({ preventScroll: true });
        wInput.select();
    }

    /* ═══════════════════════════════════════════
       Text Tool
       ═══════════════════════════════════════════ */

    // 5×7 bitmap pixel font (each char = 7 rows of 5 cols, '#' = filled, '_' = empty)
    const _PIXEL_FONT = {
        'A': ['_###_','#___#','#___#','#####','#___#','#___#','#___#'],
        'B': ['####_','#___#','#___#','####_','#___#','#___#','####_'],
        'C': ['_####','#____','#____','#____','#____','#____','_####'],
        'D': ['####_','#___#','#___#','#___#','#___#','#___#','####_'],
        'E': ['#####','#____','#____','####_','#____','#____','#####'],
        'F': ['#####','#____','#____','####_','#____','#____','#____'],
        'G': ['_####','#____','#____','#__##','#___#','#___#','_####'],
        'H': ['#___#','#___#','#___#','#####','#___#','#___#','#___#'],
        'I': ['#####','__#__','__#__','__#__','__#__','__#__','#####'],
        'J': ['__###','___#_','___#_','___#_','___#_','#__#_','_##__'],
        'K': ['#___#','#__#_','#_#__','##___','#_#__','#__#_','#___#'],
        'L': ['#____','#____','#____','#____','#____','#____','#####'],
        'M': ['#___#','##_##','#_#_#','#___#','#___#','#___#','#___#'],
        'N': ['#___#','##__#','#_#_#','#__##','#___#','#___#','#___#'],
        'O': ['_###_','#___#','#___#','#___#','#___#','#___#','_###_'],
        'P': ['####_','#___#','#___#','####_','#____','#____','#____'],
        'Q': ['_###_','#___#','#___#','#___#','#_#_#','#__#_','_##_#'],
        'R': ['####_','#___#','#___#','####_','#_#__','#__#_','#___#'],
        'S': ['_####','#____','#____','_###_','____#','____#','####_'],
        'T': ['#####','__#__','__#__','__#__','__#__','__#__','__#__'],
        'U': ['#___#','#___#','#___#','#___#','#___#','#___#','_###_'],
        'V': ['#___#','#___#','#___#','#___#','_#_#_','_#_#_','__#__'],
        'W': ['#___#','#___#','#___#','#___#','#_#_#','##_##','#___#'],
        'X': ['#___#','#___#','_#_#_','__#__','_#_#_','#___#','#___#'],
        'Y': ['#___#','#___#','_#_#_','__#__','__#__','__#__','__#__'],
        'Z': ['#####','____#','___#_','__#__','_#___','#____','#####'],
        '0': ['_###_','#___#','#__##','#_#_#','##__#','#___#','_###_'],
        '1': ['__#__','_##__','__#__','__#__','__#__','__#__','_###_'],
        '2': ['_###_','#___#','____#','___#_','__#__','_#___','#####'],
        '3': ['_###_','#___#','____#','__##_','____#','#___#','_###_'],
        '4': ['___#_','__##_','_#_#_','#__#_','#####','___#_','___#_'],
        '5': ['#####','#____','####_','____#','____#','#___#','_###_'],
        '6': ['_###_','#____','#____','####_','#___#','#___#','_###_'],
        '7': ['#####','____#','___#_','__#__','__#__','__#__','__#__'],
        '8': ['_###_','#___#','#___#','_###_','#___#','#___#','_###_'],
        '9': ['_###_','#___#','#___#','_####','____#','____#','_###_'],
        ' ': ['_____','_____','_____','_____','_____','_____','_____'],
        '.': ['_____','_____','_____','_____','_____','_____','__#__'],
        ',': ['_____','_____','_____','_____','_____','__#__','_#___'],
        ':': ['_____','_____','__#__','_____','_____','__#__','_____'],
        ';': ['_____','_____','__#__','_____','_____','__#__','_#___'],
        '!': ['__#__','__#__','__#__','__#__','__#__','_____','__#__'],
        '?': ['_###_','#___#','____#','__##_','__#__','_____','__#__'],
        '-': ['_____','_____','_____','_###_','_____','_____','_____'],
        '+': ['_____','__#__','__#__','#####','__#__','__#__','_____'],
        '/': ['____#','___#_','___#_','__#__','_#___','_#___','#____'],
        '(': ['___#_','__#__','_#___','_#___','_#___','__#__','___#_'],
        ')': ['_#___','__#__','___#_','___#_','___#_','__#__','_#___'],
        '#': ['_#_#_','_#_#_','#####','_#_#_','#####','_#_#_','_#_#_'],
        '&': ['_##__','#__#_','#__#_','_##__','#__#_','#___#','_##_#'],
        '*': ['_____','_#_#_','__#__','#####','__#__','_#_#_','_____'],
    };

    const _PIXEL_FONT_COMPACT = {
        'A': ['_#_','#_#','###','#_#','#_#'],
        'B': ['##_','#_#','##_','#_#','##_'],
        'C': ['_##','#__','#__','#__','_##'],
        'D': ['##_','#_#','#_#','#_#','##_'],
        'E': ['###','#__','##_','#__','###'],
        'F': ['###','#__','##_','#__','#__'],
        'G': ['_##','#__','#_#','#_#','_##'],
        'H': ['#_#','#_#','###','#_#','#_#'],
        'I': ['###','_#_','_#_','_#_','###'],
        'J': ['__#','__#','__#','#_#','_#_'],
        'K': ['#_#','##_','#__','##_','#_#'],
        'L': ['#__','#__','#__','#__','###'],
        'M': ['#_#','###','#_#','#_#','#_#'],
        'N': ['#_#','##_','#_#','#_#','#_#'],
        'O': ['_#_','#_#','#_#','#_#','_#_'],
        'P': ['##_','#_#','##_','#__','#__'],
        'Q': ['_#_','#_#','#_#','_#_','__#'],
        'R': ['##_','#_#','##_','#_#','#_#'],
        'S': ['_##','#__','_#_','__#','##_'],
        'T': ['###','_#_','_#_','_#_','_#_'],
        'U': ['#_#','#_#','#_#','#_#','_#_'],
        'V': ['#_#','#_#','#_#','#_#','_#_'],
        'W': ['#_#','#_#','###','###','#_#'],
        'X': ['#_#','#_#','_#_','#_#','#_#'],
        'Y': ['#_#','#_#','_#_','_#_','_#_'],
        'Z': ['###','__#','_#_','#__','###'],
        '0': ['_#_','#_#','#_#','#_#','_#_'],
        '1': ['_#_','##_','_#_','_#_','###'],
        '2': ['###','__#','_#_','#__','###'],
        '3': ['###','__#','_#_','__#','###'],
        '4': ['#_#','#_#','###','__#','__#'],
        '5': ['###','#__','###','__#','###'],
        '6': ['_##','#__','###','#_#','_#_'],
        '7': ['###','__#','_#_','_#_','_#_'],
        '8': ['_#_','#_#','_#_','#_#','_#_'],
        '9': ['_#_','#_#','###','__#','##_'],
        ' ': ['___','___','___','___','___'],
        '.': ['___','___','___','___','_#_'],
        ',': ['___','___','___','_#_','#__'],
        ':': ['___','_#_','___','_#_','___'],
        '!': ['_#_','_#_','_#_','___','_#_'],
        '?': ['##_','__#','_#_','___','_#_'],
        '-': ['___','___','###','___','___'],
        '+': ['___','_#_','###','_#_','___'],
        '/': ['__#','__#','_#_','#__','#__'],
    };

    let _textInsertPos = null;   // { col, row }
    let _textPanel = null;       // DOM element
    let _textInput = null;       // input element
    let _textPixelFontRow = null;
    let _textSysFontRow = null;
    let _textScale = 1;
    let _textCompact = false;
    let _textFontMode = 'pixel'; // 'pixel' | 'system'
    let _textSystemFont = 'Georgia';
    const _SYSTEM_FONTS = [
        { name: 'Georgia',          label: 'Georgia (Serif)' },
        { name: 'Times New Roman',  label: 'Times New Roman' },
        { name: 'Palatino Linotype', label: 'Palatino' },
        { name: 'Arial',            label: 'Arial (Sans)' },
        { name: 'Verdana',          label: 'Verdana' },
        { name: 'Trebuchet MS',     label: 'Trebuchet MS' },
        { name: 'Courier New',      label: 'Courier New (Mono)' },
        { name: 'Impact',           label: 'Impact' },
        { name: 'Comic Sans MS',    label: 'Comic Sans MS' },
    ];

    function _textToGrid(text, scale) {
        const font = _textCompact ? _PIXEL_FONT_COMPACT : _PIXEL_FONT;
        const fw = _textCompact ? 3 : 5, fh = _textCompact ? 5 : 7;
        const chars = text.toUpperCase().split('');
        const charW = fw * scale, charH = fh * scale, gap = 1 * scale;
        const totalW = chars.length * (charW + gap) - gap;
        const cells = [];
        let cursorX = 0;
        for (const ch of chars) {
            const glyph = font[ch];
            if (glyph) {
                for (let r = 0; r < fh; r++) {
                    for (let c = 0; c < fw; c++) {
                        if (glyph[r][c] === '#') {
                            for (let sr = 0; sr < scale; sr++)
                                for (let sc = 0; sc < scale; sc++)
                                    cells.push({ col: cursorX + c * scale + sc, row: r * scale + sr });
                        }
                    }
                }
            } else {
                // Unknown char: filled block
                for (let r = 0; r < charH; r++)
                    for (let c = 0; c < charW; c++)
                        cells.push({ col: cursorX + c, row: r });
            }
            cursorX += charW + gap;
        }
        return { w: Math.max(totalW, 0), h: charH, cells };
    }

    let _textRenderCanvas = null;
    function _textToGridSystem(text, scale, fontName) {
        // Target height in grid cells — match pixel font proportions
        const baseH = 7 * scale;
        const fontSize = Math.max(8, baseH * 1.1);
        if (!_textRenderCanvas) _textRenderCanvas = document.createElement('canvas');
        const cv = _textRenderCanvas;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.font = `bold ${fontSize}px "${fontName}", sans-serif`;
        const metrics = ctx.measureText(text);
        const textW = Math.ceil(metrics.width);
        const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fontSize * 0.8);
        const descent = Math.ceil(metrics.actualBoundingBoxDescent || fontSize * 0.2);
        const textH = ascent + descent;
        if (textW <= 0 || textH <= 0) return { w: 0, h: 0, cells: [] };
        cv.width = textW;
        cv.height = textH;
        // Reset context after dimension change
        ctx.font = `bold ${fontSize}px "${fontName}", sans-serif`;
        ctx.fillStyle = '#000';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, 0, ascent);
        const imgData = ctx.getImageData(0, 0, cv.width, cv.height);
        const pixels = imgData.data;
        const cells = [];
        for (let r = 0; r < textH; r++) {
            for (let c = 0; c < textW; c++) {
                const alpha = pixels[(r * textW + c) * 4 + 3];
                if (alpha > 100) {
                    cells.push({ col: c, row: r });
                }
            }
        }
        return { w: textW, h: textH, cells };
    }

    // Cache to avoid double-computing on each keystroke (dim label + preview)
    let _textGridCache = null;
    function _textToGridDispatch(text, scale) {
        const key = `${_textFontMode}|${text}|${scale}|${_textSystemFont}|${_textCompact}`;
        if (_textGridCache && _textGridCache.key === key) return _textGridCache.result;
        const result = _textFontMode === 'system'
            ? _textToGridSystem(text, scale, _textSystemFont)
            : _textToGrid(text, scale);
        _textGridCache = { key, result };
        return result;
    }

    function _showTextPanel(col, row) {
        _textInsertPos = { col, row };
        if (!_textPanel) {
            _textPanel = document.createElement('div');
            _textPanel.className = 'ed-text-panel';
            const fontMenuItems = _SYSTEM_FONTS.map(f =>
                `<button data-font-name="${f.name}"${f.name === _textSystemFont ? ' class="active"' : ''} style="font-family:'${f.name}',sans-serif">${f.label}</button>`
            ).join('');
            _textPanel.innerHTML = `
                <input type="text" class="ed-text-input" placeholder="Type text…" maxlength="40">
                <div class="ed-text-mode-row">
                    <button data-mode="pixel" class="active">Pixel</button>
                    <button data-mode="system">System Font</button>
                </div>
                <div class="ed-text-font-row">
                    <button data-font="standard" class="active">Standard</button>
                    <button data-font="compact">Compact</button>
                </div>
                <div class="ed-text-sysfont-row" style="display:none">
                    <button class="ed-font-trigger" type="button"><span class="ed-ft-label">${_SYSTEM_FONTS.find(f => f.name === _textSystemFont).label}</span><span class="ed-ft-arrow">▼</span></button>
                    <div class="ed-font-menu">${fontMenuItems}</div>
                </div>
                <div class="ed-text-scale-row">
                    <input type="range" class="ed-text-scale" min="1" max="10" value="1" step="1">
                    <span class="ed-text-scale-val">1×</span>
                </div>
                <div class="ed-text-dim"></div>
                <div class="ed-text-hint">Enter to stamp, Esc to cancel</div>
            `;
            container.appendChild(_textPanel);
            _textInput = _textPanel.querySelector('.ed-text-input');
            const scaleSlider = _textPanel.querySelector('.ed-text-scale');
            const scaleLabel = _textPanel.querySelector('.ed-text-scale-val');
            const dimEl = _textPanel.querySelector('.ed-text-dim');
            _textPixelFontRow = _textPanel.querySelector('.ed-text-font-row');
            _textSysFontRow = _textPanel.querySelector('.ed-text-sysfont-row');
            const fontTrigger = _textPanel.querySelector('.ed-font-trigger');
            const fontMenu = _textPanel.querySelector('.ed-font-menu');
            const fontLabel = _textPanel.querySelector('.ed-ft-label');
            function _updateTextDim() {
                const val = _textInput.value.trim();
                if (!val) { dimEl.textContent = ''; return; }
                const { w, h } = _textToGridDispatch(val, _textScale);
                dimEl.textContent = `${w} × ${h} cells`;
            }
            function _closeFontMenu() { fontTrigger.classList.remove('open'); fontMenu.classList.remove('open'); }
            // Mode toggle (Pixel / System Font)
            _textPanel.querySelectorAll('.ed-text-mode-row button').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    _textFontMode = btn.dataset.mode;
                    _textPanel.querySelectorAll('.ed-text-mode-row button').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    _textPixelFontRow.style.display = _textFontMode === 'pixel' ? '' : 'none';
                    _textSysFontRow.style.display = _textFontMode === 'system' ? '' : 'none';
                    _closeFontMenu();
                    _updateTextDim();
                    _redrawOverlay();
                });
            });
            // Custom font picker dropdown
            fontTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = fontMenu.classList.contains('open');
                if (isOpen) { _closeFontMenu(); } else { fontTrigger.classList.add('open'); fontMenu.classList.add('open'); }
            });
            fontMenu.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    _textSystemFont = btn.dataset.fontName;
                    fontLabel.textContent = btn.textContent;
                    fontMenu.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    _closeFontMenu();
                    _updateTextDim();
                    _redrawOverlay();
                });
            });
            _textInput.addEventListener('input', () => { _updateTextDim(); _redrawOverlay(); });
            _textInput.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    e.preventDefault();
                    _commitText();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    _hideTextPanel();
                    _redrawOverlay();
                }
            });
            // Pixel font variant toggle (Standard / Compact)
            _textPanel.querySelectorAll('.ed-text-font-row button').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    _textCompact = btn.dataset.font === 'compact';
                    _textPanel.querySelectorAll('.ed-text-font-row button').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    _updateTextDim();
                    _redrawOverlay();
                });
            });
            scaleSlider.addEventListener('input', () => {
                _textScale = parseInt(scaleSlider.value);
                scaleLabel.textContent = _textScale + '×';
                _updateTextDim();
                _redrawOverlay();
            });
            scaleSlider.addEventListener('keydown', (e) => e.stopPropagation());
            _textPanel.addEventListener('mousedown', (e) => e.stopPropagation());
            _textPanel.addEventListener('click', (e) => e.stopPropagation());
        }
        // Preserve text when repositioning (panel already open)
        const wasOpen = _textPanel.style.display === 'block';
        // Position near the insertion point, clamped to visible area
        const offset = getGridOffset();
        const cp = getCellPx();
        const px = offset.x + col * cp;
        const py = offset.y + row * cp;
        // Sync font mode UI on every open (panel is reused)
        _textPixelFontRow.style.display = _textFontMode === 'pixel' ? '' : 'none';
        _textSysFontRow.style.display = _textFontMode === 'system' ? '' : 'none';
        _textPanel.querySelectorAll('.ed-text-mode-row button').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === _textFontMode);
        });
        _textPanel.style.display = 'block';
        const panelW = _textPanel.offsetWidth || 200;
        const panelH = _textPanel.offsetHeight || 70;
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        const clampedX = Math.max(8, Math.min(px, cw - panelW - 8));
        const clampedY = Math.max(8, Math.min(py - panelH - 8, ch - panelH - 8));
        _textPanel.style.left = clampedX + 'px';
        _textPanel.style.top = clampedY + 'px';
        if (!wasOpen) _textInput.value = '';
        _textInput.focus({ preventScroll: true });
    }

    function _hideTextPanel() {
        _textInsertPos = null;
        if (_textPanel) _textPanel.style.display = 'none';
    }

    function _commitText() {
        if (!_textInsertPos || !_textInput || !_textInput.value.trim()) {
            _hideTextPanel();
            _redrawOverlay();
            return;
        }
        const { cells } = _textToGridDispatch(_textInput.value, _textScale);
        if (cells.length === 0) { _hideTextPanel(); return; }
        const pd = getPatternData();
        pushUndo();
        for (const { col, row } of cells) {
            const destC = _textInsertPos.col + col;
            const destR = _textInsertPos.row + row;
            if (destC >= 0 && destC < pd.grid_w && destR >= 0 && destR < pd.grid_h) {
                _withMirror(destC, destR, pencilAt);
            }
        }
        _hideTextPanel();
        _commitEdit();
        _redrawOverlay();
    }

    function _drawTextPreview(ctx, offset, cp) {
        if (!_textInsertPos || !_textInput || !_textInput.value) return;
        const { cells } = _textToGridDispatch(_textInput.value, _textScale);
        ctx.fillStyle = activeHex + '88';
        for (const { col, row } of cells) {
            const destC = _textInsertPos.col + col;
            const destR = _textInsertPos.row + row;
            ctx.fillRect(offset.x + destC * cp, offset.y + destR * cp, cp, cp);
        }
    }

    /* ═══════════════════════════════════════════
       UI Helpers
       ═══════════════════════════════════════════ */

    const _STITCH_MODES = { 'stitch-half': 'half', 'stitch-quarter': 'quarter', 'stitch-threequarter': 'three_quarter', 'stitch-petite': 'petite', 'stitch-back': 'backstitch', 'stitch-knot': 'knot', 'stitch-bead': 'bead' };
    const _STITCH_TOOLS = new Set(Object.keys(_STITCH_MODES));

    function _setTool(tool) {
        if (_painting) {
            _painting = false;
            _lastPaintCell = null;
            _recountStitches();
            renderAll();
            renderLegend();
        }
        // Commit pending selection before switching away
        if (activeTool === 'select' && _selRect) {
            _commitMovedSelection();
            _selRect = null;
            _selBuffer = null;
            _selOffset = { dc: 0, dr: 0 };
            _stopMarchingAnts();
        }
        // auto-outline is now a persistent tool mode (falls through to activeTool = tool)
        // Map stitch sub-tools to activeTool='stitch' + activeStitchMode
        const isStitch = _STITCH_TOOLS.has(tool);
        if (isStitch) {
            activeTool = 'stitch';
            activeStitchMode = _STITCH_MODES[tool];
            _bsStart = null; _bsPreviewEnd = null;
            // Show/hide direction toggle for half/three-quarter
            if (_dirToggle) {
                _dirToggle.style.display = (activeStitchMode === 'half' || activeStitchMode === 'three_quarter') ? '' : 'none';
                _dirToggle.textContent = _halfDir === 'fwd' ? '/' : '\\';
            }
        } else {
            activeTool = tool;
        }
        if (_toolbar) {
            _toolbar.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
                b.classList.toggle('active', b.dataset.tool === tool);
            });
        }
        container.classList.remove('tool-eraser', 'tool-eyedropper', 'tool-pan', 'tool-select');
        if (tool === 'eraser')          container.classList.add('tool-eraser');
        else if (tool === 'eyedropper') container.classList.add('tool-eyedropper');
        else if (tool === 'pan')        container.classList.add('tool-pan');
        else if (tool === 'select')     container.classList.add('tool-select');
        const _subTop = (_toolbar && _toolbar.offsetHeight > 0 ? (_toolbar.offsetTop + _toolbar.offsetHeight + 4) : 80) + 'px';
        if (_replacePanel) { _replacePanel.style.display = tool === 'replace' ? 'flex' : 'none'; _replacePanel.style.top = _subTop; }
        if (tool === 'replace') _populateReplaceTarget();
        else _closeReplaceDropdown();
        // Clear line / rect / ellipse / text / stitch previews when switching away
        if (tool !== 'line') { lineStart = null; _lineEnd = null; }
        if (tool !== 'rect') { _rectStart = null; _rectPreview = null; }
        if (tool !== 'ellipse') { _ellipseStart = null; _ellipsePreview = null; }
        if (tool !== 'text') _hideTextPanel();
        if (!isStitch) { _bsStart = null; _bsPreviewEnd = null; }
        _hideEyedropTip();
        // Dim brush size group for tools that don't use it
        const _brushGroup = _toolbar ? _toolbar.querySelector('.brush-size-group') : null;
        if (_brushGroup) {
            const _usesBrush = _toolUsesBrush();
            _brushGroup.style.opacity = _usesBrush ? '' : '0.35';
            _brushGroup.style.pointerEvents = _usesBrush ? '' : 'none';
        }
        _redrawOverlay();
    }

    // _setStitchMode is now handled inline by _setTool via stitch sub-tool mapping

    function _toggleHalfDir() {
        _halfDir = _halfDir === 'fwd' ? 'bwd' : 'fwd';
        if (_dirToggle) _dirToggle.querySelector('span:first-child').textContent = _halfDir === 'fwd' ? '/' : '\\';
    }

    function _setActiveColor(dmc) {
        const lu   = getLookup();
        const info = lu[dmc];
        if (!info) return;
        activeDmc    = String(dmc);
        activeHex    = info.hex;
        _updateActiveIndicator();
        document.querySelectorAll('.legend-row, .key-row').forEach(r => {
            r.classList.toggle('active', _active && r.dataset.dmc === String(dmc));
        });
    }

    function _updateActiveIndicator() {
        if (!_activeSwatch || !_activeLabel) return;
        if (activeDmc) {
            _activeSwatch.style.background = activeHex;
            _activeLabel.textContent = _brand + ' ' + activeDmc;
        } else {
            _activeSwatch.style.background = '#444';
            _activeLabel.textContent = 'No color';
        }
        if (_replaceSrcSwatch) _replaceSrcSwatch.style.background = activeDmc ? activeHex : '#444';
    }

    /* ═══════════════════════════════════════════
       Unified Overlay
       ═══════════════════════════════════════════ */

    function _ensureEyedropTip() {
        if (!_eyedropTip) {
            _eyedropTip = document.createElement('div');
            _eyedropTip.className = 'ed-eyedrop-tip';
            container.appendChild(_eyedropTip);
        }
        return _eyedropTip;
    }
    function _showEyedropTip(e, stitch) {
        if (!stitch) { _hideEyedropTip(); return; }
        const pd = getPatternData();
        const dmc = pd.grid[stitch.row * pd.grid_w + stitch.col];
        if (dmc === 'BG' || !getLookup()[dmc]) { _hideEyedropTip(); return; }
        const info = getLookup()[dmc];
        const tip = _ensureEyedropTip();
        tip.innerHTML = `<span class="ed-et-sw" style="background:${escHtml(info.hex)}"></span>${escHtml(_brand)} ${escHtml(String(dmc))} — ${escHtml(info.name || '')}`;
        const rect = container.getBoundingClientRect();
        tip.style.left = (e.clientX - rect.left + 14) + 'px';
        tip.style.top = (e.clientY - rect.top - 30) + 'px';
        tip.style.display = 'flex';
    }
    function _hideEyedropTip() {
        if (_eyedropTip) _eyedropTip.style.display = 'none';
    }

    function _cellKey(cell) { return cell ? `${cell.col},${cell.row}` : ''; }

    function _redrawOverlay() {
        const overlay = getOverlayCanvas();
        if (!overlay) return;
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        // Let the page draw its own overlay content first (DMC highlight, etc.)
        if (onOverlayClear) onOverlayClear();

        const offset = getGridOffset();
        const cp     = getCellPx();

        // Mirror guide lines
        if (_mirrorMode !== 'off') _drawMirrorGuides(ctx, offset, cp);

        // Line preview
        if (activeTool === 'line' && lineStart && _lineEnd) {
            const cells = bresenhamLine(lineStart.col, lineStart.row, _lineEnd.col, _lineEnd.row);
            ctx.fillStyle = activeHex + 'aa';
            for (const { col, row } of cells) {
                ctx.fillRect(offset.x + col * cp, offset.y + row * cp, cp, cp);
            }
            const len = cells.length;
            const mid = cells[Math.floor(len / 2)] || _lineEnd;
            _drawDimLabel(ctx, String(len), offset.x + (mid.col + 1) * cp + 4, offset.y + mid.row * cp + cp / 2);
        }

        // Rectangle preview
        if (_rectPreview) _drawShapePreview(ctx, offset, cp, _rectPreview, _getRectCells);

        // Ellipse preview
        if (_ellipsePreview) _drawShapePreview(ctx, offset, cp, _ellipsePreview, _getEllipseCells);

        // Text preview
        if (activeTool === 'text') _drawTextPreview(ctx, offset, cp);

        // Backstitch preview
        if (activeTool === 'stitch' && activeStitchMode === 'backstitch' && _bsStart && _bsPreviewEnd) {
            const px1 = offset.x + _bsStart.ix * cp;
            const py1 = offset.y + _bsStart.iy * cp;
            const px2 = offset.x + _bsPreviewEnd.ix * cp;
            const py2 = offset.y + _bsPreviewEnd.iy * cp;
            ctx.save();
            ctx.strokeStyle = activeHex + 'bb';
            ctx.lineWidth = Math.max(2, cp * 0.18);
            ctx.lineCap = 'round';
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(px1, py1);
            ctx.lineTo(px2, py2);
            ctx.stroke();
            // Dot at start
            ctx.fillStyle = activeHex;
            ctx.beginPath();
            ctx.arc(px1, py1, Math.max(2, cp * 0.12), 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // Backstitch start indicator
        if (activeTool === 'stitch' && activeStitchMode === 'backstitch' && _bsStart && !_bsPreviewEnd) {
            const px = offset.x + _bsStart.ix * cp;
            const py = offset.y + _bsStart.iy * cp;
            ctx.save();
            ctx.fillStyle = activeHex;
            ctx.beginPath();
            ctx.arc(px, py, Math.max(3, cp * 0.15), 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // Selection marching ants
        if (_selRect) _drawSelectionOutline(ctx, offset, cp);

        // Hover cell highlight (always on top)
        if (_hoverCell && activeTool !== 'pan') {
            ctx.strokeStyle = 'rgba(200, 145, 58, 0.7)';
            ctx.lineWidth = 2;
            if (_brushSize > 1 && _toolUsesBrush()) {
                for (const bc of _getBrushCells(_hoverCell.col, _hoverCell.row)) {
                    ctx.strokeRect(offset.x + bc.col * cp + 1, offset.y + bc.row * cp + 1, cp - 2, cp - 2);
                }
            } else {
                const x = offset.x + _hoverCell.col * cp;
                const y = offset.y + _hoverCell.row * cp;
                ctx.strokeRect(x + 1, y + 1, cp - 2, cp - 2);
            }
        }

        // Intersection hover for backstitch/knot modes
        if (activeTool === 'stitch' && (activeStitchMode === 'backstitch' || activeStitchMode === 'knot') && _hoverIntersection) {
            const px = offset.x + _hoverIntersection.ix * cp;
            const py = offset.y + _hoverIntersection.iy * cp;
            ctx.save();
            ctx.strokeStyle = 'rgba(200, 145, 58, 0.6)';
            ctx.lineWidth = 1.5;
            const r = Math.max(3, cp * 0.15);
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    function _drawMirrorGuides(ctx, offset, cp) {
        const pd = getPatternData();
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(200, 145, 58, 0.4)';
        ctx.lineWidth = 1;
        if (_mirrorMode === 'horizontal' || _mirrorMode === 'both') {
            const midX = offset.x + (pd.grid_w / 2) * cp;
            ctx.beginPath();
            ctx.moveTo(midX, offset.y);
            ctx.lineTo(midX, offset.y + pd.grid_h * cp);
            ctx.stroke();
        }
        if (_mirrorMode === 'vertical' || _mirrorMode === 'both') {
            const midY = offset.y + (pd.grid_h / 2) * cp;
            ctx.beginPath();
            ctx.moveTo(offset.x, midY);
            ctx.lineTo(offset.x + pd.grid_w * cp, midY);
            ctx.stroke();
        }
        ctx.restore();
    }

    function _drawDimLabel(ctx, text, px, py) {
        ctx.save();
        ctx.font = 'bold 11px "IBM Plex Mono", monospace';
        const m = ctx.measureText(text);
        const pad = 3;
        ctx.fillStyle = 'rgba(0,0,0,.7)';
        ctx.fillRect(px - pad, py - 11 - pad, m.width + pad * 2, 14 + pad);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, px, py);
        ctx.restore();
    }

    function _drawShapePreview(ctx, offset, cp, preview, getCellsFn) {
        const cells = getCellsFn(preview.c1, preview.r1, preview.c2, preview.r2, !preview.outline);
        ctx.fillStyle = activeHex + 'aa';
        for (const { col, row } of cells) {
            ctx.fillRect(offset.x + col * cp, offset.y + row * cp, cp, cp);
        }
        const w = Math.abs(preview.c2 - preview.c1) + 1;
        const h = Math.abs(preview.r2 - preview.r1) + 1;
        const lx = offset.x + (Math.max(preview.c1, preview.c2) + 1) * cp + 4;
        const ly = offset.y + (Math.max(preview.r1, preview.r2) + 1) * cp;
        _drawDimLabel(ctx, `${w}×${h}`, lx, ly);
    }

    function _drawSelectionOutline(ctx, offset, cp) {
        const dc = _selOffset.dc, dr = _selOffset.dr;
        const x = offset.x + (_selRect.c1 + dc) * cp;
        const y = offset.y + (_selRect.r1 + dr) * cp;
        const w = (_selRect.c2 - _selRect.c1 + 1) * cp;
        const h = (_selRect.r2 - _selRect.r1 + 1) * cp;

        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 2;
        // White stroke
        ctx.lineDashOffset = -_marchPhase;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeRect(x, y, w, h);
        // Black stroke offset for contrast
        ctx.lineDashOffset = -_marchPhase + 4;
        ctx.strokeStyle = '#000000';
        ctx.strokeRect(x, y, w, h);
        ctx.restore();

        // Draw buffer preview if moving
        if (_selBuffer && (dc !== 0 || dr !== 0)) {
            const lu = getLookup();
            for (let r = 0; r < _selBuffer.h; r++) {
                for (let c = 0; c < _selBuffer.w; c++) {
                    const val = _selBuffer.data[r * _selBuffer.w + c];
                    if (val === 'BG') continue;
                    const info = lu[val];
                    if (!info) continue;
                    ctx.fillStyle = info.hex + 'cc';
                    ctx.fillRect(
                        offset.x + (_selRect.c1 + dc + c) * cp,
                        offset.y + (_selRect.r1 + dr + r) * cp,
                        cp, cp
                    );
                }
            }
        }
    }

    function _startMarchingAnts() {
        _stopMarchingAnts();
        let _marchFrameCount = 0;
        function step() {
            _marchRAF = requestAnimationFrame(step);
            if (++_marchFrameCount % 6 !== 0) return; // ~10fps instead of 60fps
            _marchPhase = (_marchPhase + 1) % 16;
            _redrawOverlay();
        }
        _marchRAF = requestAnimationFrame(step);
    }

    function _stopMarchingAnts() {
        if (_marchRAF) { cancelAnimationFrame(_marchRAF); _marchRAF = null; }
    }

    function _getRectCells(c1, r1, c2, r2, filled) {
        const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
        const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
        const cells = [];
        if (filled) {
            for (let r = minR; r <= maxR; r++)
                for (let c = minC; c <= maxC; c++)
                    cells.push({ col: c, row: r });
        } else {
            for (let c = minC; c <= maxC; c++) {
                cells.push({ col: c, row: minR });
                if (minR !== maxR) cells.push({ col: c, row: maxR });
            }
            for (let r = minR + 1; r < maxR; r++) {
                cells.push({ col: minC, row: r });
                if (minC !== maxC) cells.push({ col: maxC, row: r });
            }
        }
        return cells;
    }

    function _getEllipseCells(c1, r1, c2, r2, filled) {
        const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
        const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
        const cx = (minC + maxC) / 2, cy = (minR + maxR) / 2;
        const rx = (maxC - minC) / 2, ry = (maxR - minR) / 2;
        const cells = [];
        if (rx === 0 && ry === 0) { cells.push({ col: minC, row: minR }); return cells; }
        if (filled) {
            for (let r = minR; r <= maxR; r++)
                for (let c = minC; c <= maxC; c++) {
                    const dx = (c - cx) / (rx || 0.5), dy = (r - cy) / (ry || 0.5);
                    if (dx * dx + dy * dy <= 1.0001) cells.push({ col: c, row: r });
                }
        } else {
            // Midpoint ellipse: collect border cells
            const set = new Set();
            const add = (x, y) => {
                const ic = Math.round(cx + x), ir = Math.round(cy + y);
                if (ic >= minC && ic <= maxC && ir >= minR && ir <= maxR)
                    set.add(ir * 100000 + ic);
            };
            const plot4 = (x, y) => { add(x, y); add(-x, y); add(x, -y); add(-x, -y); };
            let x = 0, y = ry;
            let rx2 = rx * rx, ry2 = ry * ry;
            let px = 0, py = 2 * rx2 * y;
            plot4(x, y);
            // Region 1
            let p = ry2 - rx2 * ry + 0.25 * rx2;
            while (px < py) {
                x++; px += 2 * ry2;
                if (p < 0) { p += ry2 + px; }
                else { y--; py -= 2 * rx2; p += ry2 + px - py; }
                plot4(x, y);
            }
            // Region 2
            p = ry2 * (x + 0.5) * (x + 0.5) + rx2 * (y - 1) * (y - 1) - rx2 * ry2;
            while (y > 0) {
                y--; py -= 2 * rx2;
                if (p > 0) { p += rx2 - py; }
                else { x++; px += 2 * ry2; p += rx2 - py + px; }
                plot4(x, y);
            }
            for (const key of set) {
                const ir = Math.floor(key / 100000), ic = key % 100000;
                cells.push({ col: ic, row: ir });
            }
        }
        return cells;
    }

    /* ═══════════════════════════════════════════
       Shared Thread Helpers
       ═══════════════════════════════════════════ */

    async function _ensureThreadsLoaded() {
        if (allDmcThreads) return true;
        try {
            const resp = await fetch('/api/threads?brand=' + encodeURIComponent(_brand));
            allDmcThreads = await resp.json();
            return true;
        } catch (err) { toast('Could not load thread list.', { type: 'error' }); return false; }
    }

    function _renderThreadList(listEl, searchEl, { excludeDmc, selectedDmc } = {}) {
        if (!allDmcThreads || !listEl) return;
        const q = (searchEl ? searchEl.value.trim().toLowerCase() : '');
        const pd = getPatternData();
        const inPalette = new Set(pd.legend.map(e => String(e.dmc)));
        const matches = allDmcThreads.filter(t => {
            if (excludeDmc && String(t.number) === excludeDmc) return false;
            if (!q) return true;
            return String(t.number).toLowerCase().includes(q) ||
                   (t.name || '').toLowerCase().includes(q);
        });
        listEl.innerHTML = matches.map(t => {
            const num = String(t.number);
            const badge = inPalette.has(num) ? '<span class="rtr-badge">in palette</span>' : '';
            const sel = selectedDmc && num === selectedDmc ? ' selected' : '';
            return `<div class="replace-target-row${sel}" data-dmc="${escHtml(num)}">
                <div class="rtr-sw" style="background:${t.hex_color || '#888'}"></div>
                <span class="rtr-num">${escHtml(num)}</span>
                <span class="rtr-name">${escHtml(t.name || '')}</span>
                ${badge}
            </div>`;
        }).join('');
    }

    /** Add a DMC color to the palette if not already present. Returns true if added or already exists. */
    function _ensureColorInPalette(dmcNumber) {
        const pd = getPatternData();
        const dmc = String(dmcNumber);
        if (pd.legend.find(e => String(e.dmc) === dmc)) return true;
        const thread = allDmcThreads ? allDmcThreads.find(t => String(t.number) === dmc) : null;
        if (!thread) return false;
        const usedSymbols = new Set(pd.legend.map(e => e.symbol));
        let sym = '?';
        for (const s of symbolSet) { if (!usedSymbols.has(s)) { sym = s; break; } }
        const newEntry = {
            dmc, name: thread.name || '', hex: thread.hex_color || '#888888',
            symbol: sym, stitches: 0, status: thread.status || 'dont_own',
            category: thread.category || ''
        };
        pd.legend.push(newEntry);
        const lu = getLookup();
        lu[dmc] = { hex: newEntry.hex, symbol: newEntry.symbol, name: newEntry.name, count: 0 };
        setLookup(lu);
        return true;
    }

    /* ═══════════════════════════════════════════
       Add Color Modal
       ═══════════════════════════════════════════ */

    async function _toggleAddColorDropdown() {
        if (!_addColorDropdown) return;
        if (_addColorDropdown.classList.contains('open')) {
            _closeAddColorDropdown();
            return;
        }
        _closeReplaceDropdown();
        if (!await _ensureThreadsLoaded()) return;
        _addColorDropdown.classList.add('open');
        if (_addColorSearch) { _addColorSearch.value = ''; _addColorSearch.focus(); }
        _filterAddColorList();
    }

    function _closeAddColorDropdown() {
        if (_addColorDropdown) _addColorDropdown.classList.remove('open');
    }

    function _filterAddColorList() {
        _renderThreadList(_addColorList, _addColorSearch);
    }

    function _addDmcColor(number) {
        if (!_ensureColorInPalette(number)) return;
        renderLegend();
        _setActiveColor(number);
        _closeAddColorDropdown();
        _markDirty();
    }

    /* ═══════════════════════════════════════════
       Color Replace
       ═══════════════════════════════════════════ */

    async function _populateReplaceTarget() {
        if (!await _ensureThreadsLoaded()) return;
        // Reset selection
        _replaceTargetDmc = null;
        if (_replaceTargetSw) _replaceTargetSw.style.background = '#444';
        if (_replaceTargetLabel) _replaceTargetLabel.textContent = 'Pick color\u2026';
        if (_replaceTargetSearch) _replaceTargetSearch.value = '';
        _filterReplaceTargets();
    }

    function _filterReplaceTargets() {
        _renderThreadList(_replaceTargetList, _replaceTargetSearch, { excludeDmc: activeDmc, selectedDmc: _replaceTargetDmc });
    }

    function _selectReplaceTarget(dmc) {
        _replaceTargetDmc = dmc;
        const thread = allDmcThreads ? allDmcThreads.find(t => String(t.number) === dmc) : null;
        if (_replaceTargetSw) _replaceTargetSw.style.background = thread ? (thread.hex_color || '#888') : '#444';
        if (_replaceTargetLabel) _replaceTargetLabel.textContent = thread ? (_brand + ' ' + dmc) : dmc;
        _closeReplaceDropdown();
    }

    function _toggleReplaceDropdown() {
        if (!_replaceTargetDropdown) return;
        const isOpen = _replaceTargetDropdown.classList.contains('open');
        if (isOpen) {
            _closeReplaceDropdown();
        } else {
            _closeAddColorDropdown();
            _replaceTargetDropdown.classList.add('open');
            if (_replaceTargetSearch) { _replaceTargetSearch.value = ''; _replaceTargetSearch.focus(); }
            _filterReplaceTargets();
        }
    }

    function _closeReplaceDropdown() {
        if (_replaceTargetDropdown) _replaceTargetDropdown.classList.remove('open');
    }

    function _doColorReplace() {
        if (!activeDmc || !_replaceTargetDmc) return;
        if (_replaceTargetDmc === activeDmc) return;

        const pd = getPatternData();
        const targetDmc = _replaceTargetDmc;

        pushUndo();

        // Ensure target color is in the palette
        if (!_ensureColorInPalette(targetDmc)) return;
        for (let i = 0; i < pd.grid.length; i++) {
            if (String(pd.grid[i]) === activeDmc) pd.grid[i] = targetDmc;
        }
        if (pd.part_stitches) {
            for (const ps of pd.part_stitches) {
                if (String(ps.dmc) === activeDmc) ps.dmc = targetDmc;
            }
        }
        if (pd.backstitches) {
            for (const bs of pd.backstitches) {
                if (String(bs.dmc) === activeDmc) bs.dmc = targetDmc;
            }
        }
        if (pd.knots) {
            for (const k of pd.knots) {
                if (String(k.dmc) === activeDmc) k.dmc = targetDmc;
            }
        }
        if (pd.beads) {
            for (const b of pd.beads) {
                if (String(b.dmc) === activeDmc) b.dmc = targetDmc;
            }
        }
        _setActiveColor(targetDmc);
        _commitEdit();
        _replaceTargetDmc = null;
        if (_replaceTargetSw) _replaceTargetSw.style.background = '#444';
        if (_replaceTargetLabel) _replaceTargetLabel.textContent = 'Pick color\u2026';
    }

    /* ═══════════════════════════════════════════
       Input Dispatchers
       ═══════════════════════════════════════════ */

    function _handleToolMouseDown(e) {
        if (activeTool === 'pan') return; // page handles pan drag
        const stitch = eventToStitch(e);
        if (!stitch) return;
        const { col, row } = stitch;
        const pd = getPatternData();

        switch (activeTool) {
            case 'pencil':
                pushUndo();
                _painting = true;
                _lastPaintCell = `${col},${row}`;
                for (const bc of _getBrushCells(col, row)) _withMirror(bc.col, bc.row, pencilAt);
                break;
            case 'eraser':
                pushUndo();
                _painting = true;
                _lastPaintCell = `${col},${row}`;
                for (const bc of _getBrushCells(col, row)) _withMirror(bc.col, bc.row, eraserAt);
                break;
            case 'auto-outline':
                _outlineRegionAt(col, row);
                break;
            case 'fill':
                if (_mirrorMode === 'off') {
                    floodFill(col, row);
                } else {
                    pushUndo();
                    _floodFillNoUndo(col, row);
                    if (_mirrorMode === 'horizontal' || _mirrorMode === 'both')
                        _floodFillNoUndo(pd.grid_w - 1 - col, row);
                    if (_mirrorMode === 'vertical' || _mirrorMode === 'both')
                        _floodFillNoUndo(col, pd.grid_h - 1 - row);
                    if (_mirrorMode === 'both')
                        _floodFillNoUndo(pd.grid_w - 1 - col, pd.grid_h - 1 - row);
                    _commitEdit();
                }
                break;
            case 'eyedropper': {
                const dmc = pd.grid[row * pd.grid_w + col];
                if (dmc !== 'BG' && getLookup()[dmc]) {
                    _setActiveColor(dmc);
                    _setTool('pencil');
                }
                break;
            }
            case 'line':
                if (!lineStart) {
                    lineStart = { col, row };
                } else {
                    pushUndo();
                    const cells = bresenhamLine(lineStart.col, lineStart.row, col, row);
                    for (const c of cells) _withMirror(c.col, c.row, pencilAt);
                    lineStart = null;
                    _lineEnd = null;
                    _commitEdit();
                    _redrawOverlay();
                }
                break;
            case 'rect':
                _rectStart = { col, row };
                break;
            case 'ellipse':
                _ellipseStart = { col, row };
                break;
            case 'text':
                _showTextPanel(col, row);
                break;
            case 'replace': {
                const rdmc = pd.grid[row * pd.grid_w + col];
                if (rdmc !== 'BG' && getLookup()[rdmc]) {
                    _setActiveColor(rdmc);
                    _populateReplaceTarget();
                }
                break;
            }
            case 'stitch': {
                const gc = _getGridCoords(e);
                if (!gc) break;
                switch (activeStitchMode) {
                    case 'half': {
                        pushUndo();
                        for (const bc of _getBrushCells(col, row)) {
                            for (const p of _mirrorCellPositions(bc.col, bc.row)) {
                                const d = p.axis ? _mirrorHalfDir(_halfDir, p.axis) : _halfDir;
                                _placePartStitch(p.col, p.row, 'half', { direction: d });
                            }
                        }
                        _commitEdit();
                        break;
                    }
                    case 'quarter':
                    case 'petite': {
                        const q = _cellQuadrant(gc.gx, gc.gy);
                        if (q.col >= 0 && q.col < pd.grid_w && q.row >= 0 && q.row < pd.grid_h) {
                            pushUndo();
                            for (const bc of _getBrushCells(q.col, q.row)) {
                                for (const p of _mirrorCellPositions(bc.col, bc.row)) {
                                    const c = p.axis ? _mirrorCorner(q.corner, p.axis) : q.corner;
                                    _placePartStitch(p.col, p.row, activeStitchMode, { corner: c });
                                }
                            }
                            _commitEdit();
                        }
                        break;
                    }
                    case 'three_quarter': {
                        const tq = _cellQuadrant(gc.gx, gc.gy);
                        if (tq.col >= 0 && tq.col < pd.grid_w && tq.row >= 0 && tq.row < pd.grid_h) {
                            pushUndo();
                            for (const bc of _getBrushCells(tq.col, tq.row)) {
                                for (const p of _mirrorCellPositions(bc.col, bc.row)) {
                                    const mc = p.axis ? _mirrorCorner(tq.corner, p.axis) : tq.corner;
                                    const hd = p.axis ? _mirrorHalfDir(_halfDir, p.axis) : _halfDir;
                                    _placePartStitch(p.col, p.row, 'three_quarter', { halfDir: hd, shortCorner: mc });
                                }
                            }
                            _commitEdit();
                        }
                        break;
                    }
                    case 'backstitch': {
                        const inter = _nearestIntersection(gc.gx, gc.gy);
                        if (!_bsStart) {
                            _bsStart = inter;
                            _redrawOverlay();
                        } else {
                            if (inter.ix !== _bsStart.ix || inter.iy !== _bsStart.iy) {
                                pushUndo();
                                for (const p of _mirrorIntersectionPositions(0, 0)) {
                                    const dx = p.axis ? (p.axis === 'h' || p.axis === 'b' ? -1 : 1) : 1;
                                    const dy = p.axis ? (p.axis === 'v' || p.axis === 'b' ? -1 : 1) : 1;
                                    const ox = p.axis ? (p.axis === 'h' || p.axis === 'b' ? pd.grid_w : 0) : 0;
                                    const oy = p.axis ? (p.axis === 'v' || p.axis === 'b' ? pd.grid_h : 0) : 0;
                                    _placeBackstitch(
                                        ox + dx * _bsStart.ix, oy + dy * _bsStart.iy,
                                        ox + dx * inter.ix, oy + dy * inter.iy
                                    );
                                }
                                _commitEdit();
                            }
                            _bsStart = null;
                            _bsPreviewEnd = null;
                            _redrawOverlay();
                        }
                        break;
                    }
                    case 'knot': {
                        const ki = _nearestIntersection(gc.gx, gc.gy);
                        pushUndo();
                        for (const p of _mirrorIntersectionPositions(ki.ix, ki.iy)) {
                            _placeKnot(p.ix, p.iy);
                        }
                        _commitEdit();
                        break;
                    }
                    case 'bead': {
                        pushUndo();
                        for (const bc of _getBrushCells(col, row)) {
                            for (const p of _mirrorCellPositions(bc.col, bc.row)) {
                                _placeBead(p.col, p.row);
                            }
                        }
                        _commitEdit();
                        break;
                    }
                }
                break;
            }
            case 'select':
                if (_selRect && _isInsideSelection(col, row)) {
                    // Start moving selection
                    _selMoving = true;
                    _selMoveOrigin = { col, row };
                    if (!_selBuffer) {
                        _captureSelectionBuffer();
                    }
                } else {
                    // Commit any pending move, start new selection
                    _commitMovedSelection();
                    _selStart = { col, row };
                    _selDragging = true;
                    _selRect = null;
                    _selBuffer = null;
                    _selOffset = { dc: 0, dr: 0 };
                    _stopMarchingAnts();
                }
                break;
        }
    }

    function _handleToolMouseMove(e) {
        const hoverStitch = eventToStitch(e);
        const prevHover = _hoverCell;
        _hoverCell = hoverStitch;

        // Eyedropper tooltip
        if (activeTool === 'eyedropper') _showEyedropTip(e, hoverStitch);
        else _hideEyedropTip();

        // Pan tool — no editor overlay interaction
        if (activeTool === 'pan') {
            _hoverCell = null;
            _hoverIntersection = null;
            return;
        }

        // Stitch tool — backstitch preview + intersection hover
        if (activeTool === 'stitch') {
            const gc = _getGridCoords(e);
            if (gc && (activeStitchMode === 'backstitch' || activeStitchMode === 'knot')) {
                _hoverIntersection = _nearestIntersection(gc.gx, gc.gy);
                if (activeStitchMode === 'backstitch' && _bsStart) {
                    _bsPreviewEnd = _hoverIntersection;
                }
            } else {
                _hoverIntersection = null;
            }
            if (_cellKey(prevHover) !== _cellKey(_hoverCell) || _hoverIntersection) _redrawOverlay();
            return;
        }

        _hoverIntersection = null;

        // Line preview
        if (activeTool === 'line' && lineStart) {
            if (hoverStitch) _lineEnd = hoverStitch;
            _redrawOverlay();
            return;
        }

        // Rectangle preview
        // Rect/ellipse preview
        const _shapeStart = activeTool === 'rect' ? _rectStart : activeTool === 'ellipse' ? _ellipseStart : null;
        if (_shapeStart) {
            if (hoverStitch) {
                const preview = { c1: _shapeStart.col, r1: _shapeStart.row, c2: hoverStitch.col, r2: hoverStitch.row, outline: e.shiftKey };
                if (activeTool === 'rect') _rectPreview = preview; else _ellipsePreview = preview;
            }
            _redrawOverlay();
            return;
        }

        // Selection drag / move
        if (activeTool === 'select') {
            if (_selDragging && hoverStitch) {
                _selRect = {
                    c1: Math.min(_selStart.col, hoverStitch.col),
                    r1: Math.min(_selStart.row, hoverStitch.row),
                    c2: Math.max(_selStart.col, hoverStitch.col),
                    r2: Math.max(_selStart.row, hoverStitch.row),
                };
                _redrawOverlay();
                return;
            }
            if (_selMoving && hoverStitch && _selMoveOrigin) {
                _selOffset = {
                    dc: hoverStitch.col - _selMoveOrigin.col,
                    dr: hoverStitch.row - _selMoveOrigin.row,
                };
                _redrawOverlay();
                return;
            }
        }

        // Painting (pencil / eraser drag)
        if (!_painting) {
            if (_cellKey(prevHover) !== _cellKey(_hoverCell)) _redrawOverlay();
            return;
        }
        const stitch = hoverStitch;
        if (!stitch) return;
        const key = `${stitch.col},${stitch.row}`;
        if (key === _lastPaintCell) return;
        _lastPaintCell = key;
        if (activeTool === 'pencil') {
            for (const bc of _getBrushCells(stitch.col, stitch.row)) _withMirror(bc.col, bc.row, pencilAt);
        } else if (activeTool === 'eraser') {
            for (const bc of _getBrushCells(stitch.col, stitch.row)) _withMirror(bc.col, bc.row, eraserAt);
        }
        _redrawOverlay();
    }

    function _handleToolMouseUp() {
        // Rectangle / Ellipse commit
        const _shapeCommit = activeTool === 'rect' ? { start: _rectStart, preview: _rectPreview, getCells: _getRectCells }
                           : activeTool === 'ellipse' ? { start: _ellipseStart, preview: _ellipsePreview, getCells: _getEllipseCells }
                           : null;
        if (_shapeCommit && _shapeCommit.start && _shapeCommit.preview) {
            pushUndo();
            const p = _shapeCommit.preview;
            const cells = _shapeCommit.getCells(p.c1, p.r1, p.c2, p.r2, !p.outline);
            for (const c of cells) _withMirror(c.col, c.row, pencilAt);
            _rectStart = null; _rectPreview = null;
            _ellipseStart = null; _ellipsePreview = null;
            _commitEdit();
            _redrawOverlay();
            return;
        }

        // Selection drag end
        if (activeTool === 'select') {
            if (_selDragging) {
                _selDragging = false;
                if (_selRect && (_selRect.c1 !== _selRect.c2 || _selRect.r1 !== _selRect.r2)) {
                    _startMarchingAnts();
                } else {
                    _selRect = null;
                }
                _redrawOverlay();
            }
            if (_selMoving) {
                _selMoving = false;
            }
            return;
        }

        // Paint end
        if (_painting) {
            _painting = false;
            _lastPaintCell = null;
            _commitEdit();
        }
    }

    /* ═══════════════════════════════════════════
       Public API
       ═══════════════════════════════════════════ */

    function activate() {
        _active = true;
        container.classList.add('edit-mode');
        if (_toolbar) _toolbar.style.display = '';
        const pd = getPatternData();
        if (!activeDmc && pd.legend.length > 0) _setActiveColor(pd.legend[0].dmc);
        document.querySelectorAll('.leg-check').forEach(el => el.style.display = 'none');
        _updateActiveIndicator();
        _updateMirrorButton();
        _setTool(activeTool);
    }

    function deactivate() {
        _active = false;
        spaceHeld = false;
        container.classList.remove('edit-mode', 'tool-eraser', 'tool-eyedropper', 'tool-pan', 'tool-select', 'space-pan');
        if (_toolbar) _toolbar.style.display = 'none';
        if (_replacePanel) _replacePanel.style.display = 'none';
        _closeAddColorDropdown();
        _closeReplaceDropdown();
        document.querySelectorAll('.legend-row.active, .key-row.active').forEach(r => r.classList.remove('active'));
        document.querySelectorAll('.leg-check').forEach(el => el.style.display = '');
        lineStart = null;
        _lineEnd = null;
        _painting = false;
        _rectStart = null;
        _rectPreview = null;
        _ellipseStart = null;
        _ellipsePreview = null;
        _bsStart = null;
        _bsPreviewEnd = null;
        _hoverIntersection = null;
        _hideTextPanel();
        _hideEyedropTip();
        if (_rcModal) { _rcBackdrop?.remove(); _rcModal.remove(); _rcBackdrop = null; _rcModal = null; }
        if (_resizeModal) { _resizeBackdrop?.remove(); _resizeModal.remove(); _resizeBackdrop = null; _resizeModal = null; }
        _mirrorMode = 'off';
        _hoverCell = null;
        _selRect = null; _selBuffer = null; _selOffset = { dc: 0, dr: 0 };
        _selDragging = false; _selMoving = false;
        _stopMarchingAnts();
        _redrawOverlay();
    }

    function handleMouseDown(e) { _handleToolMouseDown(e); }
    function handleMouseMove(e) { _handleToolMouseMove(e); }
    function handleMouseUp()    { _handleToolMouseUp(); }

    /** @returns {boolean} true if the editor consumed the event */
    function handleKeyDown(e) {
        // Don't intercept keystrokes when typing in any input/textarea outside the editor toolbar
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && (!_toolbar || !_toolbar.contains(ae))) {
            if (activeTool === 'text' && _textInput && _textInput === ae) return true;
            return false;
        }
        if (_resizeModal && _resizeModal.contains(ae)) return false;
        if (_rcModal && _rcModal.contains(ae)) return false;
        if (e.key === 'Escape') {
            if (_addColorDropdown && _addColorDropdown.classList.contains('open')) {
                _closeAddColorDropdown();
                return true;
            }
            if (_replaceTargetDropdown && _replaceTargetDropdown.classList.contains('open')) {
                _closeReplaceDropdown();
                return true;
            }
            if (lineStart) {
                lineStart = null; _lineEnd = null;
                _redrawOverlay();
                return true;
            }
            if (_rectStart) {
                _rectStart = null; _rectPreview = null;
                _redrawOverlay();
                return true;
            }
            if (_ellipseStart) {
                _ellipseStart = null; _ellipsePreview = null;
                _redrawOverlay();
                return true;
            }
            if (_bsStart) {
                _bsStart = null; _bsPreviewEnd = null;
                _redrawOverlay();
                return true;
            }
            if (activeTool === 'select' && _selRect) {
                _commitMovedSelection();
                _selRect = null; _selBuffer = null;
                _selOffset = { dc: 0, dr: 0 };
                _stopMarchingAnts();
                _redrawOverlay();
                return true;
            }
        }
        // Selection keyboard shortcuts
        if (activeTool === 'select' && _selRect) {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                pushUndo();
                _clearSelectionSource();
                _selRect = null; _selBuffer = null;
                _selOffset = { dc: 0, dr: 0 };
                _stopMarchingAnts();
                _commitEdit();
                _redrawOverlay();
                return true;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                e.preventDefault();
                _captureSelectionBuffer();
                return true;
            }
            // Rotate / flip selection (R/H/V intercepted before tool-switch shortcuts)
            const sk = e.key.toLowerCase();
            if (sk === 'r') { e.preventDefault(); _rotateBufferCW(); return true; }
            if (sk === 'h') { e.preventDefault(); _flipBufferH(); return true; }
            if (sk === 'v') { e.preventDefault(); _flipBufferV(); return true; }
            if ((e.ctrlKey || e.metaKey) && e.key === 'v' && _selBuffer) {
                e.preventDefault();
                pushUndo();
                // Paste buffer at current selection position
                const pd = getPatternData();
                const dc = _selOffset.dc, dr = _selOffset.dr;
                for (let r = 0; r < _selBuffer.h; r++) {
                    for (let c = 0; c < _selBuffer.w; c++) {
                        const destR = _selRect.r1 + dr + r, destC = _selRect.c1 + dc + c;
                        if (destR >= 0 && destR < pd.grid_h && destC >= 0 && destC < pd.grid_w) {
                            const val = _selBuffer.data[r * _selBuffer.w + c];
                            if (val !== 'BG') pd.grid[destR * pd.grid_w + destC] = val;
                        }
                    }
                }
                _commitEdit();
                return true;
            }
        }
        if (e.key === ' ') {
            e.preventDefault();
            spaceHeld = true;
            container.classList.add('space-pan');
            return true;
        }
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') { e.preventDefault(); undo(); return true; }
            if (e.key === 'y') { e.preventDefault(); redo(); return true; }
            if (e.key === 's' && onSave) { e.preventDefault(); onSave(); return true; }
            if (e.shiftKey && e.key.toUpperCase() === 'R') { e.preventDefault(); _showResizeModal(); return true; }
            if (e.shiftKey && e.key.toUpperCase() === 'I') { e.preventDefault(); _showRowColModal(); return true; }
            if (e.shiftKey && e.key.toUpperCase() === 'O') { e.preventDefault(); _setTool('auto-outline'); return true; }
            return false;
        }
        const k = e.key.toLowerCase();
        if (k === 'p') { _setTool('pencil');     return true; }
        if (k === 'e') { _setTool('eraser');      return true; }
        if (k === 'f') { _setTool('fill');        return true; }
        if (k === 'i') { _setTool('eyedropper');  return true; }
        if (k === 'l') { _setTool('line');        return true; }
        if (k === 't') { _setTool('rect');        return true; }
        if (k === 'o') { _setTool('ellipse');    return true; }
        if (k === 'x') { _setTool('text');       return true; }
        if (k === 'r') { _setTool('replace');     return true; }
        if (k === 's') { _setTool('select');      return true; }
        if (k === 'h') { _setTool('pan');         return true; }
        if (k === 'w') { _setTool('pencil');        return true; }
        if (k === 'm') { _cycleMirror();          return true; }
        if (e.key === '[') { _cycleBrushSize(-1); return true; }
        if (e.key === ']') { _cycleBrushSize(1);  return true; }
        // Stitch type shortcuts (1-5) — always available
        const _stitchKeys = ['stitch-half', 'stitch-quarter', 'stitch-threequarter', 'stitch-petite', 'stitch-back', 'stitch-knot', 'stitch-bead'];
        const _skIdx = parseInt(e.key) - 1;
        if (_skIdx >= 0 && _skIdx < _stitchKeys.length) { _setTool(_stitchKeys[_skIdx]); return true; }
        if (e.key === '`') { _toggleHalfDir(); return true; }
        return false;
    }

    function handleKeyUp(e) {
        if (e.key === ' ') {
            spaceHeld = false;
            container.classList.remove('space-pan');
        }
    }

    function reset() {
        undoStack = [];
        redoStack = [];
        editorDirty = false;
        lineStart = null;
        _lineEnd = null;
        _painting = false;
        _lastPaintCell = null;
        activeDmc = null;
        activeHex = '#888888';
        activeTool = 'pan';
        _rectStart = null;
        _rectPreview = null;
        _ellipseStart = null;
        _ellipsePreview = null;
        _bsStart = null;
        _bsPreviewEnd = null;
        _hoverIntersection = null;
        activeStitchMode = 'half';
        _halfDir = 'fwd';
        _hideTextPanel();
        _mirrorMode = 'off';
        _brushSize = 1;
        _hoverCell = null;
        _selRect = null; _selBuffer = null; _selOffset = { dc: 0, dr: 0 };
        _selDragging = false; _selMoving = false;
        _stopMarchingAnts();
        if (_undoBtn) _undoBtn.disabled = true;
        if (_redoBtn) _redoBtn.disabled = true;
        _updateActiveIndicator();
        _updateMirrorButton();
        _updateBrushButtons();
    }

    /* ═══════════════════════════════════════════
       UI Injection
       ═══════════════════════════════════════════ */

    function injectUI() {
        if (_uiInjected) return;
        _uiInjected = true;

        // CSS
        _styleEl = document.createElement('style');
        _styleEl.id = 'editor-styles';
        _styleEl.textContent = EDITOR_CSS;
        document.head.appendChild(_styleEl);

        // Toolbar
        _toolbar = document.createElement('div');
        _toolbar.className = 'editor-toolbar';
        _toolbar.style.display = 'none';
        _toolbar.innerHTML = `
            <div class="toolbar-row">
                <button class="tool-btn active" data-tool="pan" title="Pan / Hand (H)"><i class="ti ti-hand-grab"></i><span class="tool-lbl">Pan</span></button>
                <div class="tool-sep"></div>
                <div class="tool-group">
                    <button class="tool-btn" data-tool="pencil" title="Full Stitch (P)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><line x1="4" y1="20" x2="20" y2="4"/><line x1="4" y1="4" x2="20" y2="20"/></svg><span class="tool-lbl">Full</span></button>
                    <button class="tool-btn" data-tool="stitch-half" title="Half Stitch (1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><line x1="4" y1="20" x2="20" y2="4"/></svg><span class="tool-lbl">Half</span></button>
                    <button class="tool-btn" data-tool="stitch-quarter" title="Quarter Stitch (2)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><line x1="4" y1="20" x2="12" y2="12"/></svg><span class="tool-lbl">Qtr</span></button>
                    <button class="tool-btn" data-tool="stitch-threequarter" title="Three-Quarter Stitch (3)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><line x1="4" y1="4" x2="20" y2="20"/><line x1="4" y1="20" x2="12" y2="12"/></svg><span class="tool-lbl">3/4</span></button>
                    <button class="tool-btn" data-tool="stitch-petite" title="Petite Stitch (4)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><line x1="4" y1="4" x2="10" y2="10"/><line x1="10" y1="4" x2="4" y2="10"/></svg><span class="tool-lbl">Petite</span></button>
                    <button class="tool-btn" data-tool="stitch-back" title="Backstitch (5)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><line x1="3" y1="18" x2="21" y2="6"/><circle cx="3" cy="18" r="2" fill="currentColor"/><circle cx="21" cy="6" r="2" fill="currentColor"/></svg><span class="tool-lbl">Back</span></button>
                    <button class="tool-btn" data-tool="stitch-knot" title="French Knot (6)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 8 C14 6, 16 8, 14 10" stroke="currentColor" stroke-width="1.5" fill="none"/></svg><span class="tool-lbl">Knot</span></button>
                    <button class="tool-btn" data-tool="stitch-bead" title="Bead (7)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><ellipse cx="12" cy="12" rx="4" ry="6" fill="currentColor"/></svg><span class="tool-lbl">Bead</span></button>
                    <button class="tool-btn stitch-dir-toggle" title="Toggle direction (\`)" style="display:none"><span style="font-size:16px">/</span><span class="tool-lbl">Dir</span></button>
                </div>
                <div class="tool-sep"></div>
                <div class="tool-group">
                    <button class="tool-btn" data-tool="line" title="Line (L)"><i class="ti ti-line"></i><span class="tool-lbl">Line</span></button>
                    <button class="tool-btn" data-tool="rect" title="Rectangle (T)"><i class="ti ti-rectangle"></i><span class="tool-lbl">Rect</span></button>
                    <button class="tool-btn" data-tool="ellipse" title="Ellipse (O)"><i class="ti ti-circle"></i><span class="tool-lbl">Oval</span></button>
                    <button class="tool-btn" data-tool="fill" title="Flood Fill (F)"><i class="ti ti-paint-filled"></i><span class="tool-lbl">Fill</span></button>
                </div>
                <div class="tool-sep"></div>
                <div class="tool-group">
                    <button class="tool-btn" data-tool="eraser" title="Eraser (E)"><i class="ti ti-eraser"></i><span class="tool-lbl">Erase</span></button>
                    <button class="tool-btn" data-tool="eyedropper" title="Eyedropper (I)"><i class="ti ti-color-picker"></i><span class="tool-lbl">Pick</span></button>
                    <button class="tool-btn" data-tool="text" title="Text (X)"><i class="ti ti-typography"></i><span class="tool-lbl">Text</span></button>
                    <button class="tool-btn" data-tool="replace" title="Color Replace (R)"><i class="ti ti-replace"></i><span class="tool-lbl">Swap</span></button>
                    <button class="tool-btn" data-tool="select" title="Selection (S)"><i class="ti ti-marquee-2"></i><span class="tool-lbl">Select</span></button>
                </div>
            </div>
            <div class="toolbar-row">
                <div class="active-color-ind">
                    <div class="active-sw ed-active-swatch"></div>
                    <span class="active-lbl ed-active-label">No color</span>
                </div>
                <div class="add-color-wrapper">
                    <button class="tool-btn ed-add-color-btn" title="Add ${_brand} Color (+)"><i class="ti ti-plus"></i><span class="tool-lbl">Add</span></button>
                    <div class="add-color-dropdown">
                        <input type="text" class="replace-target-search" placeholder="Search ${_brand} #/name…">
                        <div class="replace-target-list"></div>
                    </div>
                </div>
                <div class="tool-sep"></div>
                <div class="brush-size-group">
                    <span class="brush-lbl">Brush</span>
                    <button class="brush-pill active" data-brush="1" title="Brush 1×1 ([ / ])">1</button>
                    <button class="brush-pill" data-brush="2" title="Brush 2×2 ([ / ])">2</button>
                    <button class="brush-pill" data-brush="3" title="Brush 3×3 ([ / ])">3</button>
                    <button class="brush-pill" data-brush="5" title="Brush 5×5 ([ / ])">5</button>
                    <button class="brush-pill" data-brush="9" title="Brush 9×9 ([ / ])">9</button>
                </div>
                <div class="tool-sep"></div>
                <button class="tool-btn ed-undo-btn" title="Undo (Ctrl+Z)" disabled><i class="ti ti-arrow-back-up"></i><span class="tool-lbl">Undo</span></button>
                <button class="tool-btn ed-redo-btn" title="Redo (Ctrl+Y)" disabled><i class="ti ti-arrow-forward-up"></i><span class="tool-lbl">Redo</span></button>
                <div class="tool-sep"></div>
                <button class="tool-btn ed-mirror-btn" title="Mirror: off (M)"><i class="ti ti-flip-horizontal"></i><span class="tool-lbl">Mirror</span></button>
                <button class="tool-btn ed-resize-btn" title="Resize Canvas (Ctrl+Shift+R)"><i class="ti ti-dimensions"></i><span class="tool-lbl">Resize</span></button>
                <button class="tool-btn ed-rowcol-btn" title="Insert/Delete Row/Column (Ctrl+Shift+I)"><i class="ti ti-row-insert-bottom"></i><span class="tool-lbl">Row/Col</span></button>
                <button class="tool-btn" data-tool="auto-outline" title="Auto Outline (Ctrl+Shift+O)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="5" y="5" width="14" height="14" rx="1" stroke-dasharray="3 2"/></svg><span class="tool-lbl">Outline</span></button>
            </div>
        `;
        container.appendChild(_toolbar);

        // Replace panel
        _replacePanel = document.createElement('div');
        _replacePanel.className = 'replace-panel';
        _replacePanel.style.display = 'none';
        _replacePanel.innerHTML = `
            <span>Replace all</span>
            <div class="active-sw ed-replace-src-swatch"></div>
            <span>&#8594;</span>
            <div class="replace-target-picker">
                <div class="replace-target-trigger">
                    <div class="replace-target-sw"></div>
                    <span class="replace-target-label">Pick color…</span>
                </div>
                <div class="replace-target-dropdown">
                    <input type="text" class="replace-target-search" placeholder="Search ${_brand} #/name…">
                    <div class="replace-target-list"></div>
                </div>
            </div>
            <button class="ed-replace-apply-btn">Apply</button>
        `;
        container.appendChild(_replacePanel);

        // Cache DOM refs
        _dirToggle = _toolbar.querySelector('.stitch-dir-toggle');
        _dirToggle.addEventListener('click', (e) => { e.stopPropagation(); _toggleHalfDir(); });
        const _addColorWrapper = _toolbar.querySelector('.add-color-wrapper');
        _undoBtn         = _toolbar.querySelector('.ed-undo-btn');
        _redoBtn         = _toolbar.querySelector('.ed-redo-btn');
        _activeSwatch    = _toolbar.querySelector('.ed-active-swatch');
        _activeLabel     = _toolbar.querySelector('.ed-active-label');
        _replaceSrcSwatch    = _replacePanel.querySelector('.ed-replace-src-swatch');
        _replaceTargetPicker   = _replacePanel.querySelector('.replace-target-picker');
        _replaceTargetTrigger  = _replacePanel.querySelector('.replace-target-trigger');
        _replaceTargetDropdown = _replacePanel.querySelector('.replace-target-dropdown');
        _replaceTargetSearch   = _replacePanel.querySelector('.replace-target-search');
        _replaceTargetList     = _replacePanel.querySelector('.replace-target-list');
        _replaceTargetSw       = _replacePanel.querySelector('.replace-target-sw');
        _replaceTargetLabel    = _replacePanel.querySelector('.replace-target-label');
        _addColorDropdown  = _addColorWrapper.querySelector('.add-color-dropdown');
        _addColorSearch    = _addColorWrapper.querySelector('.replace-target-search');
        _addColorList      = _addColorWrapper.querySelector('.replace-target-list');

        // Event listeners — toolbar
        _toolbar.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => _setTool(btn.dataset.tool));
        });
        _undoBtn.addEventListener('click', undo);
        _redoBtn.addEventListener('click', redo);
        _toolbar.querySelector('.ed-add-color-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            _toggleAddColorDropdown();
        });
        _toolbar.querySelector('.ed-mirror-btn').addEventListener('click', _cycleMirror);
        _toolbar.querySelector('.ed-resize-btn').addEventListener('click', _showResizeModal);
        _toolbar.querySelector('.ed-rowcol-btn').addEventListener('click', _showRowColModal);

        // Brush size pills
        _brushBtns = _toolbar.querySelectorAll('.brush-pill[data-brush]');
        _brushBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                _setBrushSize(parseInt(btn.dataset.brush));
            });
        });

        // Event listeners — replace panel
        _replacePanel.querySelector('.ed-replace-apply-btn').addEventListener('click', _doColorReplace);
        _replaceTargetTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            _toggleReplaceDropdown();
        });
        _replaceTargetSearch.addEventListener('input', _debounce(_filterReplaceTargets, 150));
        _replaceTargetSearch.addEventListener('click', (e) => e.stopPropagation());
        _replaceTargetList.addEventListener('click', (e) => {
            const row = e.target.closest('.replace-target-row');
            if (row) _selectReplaceTarget(row.dataset.dmc);
        });
        _replaceTargetDropdown.addEventListener('click', (e) => e.stopPropagation());
        _replaceTargetDropdown.addEventListener('wheel', (e) => e.stopPropagation());

        // Event listeners — add color dropdown
        _addColorSearch.addEventListener('input', _debounce(_filterAddColorList, 150));
        _addColorSearch.addEventListener('click', (e) => e.stopPropagation());
        _addColorList.addEventListener('click', (e) => {
            const row = e.target.closest('.replace-target-row');
            if (row) _addDmcColor(row.dataset.dmc);
        });
        _addColorDropdown.addEventListener('click', (e) => e.stopPropagation());
        _addColorDropdown.addEventListener('wheel', (e) => e.stopPropagation());

        // Close dropdowns on outside click
        _outsideClickHandler = () => { _closeReplaceDropdown(); _closeAddColorDropdown(); };
        document.addEventListener('click', _outsideClickHandler);
    }

    function removeUI() {
        if (!_uiInjected) return;
        if (_outsideClickHandler) {
            document.removeEventListener('click', _outsideClickHandler);
            _outsideClickHandler = null;
        }
        if (_styleEl)       _styleEl.remove();
        if (_toolbar)       _toolbar.remove();
        if (_replacePanel)  _replacePanel.remove();
        if (_eyedropTip)    { _eyedropTip.remove(); _eyedropTip = null; }
        if (_textPanel)     { _textPanel.remove(); _textPanel = null; _textInput = null; }
        _uiInjected = false;
        _toolbar = _replacePanel = null;
        _dirToggle = null;
        _brushBtns = null;
        _undoBtn = _redoBtn = _activeSwatch = _activeLabel = null;
        _replaceSrcSwatch = null;
        _replaceTargetPicker = _replaceTargetTrigger = _replaceTargetDropdown = null;
        _replaceTargetSearch = _replaceTargetList = _replaceTargetSw = _replaceTargetLabel = null;
        _replaceTargetDmc = null;
        _addColorDropdown = _addColorSearch = _addColorList = null;
        _styleEl = null;
    }

    /* ═══════════════════════════════════════════
       Return public interface
       ═══════════════════════════════════════════ */

    function handleMouseLeave() {
        _hoverCell = null;
        _hideEyedropTip();
        _redrawOverlay();
    }

    function startReplace(dmc) {
        _setActiveColor(dmc);
        _setTool('replace');
    }

    return {
        activate,
        deactivate,
        isActive:          () => _active,
        isSpaceHeld:       () => spaceHeld,
        wantsPan:          () => spaceHeld || activeTool === 'pan',
        isPainting:        () => _painting,
        isLinePreviewing:  () => activeTool === 'line' && lineStart !== null,
        isDirty:           () => editorDirty,
        clearDirty()       { editorDirty = false; if (onClean) onClean(); },
        reset,
        handleMouseDown,
        handleMouseMove,
        handleMouseUp,
        handleMouseLeave,
        handleKeyDown,
        handleKeyUp,
        setTool:           _setTool,
        setActiveColor:    _setActiveColor,
        undo,
        redo,
        getActiveDmc:      () => activeDmc,
        getMirrorMode:     () => _mirrorMode,
        getBrushSize:      () => _brushSize,
        setBrushSize:      _setBrushSize,
        startReplace,
        setBrand(b) { _brand = b; allDmcThreads = null; },
        injectUI,
        removeUI,
        isUIElement:       (el) => !!el.closest('.editor-toolbar,.ed-replace-panel,.ed-add-color-modal,.ed-resize-modal,.ed-resize-backdrop,.ed-text-panel,.stitch-mode-bar,.zoom-controls'),
    };
}
