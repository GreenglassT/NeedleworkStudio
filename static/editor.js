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
    let _crosshairMode = _pref('dmc-ed-crosshair', '0') === '1';  // row/column crosshair highlighting
    let _hoverCell     = null;   // { col, row } or null
    let _shapeStart    = null;   // { col, row } shape drag start
    let _shapePreview  = null;   // { c1, r1, c2, r2, outline } or null
    let _shapeMode     = 'rect'; // 'rect' | 'ellipse' | 'triangle' | 'diamond' | 'star'
    let _shapeBar      = null;   // floating shape sub-bar DOM element
    let _fillPreviewRegion = null;   // Set<number> of grid indices, or null
    let _fillPreviewCell   = null;   // { col, row } that generated the cached region
    function _clearFillPreview() { _fillPreviewRegion = null; _fillPreviewCell = null; }

    /* Confetti cleanup state */
    let _confettiThreshold = 3;        // cluster size threshold (1-10)
    let _confettiScope     = 'all';    // 'all' or 'selection'
    let _confettiMap       = null;     // Map<cellIndex, replacementColor> or null
    let _confettiBar       = null;     // floating options bar DOM element
    let _confettiDebounce  = null;     // debounce timer ID
    function _clearConfetti() {
        _confettiMap = null;
        if (_confettiDebounce) { clearTimeout(_confettiDebounce); _confettiDebounce = null; }
    }

    let _mirrorMode    = _pref('dmc-ed-mirror', 'off');  // 'off' | 'horizontal' | 'vertical' | 'both'

    /* Brush size state */
    const _BRUSH_SIZES = [1, 2, 3, 5, 9];
    let _brushSize = (function() { var v = parseInt(_pref('dmc-ed-brush', 1)); return _BRUSH_SIZES.includes(v) ? v : 1; })();

    /* Selection state */
    let _selStart      = null;
    let _selRect       = null;   // { c1, r1, c2, r2 } normalized
    let _selBuffer     = null;   // { w, h, data, part_stitches, backstitches, knots, beads, isCut }
    let _selOffset     = { dc: 0, dr: 0 };
    let _selDragging   = false;
    let _selMoving     = false;
    let _selMoveOrigin = null;
    let _marchPhase    = 0;
    let _marchRAF      = null;
    let _pasteMode     = false;  // true when floating paste preview is active
    let _pasteLoc      = null;   // { col, row } cursor position for paste placement
    let _selectMode    = 'rect';       // 'rect' or 'wand'
    let _wandMask      = null;         // Set<index> for wand selections, null for rect
    let _selectBar     = null;         // floating selection bar DOM element
    let _selFlipHBtn   = null;         // cached DOM refs for select bar
    let _selFlipVBtn   = null;
    let _selRotateBtn  = null;
    let _selDimsSpan   = null;
    let _lassoPath     = null;         // Array<{gx, gy}> sub-cell polygon vertices
    let _lassoDragging = false;        // true while drawing a lasso path
    let _eyedropTip    = null;

    /* Stitch tool state */
    let activeStitchMode = 'full';   // 'full'|'half'|'quarter'|'three_quarter'|'petite'|'backstitch'|'knot'|'bead'
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
    let _fabricSwatch = null, _fabricDropdown = null, _fabricCustom = null;

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
.palette-group{display:flex;align-items:stretch;gap:1px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r);padding:2px 3px}
.palette-btn{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 6px 3px;cursor:pointer;border-radius:var(--r);border:none;background:transparent;transition:background var(--t);position:relative}
.palette-btn:hover{background:var(--surface)}
.palette-sw{width:24px;height:24px;border-radius:3px;border:1px solid var(--border-2);flex-shrink:0}
.palette-lbl{font-family:'IBM Plex Mono',monospace;font-size:8px;letter-spacing:.02em;line-height:1;color:var(--text-muted);white-space:nowrap;display:flex;align-items:center;gap:1px}
.palette-lbl .ti{font-size:10px}
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
.ed-confetti-bar{position:absolute;left:50%;transform:translateX(-50%);z-index:16;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);padding:6px 12px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:nowrap;font-size:10px;font-family:'IBM Plex Mono',monospace;color:var(--text-muted)}
.ed-confetti-bar label{display:flex;align-items:center;gap:6px}
.ed-confetti-bar input[type=range]{width:80px;accent-color:var(--gold)}
.ed-confetti-bar .confetti-count{color:var(--text);font-weight:600;min-width:40px}
.ed-confetti-bar button{padding:4px 10px;border:1px solid var(--border-2);border-radius:var(--r);cursor:pointer;font-size:10px;font-family:inherit}
.ed-confetti-bar .confetti-apply{background:var(--gold);color:#1a1208;border-color:var(--gold)}
.ed-confetti-bar .confetti-cancel{background:var(--surface-2);color:var(--text)}
.confetti-scope{display:flex;gap:2px}
.confetti-scope-btn{padding:3px 8px;border:1px solid var(--border-2);border-radius:var(--r);background:var(--surface-2);color:var(--text-muted);cursor:pointer;font-size:10px;font-family:inherit}
.confetti-scope-btn.active{background:var(--gold);color:#1a1208;border-color:var(--gold)}
.ed-select-bar{position:absolute;left:50%;transform:translateX(-50%);z-index:16;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);padding:6px 12px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:nowrap;font-size:10px;font-family:'IBM Plex Mono',monospace;color:var(--text-muted)}
.ed-select-bar button{padding:4px 10px;border:1px solid var(--border-2);border-radius:var(--r);cursor:pointer;font-size:10px;font-family:inherit;background:var(--surface-2);color:var(--text)}
.ed-select-bar button:disabled{opacity:0.4;cursor:not-allowed}
.ed-select-bar .select-dims{color:var(--text);font-weight:600}
.ed-select-bar .select-dims:empty{display:none}
.ed-shape-bar{position:absolute;left:50%;transform:translateX(-50%);z-index:16;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);padding:4px 8px;display:flex;align-items:center;gap:2px;box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:nowrap;font-size:10px;font-family:'IBM Plex Mono',monospace;color:var(--text-muted)}
.fabric-color-wrapper{position:relative}
.fabric-dropdown{display:none;position:absolute;top:calc(100% + 6px);left:0;background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r);box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:20;padding:8px;font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-muted);min-width:160px}
.fabric-dropdown.open{display:block}
.fabric-preset{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer;transition:background var(--t)}
.fabric-preset:hover{background:var(--surface-2)}
.fabric-preset-sw{width:18px;height:18px;border-radius:3px;border:1px solid var(--border-2);flex-shrink:0}
.fabric-preset.active .fabric-preset-sw{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.fabric-custom{display:flex;align-items:center;gap:8px;padding:4px 6px;margin-top:4px;border-top:1px solid var(--border-2)}
.fabric-custom input[type=color]{width:24px;height:20px;border:1px solid var(--border-2);border-radius:3px;padding:0;cursor:pointer;background:transparent}
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

    /* ═══════════════════════════════════════════
       Confetti Detection
       ═══════════════════════════════════════════ */

    /**
     * Detect confetti stitches — small connected components of same-color cells.
     * @param {string[]} grid - flat array of DMC codes ('BG' for background)
     * @param {number} w - grid width
     * @param {number} h - grid height
     * @param {number} threshold - max component size to flag as confetti (1-10)
     * @param {Object} [bounds] - optional {c1,r1,c2,r2} to restrict to selection
     * @returns {Map<number, string>} map of cellIndex → replacement DMC code
     */
    function _findConfetti(grid, w, h, threshold, bounds) {
        const n = w * h;
        const visited = new Uint8Array(n);       // 0 = unvisited
        const isConfetti = new Uint8Array(n);     // 1 = confetti cell
        const inBounds = bounds
            ? (i) => { const c = i % w, r = (i - c) / w; return c >= bounds.c1 && c <= bounds.c2 && r >= bounds.r1 && r <= bounds.r2; }
            : () => true;
        const components = [];                    // array of arrays of cell indices

        // Pass 1: find connected components via flood-fill, flag small ones as confetti
        const queue = [];
        for (let i = 0; i < n; i++) {
            if (visited[i] || grid[i] === 'BG' || !inBounds(i)) continue;
            const color = grid[i];
            const component = [];
            queue.push(i);
            visited[i] = 1;
            while (queue.length) {
                const ci = queue.pop();
                component.push(ci);
                const cx = ci % w, cy = (ci - cx) / w;
                // 4-neighbor: up, right, down, left
                const neighbors = [];
                if (cy > 0)     neighbors.push(ci - w);
                if (cx < w - 1) neighbors.push(ci + 1);
                if (cy < h - 1) neighbors.push(ci + w);
                if (cx > 0)     neighbors.push(ci - 1);
                for (const ni of neighbors) {
                    if (!visited[ni] && grid[ni] === color && inBounds(ni)) {
                        visited[ni] = 1;
                        queue.push(ni);
                    }
                }
            }
            if (component.length <= threshold) {
                for (const ci of component) isConfetti[ci] = 1;
                components.push(component);
            }
        }

        // Pass 2: compute replacement color for each confetti cell
        const result = new Map();
        for (const component of components) {
            for (const ci of component) {
                const cx = ci % w, cy = (ci - cx) / w;
                // Collect non-BG, non-confetti neighbor colors (clockwise: top, right, bottom, left)
                const neighborIndices = [];
                if (cy > 0)     neighborIndices.push(ci - w);     // top
                if (cx < w - 1) neighborIndices.push(ci + 1);     // right
                if (cy < h - 1) neighborIndices.push(ci + w);     // bottom
                if (cx > 0)     neighborIndices.push(ci - 1);     // left

                const counts = {};
                let firstSeen = {};   // tracks clockwise order for tie-breaking
                let order = 0;
                for (const ni of neighborIndices) {
                    const nc = grid[ni];
                    if (nc === 'BG' || isConfetti[ni]) continue;
                    counts[nc] = (counts[nc] || 0) + 1;
                    if (!(nc in firstSeen)) firstSeen[nc] = order;
                    order++;
                }

                // Find most common; ties broken by earliest clockwise occurrence
                let bestColor = null, bestCount = 0, bestOrder = Infinity;
                for (const c in counts) {
                    if (counts[c] > bestCount || (counts[c] === bestCount && firstSeen[c] < bestOrder)) {
                        bestColor = c;
                        bestCount = counts[c];
                        bestOrder = firstSeen[c];
                    }
                }
                if (bestColor) result.set(ci, bestColor);
            }
        }
        return result;
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
     *
     *  Diagonal mapping: fwd(/) = BL,TR  |  bwd(\) = TL,BR
     *  Cross-type conflict rules:
     *   - Half replaces same-dir half + quarters/petites on same diagonal
     *   - Quarter/petite replaces same-corner quarter/petite + half on same diagonal
     *   - Three-quarter clears all existing part_stitches in the cell
     */
    const _DIAG_CORNERS = { fwd: ['BL', 'TR'], bwd: ['TL', 'BR'] };
    const _CORNER_DIAG  = { TL: 'bwd', TR: 'fwd', BL: 'fwd', BR: 'bwd' };

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
        else if (type === 'three_quarter') {
            // Reject on-diagonal shortCorner (would look identical to a half stitch)
            if (_DIAG_CORNERS[extra.halfDir].includes(extra.shortCorner)) return;
            dir = extra.halfDir + '_' + extra.shortCorner;
        }
        const entry = { x: col, y: row, type, dmc: activeDmc, dir };
        // Remove any existing stitch that conflicts (same cell only)
        pd.part_stitches = pd.part_stitches.filter(s => {
            if (s.x !== col || s.y !== row) return true;
            // Three-quarter clears everything in the cell
            if (type === 'three_quarter') return false;
            if (type === 'half') {
                // Half replaces: same-dir half, quarters/petites on same diagonal
                if (s.type === 'half' && s.dir === dir) return false;
                const diagCorners = _DIAG_CORNERS[dir];
                if ((s.type === 'quarter' || s.type === 'petite') && diagCorners.includes(s.dir)) return false;
                if (s.type === 'three_quarter') return false;
                return true;
            }
            if (type === 'quarter' || type === 'petite') {
                // Quarter/petite replaces: same-corner quarter/petite, half on same diagonal
                if ((s.type === 'quarter' || s.type === 'petite') && s.dir === dir) return false;
                const diag = _CORNER_DIAG[dir];
                if (s.type === 'half' && s.dir === diag) return false;
                if (s.type === 'three_quarter') return false;
                return true;
            }
            return true;
        });
        pd.part_stitches.push(entry);
        // Clear full stitch from grid if part stitch covers significant area
        if (type === 'three_quarter' || type === 'half') {
            const idx = row * pd.grid_w + col;
            if (pd.grid[idx] !== 'BG') pd.grid[idx] = 'BG';
        }
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

    /** Place a stitch using the current activeStitchMode.
     *  Used by pencil, shape, line tools so stitch mode applies uniformly.
     *  For quarter/petite, uses a default corner from _halfDir.
     *  For three_quarter, uses _halfDir + a default short corner.
     *  Backstitch/knot modes fall back to full stitch (intersection-based). */
    function _placeStitchAt(col, row) {
        switch (activeStitchMode) {
            case 'half':
                _placePartStitch(col, row, 'half', { direction: _halfDir });
                break;
            case 'quarter':
            case 'petite':
                _placePartStitch(col, row, activeStitchMode, { corner: _DIAG_CORNERS[_halfDir][0] });
                break;
            case 'three_quarter': {
                const sc = _halfDir === 'fwd' ? 'TL' : 'TR';
                _placePartStitch(col, row, 'three_quarter', { halfDir: _halfDir, shortCorner: sc });
                break;
            }
            case 'bead':
                _placeBead(col, row);
                break;
            default: // 'full', 'backstitch', 'knot'
                pencilAt(col, row);
                break;
        }
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

    /** BFS flood — returns Set of grid indices matching targetColor from startIdx.
     *  Optional limit: stop early once region exceeds this size. */
    function _bfsRegion(grid, grid_w, grid_h, startIdx, targetColor, limit) {
        const region  = new Set();
        const visited = new Uint8Array(grid_w * grid_h);
        const queue   = [startIdx];
        let   head    = 0;
        visited[startIdx] = 1;
        while (head < queue.length) {
            const i = queue[head++];
            region.add(i);
            if (limit && region.size >= limit) return region;
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

    /** Rasterize a lasso polygon to a Set of grid cell indices via ray-casting. */
    function _rasterizeLasso(path, gridW, gridH) {
        const result = new Set();
        const n = path.length;
        if (n < 3) return result;
        let pMinC = Infinity, pMaxC = -Infinity, pMinR = Infinity, pMaxR = -Infinity;
        for (const p of path) {
            if (p.gx < pMinC) pMinC = p.gx; if (p.gx > pMaxC) pMaxC = p.gx;
            if (p.gy < pMinR) pMinR = p.gy; if (p.gy > pMaxR) pMaxR = p.gy;
        }
        const startCol = Math.max(0, Math.floor(pMinC));
        const endCol   = Math.min(gridW - 1, Math.floor(pMaxC));
        const startRow = Math.max(0, Math.floor(pMinR));
        const endRow   = Math.min(gridH - 1, Math.floor(pMaxR));
        for (let row = startRow; row <= endRow; row++) {
            const ty = row + 0.5;
            for (let col = startCol; col <= endCol; col++) {
                const tx = col + 0.5;
                let inside = false;
                for (let i = 0, j = n - 1; i < n; j = i++) {
                    const yi = path[i].gy, yj = path[j].gy;
                    if ((yi > ty) !== (yj > ty)) {
                        if (tx < path[i].gx + (ty - yi) / (yj - yi) * (path[j].gx - path[i].gx))
                            inside = !inside;
                    }
                }
                if (inside) result.add(row * gridW + col);
            }
        }
        return result;
    }

    function _updateSelectBarState() {
        if (!_selectBar) return;
        const hasSelection = !!_selRect;
        _selFlipHBtn.disabled = !hasSelection;
        _selFlipVBtn.disabled = !hasSelection;
        _selRotateBtn.disabled = !hasSelection;
        if (hasSelection) {
            const w = (_selBuffer ? _selBuffer.w : _selRect.c2 - _selRect.c1 + 1);
            const h = (_selBuffer ? _selBuffer.h : _selRect.r2 - _selRect.r1 + 1);
            _selDimsSpan.textContent = w + ' \u00d7 ' + h;
        } else {
            _selDimsSpan.textContent = '';
        }
    }

    function _captureSelectionBuffer(isCut) {
        if (!_selRect) return;
        const pd = getPatternData();
        const { c1, r1, c2, r2 } = _selRect;
        const w = c2 - c1 + 1, h = r2 - r1 + 1;
        // Grid cells — mask non-wand cells to 'BG'
        const data = new Array(w * h);
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++) {
                const gi = (r1 + r) * pd.grid_w + (c1 + c);
                if (_wandMask && !_wandMask.has(gi)) {
                    data[r * w + c] = 'BG';
                } else {
                    data[r * w + c] = pd.grid[gi];
                }
            }
        // Helper: check if a cell-coord stitch is in wand mask
        const _cellInWand = _wandMask
            ? (x, y) => _wandMask.has((r1 + y) * pd.grid_w + (c1 + x))
            : () => true;
        // Helper: check if an intersection-coord stitch is in wand mask (use floor to get containing cell)
        const _intInWand = _wandMask
            ? (x, y) => {
                const cx = Math.min(Math.floor(c1 + x), c2), cy = Math.min(Math.floor(r1 + y), r2);
                return _wandMask.has(cy * pd.grid_w + cx);
            }
            : () => true;
        // Part stitches (cell coords)
        const part_stitches = (pd.part_stitches || [])
            .filter(s => _cellInRect(s.x, s.y, c1, r1, c2, r2) && _cellInWand(s.x - c1, s.y - r1))
            .map(s => ({ x: s.x - c1, y: s.y - r1, type: s.type, dmc: s.dmc, dir: s.dir }));
        // Backstitches (intersection coords) — both ends must be inside and in wand
        const backstitches = (pd.backstitches || [])
            .filter(bs => _intersectionInRect(bs.x1, bs.y1, c1, r1, c2, r2) &&
                          _intersectionInRect(bs.x2, bs.y2, c1, r1, c2, r2) &&
                          _intInWand(bs.x1 - c1, bs.y1 - r1) && _intInWand(bs.x2 - c1, bs.y2 - r1))
            .map(bs => ({ x1: bs.x1 - c1, y1: bs.y1 - r1, x2: bs.x2 - c1, y2: bs.y2 - r1, dmc: bs.dmc }));
        // Knots (intersection coords)
        const knots = (pd.knots || [])
            .filter(k => _intersectionInRect(k.x, k.y, c1, r1, c2, r2) && _intInWand(k.x - c1, k.y - r1))
            .map(k => ({ x: k.x - c1, y: k.y - r1, dmc: k.dmc }));
        // Beads (cell coords)
        const beads = (pd.beads || [])
            .filter(b => _cellInRect(b.x, b.y, c1, r1, c2, r2) && _cellInWand(b.x - c1, b.y - r1))
            .map(b => ({ x: b.x - c1, y: b.y - r1, dmc: b.dmc }));
        _selBuffer = { w, h, data, part_stitches, backstitches, knots, beads,
                       isCut: !!isCut, cutSource: isCut ? { c1, r1, c2, r2 } : null };
    }

    /** After transforming the buffer, write it back to the grid so the result is visible. */
    function _commitTransformInPlace(oldRect) {
        if (!_selBuffer || !_selRect) return;
        const pd = getPatternData();
        pushUndo();
        _clearSelectionSource(oldRect || _selRect);
        _pasteBufferAt(pd, _selBuffer, _selRect.c1, _selRect.r1);
        // Recompute wand mask from transformed buffer's non-BG cells
        if (_wandMask) {
            const newMask = new Set();
            for (let r = 0; r < _selBuffer.h; r++)
                for (let c = 0; c < _selBuffer.w; c++)
                    if (_selBuffer.data[r * _selBuffer.w + c] !== 'BG')
                        newMask.add((_selRect.r1 + r) * pd.grid_w + (_selRect.c1 + c));
            _wandMask = newMask;
        }
        _selBuffer = null;    // will be re-captured on next transform/move
        _commitEdit();
        renderAll();
        _redrawOverlay();
    }

    function _rotateBufferCW() {
        if (!_selBuffer) _captureSelectionBuffer();
        if (!_selBuffer) return;
        const oldRect = _selRect ? { c1: _selRect.c1, r1: _selRect.r1, c2: _selRect.c2, r2: _selRect.r2 } : null;
        const { w, h, data } = _selBuffer;
        const nW = h, nH = w;
        const nd = new Array(nW * nH);
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                nd[c * nW + (h - 1 - r)] = data[r * w + c];
        // Rotate CW: (x,y) → (h-1-y, x) for cell coords, (x,y) → (h-y, x) for intersection coords
        const rParts = (_selBuffer.part_stitches || []).map(s => ({ ...s, x: h - 1 - s.y, y: s.x }));
        const rBS    = (_selBuffer.backstitches  || []).map(bs => ({ ...bs, x1: h - bs.y1, y1: bs.x1, x2: h - bs.y2, y2: bs.x2 }));
        const rKnots = (_selBuffer.knots         || []).map(k => ({ ...k, x: h - k.y, y: k.x }));
        const rBeads = (_selBuffer.beads         || []).map(b => ({ ...b, x: h - 1 - b.y, y: b.x }));
        _selBuffer = { w: nW, h: nH, data: nd, part_stitches: rParts, backstitches: rBS, knots: rKnots, beads: rBeads, isCut: _selBuffer.isCut, cutSource: _selBuffer.cutSource };
        if (_selRect) { _selRect.c2 = _selRect.c1 + nW - 1; _selRect.r2 = _selRect.r1 + nH - 1; }
        _commitTransformInPlace(oldRect);
    }

    function _flipBufferH() {
        if (!_selBuffer) _captureSelectionBuffer();
        if (!_selBuffer) return;
        const { w, h, data } = _selBuffer;
        const nd = new Array(w * h);
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                nd[r * w + (w - 1 - c)] = data[r * w + c];
        // Flip horizontal: x → (w-1-x) for cell coords, x → (w-x) for intersection coords
        const fParts = (_selBuffer.part_stitches || []).map(s => ({ ...s, x: w - 1 - s.x }));
        const fBS    = (_selBuffer.backstitches  || []).map(bs => ({ ...bs, x1: w - bs.x1, x2: w - bs.x2 }));
        const fKnots = (_selBuffer.knots         || []).map(k => ({ ...k, x: w - k.x }));
        const fBeads = (_selBuffer.beads         || []).map(b => ({ ...b, x: w - 1 - b.x }));
        _selBuffer = { w, h, data: nd, part_stitches: fParts, backstitches: fBS, knots: fKnots, beads: fBeads, isCut: _selBuffer.isCut, cutSource: _selBuffer.cutSource };
        _commitTransformInPlace();
    }

    function _flipBufferV() {
        if (!_selBuffer) _captureSelectionBuffer();
        if (!_selBuffer) return;
        const { w, h, data } = _selBuffer;
        const nd = new Array(w * h);
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                nd[(h - 1 - r) * w + c] = data[r * w + c];
        // Flip vertical: y → (h-1-y) for cell coords, y → (h-y) for intersection coords
        const fParts = (_selBuffer.part_stitches || []).map(s => ({ ...s, y: h - 1 - s.y }));
        const fBS    = (_selBuffer.backstitches  || []).map(bs => ({ ...bs, y1: h - bs.y1, y2: h - bs.y2 }));
        const fKnots = (_selBuffer.knots         || []).map(k => ({ ...k, y: h - k.y }));
        const fBeads = (_selBuffer.beads         || []).map(b => ({ ...b, y: h - 1 - b.y }));
        _selBuffer = { w, h, data: nd, part_stitches: fParts, backstitches: fBS, knots: fKnots, beads: fBeads, isCut: _selBuffer.isCut, cutSource: _selBuffer.cutSource };
        _commitTransformInPlace();
    }

    /* Bounds helpers for cell coords (0..w-1) vs intersection coords (0..w) */
    function _cellInRect(x, y, c1, r1, c2, r2) {
        return x >= c1 && x <= c2 && y >= r1 && y <= r2;
    }
    function _intersectionInRect(x, y, c1, r1, c2, r2) {
        return x >= c1 && x <= c2 + 1 && y >= r1 && y <= r2 + 1;
    }

    function _clearSelectionSource(bounds) {
        const rect = bounds || _selRect;
        if (!rect) return;
        const pd = getPatternData();
        const { c1, r1, c2, r2 } = rect;
        // Clear grid cells — only wand-mask cells if wand is active
        for (let r = r1; r <= r2; r++)
            for (let c = c1; c <= c2; c++) {
                const gi = r * pd.grid_w + c;
                if (!_wandMask || _wandMask.has(gi))
                    pd.grid[gi] = 'BG';
            }
        // Helper: check if a cell-coord stitch is in wand mask
        const inWand = _wandMask
            ? (x, y) => _wandMask.has(y * pd.grid_w + x)
            : () => true;
        // Helper: intersection-coord → containing cell check
        const intInWand = _wandMask
            ? (x, y) => {
                const cx = Math.min(Math.floor(x), c2), cy = Math.min(Math.floor(y), r2);
                return _wandMask.has(cy * pd.grid_w + cx);
            }
            : () => true;
        if (pd.part_stitches) pd.part_stitches = pd.part_stitches.filter(s =>
            !(_cellInRect(s.x, s.y, c1, r1, c2, r2) && inWand(s.x, s.y)));
        if (pd.backstitches) pd.backstitches = pd.backstitches.filter(bs =>
            !(_intersectionInRect(bs.x1, bs.y1, c1, r1, c2, r2) &&
              _intersectionInRect(bs.x2, bs.y2, c1, r1, c2, r2) &&
              intInWand(bs.x1, bs.y1) && intInWand(bs.x2, bs.y2)));
        if (pd.knots) pd.knots = pd.knots.filter(k =>
            !(_intersectionInRect(k.x, k.y, c1, r1, c2, r2) && intInWand(k.x, k.y)));
        if (pd.beads) pd.beads = pd.beads.filter(b =>
            !(_cellInRect(b.x, b.y, c1, r1, c2, r2) && inWand(b.x, b.y)));
    }

    /* Write buffer stitches at a destination offset */
    function _pasteBufferAt(pd, buf, destCol, destRow) {
        // Grid cells
        for (let r = 0; r < buf.h; r++) {
            for (let c = 0; c < buf.w; c++) {
                const dr = destRow + r, dc = destCol + c;
                if (dr >= 0 && dr < pd.grid_h && dc >= 0 && dc < pd.grid_w) {
                    const val = buf.data[r * buf.w + c];
                    if (val !== 'BG') pd.grid[dr * pd.grid_w + dc] = val;
                }
            }
        }
        // Part stitches
        for (const s of (buf.part_stitches || [])) {
            const nx = destCol + s.x, ny = destRow + s.y;
            if (nx >= 0 && nx < pd.grid_w && ny >= 0 && ny < pd.grid_h)
                (pd.part_stitches || (pd.part_stitches = [])).push({ x: nx, y: ny, type: s.type, dmc: s.dmc, dir: s.dir });
        }
        // Backstitches
        for (const bs of (buf.backstitches || [])) {
            const nx1 = destCol + bs.x1, ny1 = destRow + bs.y1;
            const nx2 = destCol + bs.x2, ny2 = destRow + bs.y2;
            if (nx1 >= 0 && nx1 <= pd.grid_w && ny1 >= 0 && ny1 <= pd.grid_h &&
                nx2 >= 0 && nx2 <= pd.grid_w && ny2 >= 0 && ny2 <= pd.grid_h)
                (pd.backstitches || (pd.backstitches = [])).push({ x1: nx1, y1: ny1, x2: nx2, y2: ny2, dmc: bs.dmc });
        }
        // Knots
        for (const k of (buf.knots || [])) {
            const nx = destCol + k.x, ny = destRow + k.y;
            if (nx >= 0 && nx <= pd.grid_w && ny >= 0 && ny <= pd.grid_h)
                (pd.knots || (pd.knots = [])).push({ x: nx, y: ny, dmc: k.dmc });
        }
        // Beads
        for (const b of (buf.beads || [])) {
            const nx = destCol + b.x, ny = destRow + b.y;
            if (nx >= 0 && nx < pd.grid_w && ny >= 0 && ny < pd.grid_h)
                (pd.beads || (pd.beads = [])).push({ x: nx, y: ny, dmc: b.dmc });
        }
    }

    function _commitMovedSelection() {
        if (!_selBuffer || !_selRect) return;
        if (_selOffset.dc === 0 && _selOffset.dr === 0) return;
        const pd = getPatternData();
        pushUndo();
        _clearSelectionSource();
        _pasteBufferAt(pd, _selBuffer, _selRect.c1 + _selOffset.dc, _selRect.r1 + _selOffset.dr);
        _selBuffer = null;
        _selRect = null;
        _wandMask = null;
        _selOffset = { dc: 0, dr: 0 };
        _commitEdit();
        _stopMarchingAnts();
        _redrawOverlay();
        _updateSelectBarState();
    }

    /* ── Paste mode ── */
    function _enterPasteMode() {
        if (!_selBuffer) return;
        _pasteMode = true;
        _pasteLoc = null;
        // Clear selection rect so marching ants stop — buffer is preserved
        _selRect = null; _wandMask = null;
        _selOffset = { dc: 0, dr: 0 };
        _stopMarchingAnts();
        _redrawOverlay();
    }

    function _exitPasteMode() {
        _pasteMode = false;
        _pasteLoc = null;
        _redrawOverlay();
    }

    function _commitPaste(destCol, destRow) {
        if (!_selBuffer) return;
        const pd = getPatternData();
        pushUndo();
        if (_selBuffer.isCut && _selBuffer.cutSource) {
            _clearSelectionSource(_selBuffer.cutSource);
            _selBuffer.isCut = false;
            _selBuffer.cutSource = null;
        }
        _pasteBufferAt(pd, _selBuffer, destCol, destRow);
        _exitPasteMode();
        _commitEdit();
    }

    function _toggleMirrorAxis(axis) {
        // axis: 'horizontal' or 'vertical'
        const hasH = _mirrorMode === 'horizontal' || _mirrorMode === 'both';
        const hasV = _mirrorMode === 'vertical' || _mirrorMode === 'both';
        let newH = axis === 'horizontal' ? !hasH : hasH;
        let newV = axis === 'vertical' ? !hasV : hasV;
        if (newH && newV) _mirrorMode = 'both';
        else if (newH) _mirrorMode = 'horizontal';
        else if (newV) _mirrorMode = 'vertical';
        else _mirrorMode = 'off';
        localStorage.setItem('dmc-ed-mirror', _mirrorMode);
        _updateMirrorButton();

        _redrawOverlay();
    }

    function _cycleMirror() {
        const modes = ['off', 'horizontal', 'vertical', 'both'];
        const i = modes.indexOf(_mirrorMode);
        _mirrorMode = modes[(i + 1) % modes.length];
        localStorage.setItem('dmc-ed-mirror', _mirrorMode);
        _updateMirrorButton();

        _redrawOverlay();
    }

    function _updateMirrorButton() {
        if (!_toolbar) return;
        const hBtn = _toolbar.querySelector('.ed-mirror-h-btn');
        const vBtn = _toolbar.querySelector('.ed-mirror-v-btn');
        if (hBtn) hBtn.classList.toggle('active', _mirrorMode === 'horizontal' || _mirrorMode === 'both');
        if (vBtn) vBtn.classList.toggle('active', _mirrorMode === 'vertical' || _mirrorMode === 'both');
    }

    /* ── Brush size controls ── */
    function _setBrushSize(size) {
        if (!_BRUSH_SIZES.includes(size)) return;
        _brushSize = size;
        localStorage.setItem('dmc-ed-brush', size);
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

    /** Crop canvas to the bounding box of all content (grid + part_stitches + backstitches + knots + beads). */
    function _cropToContent() {
        const pd = getPatternData();
        let minC = pd.grid_w, maxC = -1, minR = pd.grid_h, maxR = -1;
        // Scan grid
        for (let r = 0; r < pd.grid_h; r++) {
            for (let c = 0; c < pd.grid_w; c++) {
                if (pd.grid[r * pd.grid_w + c] !== 'BG') {
                    if (c < minC) minC = c; if (c > maxC) maxC = c;
                    if (r < minR) minR = r; if (r > maxR) maxR = r;
                }
            }
        }
        // Scan part_stitches
        if (pd.part_stitches) for (const ps of pd.part_stitches) {
            const x = ps.x !== undefined ? ps.x : ps.col;
            const y = ps.y !== undefined ? ps.y : ps.row;
            if (x < minC) minC = x; if (x > maxC) maxC = x;
            if (y < minR) minR = y; if (y > maxR) maxR = y;
        }
        // Scan backstitches (intersection coords — expand to include adjacent cells)
        if (pd.backstitches) for (const bs of pd.backstitches) {
            const cLo = Math.max(0, Math.min(bs.x1, bs.x2) - 1);
            const cHi = Math.min(pd.grid_w - 1, Math.max(bs.x1, bs.x2));
            const rLo = Math.max(0, Math.min(bs.y1, bs.y2) - 1);
            const rHi = Math.min(pd.grid_h - 1, Math.max(bs.y1, bs.y2));
            if (cLo < minC) minC = cLo; if (cHi > maxC) maxC = cHi;
            if (rLo < minR) minR = rLo; if (rHi > maxR) maxR = rHi;
        }
        // Scan knots (intersection coords — include adjacent cells)
        if (pd.knots) for (const k of pd.knots) {
            const cLo = Math.max(0, k.x - 1), cHi = Math.min(pd.grid_w - 1, k.x);
            const rLo = Math.max(0, k.y - 1), rHi = Math.min(pd.grid_h - 1, k.y);
            if (cLo < minC) minC = cLo; if (cHi > maxC) maxC = cHi;
            if (rLo < minR) minR = rLo; if (rHi > maxR) maxR = rHi;
        }
        // Scan beads
        if (pd.beads) for (const b of pd.beads) {
            if (b.x < minC) minC = b.x; if (b.x > maxC) maxC = b.x;
            if (b.y < minR) minR = b.y; if (b.y > maxR) maxR = b.y;
        }
        if (maxC < 0) return; // nothing to crop to
        const newW = maxC - minC + 1, newH = maxR - minR + 1;
        if (newW === pd.grid_w && newH === pd.grid_h) return; // already tight
        // Use _resizeCanvas with anchor that produces offset = (-minC, -minR)
        // offset = (newW - oldW) * anchorX = -minC → anchorX = minC / (oldW - newW)
        const dw = pd.grid_w - newW, dh = pd.grid_h - newH;
        const ax = dw > 0 ? minC / dw : 0;
        const ay = dh > 0 ? minR / dh : 0;
        _resizeCanvas(newW, newH, ax, ay);
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
                _withMirror(destC, destR, _placeStitchAt);
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
    /** Reverse lookup: activeStitchMode → data-tool attribute value */
    function _stitchModeToBtnTool(mode) {
        for (const [btn, m] of Object.entries(_STITCH_MODES)) { if (m === mode) return btn; }
        return null;
    }
    function _recomputeConfetti() {
        const pd = getPatternData();
        const bounds = _confettiScope === 'selection' ? _selRect : undefined;
        if (_confettiScope === 'selection' && !_selRect) {
            _confettiMap = new Map();
        } else {
            _confettiMap = _findConfetti(pd.grid, pd.grid_w, pd.grid_h, _confettiThreshold, bounds);
        }
        // Update count label
        const countLabel = _confettiBar ? _confettiBar.querySelector('.confetti-count') : null;
        if (countLabel) {
            countLabel.textContent = _confettiMap.size + ' cell' + (_confettiMap.size !== 1 ? 's' : '');
        }
        _redrawOverlay();
    }

    function _applyConfetti() {
        if (!_confettiMap || _confettiMap.size === 0) {
            _cancelConfetti();
            return;
        }
        const pd = getPatternData();
        pushUndo();
        for (const [idx, color] of _confettiMap) {
            pd.grid[idx] = color;
        }
        _clearConfetti();
        _selRect = null; _selBuffer = null; _selOffset = { dc: 0, dr: 0 };
        _setTool('pan');
        _commitEdit();
    }

    function _cancelConfetti() {
        _clearConfetti();
        _selRect = null; _selBuffer = null; _selOffset = { dc: 0, dr: 0 };
        _setTool('pan');
    }

    const _STITCH_TOOLS = new Set(Object.keys(_STITCH_MODES));

    function _setTool(tool) {
        if (_pasteMode) _exitPasteMode();
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
        // Map stitch sub-tools to activeTool='stitch' + activeStitchMode
        const isStitch = _STITCH_TOOLS.has(tool);
        // Drawing tools that use activeStitchMode for placement
        const _STITCH_AWARE_TOOLS = new Set(['pencil', 'shape', 'line', 'text']);
        if (isStitch) {
            activeTool = 'stitch';
            activeStitchMode = _STITCH_MODES[tool];
            _bsStart = null; _bsPreviewEnd = null;
        } else {
            activeTool = tool;
            // Clicking Full Stitch (pencil) resets stitch mode to full
            if (tool === 'pencil') activeStitchMode = 'full';
        }
        // Show/hide direction toggle for half/three-quarter on any tool that uses stitch mode
        if (_dirToggle) {
            const showDir = (activeStitchMode === 'half' || activeStitchMode === 'three_quarter') &&
                            (isStitch || _STITCH_AWARE_TOOLS.has(tool));
            _dirToggle.style.display = showDir ? '' : 'none';
            _dirToggle.querySelector('span:first-child').textContent = _halfDir === 'fwd' ? '/' : '\\';
        }
        // Highlight active tool button + keep stitch mode button highlighted on drawing tools
        if (_toolbar) {
            const stitchModeBtn = activeStitchMode !== 'full' ? _stitchModeToBtnTool(activeStitchMode) : null;
            const keepStitchHighlight = !isStitch && _STITCH_AWARE_TOOLS.has(tool) && stitchModeBtn;
            _toolbar.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
                const isTool = b.dataset.tool === tool;
                const isStitchMode = keepStitchHighlight && b.dataset.tool === stitchModeBtn;
                b.classList.toggle('active', isTool || isStitchMode);
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
        if (_confettiBar) {
            if (tool === 'confetti') {
                _confettiBar.style.display = 'flex';
                _confettiBar.style.top = _subTop;
                // Initialize: set slider value
                const slider = _confettiBar.querySelector('.confetti-slider');
                if (slider) slider.value = _confettiThreshold;
                const label = _confettiBar.querySelector('.confetti-thresh-label');
                if (label) label.textContent = _confettiThreshold;
                _recomputeConfetti();
            } else {
                _confettiBar.style.display = 'none';
            }
        }
        // Clear line / shape / text / stitch previews when switching away
        if (tool !== 'line') { lineStart = null; _lineEnd = null; }
        if (tool !== 'shape') { _shapeStart = null; _shapePreview = null; }
        if (tool !== 'fill') _clearFillPreview();
        if (tool !== 'confetti') {
            _clearConfetti();
            if (_confettiBar) _confettiBar.style.display = 'none';
        }
        if (tool !== 'text') _hideTextPanel();
        if (_shapeBar) {
            if (tool === 'shape') {
                _shapeBar.style.display = 'flex';
                _shapeBar.style.top = _subTop;
                _shapeBar.querySelectorAll('.confetti-scope-btn').forEach(b =>
                    b.classList.toggle('active', b.dataset.shape === _shapeMode));
            } else {
                _shapeBar.style.display = 'none';
            }
        }
        if (tool === 'select') {
            _selectBar.style.display = 'flex';
            _selectBar.style.top = _subTop;
            // Sync mode toggle to current _selectMode
            _selectBar.querySelectorAll('.confetti-scope-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.mode === _selectMode));
            _updateSelectBarState();
        } else {
            // Switching away from select: commit pending move, hide bar, cancel lasso
            if (activeTool === 'select') _commitMovedSelection();
            _lassoPath = null; _lassoDragging = false;
            if (_selectBar) _selectBar.style.display = 'none';
        }
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

    function _setFabricColor(hex) {
        const pd = getPatternData();
        pd.fabric_color = hex;
        if (!_fabricSwatch) return;
        _fabricSwatch.style.background = hex;
        _fabricCustom.value = hex;
        _fabricDropdown.querySelectorAll('.fabric-preset').forEach(el => {
            el.classList.toggle('active', el.dataset.color === hex);
        });
        renderAll();
        if (onDirty) onDirty();
    }

    function _setActiveColor(dmc) {
        const lu   = getLookup();
        const info = lu[dmc];
        if (!info) return;
        activeDmc    = String(dmc);
        activeHex    = info.hex;
        _clearFillPreview();
        _updateActiveIndicator();
        document.querySelectorAll('.legend-row, .key-row').forEach(r => {
            r.classList.toggle('active', _active && r.dataset.dmc === String(dmc));
        });
    }

    function _updateActiveIndicator() {
        if (!_activeSwatch || !_activeLabel) return;
        const chevron = ' <i class="ti ti-chevron-down"></i>';
        if (activeDmc) {
            _activeSwatch.style.background = activeHex;
            _activeLabel.innerHTML = escHtml(_brand + ' ' + activeDmc) + chevron;
        } else {
            _activeSwatch.style.background = '#444';
            _activeLabel.innerHTML = 'Thread' + chevron;
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

        // Crosshair row/column highlighting
        if (_crosshairMode && _hoverCell) {
            const pd = getPatternData();
            ctx.save();
            ctx.fillStyle = 'rgba(200, 145, 58, 0.18)';
            // Full row band
            ctx.fillRect(offset.x, offset.y + _hoverCell.row * cp, pd.grid_w * cp, cp);
            // Full column band
            ctx.fillRect(offset.x + _hoverCell.col * cp, offset.y, cp, pd.grid_h * cp);
            ctx.restore();
        }

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

        // Shape preview (rect, ellipse, triangle, diamond, star)
        if (_shapePreview) _drawShapePreview(ctx, offset, cp, _shapePreview, _getShapeCellsFn());

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

        // Lasso path preview while drawing
        if (_lassoDragging && _lassoPath && _lassoPath.length >= 2) {
            ctx.save();
            ctx.strokeStyle = '#00bbff';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(offset.x + _lassoPath[0].gx * cp, offset.y + _lassoPath[0].gy * cp);
            for (let i = 1; i < _lassoPath.length; i++) {
                ctx.lineTo(offset.x + _lassoPath[i].gx * cp, offset.y + _lassoPath[i].gy * cp);
            }
            // Closing line back to start
            ctx.lineTo(offset.x + _lassoPath[0].gx * cp, offset.y + _lassoPath[0].gy * cp);
            ctx.stroke();
            // Start point indicator
            ctx.fillStyle = '#00bbff';
            ctx.beginPath();
            ctx.arc(offset.x + _lassoPath[0].gx * cp, offset.y + _lassoPath[0].gy * cp, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // Fill preview (under hover highlight)
        if (_fillPreviewRegion && activeTool === 'fill') {
            const fpd = getPatternData();
            ctx.save();
            ctx.fillStyle = activeHex;
            ctx.globalAlpha = 0.3;
            for (const idx of _fillPreviewRegion) {
                const c = idx % fpd.grid_w;
                const r = (idx - c) / fpd.grid_w;
                ctx.fillRect(offset.x + c * cp, offset.y + r * cp, cp, cp);
            }
            ctx.restore();
        }

        // Confetti preview
        if (_confettiMap && _confettiMap.size > 0 && activeTool === 'confetti') {
            const cpd = getPatternData();
            ctx.save();
            ctx.fillStyle = 'rgba(255, 60, 60, 0.4)';
            for (const idx of _confettiMap.keys()) {
                const c = idx % cpd.grid_w;
                const r = (idx - c) / cpd.grid_w;
                ctx.fillRect(offset.x + c * cp, offset.y + r * cp, cp, cp);
            }
            ctx.restore();
        }

        // Paste mode floating preview (batched by color)
        if (_pasteMode && _selBuffer && _pasteLoc) {
            const lu = getLookup();
            const bx = offset.x + _pasteLoc.col * cp, by = offset.y + _pasteLoc.row * cp;
            ctx.save();
            ctx.globalAlpha = 0.4;
            // Group cells by hex color to minimize fillStyle switches
            const colorCells = {};
            for (let r = 0; r < _selBuffer.h; r++) {
                for (let c = 0; c < _selBuffer.w; c++) {
                    const val = _selBuffer.data[r * _selBuffer.w + c];
                    if (val === 'BG') continue;
                    const info = lu[val];
                    if (!info) continue;
                    (colorCells[info.hex] || (colorCells[info.hex] = [])).push(c, r);
                }
            }
            for (const hex in colorCells) {
                ctx.fillStyle = hex;
                const arr = colorCells[hex];
                for (let i = 0; i < arr.length; i += 2)
                    ctx.fillRect(bx + arr[i] * cp, by + arr[i + 1] * cp, cp, cp);
            }
            ctx.globalAlpha = 1;
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#4a90e2';
            ctx.strokeRect(bx, by, _selBuffer.w * cp, _selBuffer.h * cp);
            ctx.restore();
        }

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

        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 2;

        if (_wandMask && _wandMask.size > 0) {
            // Freeform outline: trace per-cell edges for wand/lasso selections
            const pd = getPatternData();
            const gw = pd.grid_w;
            ctx.beginPath();
            for (const idx of _wandMask) {
                const col = idx % gw, row = (idx - col) / gw;
                const cx = offset.x + (col + dc) * cp;
                const cy = offset.y + (row + dr) * cp;
                // Top edge
                if (!_wandMask.has(idx - gw)) { ctx.moveTo(cx, cy); ctx.lineTo(cx + cp, cy); }
                // Bottom edge
                if (!_wandMask.has(idx + gw)) { ctx.moveTo(cx, cy + cp); ctx.lineTo(cx + cp, cy + cp); }
                // Left edge
                if (col === 0 || !_wandMask.has(idx - 1)) { ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + cp); }
                // Right edge
                if (col === gw - 1 || !_wandMask.has(idx + 1)) { ctx.moveTo(cx + cp, cy); ctx.lineTo(cx + cp, cy + cp); }
            }
            ctx.lineDashOffset = -_marchPhase;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            ctx.lineDashOffset = -_marchPhase + 4;
            ctx.strokeStyle = '#000000';
            ctx.stroke();
        } else {
            // Rectangular outline
            const x = offset.x + (_selRect.c1 + dc) * cp;
            const y = offset.y + (_selRect.r1 + dr) * cp;
            const w = (_selRect.c2 - _selRect.c1 + 1) * cp;
            const h = (_selRect.r2 - _selRect.r1 + 1) * cp;
            ctx.lineDashOffset = -_marchPhase;
            ctx.strokeStyle = '#ffffff';
            ctx.strokeRect(x, y, w, h);
            ctx.lineDashOffset = -_marchPhase + 4;
            ctx.strokeStyle = '#000000';
            ctx.strokeRect(x, y, w, h);
        }
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

    function _getTriangleCells(c1, r1, c2, r2, filled) {
        const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
        const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
        const cells = [];
        const w = maxC - minC, h = maxR - minR;
        if (w === 0 && h === 0) { cells.push({ col: minC, row: minR }); return cells; }
        // Orientation: vertical if taller/square, horizontal if wider
        // Apex at drag-start side, base at drag-end side
        if (h >= w) {
            // Vertical triangle
            const apexAtTop = r1 <= r2;
            const cx = (minC + maxC) / 2;
            for (let r = minR; r <= maxR; r++) {
                const t = h === 0 ? 1 : (apexAtTop ? (r - minR) / h : (maxR - r) / h);
                const halfW = t * w / 2;
                const cLeft  = Math.max(minC, Math.round(cx - halfW));
                const cRight = Math.min(maxC, Math.round(cx + halfW));
                if (filled) {
                    for (let c = cLeft; c <= cRight; c++) cells.push({ col: c, row: r });
                } else {
                    const isApex = apexAtTop ? r === minR : r === maxR;
                    const isBase = apexAtTop ? r === maxR : r === minR;
                    if (isApex || isBase) {
                        for (let c = cLeft; c <= cRight; c++) cells.push({ col: c, row: r });
                    } else {
                        cells.push({ col: cLeft, row: r });
                        if (cRight !== cLeft) cells.push({ col: cRight, row: r });
                    }
                }
            }
        } else {
            // Horizontal triangle: apex at c1 side, base at c2 side
            const apexAtLeft = c1 <= c2;
            const cy = (minR + maxR) / 2;
            for (let c = minC; c <= maxC; c++) {
                const t = w === 0 ? 1 : (apexAtLeft ? (c - minC) / w : (maxC - c) / w);
                const halfH = t * h / 2;
                const rTop    = Math.max(minR, Math.round(cy - halfH));
                const rBottom = Math.min(maxR, Math.round(cy + halfH));
                if (filled) {
                    for (let r = rTop; r <= rBottom; r++) cells.push({ col: c, row: r });
                } else {
                    const isApex = apexAtLeft ? c === minC : c === maxC;
                    const isBase = apexAtLeft ? c === maxC : c === minC;
                    if (isApex || isBase) {
                        for (let r = rTop; r <= rBottom; r++) cells.push({ col: c, row: r });
                    } else {
                        cells.push({ col: c, row: rTop });
                        if (rBottom !== rTop) cells.push({ col: c, row: rBottom });
                    }
                }
            }
        }
        return cells;
    }

    function _getDiamondCells(c1, r1, c2, r2, filled) {
        const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
        const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
        const cells = [];
        const w = maxC - minC, h = maxR - minR;
        if (w === 0 && h === 0) { cells.push({ col: minC, row: minR }); return cells; }
        const cx = (minC + maxC) / 2;
        const cy = (minR + maxR) / 2;
        for (let r = minR; r <= maxR; r++) {
            const t = h === 0 ? 0 : Math.abs(r - cy) / (h / 2);
            const halfW = (1 - t) * w / 2;
            const cLeft  = Math.max(minC, Math.round(cx - halfW));
            const cRight = Math.min(maxC, Math.round(cx + halfW));
            if (filled) {
                for (let c = cLeft; c <= cRight; c++) cells.push({ col: c, row: r });
            } else {
                cells.push({ col: cLeft, row: r });
                if (cRight !== cLeft) cells.push({ col: cRight, row: r });
            }
        }
        return cells;
    }

    function _getStarCells(c1, r1, c2, r2, filled) {
        const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
        const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
        const w = maxC - minC, h = maxR - minR;
        if (w <= 1 && h <= 1) {
            const cells = [];
            for (let r = minR; r <= maxR; r++)
                for (let c = minC; c <= maxC; c++)
                    cells.push({ col: c, row: r });
            return cells;
        }
        const cx = (minC + maxC) / 2, cy = (minR + maxR) / 2;
        const rx = w / 2, ry = h / 2;
        const innerRatio = 0.381966;
        const verts = [];
        for (let i = 0; i < 10; i++) {
            const angle = -Math.PI / 2 + (i * Math.PI / 5);
            const rad = i % 2 === 0 ? 1 : innerRatio;
            verts.push({ x: cx + rad * rx * Math.cos(angle), y: cy + rad * ry * Math.sin(angle) });
        }
        const cells = [];
        const set = new Set();
        const addCell = (col, row) => {
            const key = row * 100000 + col;
            if (!set.has(key)) { set.add(key); cells.push({ col, row }); }
        };
        for (let row = minR; row <= maxR; row++) {
            const intersections = [];
            for (let i = 0; i < verts.length; i++) {
                const a = verts[i], b = verts[(i + 1) % verts.length];
                if ((a.y <= row + 0.5 && b.y > row + 0.5) || (b.y <= row + 0.5 && a.y > row + 0.5)) {
                    const t = (row + 0.5 - a.y) / (b.y - a.y);
                    intersections.push(a.x + t * (b.x - a.x));
                }
            }
            intersections.sort((a, b) => a - b);
            if (filled) {
                for (let j = 0; j < intersections.length - 1; j += 2) {
                    const left = Math.max(minC, Math.round(intersections[j]));
                    const right = Math.min(maxC, Math.round(intersections[j + 1]));
                    for (let c = left; c <= right; c++) addCell(c, row);
                }
            } else {
                for (let j = 0; j < intersections.length; j++) {
                    addCell(Math.max(minC, Math.min(maxC, Math.round(intersections[j]))), row);
                }
            }
        }
        if (!filled) {
            for (let i = 0; i < verts.length; i++) {
                const a = verts[i], b = verts[(i + 1) % verts.length];
                const ac = Math.max(minC, Math.min(maxC, Math.round(a.x)));
                const ar = Math.max(minR, Math.min(maxR, Math.round(a.y)));
                const bc = Math.max(minC, Math.min(maxC, Math.round(b.x)));
                const br = Math.max(minR, Math.min(maxR, Math.round(b.y)));
                const steps = Math.max(Math.abs(bc - ac), Math.abs(br - ar));
                for (let s = 0; s <= steps; s++) {
                    const t = steps === 0 ? 0 : s / steps;
                    const c = Math.round(ac + t * (bc - ac));
                    const r = Math.round(ar + t * (br - ar));
                    if (c >= minC && c <= maxC && r >= minR && r <= maxR) addCell(c, r);
                }
            }
        }
        return cells;
    }

    function _getShapeCellsFn() {
        return { rect: _getRectCells, ellipse: _getEllipseCells, triangle: _getTriangleCells, diamond: _getDiamondCells, star: _getStarCells }[_shapeMode];
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
                for (const bc of _getBrushCells(col, row)) _withMirror(bc.col, bc.row, _placeStitchAt);
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
                _clearFillPreview();
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
                    for (const c of cells) _withMirror(c.col, c.row, _placeStitchAt);
                    lineStart = null;
                    _lineEnd = null;
                    _commitEdit();
                    _redrawOverlay();
                }
                break;
            case 'shape':
                _shapeStart = { col, row };
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
                if (_pasteMode) {
                    if (_pasteLoc) _commitPaste(_pasteLoc.col, _pasteLoc.row);
                    return;
                }
                if (_selectMode === 'lasso') {
                    // If clicking inside existing selection, start move
                    if (_selRect && _isInsideSelection(col, row)) {
                        _selMoving = true;
                        _selMoveOrigin = { col, row };
                        if (!_selBuffer) _captureSelectionBuffer();
                        break;
                    }
                    // Start a new lasso
                    _commitMovedSelection();
                    _selRect = null; _selBuffer = null; _wandMask = null;
                    _selOffset = { dc: 0, dr: 0 };
                    _stopMarchingAnts();
                    const sub = _getGridCoords(e);
                    if (!sub) break;
                    _lassoPath = [{ gx: sub.gx, gy: sub.gy }];
                    _lassoDragging = true;
                    _redrawOverlay();
                    _updateSelectBarState();
                    break;
                }
                if (_selectMode === 'wand') {
                    // If clicking inside existing selection, start move (same as rect mode)
                    if (_selRect && _isInsideSelection(col, row)) {
                        _selMoving = true;
                        _selMoveOrigin = { col, row };
                        if (!_selBuffer) _captureSelectionBuffer();
                        break;
                    }
                    // Wand click: BFS from clicked cell
                    const pd = getPatternData();
                    const idx = row * pd.grid_w + col;
                    const color = pd.grid[idx];
                    if (color === 'BG') {
                        _commitMovedSelection();
                        _selRect = null; _selBuffer = null; _wandMask = null;
                        _stopMarchingAnts();
                        _updateSelectBarState();
                        _redrawOverlay();
                        break;
                    }
                    _commitMovedSelection();
                    _wandMask = null;
                    const region = _bfsRegion(pd.grid, pd.grid_w, pd.grid_h, idx, color);
                    let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
                    for (const i of region) {
                        const c = i % pd.grid_w, r = (i - c) / pd.grid_w;
                        if (c < minC) minC = c; if (c > maxC) maxC = c;
                        if (r < minR) minR = r; if (r > maxR) maxR = r;
                    }
                    _selRect = { c1: minC, r1: minR, c2: maxC, r2: maxR };
                    _wandMask = region;
                    _captureSelectionBuffer();
                    _startMarchingAnts();
                    _updateSelectBarState();
                    _redrawOverlay();
                    break;
                }
                // Rect mode (existing behavior)
                if (_selRect && _isInsideSelection(col, row)) {
                    _selMoving = true;
                    _selMoveOrigin = { col, row };
                    if (!_selBuffer) {
                        _captureSelectionBuffer();
                    }
                } else {
                    _commitMovedSelection();
                    _selStart = { col, row };
                    _selDragging = true;
                    _selRect = null;
                    _selBuffer = null;
                    _wandMask = null;
                    _selOffset = { dc: 0, dr: 0 };
                    _stopMarchingAnts();
                }
                break;
            case 'confetti':
                if (_confettiScope === 'selection') {
                    _selStart = { col, row };
                    _selDragging = true;
                    _selRect = null;
                    _selBuffer = null;
                    _selOffset = { dc: 0, dr: 0 };
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

        // Fill preview — compute BFS region on hover
        if (activeTool === 'fill' && !_painting) {
            if (_cellKey(prevHover) !== _cellKey(_hoverCell)) {
                if (!hoverStitch || !activeDmc) {
                    _clearFillPreview();
                } else if (!_fillPreviewCell || _fillPreviewCell.col !== hoverStitch.col || _fillPreviewCell.row !== hoverStitch.row) {
                    _fillPreviewCell = { col: hoverStitch.col, row: hoverStitch.row };
                    const pd = getPatternData();
                    const idx = hoverStitch.row * pd.grid_w + hoverStitch.col;
                    const target = pd.grid[idx];
                    if (target === activeDmc) {
                        _fillPreviewRegion = null;
                    } else {
                        const region = _bfsRegion(pd.grid, pd.grid_w, pd.grid_h, idx, target, 50001);
                        _fillPreviewRegion = region.size <= 50000 ? region : null;
                    }
                }
                _redrawOverlay();
            }
            return;
        }

        // Line preview
        if (activeTool === 'line' && lineStart) {
            if (hoverStitch) _lineEnd = hoverStitch;
            _redrawOverlay();
            return;
        }

        // Shape preview (rect, ellipse, triangle, diamond, star)
        if (activeTool === 'shape' && _shapeStart) {
            if (hoverStitch) {
                _shapePreview = { c1: _shapeStart.col, r1: _shapeStart.row, c2: hoverStitch.col, r2: hoverStitch.row, outline: e.shiftKey };
            }
            _redrawOverlay();
            return;
        }

        // Confetti selection drag
        if (activeTool === 'confetti' && _confettiScope === 'selection' && _selDragging && hoverStitch) {
            _selRect = {
                c1: Math.min(_selStart.col, hoverStitch.col),
                r1: Math.min(_selStart.row, hoverStitch.row),
                c2: Math.max(_selStart.col, hoverStitch.col),
                r2: Math.max(_selStart.row, hoverStitch.row),
            };
            _redrawOverlay();
            return;
        }

        // Selection drag / move / paste preview
        if (activeTool === 'select') {
            if (_pasteMode && hoverStitch) {
                _pasteLoc = { col: hoverStitch.col, row: hoverStitch.row };
                _redrawOverlay();
                return;
            }
            if (_lassoDragging && _lassoPath) {
                const sub = _getGridCoords(e);
                if (sub) {
                    const last = _lassoPath[_lassoPath.length - 1];
                    const dx = sub.gx - last.gx, dy = sub.gy - last.gy;
                    if (dx * dx + dy * dy >= 0.04) {
                        _lassoPath.push({ gx: sub.gx, gy: sub.gy });
                    }
                }
                _redrawOverlay();
                return;
            }
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
            for (const bc of _getBrushCells(stitch.col, stitch.row)) _withMirror(bc.col, bc.row, _placeStitchAt);
        } else if (activeTool === 'eraser') {
            for (const bc of _getBrushCells(stitch.col, stitch.row)) _withMirror(bc.col, bc.row, eraserAt);
        }
        _redrawOverlay();
    }

    function _handleToolMouseUp() {
        // Confetti selection drag end
        if (activeTool === 'confetti' && _confettiScope === 'selection' && _selDragging) {
            _selDragging = false;
            if (_selRect && (_selRect.c1 !== _selRect.c2 || _selRect.r1 !== _selRect.r2)) {
                _recomputeConfetti();
            } else {
                _selRect = null;
                _confettiMap = new Map();
                const countLabel = _confettiBar ? _confettiBar.querySelector('.confetti-count') : null;
                if (countLabel) countLabel.textContent = '0 cells';
            }
            _redrawOverlay();
            return;
        }

        // Shape commit (rect, ellipse, triangle, diamond, star)
        if (activeTool === 'shape' && _shapeStart && _shapePreview) {
            pushUndo();
            const p = _shapePreview;
            const cells = _getShapeCellsFn()(p.c1, p.r1, p.c2, p.r2, !p.outline);
            for (const c of cells) _withMirror(c.col, c.row, _placeStitchAt);
            _shapeStart = null; _shapePreview = null;
            _commitEdit();
            _redrawOverlay();
            return;
        }

        // Selection drag end
        if (activeTool === 'select') {
            if (_lassoDragging && _lassoPath) {
                _lassoDragging = false;
                if (_lassoPath.length >= 3) {
                    const pd = getPatternData();
                    const mask = _rasterizeLasso(_lassoPath, pd.grid_w, pd.grid_h);
                    if (mask.size > 0) {
                        let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
                        for (const i of mask) {
                            const c = i % pd.grid_w, r = (i - c) / pd.grid_w;
                            if (c < minC) minC = c; if (c > maxC) maxC = c;
                            if (r < minR) minR = r; if (r > maxR) maxR = r;
                        }
                        _selRect = { c1: minC, r1: minR, c2: maxC, r2: maxR };
                        _wandMask = mask;
                        _startMarchingAnts();
                    }
                }
                _lassoPath = null;
                _redrawOverlay();
                _updateSelectBarState();
                return;
            }
            if (_selDragging) {
                _selDragging = false;
                if (_selRect && (_selRect.c1 !== _selRect.c2 || _selRect.r1 !== _selRect.r2)) {
                    _startMarchingAnts();
                } else {
                    _selRect = null;
                }
                _redrawOverlay();
                _updateSelectBarState();
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
        if (_fabricSwatch) {
            const initFab = getPatternData().fabric_color || '#F5F0E8';
            _fabricSwatch.style.background = initFab;
            _fabricCustom.value = initFab;
            _fabricDropdown.querySelectorAll('.fabric-preset').forEach(el => {
                el.classList.toggle('active', el.dataset.color === initFab);
            });
        }
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
        if (_confettiBar) _confettiBar.style.display = 'none';
        if (_selectBar) _selectBar.style.display = 'none';
        _lassoPath = null; _lassoDragging = false;
        _clearConfetti();
        _closeAddColorDropdown();
        _closeReplaceDropdown();
        document.querySelectorAll('.legend-row.active, .key-row.active').forEach(r => r.classList.remove('active'));
        document.querySelectorAll('.leg-check').forEach(el => el.style.display = '');
        lineStart = null;
        _lineEnd = null;
        _painting = false;
        _shapeStart = null;
        _shapePreview = null;
        if (_shapeBar) _shapeBar.style.display = 'none';
        _clearFillPreview();
        _bsStart = null;
        _bsPreviewEnd = null;
        _hoverIntersection = null;
        _hideTextPanel();
        _hideEyedropTip();
        if (_rcModal) { _rcBackdrop?.remove(); _rcModal.remove(); _rcBackdrop = null; _rcModal = null; }
        if (_resizeModal) { _resizeBackdrop?.remove(); _resizeModal.remove(); _resizeBackdrop = null; _resizeModal = null; }
        _hoverCell = null;
        _selRect = null; _selBuffer = null; _selOffset = { dc: 0, dr: 0 };
        _selDragging = false; _selMoving = false;
        _stopMarchingAnts();
        _redrawOverlay();
    }

    function handleMouseDown(e) { _handleToolMouseDown(e); }
    function handleMouseMove(e) { _handleToolMouseMove(e); }
    function handleMouseUp()    { _handleToolMouseUp(); }

    /** Right-click to confirm a moved selection or place a paste */
    function handleContextMenu(e) {
        if (activeTool !== 'select') return false;
        // Confirm a drag-moved selection
        if (_selRect && _selBuffer && (_selOffset.dc !== 0 || _selOffset.dr !== 0)) {
            e.preventDefault();
            _commitMovedSelection();
            return true;
        }
        // Confirm a paste placement
        if (_pasteMode && _pasteLoc) {
            e.preventDefault();
            _commitPaste(_pasteLoc.col, _pasteLoc.row);
            return true;
        }
        return false;
    }

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
            if (_shapeStart) {
                _shapeStart = null; _shapePreview = null;
                _redrawOverlay();
                return true;
            }
            if (_bsStart) {
                _bsStart = null; _bsPreviewEnd = null;
                _redrawOverlay();
                return true;
            }
            if (activeTool === 'confetti') {
                _cancelConfetti();
                return true;
            }
            if (_pasteMode) {
                _exitPasteMode();
                return true;
            }
            if (activeTool === 'select' && _lassoDragging) {
                _lassoDragging = false;
                _lassoPath = null;
                _redrawOverlay();
                return true;
            }
            if (activeTool === 'select' && _selRect) {
                _commitMovedSelection();
                _selRect = null; _wandMask = null;
                _selOffset = { dc: 0, dr: 0 };
                _stopMarchingAnts();
                _redrawOverlay();
                _updateSelectBarState();
                return true;
            }
        }
        // Paste mode: only Escape (handled above) and click (handled in mouse down)
        if (_pasteMode) return false;
        // Selection keyboard shortcuts
        if (activeTool === 'select' && _selRect) {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                pushUndo();
                _clearSelectionSource();
                _selRect = null; _selBuffer = null; _wandMask = null;
                _selOffset = { dc: 0, dr: 0 };
                _stopMarchingAnts();
                _commitEdit();
                _redrawOverlay();
                _updateSelectBarState();
                return true;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                e.preventDefault();
                _captureSelectionBuffer(false);
                _enterPasteMode();
                return true;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
                e.preventDefault();
                _captureSelectionBuffer(true);
                _enterPasteMode();
                return true;
            }
            // Rotate / flip selection (R/H/V) — only bare keys, not Ctrl combos
            if (!e.ctrlKey && !e.metaKey) {
                const sk = e.key.toLowerCase();
                if (sk === 'r') { e.preventDefault(); _rotateBufferCW(); _updateSelectBarState(); return true; }
                if (sk === 'h') { e.preventDefault(); _flipBufferH(); _updateSelectBarState(); return true; }
                if (sk === 'v') { e.preventDefault(); _flipBufferV(); _updateSelectBarState(); return true; }
            }
        }
        if (e.key === ' ') {
            e.preventDefault();
            spaceHeld = true;
            container.classList.add('space-pan');
            return true;
        }
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return true; }
            if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) { e.preventDefault(); redo(); return true; }
            if (e.key === 's' && onSave) { e.preventDefault(); onSave(); return true; }
            if (e.shiftKey && e.key.toUpperCase() === 'R') { e.preventDefault(); _showResizeModal(); return true; }
            if (e.shiftKey && e.key.toUpperCase() === 'I') { e.preventDefault(); _showRowColModal(); return true; }
            if (e.shiftKey && e.key.toUpperCase() === 'O') { e.preventDefault(); _setTool('auto-outline'); return true; }
            if (e.shiftKey && e.key.toUpperCase() === 'C') { e.preventDefault(); _cropToContent(); return true; }
            return false;
        }
        const k = e.key.toLowerCase();
        if (k === 'g') { _crosshairMode = !_crosshairMode; _pref('dmc-ed-crosshair', _crosshairMode ? '1' : '0'); _redrawOverlay(); return true; }
        if (k === 'p') { _setTool('pencil');     return true; }
        if (k === 'e') { _setTool('eraser');      return true; }
        if (k === 'f') { _setTool('fill');        return true; }
        if (k === 'i') { _setTool('eyedropper');  return true; }
        if (k === 'l') { _setTool('line');        return true; }
        if (k === 't') { _setTool('shape');        return true; }
        if (k === 'o') {
            if (activeTool === 'shape') {
                const modes = ['rect', 'ellipse', 'triangle', 'diamond', 'star'];
                _shapeMode = modes[(modes.indexOf(_shapeMode) + 1) % modes.length];
                if (_shapeBar) _shapeBar.querySelectorAll('.confetti-scope-btn').forEach(b =>
                    b.classList.toggle('active', b.dataset.shape === _shapeMode));
                _shapeStart = null; _shapePreview = null;
                _redrawOverlay();
            } else {
                _setTool('shape');
            }
            return true;
        }
        if (k === 'x') { _setTool('text');       return true; }
        if (k === 'r') { _setTool('replace');     return true; }
        if (k === 's') { _setTool('select');      return true; }
        if (k === 'h') { _setTool('pan');         return true; }
        if (k === 'w') { _setTool('pencil');        return true; }
        if (k === 'm') { _cycleMirror();          return true; }
        if (k === 'c') { _setTool('confetti');   return true; }
        if (e.key === '[') { _cycleBrushSize(-1); return true; }
        if (e.key === ']') { _cycleBrushSize(1);  return true; }
        // Stitch type shortcuts (1-5) — always available
        const _stitchKeys = ['stitch-half', 'stitch-quarter', 'stitch-threequarter', 'stitch-petite', 'stitch-back', 'stitch-knot', 'stitch-bead'];
        const _skIdx = parseInt(e.key) - 1;
        if (_skIdx >= 0 && _skIdx < _stitchKeys.length) { _setTool(_stitchKeys[_skIdx]); return true; }
        if (e.key === '`') { _toggleHalfDir(); return true; }
        // Color cycling: , / . / Arrow keys (follows visible legend/key order)
        if (e.key === ',' || e.key === '.' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const rows = [...document.querySelectorAll('.legend-row[data-dmc], .key-row[data-dmc]')];
            if (!rows.length) return false;
            const dmcs = rows.map(r => r.dataset.dmc);
            const idx = dmcs.indexOf(String(activeDmc));
            const dir = (e.key === '.' || e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
            const nextIdx = idx < 0 ? 0 : (idx + dir + dmcs.length) % dmcs.length;
            _setActiveColor(dmcs[nextIdx]);
            rows[nextIdx].scrollIntoView({ block: 'nearest' });
            return true;
        }
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
        _shapeStart = null;
        _shapePreview = null;
        _shapeMode = 'rect';
        if (_shapeBar) _shapeBar.style.display = 'none';
        _clearFillPreview();
        _clearConfetti();
        _confettiThreshold = 3;
        _confettiScope = 'all';
        if (_confettiBar) _confettiBar.style.display = 'none';
        _selectMode = 'rect';
        _wandMask = null;
        if (_selectBar) _selectBar.style.display = 'none';
        _lassoPath = null; _lassoDragging = false;
        _bsStart = null;
        _bsPreviewEnd = null;
        _hoverIntersection = null;
        activeStitchMode = 'full';
        _halfDir = 'fwd';
        _hideTextPanel();
        _mirrorMode = _pref('dmc-ed-mirror', 'off');
        _brushSize = (function() { var v = parseInt(_pref('dmc-ed-brush', 1)); return _BRUSH_SIZES.includes(v) ? v : 1; })();
        _hoverCell = null;
        _pasteMode = false; _pasteLoc = null;
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
                    <button class="tool-btn" data-tool="auto-outline" title="Auto Outline (Ctrl+Shift+O)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="5" y="5" width="14" height="14" rx="1" stroke-dasharray="3 2"/></svg><span class="tool-lbl">Outline</span></button>
                    <button class="tool-btn stitch-dir-toggle" title="Toggle direction (\`)" style="display:none"><span style="font-size:16px">/</span><span class="tool-lbl">Dir</span></button>
                </div>
                <div class="tool-sep"></div>
                <div class="tool-group">
                    <button class="tool-btn" data-tool="line" title="Line (L)"><i class="ti ti-line"></i><span class="tool-lbl">Line</span></button>
                    <button class="tool-btn" data-tool="shape" title="Shapes (T)"><i class="ti ti-polygon"></i><span class="tool-lbl">Shape</span></button>
                    <button class="tool-btn" data-tool="fill" title="Flood Fill (F)"><i class="ti ti-paint-filled"></i><span class="tool-lbl">Fill</span></button>
                </div>
                <div class="tool-sep"></div>
                <div class="tool-group">
                    <button class="tool-btn" data-tool="eraser" title="Eraser (E)"><i class="ti ti-eraser"></i><span class="tool-lbl">Erase</span></button>
                    <button class="tool-btn" data-tool="text" title="Text (X)"><i class="ti ti-typography"></i><span class="tool-lbl">Text</span></button>
                    <button class="tool-btn" data-tool="select" title="Selection (S)"><i class="ti ti-marquee-2"></i><span class="tool-lbl">Select</span></button>
                    <button class="tool-btn" data-tool="confetti" title="Confetti Cleanup (C)"><i class="ti ti-sparkles"></i><span class="tool-lbl">Confetti</span></button>
                </div>
            </div>
            <div class="toolbar-row">
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
                <button class="tool-btn ed-redo-btn" title="Redo (Ctrl+Shift+Z / Ctrl+Y)" disabled><i class="ti ti-arrow-forward-up"></i><span class="tool-lbl">Redo</span></button>
                <div class="tool-sep"></div>
                <button class="tool-btn ed-mirror-h-btn" title="Mirror Horizontal (M)"><i class="ti ti-flip-horizontal"></i><span class="tool-lbl">Mirror H</span></button>
                <button class="tool-btn ed-mirror-v-btn" title="Mirror Vertical (M)"><i class="ti ti-flip-vertical"></i><span class="tool-lbl">Mirror V</span></button>
                <button class="tool-btn ed-resize-btn" title="Resize Canvas (Ctrl+Shift+R)"><i class="ti ti-dimensions"></i><span class="tool-lbl">Resize</span></button>
                <button class="tool-btn ed-rowcol-btn" title="Insert/Delete Row/Column (Ctrl+Shift+I)"><i class="ti ti-row-insert-bottom"></i><span class="tool-lbl">Row/Col</span></button>
                <button class="tool-btn ed-crop-btn" title="Crop to Content (Ctrl+Shift+C)"><i class="ti ti-crop"></i><span class="tool-lbl">Crop</span></button>
                <div class="tool-sep"></div>
                <div class="palette-group">
                    <div class="fabric-color-wrapper">
                        <button class="palette-btn ed-fabric-btn" title="Fabric Color (Aida)">
                            <div class="palette-sw ed-fabric-swatch" style="background:#F5F0E8"></div>
                            <span class="palette-lbl">Fabric <i class="ti ti-chevron-down"></i></span>
                        </button>
                        <div class="fabric-dropdown">
                            <div class="fabric-preset" data-color="#FFFFFF"><div class="fabric-preset-sw" style="background:#FFFFFF"></div>White</div>
                            <div class="fabric-preset active" data-color="#F5F0E8"><div class="fabric-preset-sw" style="background:#F5F0E8"></div>Antique White</div>
                            <div class="fabric-preset" data-color="#000000"><div class="fabric-preset-sw" style="background:#000000"></div>Black</div>
                            <div class="fabric-custom"><input type="color" class="ed-fabric-custom" value="#F5F0E8"><span>Custom</span></div>
                        </div>
                    </div>
                    <div class="add-color-wrapper">
                        <button class="palette-btn ed-active-color-ind" title="Click to change thread color">
                            <div class="palette-sw ed-active-swatch"></div>
                            <span class="palette-lbl ed-active-label">Thread <i class="ti ti-chevron-down"></i></span>
                        </button>
                        <div class="add-color-dropdown">
                            <input type="text" class="replace-target-search" placeholder="Search ${_brand} #/name…">
                            <div class="replace-target-list"></div>
                        </div>
                    </div>
                </div>
                <button class="tool-btn" data-tool="eyedropper" title="Eyedropper (I)"><i class="ti ti-color-picker"></i><span class="tool-lbl">Pick</span></button>
                <button class="tool-btn" data-tool="replace" title="Color Replace (R)"><i class="ti ti-replace"></i><span class="tool-lbl">Swap</span></button>
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

        // Confetti cleanup options bar
        _confettiBar = document.createElement('div');
        _confettiBar.className = 'ed-confetti-bar';
        _confettiBar.style.display = 'none';
        _confettiBar.innerHTML = `
            <span class="confetti-scope"><button class="confetti-scope-btn active" data-scope="all">Whole Pattern</button><button class="confetti-scope-btn" data-scope="selection">Selection</button></span>
            <label>Max cluster: <input type="range" class="confetti-slider" min="1" max="10" value="3"><span class="confetti-thresh-label">3</span></label>
            <span class="confetti-count">0 cells</span>
            <button class="confetti-apply">Apply</button>
            <button class="confetti-cancel">Cancel</button>
        `;
        container.appendChild(_confettiBar);

        // Confetti bar event handlers
        const _confettiSlider = _confettiBar.querySelector('.confetti-slider');
        const _confettiThreshLabel = _confettiBar.querySelector('.confetti-thresh-label');

        _confettiSlider.addEventListener('input', () => {
            _confettiThreshold = parseInt(_confettiSlider.value);
            _confettiThreshLabel.textContent = _confettiThreshold;
            // Debounced recompute
            if (_confettiDebounce) clearTimeout(_confettiDebounce);
            _confettiDebounce = setTimeout(() => {
                _recomputeConfetti();
                _confettiDebounce = null;
            }, 100);
        });
        _confettiSlider.addEventListener('keydown', (e) => e.stopPropagation());

        _confettiBar.querySelectorAll('.confetti-scope-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                _confettiScope = btn.dataset.scope;
                _confettiBar.querySelectorAll('.confetti-scope-btn').forEach(b => b.classList.toggle('active', b === btn));
                _recomputeConfetti();
            });
        });

        _confettiBar.querySelector('.confetti-apply').addEventListener('click', (e) => {
            e.stopPropagation();
            _applyConfetti();
        });
        _confettiBar.querySelector('.confetti-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            _cancelConfetti();
        });
        _confettiBar.addEventListener('mousedown', (e) => e.stopPropagation());
        _confettiBar.addEventListener('click', (e) => e.stopPropagation());

        /* ── Selection bar (Rect/Wand toggle + transforms + dimensions) ── */
        _selectBar = document.createElement('div');
        _selectBar.className = 'ed-select-bar';
        _selectBar.style.display = 'none';
        _selectBar.innerHTML = `
            <span class="confetti-scope"><button class="confetti-scope-btn active" data-mode="rect">Rect</button><button class="confetti-scope-btn" data-mode="wand">Wand</button><button class="confetti-scope-btn" data-mode="lasso">Lasso</button></span>
            <span style="width:1px;height:16px;background:var(--border-2)"></span>
            <button class="select-flip-h" disabled>Flip Horizontal</button>
            <button class="select-flip-v" disabled>Flip Vertical</button>
            <button class="select-rotate" disabled>Rotate</button>
            <span class="select-dims"></span>
        `;
        container.appendChild(_selectBar);
        _selFlipHBtn  = _selectBar.querySelector('.select-flip-h');
        _selFlipVBtn  = _selectBar.querySelector('.select-flip-v');
        _selRotateBtn = _selectBar.querySelector('.select-rotate');
        _selDimsSpan  = _selectBar.querySelector('.select-dims');

        _selectBar.querySelectorAll('.confetti-scope-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                _selectMode = btn.dataset.mode;
                _selectBar.querySelectorAll('.confetti-scope-btn').forEach(b => b.classList.toggle('active', b === btn));
            });
        });

        _selFlipHBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_selRect) { _flipBufferH(); _updateSelectBarState(); }
        });
        _selFlipVBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_selRect) { _flipBufferV(); _updateSelectBarState(); }
        });
        _selRotateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_selRect) { _rotateBufferCW(); _updateSelectBarState(); }
        });
        _selectBar.addEventListener('mousedown', (e) => e.stopPropagation());
        _selectBar.addEventListener('click', (e) => e.stopPropagation());

        /* ── Shape sub-bar (Rect/Oval/Triangle/Diamond/Star) ── */
        _shapeBar = document.createElement('div');
        _shapeBar.className = 'ed-shape-bar';
        _shapeBar.style.display = 'none';
        _shapeBar.innerHTML = `
            <span class="confetti-scope"><button class="confetti-scope-btn active" data-shape="rect" title="Rectangle"><i class="ti ti-rectangle"></i> Rect</button><button class="confetti-scope-btn" data-shape="ellipse" title="Ellipse"><i class="ti ti-circle"></i> Oval</button><button class="confetti-scope-btn" data-shape="triangle" title="Triangle"><i class="ti ti-triangle"></i> Tri</button><button class="confetti-scope-btn" data-shape="diamond" title="Diamond"><i class="ti ti-diamond"></i> Dia</button><button class="confetti-scope-btn" data-shape="star" title="Star"><i class="ti ti-star"></i> Star</button></span>
        `;
        container.appendChild(_shapeBar);

        _shapeBar.querySelectorAll('.confetti-scope-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                _shapeMode = btn.dataset.shape;
                _shapeBar.querySelectorAll('.confetti-scope-btn').forEach(b => b.classList.toggle('active', b === btn));
                _shapeStart = null; _shapePreview = null;
                _redrawOverlay();
            });
        });
        _shapeBar.addEventListener('mousedown', (e) => e.stopPropagation());
        _shapeBar.addEventListener('click', (e) => e.stopPropagation());

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

        const _fabricWrapper = _toolbar.querySelector('.fabric-color-wrapper');
        _fabricSwatch  = _toolbar.querySelector('.ed-fabric-swatch');
        _fabricDropdown = _toolbar.querySelector('.fabric-dropdown');
        _fabricCustom  = _toolbar.querySelector('.ed-fabric-custom');

        _toolbar.querySelector('.ed-fabric-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            _fabricDropdown.classList.toggle('open');
        });
        _fabricDropdown.querySelectorAll('.fabric-preset').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                _setFabricColor(el.dataset.color);
                _fabricDropdown.classList.remove('open');
            });
        });
        _fabricCustom.addEventListener('input', (e) => {
            _setFabricColor(e.target.value);
        });

        // Event listeners — toolbar
        _toolbar.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => _setTool(btn.dataset.tool));
        });
        _undoBtn.addEventListener('click', undo);
        _redoBtn.addEventListener('click', redo);
        _toolbar.querySelector('.ed-active-color-ind').addEventListener('click', (e) => {
            e.stopPropagation();
            _toggleAddColorDropdown();
        });
        _toolbar.querySelector('.ed-mirror-h-btn').addEventListener('click', () => _toggleMirrorAxis('horizontal'));
        _toolbar.querySelector('.ed-mirror-v-btn').addEventListener('click', () => _toggleMirrorAxis('vertical'));
        _toolbar.querySelector('.ed-resize-btn').addEventListener('click', _showResizeModal);
        _toolbar.querySelector('.ed-rowcol-btn').addEventListener('click', _showRowColModal);
        _toolbar.querySelector('.ed-crop-btn').addEventListener('click', _cropToContent);

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
        _replaceTargetSearch.addEventListener('keydown', (e) => e.stopPropagation());
        _replaceTargetList.addEventListener('click', (e) => {
            const row = e.target.closest('.replace-target-row');
            if (row) _selectReplaceTarget(row.dataset.dmc);
        });
        _replaceTargetDropdown.addEventListener('click', (e) => e.stopPropagation());
        _replaceTargetDropdown.addEventListener('wheel', (e) => e.stopPropagation());

        // Event listeners — add color dropdown
        _addColorSearch.addEventListener('input', _debounce(_filterAddColorList, 150));
        _addColorSearch.addEventListener('click', (e) => e.stopPropagation());
        _addColorSearch.addEventListener('keydown', (e) => e.stopPropagation());
        _addColorList.addEventListener('click', (e) => {
            const row = e.target.closest('.replace-target-row');
            if (row) _addDmcColor(row.dataset.dmc);
        });
        _addColorDropdown.addEventListener('click', (e) => e.stopPropagation());
        _addColorDropdown.addEventListener('wheel', (e) => e.stopPropagation());

        // Close dropdowns on outside click
        _outsideClickHandler = (e) => {
            _closeReplaceDropdown(); _closeAddColorDropdown();
            if (_fabricDropdown && !_fabricWrapper.contains(e.target)) _fabricDropdown.classList.remove('open');
        };
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
        if (_confettiBar)   { _confettiBar.remove(); _confettiBar = null; }
        if (_selectBar) { _selectBar.remove(); _selectBar = null; }
        if (_shapeBar) { _shapeBar.remove(); _shapeBar = null; }
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
        handleContextMenu,
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
        setFabricColor: _setFabricColor,
        setBrand(b) { _brand = b; allDmcThreads = null; },
        setCrosshair(on) { _crosshairMode = on; _redrawOverlay(); },
        injectUI,
        removeUI,
        isUIElement:       (el) => !!el.closest('.editor-toolbar,.ed-replace-panel,.ed-confetti-bar,.ed-select-bar,.ed-shape-bar,.ed-add-color-modal,.ed-resize-modal,.ed-resize-backdrop,.ed-text-panel,.stitch-mode-bar,.zoom-controls,.fabric-dropdown'),
    };
}
