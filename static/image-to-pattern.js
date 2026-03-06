/* ——— CONSTANTS ——— */
const FABRIC_COLOR  = '#F5F0E8';
const FALLBACK_HEX  = '#888888';

if (typeof initShortcutHelp === 'function')
    initShortcutHelp(() => true);  // always in edit mode on this page

/* ——— STATE ——— */
let currentStep    = 'upload';
let selectedFile   = null;
let sessionImageAvailable = false;  // true once an image is stored server-side for this session
let regenSourcePatternSlug  = null;   // set when loading a saved pattern with a stored image
let loadedPatternSlug = null;  // non-null when loaded from ?load=ID
let cropImgUrl     = null;       // object URL for the crop-img src
let imgAspect      = null;       // naturalHeight / naturalWidth of full image
let cropShape      = 'rect';     // 'rect' | 'square' | 'circle'
let cropBox        = { x: 0, y: 0, w: 1, h: 1 };  // 0-1 fractions of image
let cropDragging   = null;       // drag state: { mode, startX, startY, startBox, overlayRect }
let patternData    = null;
let legendData     = [];
let lookup         = {};           // dmc → { hex, symbol, name, count } (module-level for editor)
let _lookupDirty   = true;
let editorInstance = null;
let savedPatternName = null;
let nativeW        = null;
let nativeH        = null;
let paletteBrand   = _pref('inventoryBrand', 'DMC');
let paletteFilter  = 'standard';
let displayFilter  = 'both';
let legendSort     = _pref('dmc-legend-sort', 'number'); // 'number' | 'stitches'
let heightLocked     = true;
let genDebounceTimer = null;
let genController    = null;
let dimMode          = 'stitches'; // 'stitches' | 'inches'
let dimFabricIdx     = 1;          // index into FABRIC_COUNTS (default 14-count Aida)

/* ——— AUTOSAVE / RECOVERY ——— */
const _autosave = createAutosaver(
    () => 'ns-autosave-itp-' + (loadedPatternSlug || 'new'),
    () => patternData,
    () => {
        legendData = patternData.legend;
        _lookupDirty = true;
        renderCanvas();
        if (editorInstance && editorInstance.isActive()) renderEditLegend(); else renderKey();
    }
);
const _scheduleAutosave = _autosave.schedule;
const _clearAutosave = _autosave.clear;
const _checkAutosaveRecovery = _autosave.checkRecovery;

/* ——— UI HELPERS (shared) ——— */
function _showResultCards() {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('canvas-card').classList.add('visible');
    document.getElementById('key-card').classList.add('visible');
    document.getElementById('btn-save-pattern').style.display = '';
    document.getElementById('edit-toggle-btn').style.display = '';
    document.getElementById('zoom-controls').style.display = '';
}

function _showThumbnailPreview(dataUrl) {
    const img = new Image();
    img.onload = function() {
        const cv = document.getElementById('crop-preview-canvas');
        cv.width  = img.naturalWidth;
        cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = dataUrl;
}

/* ——— STEP NAVIGATION ——— */
function showStep(name) {
    // Abort any in-flight generation when leaving generate step
    if (currentStep === 'generate' && name !== 'generate') {
        if (genController) genController.abort();
    }
    document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
    document.getElementById('step-' + name).classList.add('active');
    currentStep = name;
}

function setControlsReadOnly(readOnly) {
    const ids = ['ctrl-grid-w', 'ctrl-grid-h', 'ctrl-colors', 'ctrl-dither', 'ctrl-pixel-art', 'ctrl-contrast', 'ctrl-brightness'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = readOnly; });
    document.querySelectorAll('#palette-filter-toggle .seg-btn').forEach(btn => btn.disabled = readOnly);
    const lockBtn = document.getElementById('lock-height');
    if (lockBtn) lockBtn.disabled = readOnly;
    document.getElementById('no-source-notice').style.display   = readOnly ? '' : 'none';
    document.getElementById('btn-change-image').style.display    = readOnly ? '' : 'none';
    if (!readOnly) applyHeightLockState();
}

function goToUpload() {
    setControlsReadOnly(false);
    selectedFile = null;
    sessionImageAvailable = false;
    regenSourcePatternSlug  = null;
    if (cropImgUrl) { URL.revokeObjectURL(cropImgUrl); cropImgUrl = null; }
    cropBox = { x: 0, y: 0, w: 1, h: 1 };
    showStep('upload');
    // Re-enable the file input (so clicking upload zone triggers it again)
    const inp = document.getElementById('img-input');
    inp.value = '';
    document.getElementById('upload-filename').textContent = '';
    document.getElementById('convert-btn').disabled = true;
}

/* ——— DRAG & DROP on upload zone ——— */
const uploadZone = document.getElementById('upload-zone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleImageSelect(file);
});

/* ——— Restore UI preferences ——— */
if (_pref('dmc-gridlines', true) === false)
    document.getElementById('gridlines-check').checked = false;
if (_pref('dmc-symbols', true) === false)
    document.getElementById('symbols-check').checked = false;
if (legendSort !== 'number') {
    document.getElementById('sort-btn-number')?.classList.remove('active');
    document.getElementById('sort-btn-stitches')?.classList.add('active');
}
if (paletteBrand !== 'DMC') setBrand(paletteBrand);

/* ——— FILE SELECT ——— */
function handleImageSelect(file) {
    if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.type)) {
        showUploadError('Please select a JPG, PNG, GIF, or WebP image.');
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        showUploadError('Image must be 10 MB or smaller.');
        return;
    }
    clearUploadError();
    selectedFile = file;
    cropBox = { x: 0, y: 0, w: 1, h: 1 };
    cropShape = 'rect';
    document.getElementById('ctrl-pixel-art').checked = false;

    // Show filename and enable convert button
    document.getElementById('upload-filename').textContent = file.name;
    document.getElementById('convert-btn').disabled = false;
}

function startConvert() {
    if (!selectedFile) return;
    document.getElementById('convert-btn').disabled = true;

    if (cropImgUrl) URL.revokeObjectURL(cropImgUrl);
    cropImgUrl = URL.createObjectURL(selectedFile);

    const img = document.getElementById('crop-img');
    img.onload = function() {
        imgAspect = img.naturalHeight / img.naturalWidth;
        if (heightLocked) recalcAutoHeight();
        renderCropPreview();
        showStep('generate');
        generatePattern();
    };
    img.src = cropImgUrl;
}

/* ——— CROP SHAPE ——— */
function setCropShape(shape) {
    cropShape = shape;
    document.querySelectorAll('#crop-shape-toggle .seg-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['rect', 'square', 'ellipse', 'circle'][i] === shape);
    });
    // Clear existing crop so user draws fresh with new shape
    cropBox = { x: 0, y: 0, w: 1, h: 1 };
    document.getElementById('crop-rect').classList.toggle('circle', shape === 'ellipse' || shape === 'circle');
    renderCropRect();
}

function constrainToSquare(box) {
    const wrap = document.getElementById('crop-img-wrap');
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    // Work in pixel space so the selection is a true square on screen
    const sidePx = Math.min(box.w * W, box.h * H);
    const wFrac  = sidePx / W;
    const hFrac  = sidePx / H;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const x = Math.max(0, Math.min(1 - wFrac, cx - wFrac / 2));
    const y = Math.max(0, Math.min(1 - hFrac, cy - hFrac / 2));
    return { x, y, w: wFrac, h: hFrac };
}

/* ——— RENDER CROP RECT ——— */
function renderCropRect() {
    const wrap = document.getElementById('crop-img-wrap');
    const rect = document.getElementById('crop-rect');
    if (!rect || !wrap) return;

    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (W === 0 || H === 0) return;

    const isFullImage = cropBox.x < 0.001 && cropBox.y < 0.001 &&
                         cropBox.w > 0.999 && cropBox.h > 0.999;
    if (isFullImage) {
        rect.style.display = 'none';
        return;
    }
    rect.style.display = 'block';
    rect.style.left   = Math.round(cropBox.x * W) + 'px';
    rect.style.top    = Math.round(cropBox.y * H) + 'px';
    rect.style.width  = Math.round(cropBox.w * W) + 'px';
    rect.style.height = Math.round(cropBox.h * H) + 'px';
}

/* ——— CROP DRAG ——— */
function initCropOverlay() {
    const overlay = document.getElementById('crop-overlay');
    if (!overlay) return;
    overlay.addEventListener('mousedown', onCropMouseDown);
    document.addEventListener('mousemove', onCropMouseMove);
    document.addEventListener('mouseup', onCropMouseUp);
}

function onCropMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const overlay = document.getElementById('crop-overlay');
    const overlayRect = overlay.getBoundingClientRect();
    const mx = (e.clientX - overlayRect.left) / overlayRect.width;
    const my = (e.clientY - overlayRect.top) / overlayRect.height;

    let mode = 'draw';
    if (e.target.classList.contains('ch')) {
        mode = 'resize-' + e.target.dataset.handle;
    } else if (e.target === document.getElementById('crop-rect') ||
               e.target.closest('#crop-rect')) {
        mode = 'move';
    }

    cropDragging = { mode, startX: mx, startY: my, startBox: { ...cropBox }, overlayRect };

    if (mode === 'draw') {
        cropBox = { x: Math.max(0, Math.min(1, mx)), y: Math.max(0, Math.min(1, my)), w: 0, h: 0 };
        renderCropRect();
    }
}

function onCropMouseMove(e) {
    if (!cropDragging) return;
    const { mode, startX, startY, startBox, overlayRect } = cropDragging;
    const mx = Math.max(0, Math.min(1, (e.clientX - overlayRect.left) / overlayRect.width));
    const my = Math.max(0, Math.min(1, (e.clientY - overlayRect.top) / overlayRect.height));
    const dx = mx - startX;
    const dy = my - startY;

    if (mode === 'draw') {
        let x = Math.min(startX, mx);
        let y = Math.min(startY, my);
        let w = Math.abs(mx - startX);
        let h = Math.abs(my - startY);
        // Square and circle constrain to 1:1 in pixel space; ellipse is free-form
        if (cropShape === 'square' || cropShape === 'circle') {
            const W = overlayRect.width;
            const H = overlayRect.height;
            const sidePx = Math.min(w * W, h * H);
            w = sidePx / W;
            h = sidePx / H;
            x = mx < startX ? startX - w : startX;
            y = my < startY ? startY - h : startY;
        }
        cropBox = { x, y, w, h };
    } else if (mode === 'move') {
        cropBox = {
            x: Math.max(0, Math.min(1 - startBox.w, startBox.x + dx)),
            y: Math.max(0, Math.min(1 - startBox.h, startBox.y + dy)),
            w: startBox.w, h: startBox.h,
        };
    } else if (mode.startsWith('resize-')) {
        const handle = mode.slice(7);
        const fixedX = handle.includes('e') ? startBox.x : startBox.x + startBox.w;
        const fixedY = handle.includes('s') ? startBox.y : startBox.y + startBox.h;
        let newX, newY, newW, newH;
        if (handle.includes('w')) {
            newX = Math.max(0, Math.min(fixedX - 0.01, mx));
            newW = fixedX - newX;
        } else {
            newX = fixedX;
            newW = Math.max(0.01, Math.min(1 - fixedX, mx - fixedX));
        }
        if (handle.includes('n')) {
            newY = Math.max(0, Math.min(fixedY - 0.01, my));
            newH = fixedY - newY;
        } else {
            newY = fixedY;
            newH = Math.max(0.01, Math.min(1 - fixedY, my - fixedY));
        }
        // Square and circle: enforce pixel-space square during resize
        if (cropShape === 'square' || cropShape === 'circle') {
            const W = overlayRect.width;
            const H = overlayRect.height;
            const sidePx = Math.min(newW * W, newH * H);
            newW = sidePx / W;
            newH = sidePx / H;
            newX = handle.includes('e') ? fixedX : fixedX - newW;
            newY = handle.includes('s') ? fixedY : fixedY - newH;
        }
        cropBox = { x: newX, y: newY, w: newW, h: newH };
    }
    renderCropRect();
}

function onCropMouseUp() {
    if (!cropDragging) return;
    if (cropBox.w < 0.02 || cropBox.h < 0.02) {
        cropBox = { x: 0, y: 0, w: 1, h: 1 };
    } else if (cropShape === 'square' || cropShape === 'circle') {
        // Snap to perfect square on release (ellipse stays free-form)
        cropBox = constrainToSquare(cropBox);
    }
    cropDragging = null;
    renderCropRect();
}

/* ——— GRID DIMENSION CONTROLS ——— */
function onWidthSlider(val) {
    updateVal('val-grid-w', dimMode === 'inches' ? parseFloat(val).toFixed(1) : val);
    if (heightLocked) recalcAutoHeight();
    if (currentStep === 'generate') scheduleRegenerate();
}

function onHeightSlider(val) {
    updateVal('val-grid-h', dimMode === 'inches' ? parseFloat(val).toFixed(1) : val);
    if (currentStep === 'generate') scheduleRegenerate();
}

function toggleHeightLock() {
    heightLocked = !heightLocked;
    applyHeightLockState();
    if (heightLocked) {
        recalcAutoHeight();
        if (currentStep === 'generate') scheduleRegenerate();
    }
}

function applyHeightLockState() {
    const btn = document.getElementById('lock-height');
    const slider = document.getElementById('ctrl-grid-h');
    if (heightLocked) {
        btn.classList.add('locked');
        btn.title = 'Locked: auto from aspect ratio. Click to unlock.';
        btn.querySelector('.lock-icon').innerHTML = '<i class="ti ti-lock"></i>';
        slider.disabled = true;
    } else {
        btn.classList.remove('locked');
        btn.title = 'Unlocked: manual height. Click to lock to aspect ratio.';
        btn.querySelector('.lock-icon').innerHTML = '<i class="ti ti-lock-open"></i>';
        slider.disabled = false;
    }
}

function recalcAutoHeight() {
    if (!imgAspect && !patternData) return null;
    // Compute crop-aware aspect ratio (shared by both modes)
    let aspect;
    if (cropBox.w < 0.999 || cropBox.h < 0.999 || cropBox.x > 0.001 || cropBox.y > 0.001) {
        aspect = imgAspect && cropBox.w > 0 ? (cropBox.h / cropBox.w) * imgAspect : (imgAspect || 1);
    } else {
        aspect = imgAspect || (patternData ? patternData.grid_h / patternData.grid_w : 1);
    }
    if (dimMode === 'inches') {
        const wIn = parseFloat(document.getElementById('ctrl-grid-w').value);
        const hIn = Math.max(1, Math.round(wIn * aspect * 2) / 2); // snap to 0.5
        const slider = document.getElementById('ctrl-grid-h');
        slider.max = Math.max(30, hIn);
        slider.value = hIn;
        updateVal('val-grid-h', hIn.toFixed(1));
        return hIn;
    }
    const w = parseInt(document.getElementById('ctrl-grid-w').value);
    const h = Math.max(25, Math.round(w * aspect));
    const slider = document.getElementById('ctrl-grid-h');
    slider.max = Math.max(250, h);
    slider.value = h;
    updateVal('val-grid-h', h);
    return h;
}

/* ——— DIMENSION MODE (Stitches / Inches) ——— */
function getEffectiveFabricCount() {
    const f = FABRIC_COUNTS[dimFabricIdx];
    return (f.count >= 25) ? f.count / 2 : f.count;
}

function inchesToStitches(inches) {
    return Math.max(25, Math.round(inches * getEffectiveFabricCount()));
}

function stitchesToInches(stitches) {
    return stitches / getEffectiveFabricCount();
}

function getDimStitchValues() {
    /* Return { w, h } in stitches regardless of current mode */
    if (dimMode === 'inches') {
        const wIn = parseFloat(document.getElementById('ctrl-grid-w').value) || 7;
        const hIn = parseFloat(document.getElementById('ctrl-grid-h').value) || 7;
        return { w: inchesToStitches(wIn), h: inchesToStitches(hIn) };
    }
    return {
        w: parseInt(document.getElementById('ctrl-grid-w').value),
        h: parseInt(document.getElementById('ctrl-grid-h').value)
    };
}

function setDimMode(mode) {
    if (mode === dimMode) return;
    const wSlider = document.getElementById('ctrl-grid-w');
    const hSlider = document.getElementById('ctrl-grid-h');
    const prev = getDimStitchValues();

    dimMode = mode;

    // Toggle active button
    document.querySelectorAll('#dim-mode-toggle .seg-btn').forEach((btn, i) => {
        btn.classList.toggle('active', (i === 0 && mode === 'stitches') || (i === 1 && mode === 'inches'));
    });

    // Show/hide fabric selector
    document.getElementById('dim-fabric-group').style.display = mode === 'inches' ? '' : 'none';

    // Update labels
    const unit = mode === 'inches' ? 'inches' : 'stitches';
    document.getElementById('label-w').textContent = `Width (${unit})`;
    const labelH = document.getElementById('label-h');
    const lockBtn = document.getElementById('lock-height');
    labelH.textContent = `Height (${unit}) `;
    labelH.appendChild(lockBtn);

    if (mode === 'inches') {
        const eff = getEffectiveFabricCount();
        const wIn = Math.round(prev.w / eff * 2) / 2; // snap to 0.5
        const hIn = Math.round(prev.h / eff * 2) / 2;
        wSlider.min = 1; wSlider.max = 30; wSlider.step = 0.5;
        wSlider.value = wIn;
        updateVal('val-grid-w', wIn.toFixed(1));
        hSlider.min = 1; hSlider.max = Math.max(30, hIn); hSlider.step = 0.5;
        hSlider.value = hIn;
        updateVal('val-grid-h', hIn.toFixed(1));
        // Re-bind click-to-edit for decimal values
        rebindClickToEdit();
    } else {
        wSlider.min = 25; wSlider.max = 250; wSlider.step = 1;
        wSlider.value = prev.w;
        updateVal('val-grid-w', prev.w);
        hSlider.min = 25; hSlider.max = Math.max(250, prev.h); hSlider.step = 1;
        hSlider.value = prev.h;
        updateVal('val-grid-h', prev.h);
        rebindClickToEdit();
    }
}

function setDimFabric(idx) {
    dimFabricIdx = idx;
    if (dimMode === 'inches') {
        // Recalc: keep inch values, stitch counts change → regenerate
        if (heightLocked) recalcAutoHeight();
        if (currentStep === 'generate') scheduleRegenerate();
    }
    // Sync with output-area fabric dropdown
    selectFabric(dimFabricIdx);
}

function rebindClickToEdit() {
    if (dimMode === 'inches') {
        makeClickToEdit('val-grid-w', 'ctrl-grid-w', 1, 30, v => onWidthSlider(v), true);
        makeClickToEdit('val-grid-h', 'ctrl-grid-h', 1, 30, v => {
            if (heightLocked) { heightLocked = false; applyHeightLockState(); }
            onHeightSlider(v);
        }, true);
    } else {
        makeClickToEdit('val-grid-w', 'ctrl-grid-w', 25, 250, v => onWidthSlider(v));
        makeClickToEdit('val-grid-h', 'ctrl-grid-h', 25, 250, v => {
            if (heightLocked) { heightLocked = false; applyHeightLockState(); }
            onHeightSlider(v);
        });
    }
}

/* Reusable click-to-edit for slider value spans */
function makeClickToEdit(spanId, sliderId, min, max, onCommit, decimal) {
    function handler() {
        const span = document.getElementById(spanId);
        if (!span) return;
        const current = decimal ? parseFloat(span.textContent) : parseInt(span.textContent);
        if (isNaN(current)) return;
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'ctrl-val-input';
        if (decimal) { input.step = '0.5'; input.style.width = '4em'; }
        const slider = document.getElementById(sliderId);
        const effectiveMax = slider ? parseFloat(slider.max) || max : max;
        input.min = min;
        input.max = effectiveMax;
        input.value = current;
        span.replaceWith(input);
        input.focus();
        input.select();

        function commit() {
            let v = decimal ? parseFloat(input.value) : parseInt(input.value);
            if (isNaN(v)) v = current;
            v = Math.max(min, Math.min(effectiveMax, v));
            if (decimal) v = Math.round(v * 2) / 2; // snap to 0.5
            const newSpan = document.createElement('span');
            newSpan.className = 'ctrl-val ctrl-val-editable';
            newSpan.id = spanId;
            newSpan.title = 'Click to type a value';
            newSpan.textContent = decimal ? v.toFixed(1) : v;
            input.replaceWith(newSpan);
            if (slider) slider.value = v;
            newSpan.addEventListener('click', handler);
            if (onCommit) onCommit(v);
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = current; input.blur(); }
        });
    }
    const el = document.getElementById(spanId);
    if (el) el.addEventListener('click', handler);
    return handler;
}

makeClickToEdit('val-grid-w', 'ctrl-grid-w', 25, 250, v => onWidthSlider(v));
makeClickToEdit('val-grid-h', 'ctrl-grid-h', 25, 250, v => {
    if (heightLocked) { heightLocked = false; applyHeightLockState(); }
    onHeightSlider(v);
});
makeClickToEdit('val-colors', 'ctrl-colors', 5, 34, () => scheduleRegenerate());

/* ——— CROP MODAL ——— */
let prevCropBox = null;
let prevCropShape = null;

async function openCropModal() {
    // If no client-side image URL, fetch from session
    if (!cropImgUrl && sessionImageAvailable) {
        try {
            const resp = await fetch('/api/image/session-source');
            if (resp.ok) {
                const blob = await resp.blob();
                cropImgUrl = URL.createObjectURL(blob);
                const img = document.getElementById('crop-img');
                img.src = cropImgUrl;
                await new Promise(resolve => { img.onload = resolve; });
                imgAspect = img.naturalHeight / img.naturalWidth;
            }
        } catch (e) { /* ignore — modal will show but image may be missing */ }
    }
    prevCropBox = { ...cropBox };
    prevCropShape = cropShape;
    // Hide page content behind modal (sticky elements can paint above fixed overlays)
    document.getElementById('step-generate').style.display = 'none';
    document.body.style.overflow = 'hidden';
    document.getElementById('crop-modal').style.display = 'flex';
    requestAnimationFrame(renderCropRect);
}

function closeCropModal(apply) {
    document.getElementById('crop-modal').style.display = 'none';
    document.getElementById('step-generate').style.display = '';
    document.body.style.overflow = '';
    if (apply) {
        renderCropPreview();
        generatePattern();
    } else {
        // Restore previous crop state
        cropBox = prevCropBox || cropBox;
        cropShape = prevCropShape || cropShape;
    }
    prevCropBox = null;
    prevCropShape = null;
}

function renderCropPreview() {
    const canvas = document.getElementById('crop-preview-canvas');
    const img    = document.getElementById('crop-img');
    if (!img || !img.naturalWidth) return;

    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const sx = Math.round(cropBox.x * nw);
    const sy = Math.round(cropBox.y * nh);
    const sw = Math.max(1, Math.round(cropBox.w * nw));
    const sh = Math.max(1, Math.round(cropBox.h * nh));

    // Set canvas to crop's aspect ratio, capped at 240px wide
    const aspect = sh / sw;
    const cw = 240;
    const ch = Math.max(1, Math.round(cw * aspect));
    canvas.width  = cw;
    canvas.height = ch;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);

    if (cropShape === 'circle' || cropShape === 'ellipse') {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cw / 2, ch / 2, cw / 2, ch / 2, 0, 0, Math.PI * 2);
        ctx.clip();
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
    if (cropShape === 'circle' || cropShape === 'ellipse') ctx.restore();
}

/* ——— BRAND / PALETTE / DISPLAY FILTER ——— */
function setBrand(brand) {
    paletteBrand = brand;
    localStorage.setItem('inventoryBrand', brand);
    document.querySelectorAll('#brand-toggle .seg-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['DMC', 'Anchor'][i] === brand);
    });
    // Anchor has only Standard — hide palette filter and force 'standard'
    const pfGroup = document.getElementById('palette-filter-group');
    if (brand === 'Anchor') {
        pfGroup.style.display = 'none';
        paletteFilter = 'standard';
    } else {
        pfGroup.style.display = '';
    }
    // Update editor brand (clears cached thread list for replace/add-color)
    if (editorInstance) editorInstance.setBrand(brand);
    scheduleRegenerate();
}

function setPaletteFilter(val) {
    paletteFilter = val;
    document.querySelectorAll('#palette-filter-toggle .seg-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['standard', 'special', 'both'][i] === val);
    });
    scheduleRegenerate();
}

function setDisplayFilter(val) {
    displayFilter = val;
    document.querySelectorAll('#display-filter-toggle .seg-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['standard', 'special', 'both'][i] === val);
    });
    if (editorInstance && editorInstance.isActive()) renderEditLegend(); else renderKey();
}

/* ——— CONTROL HELPERS ——— */
function updateVal(id, val) {
    document.getElementById(id).textContent = val;
}

/* ——— GENERATE ——— */
function scheduleRegenerate() {
    if (!selectedFile && !sessionImageAvailable && regenSourcePatternSlug === null) return;
    clearTimeout(genDebounceTimer);
    genDebounceTimer = setTimeout(generatePattern, 650);
}

async function generatePattern() {
    if (!selectedFile && !sessionImageAvailable && regenSourcePatternSlug === null) return;

    if (genController) genController.abort();
    genController = new AbortController();

    clearError();
    showSpinner(true);

    const fd = new FormData();
    // Image source branching
    if (selectedFile) {
        fd.append('image', selectedFile);
    } else if (sessionImageAvailable) {
        fd.append('use_session_image', 'true');
    } else if (regenSourcePatternSlug !== null) {
        fd.append('source_pattern_slug', String(regenSourcePatternSlug));
    } else {
        showSpinner(false);
        return;
    }
    const dimSt = getDimStitchValues();
    fd.append('grid_width',     String(dimSt.w));
    fd.append('grid_height',    heightLocked ? '0' : String(dimSt.h));
    fd.append('num_colors',     document.getElementById('ctrl-colors').value);
    fd.append('dither',         document.getElementById('ctrl-dither').checked ? 'true' : 'false');
    fd.append('contrast',       document.getElementById('ctrl-contrast').value);
    fd.append('brightness',     document.getElementById('ctrl-brightness').value);
    fd.append('palette_filter', paletteFilter);
    fd.append('palette_brand',  paletteBrand);
    fd.append('pixel_art',      document.getElementById('ctrl-pixel-art').checked ? 'true' : 'false');
    fd.append('crop_left',      cropBox.x.toFixed(4));
    fd.append('crop_top',       cropBox.y.toFixed(4));
    fd.append('crop_right',     (cropBox.x + cropBox.w).toFixed(4));
    fd.append('crop_bottom',    (cropBox.y + cropBox.h).toFixed(4));
    fd.append('crop_shape',     cropShape);

    try {
        const resp = await fetch('/api/image/generate', {
            method: 'POST', body: fd,
            signal: genController.signal,
        });
        const data = await resp.json();

        if (!resp.ok || data.error) {
            showError(data.error || 'Generation failed.');
            showSpinner(false);
            return;
        }

        // Mark session image as available once server confirms storage.
        // Clear selectedFile so subsequent regens use Branch B (session image)
        // rather than re-uploading the file on every slider change.
        if (data.image_stored || data.native_w) {
            sessionImageAvailable = true;
            regenSourcePatternSlug  = null;  // promoted to session image
            selectedFile = null;
        }

        patternData = data;
        legendData  = data.legend.slice();
        _lookupDirty = true;
        nativeW     = data.native_w || null;
        nativeH     = data.native_h || null;

        const hSlider = document.getElementById('ctrl-grid-h');
        if (dimMode === 'inches') {
            const hIn = Math.round(stitchesToInches(data.grid_h) * 2) / 2;
            hSlider.max = Math.max(30, hIn);
            hSlider.value = hIn;
            updateVal('val-grid-h', hIn.toFixed(1));
        } else {
            hSlider.max = Math.max(250, data.grid_h);
            hSlider.value = data.grid_h;
            updateVal('val-grid-h', data.grid_h);
        }

        showSpinner(false);
        _showResultCards();

        canvasCellPx = 19;
        renderCanvas();
        renderKey();
        updateFabricSize();

        // Set up or reset shared editor
        ensureEditor();
        if (editorInstance.isActive()) {
            editorInstance.deactivate();
            document.getElementById('edit-toggle-btn').textContent = 'Edit';
            document.getElementById('step-generate').classList.remove('edit-fullscreen');
            document.body.style.overflow = '';
        }
        editorInstance.reset();
        document.getElementById('edit-toggle-btn').style.display = '';

    } catch (err) {
        if (err.name === 'AbortError') { showSpinner(false); return; }
        showError('Network error: ' + err.message);
        showSpinner(false);
    }
}

/* ——— CANVAS PAN / ZOOM STATE ——— */
let canvasCellPx = 19;
const MAX_CELL_PX = 80;
let cvScale = 1.0;
let cvPanX = 0, cvPanY = 0;
let _cvDragging = false;
let _cvDragSX = 0, _cvDragSY = 0, _cvPanSX = 0, _cvPanSY = 0;
let _snapTimer = null;

function applyCanvasTransform() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (wrapper) wrapper.style.transform = `translate(${cvPanX}px,${cvPanY}px) scale(${cvScale})`;
    _renderRulers();
    const zl = document.getElementById('zoom-level');
    if (zl) zl.textContent = Math.round(canvasCellPx * cvScale / 19 * 100) + '%';
}

function _renderRulers() {
    if (!patternData) return;
    renderRulers(patternData.grid_w, patternData.grid_h, canvasCellPx, cvScale, cvPanX, cvPanY);
}

function fitCanvasToView() {
    const area   = document.getElementById('canvas-area');
    const canvas = document.getElementById('pattern-canvas');
    if (!canvas.width || !canvas.height || !area) return;
    cvScale = Math.min(area.clientWidth / canvas.width, area.clientHeight / canvas.height, 1.0);
    cvPanX  = (area.clientWidth  - canvas.width  * cvScale) / 2;
    cvPanY  = (area.clientHeight - canvas.height * cvScale) / 2;
    applyCanvasTransform();
}

/* ——— Sharp zoom: re-render canvas at actual resolution after gesture settles ——— */
function scheduleSnap() {
    if (_snapTimer) clearTimeout(_snapTimer);
    _snapTimer = setTimeout(snapCellPx, 150);
}

function snapCellPx() {
    const newCellPx = Math.max(2, Math.min(MAX_CELL_PX, Math.round(canvasCellPx * cvScale)));
    if (newCellPx === canvasCellPx && Math.abs(cvScale - 1.0) < 0.001) return;
    const ratio = newCellPx / canvasCellPx;
    const area  = document.getElementById('canvas-area');
    const scx   = area.clientWidth  / 2;
    const scy   = area.clientHeight / 2;
    cvPanX  = scx - (scx - cvPanX) * ratio / cvScale;
    cvPanY  = scy - (scy - cvPanY) * ratio / cvScale;
    cvScale = 1.0;
    canvasCellPx = newCellPx;
    renderCanvas(true);
    applyCanvasTransform();
}

/* ——— CANVAS RENDER ——— */
function renderCanvas(skipFit) {
    if (!patternData) return;

    const cellPx = canvasCellPx;

    const { grid, grid_w, grid_h, legend } = patternData;
    const showGrid = document.getElementById('gridlines-check').checked;
    const showSymbols = document.getElementById('symbols-check').checked;
    const showStitch = document.getElementById('stitch-check').checked;

    if (_lookupDirty) {
        lookup = {};
        for (const e of legend) {
            const hex = e.hex || FALLBACK_HEX;
            lookup[e.dmc] = { hex, symbol: e.symbol, name: e.name || '', count: e.stitches || 0, dashIdx: 0, contrast: contrastColor(hex) };
        }
        if (patternData.backstitches && patternData.backstitches.length > 0) {
            const bsDmcs = [...new Set(patternData.backstitches.map(bs => bs.dmc))];
            bsDmcs.forEach((dmc, i) => { if (lookup[dmc]) lookup[dmc].dashIdx = i + 1; });
        }
        _lookupDirty = false;
    }

    const W = grid_w * cellPx;
    const H = grid_h * cellPx;

    const canvas = document.getElementById('pattern-canvas');
    const needsFit = (canvas.width !== W || canvas.height !== H);
    canvas.width  = W;
    canvas.height = H;
    // Size overlay canvas to match
    const overlay = document.getElementById('overlay-canvas');
    if (overlay) { overlay.width = W; overlay.height = H; }
    const ctx = canvas.getContext('2d');

    if (showStitch) {
        /* ——— STITCH VIEW ——— */
        const fabColor = FABRIC_COLOR;
        ctx.fillStyle = fabColor;
        ctx.fillRect(0, 0, W, H);
        /* Fabric texture: weave + aida dots (before stitches so it's behind them) */
        drawStitchFabric(ctx, W, H, cellPx, grid_w, grid_h, fabColor);

        for (let row = 0; row < grid_h; row++) {
            for (let col = 0; col < grid_w; col++) {
                const dmc  = grid[row * grid_w + col];
                if (dmc === 'BG') {
                    // Overwrite fabric weave texture on BG cells
                    ctx.fillStyle = fabColor;
                    ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
                    continue;
                }
                const info = lookup[dmc] || { hex: FALLBACK_HEX };
                drawStitch(ctx, col * cellPx, row * cellPx, cellPx, info.hex, fabColor);
            }
        }
    } else {
        /* ——— FLAT VIEW ——— */
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        const fontSize = Math.max(6, Math.floor(cellPx * 0.72));
        ctx.font = `${fontSize}px "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "IBM Plex Mono", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let row = 0; row < grid_h; row++) {
            for (let col = 0; col < grid_w; col++) {
                const dmc  = grid[row * grid_w + col];
                if (dmc === 'BG') continue;
                const info = lookup[dmc] || { hex: FALLBACK_HEX, symbol: '?' };
                const x = col * cellPx;
                const y = row * cellPx;

                ctx.fillStyle = info.hex;
                ctx.fillRect(x, y, cellPx, cellPx);

                if (cellPx >= 8 && showSymbols) {
                    ctx.fillStyle = info.contrast;
                    ctx.fillText(info.symbol, x + cellPx / 2, y + cellPx / 2);
                }
            }
        }
    }

    /* Part stitches (half, quarter, three-quarter) */
    if (patternData.part_stitches && patternData.part_stitches.length > 0 && cellPx >= 3) {
        for (const ps of patternData.part_stitches) {
            const info = lookup[ps.dmc];
            if (!info) continue;
            const { sx, sy } = _resolvePartFields(ps);
            if (showStitch) {
                drawThreadPartStitch(ctx, sx * cellPx, sy * cellPx, cellPx, ps, info.hex);
            } else {
                drawChartPartStitch(ctx, sx * cellPx, sy * cellPx, cellPx, ps, info.hex, info.symbol, { showSymbol: showSymbols });
            }
        }
    }

    if (showGrid && cellPx >= 4) {
        // Thin gridlines — batched into one path
        ctx.strokeStyle = showStitch ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let col = 0; col <= grid_w; col++) { ctx.moveTo(col * cellPx, 0); ctx.lineTo(col * cellPx, H); }
        for (let row = 0; row <= grid_h; row++) { ctx.moveTo(0, row * cellPx); ctx.lineTo(W, row * cellPx); }
        ctx.stroke();
        // Bold gridlines every 10th — batched into one path
        if (showStitch) {
            ctx.strokeStyle = 'rgba(0,0,0,0.55)';
            ctx.lineWidth = Math.max(1, cellPx / 7);
            ctx.beginPath();
            for (let col = 0; col <= grid_w; col += 10) { ctx.moveTo(col * cellPx, 0); ctx.lineTo(col * cellPx, H); }
            for (let row = 0; row <= grid_h; row += 10) { ctx.moveTo(0, row * cellPx); ctx.lineTo(W, row * cellPx); }
            ctx.stroke();
        }
    }

    /* Backstitches — on top of gridlines */
    if (patternData.backstitches && patternData.backstitches.length > 0) {
        for (const bs of patternData.backstitches) {
            const info = lookup[bs.dmc];
            if (!info) continue;
            const p1 = stitchIntersectionPx(bs.x1, bs.y1, 0, 0, cellPx);
            const p2 = stitchIntersectionPx(bs.x2, bs.y2, 0, 0, cellPx);
            if (showStitch) {
                drawBackstitch(ctx, p1.x, p1.y, p2.x, p2.y, info.hex, cellPx);
            } else {
                drawChartBackstitch(ctx, p1.x, p1.y, p2.x, p2.y, info.hex, cellPx, info.dashIdx || 0);
            }
        }
    }

    /* French knots — topmost layer */
    if (patternData.knots && patternData.knots.length > 0) {
        for (const k of patternData.knots) {
            const info = lookup[k.dmc];
            if (!info) continue;
            const pt = stitchIntersectionPx(k.x, k.y, 0, 0, cellPx);
            if (showStitch) {
                drawFrenchKnot(ctx, pt.x, pt.y, info.hex, cellPx);
            } else {
                drawChartFrenchKnot(ctx, pt.x, pt.y, info.hex, cellPx, info.symbol, { showSymbol: showSymbols });
            }
        }
    }

    /* Beads — topmost layer (above knots) */
    if (patternData.beads && patternData.beads.length > 0) {
        for (const b of patternData.beads) {
            const info = lookup[b.dmc];
            if (!info) continue;
            const pt = stitchCellCenterPx(b.x, b.y, 0, 0, cellPx);
            if (showStitch) {
                drawBead(ctx, pt.x, pt.y, info.hex, cellPx);
            } else {
                drawChartBead(ctx, pt.x, pt.y, info.hex, cellPx, info.symbol, { showSymbol: showSymbols });
            }
        }
    }

    const totalSt = grid_w * grid_h;
    document.getElementById('canvas-info').textContent =
        `${grid_w} × ${grid_h} stitches · ${totalSt.toLocaleString()} total · ${legend.length} colors`;

    if (needsFit && !skipFit) fitCanvasToView();
    else _renderRulers();
}

/* ——— STITCH / SYMBOL TOGGLE ——— */
function onStitchToggle() {
    const stitch = document.getElementById('stitch-check');
    if (stitch.checked) {
        document.getElementById('symbols-check').checked = false;
    }
    renderCanvas();
}
function onSymbolsToggle() {
    const symbols = document.getElementById('symbols-check');
    if (symbols.checked) {
        document.getElementById('stitch-check').checked = false;
    }
    renderCanvas();
}

/* ——— EDITOR TOGGLE ——— */
function ensureEditor() {
    if (editorInstance) return;
    editorInstance = createPatternEditor({
        brand:            paletteBrand,
        container:        document.getElementById('canvas-area'),
        getPatternData:   () => patternData,
        getLookup:        () => lookup,
        setLookup:        (l) => { lookup = l; _lookupDirty = false; },
        eventToStitch:    (e) => {
            const area = document.getElementById('canvas-area');
            const rect = area.getBoundingClientRect();
            const canvasX = (e.clientX - rect.left - cvPanX) / cvScale;
            const canvasY = (e.clientY - rect.top  - cvPanY) / cvScale;
            const col = Math.floor(canvasX / canvasCellPx);
            const row = Math.floor(canvasY / canvasCellPx);
            if (!patternData || col < 0 || col >= patternData.grid_w || row < 0 || row >= patternData.grid_h) return null;
            return { col, row };
        },
        eventToSubCell:   (e) => {
            const area = document.getElementById('canvas-area');
            const rect = area.getBoundingClientRect();
            const canvasX = (e.clientX - rect.left - cvPanX) / cvScale;
            const canvasY = (e.clientY - rect.top  - cvPanY) / cvScale;
            const gx = canvasX / canvasCellPx;
            const gy = canvasY / canvasCellPx;
            if (!patternData || gx < 0 || gx > patternData.grid_w || gy < 0 || gy > patternData.grid_h) return null;
            return { gx, gy };
        },
        renderSingleCell: (col, row) => {
            const canvas = document.getElementById('pattern-canvas');
            const ctx = canvas.getContext('2d');
            const cp = canvasCellPx;
            const x = col * cp, y = row * cp;
            const dmc = patternData.grid[row * patternData.grid_w + col];
            const stitchMode = document.getElementById('stitch-check').checked;

            if (stitchMode) {
                const fabColor = FABRIC_COLOR;
                ctx.fillStyle = fabColor;
                ctx.fillRect(x, y, cp, cp);
                if (dmc !== 'BG') {
                    const info = lookup[dmc];
                    if (info) drawStitch(ctx, x, y, cp, info.hex, fabColor);
                }
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(x, y, cp, cp);
                if (dmc !== 'BG') {
                    const info = lookup[dmc];
                    if (info) {
                        drawFullStitch(ctx, x, y, cp, info.hex, info.symbol,
                            { showSymbol: document.getElementById('symbols-check').checked });
                    }
                }
            }
            /* Part stitches in this cell */
            if (patternData.part_stitches && cp >= 3) {
                for (const ps of patternData.part_stitches) {
                    const { sx, sy } = _resolvePartFields(ps);
                    if (sx !== col || sy !== row) continue;
                    const info = lookup[ps.dmc];
                    if (!info) continue;
                    if (stitchMode) {
                        drawThreadPartStitch(ctx, x, y, cp, ps, info.hex);
                    } else {
                        drawChartPartStitch(ctx, x, y, cp, ps, info.hex, info.symbol,
                            { showSymbol: document.getElementById('symbols-check').checked });
                    }
                }
            }
            if (!stitchMode && document.getElementById('gridlines-check').checked && cp >= 4) {
                ctx.strokeStyle = 'rgba(0,0,0,0.18)';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(x, y, cp, cp);
            }
        },
        renderAll:        () => renderCanvas(),
        renderLegend:     () => { legendData = patternData.legend; _lookupDirty = true; if (editorInstance && editorInstance.isActive()) renderEditLegend(); else renderKey(); },
        getOverlayCanvas: () => document.getElementById('overlay-canvas'),
        getCellPx:        () => canvasCellPx,
        getGridOffset:    () => ({ x: 0, y: 0 }),
        onDirty:          () => { _scheduleAutosave(); },
        onClean:          () => {},
        onSave:           null,
        symbolSet:        (window._PAGE_CONFIG && window._PAGE_CONFIG.patternSymbols) || "+×#@*!=?%&~^$●■▲◆★§¶†‡±÷◎⊕⊗≠√∞⊞⬡¤※",
    });
    editorInstance.injectUI();
}

function toggleCanvasEdit() {
    ensureEditor();
    if (!editorInstance) return;
    const stepEl = document.getElementById('step-generate');
    const btn    = document.getElementById('edit-toggle-btn');
    const legBtn = document.getElementById('edit-fs-legend-toggle');

    if (editorInstance.isActive()) {
        /* ——— EXIT fullscreen edit ——— */
        editorInstance.deactivate();
        stepEl.classList.remove('edit-fullscreen');
        btn.textContent = 'Edit';
        document.body.style.overflow = '';
        if (legBtn) legBtn.style.display = 'none';
        const kc = document.getElementById('key-card');
        kc.classList.remove('legend-open');
        kc.style.width = '';  /* clear resize-handle inline width */
        renderKey(); /* restore table view */
        requestAnimationFrame(() => { fitCanvasToView(); _renderRulers(); });
    } else {
        /* ——— ENTER fullscreen edit ——— */
        editorInstance.activate();
        stepEl.classList.add('edit-fullscreen');
        btn.textContent = 'Done Editing';
        document.body.style.overflow = 'hidden';
        if (legBtn && window.innerWidth <= 768) legBtn.style.display = '';
        renderEditLegend(); /* compact row view */
        requestAnimationFrame(() => { fitCanvasToView(); _renderRulers(); });
    }
}

function toggleEditLegend() {
    const kc  = document.getElementById('key-card');
    const btn = document.getElementById('edit-fs-legend-toggle');
    kc.classList.toggle('legend-open');
    if (btn) btn.innerHTML = kc.classList.contains('legend-open') ? 'Legend <i class="ti ti-chevron-down"></i>' : 'Legend <i class="ti ti-chevron-up"></i>';
}

/* ——— FULLSCREEN KEY SIDEBAR RESIZE ——— */
(function() {
    const handle = document.getElementById('edit-fs-resize-handle');
    const panel  = document.getElementById('key-card');
    const MIN_W  = 180, MAX_W = 520;
    let _rDrag = false, _rStartX = 0, _rStartW = 280;

    handle.addEventListener('mousedown', function(e) {
        _rDrag = true;
        _rStartX = e.clientX;
        _rStartW = panel.offsetWidth;
        handle.classList.add('resizing');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
        if (!_rDrag) return;
        const w = Math.max(MIN_W, Math.min(MAX_W, _rStartW + (_rStartX - e.clientX)));
        panel.style.width = w + 'px';
    });
    document.addEventListener('mouseup', function() {
        if (!_rDrag) return;
        _rDrag = false;
        handle.classList.remove('resizing');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    });
})();

/* ——— DOWNLOAD MENU ——— */
function toggleDownloadMenu(e) {
    e.stopPropagation();
    closeFabricMenu();
    document.getElementById('download-menu').classList.toggle('open');
}
function closeDownloadMenu() {
    document.getElementById('download-menu').classList.remove('open');
}
document.addEventListener('click', closeDownloadMenu);

/* ——— DOWNLOAD ——— */
function downloadCanvas() {
    const canvas = document.getElementById('pattern-canvas');
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'cross-stitch-pattern.png';
    a.click();
}

async function downloadPDF() {
    if (!patternData) return;
    if (typeof window.jspdf === 'undefined') {
        await alertDialog('jsPDF not loaded — refresh and try again.', { type: 'error' });
        return;
    }
    const btn = document.querySelector('.download-btn');
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> Generating…';
    try {
        const name = savedPatternName || (selectedFile?.name?.replace(/\.[^.]+$/, '')) || 'Cross Stitch Pattern';
        await generatePatternPDF(name, patternData, {
            skipBG: true, symbolScale: 0.72,
            onProgress(done, total) {
                btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> ' + done + '/' + total;
            }
        });
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHTML;
    }
}

/* ——— COLOR KEY ——— */
function filteredLegend() {
    let rows;
    if (displayFilter === 'standard') rows = legendData.filter(e => e.category === 'Standard');
    else if (displayFilter === 'special') rows = legendData.filter(e => e.category !== 'Standard');
    else rows = [...legendData];
    return rows.sort(legendSort === 'stitches'
        ? (a, b) => (b.stitches || 0) - (a.stitches || 0)
        : (a, b) => dmcSortKey(a.dmc) - dmcSortKey(b.dmc) || String(a.dmc).localeCompare(String(b.dmc))
    );
}

function setLegendSort(mode) {
    legendSort = mode;
    localStorage.setItem('dmc-legend-sort', mode);
    document.getElementById('sort-btn-number')?.classList.toggle('active', mode === 'number');
    document.getElementById('sort-btn-stitches')?.classList.toggle('active', mode === 'stitches');
    if (editorInstance && editorInstance.isActive()) renderEditLegend(); else renderKey();
}

function renderKey() {
    const wrap = document.getElementById('key-table-wrap');

    const rows = filteredLegend();

    let html = `
        <table class="key-table">
            <thead>
                <tr>
                    <th style="width:36px;text-align:center">Sym</th>
                    <th style="width:32px"></th>
                    <th>${paletteBrand}</th>
                    <th>Name</th>
                    <th>Stitches</th>
                    <th>Status</th>
                    <th style="width:36px"></th>
                </tr>
            </thead>
            <tbody>
    `;

    for (const e of rows) {
        const swatchColor = safeHex(e.hex);
        const sc = STATUS_CLASS[e.status] || 'status-not_found';
        const sl = STATUS_LABEL[e.status] || e.status;
        html += `
            <tr data-dmc="${escHtml(e.dmc)}" class="key-row">
                <td class="sym-cell">${escHtml(e.symbol)}</td>
                <td><span class="swatch" data-sym="${escHtml(e.symbol)}" style="background:${swatchColor}"></span></td>
                <td><span class="dmc-num">${escHtml(e.dmc)}</span></td>
                <td><span class="thread-name">${escHtml(e.name || '—')}</span></td>
                <td>${fmtStitches(e.stitches)}</td>
                <td><span class="status-badge ${sc}">${sl}</span></td>
                <td class="leg-replace-cell"><button class="leg-replace-btn" data-dmc="${escHtml(e.dmc)}" title="Replace this color"><i class="ti ti-replace"></i></button></td>
            </tr>
        `;
    }

    html += '</tbody></table>';
    wrap.innerHTML = html;

    const hasUnowned = rows.some(e => e.status === 'dont_own');
    document.getElementById('mark-need-btn').disabled = !hasUnowned;
}

function renderEditLegend() {
    const wrap = document.getElementById('key-table-wrap');
    const rows = filteredLegend();
    const totalSt = rows.reduce((s, e) => s + (e.stitches || 0), 0);
    const totalsEl = document.getElementById('key-edit-totals');
    if (totalsEl) totalsEl.textContent = `${rows.length} color${rows.length === 1 ? '' : 's'} · ${fmtStitches(totalSt)} stitch${totalSt === 1 ? '' : 'es'}`;
    const activeDmc = editorInstance ? editorInstance.getActiveDmc() : null;
    wrap.innerHTML = rows.map(e => {
        const hex = safeHex(e.hex);
        const fg = contrastColor(hex);
        const dmcStr = escHtml(String(e.dmc));
        const isActive = activeDmc === String(e.dmc) ? ' active' : '';
        return `<div class="legend-row${isActive}" data-dmc="${dmcStr}">
            <div class="legend-swatch" style="background:${hex};color:${fg}"><span>${escHtml(e.symbol)}</span></div>
            <div class="legend-info">
                <div class="legend-dmc">${dmcStr}</div>
                <div class="legend-name" title="${escHtml(e.name || '')}">${escHtml(e.name || '')}</div>
            </div>
            <div class="legend-count">${fmtStitches(e.stitches || 0)}</div>
            <button class="leg-replace-btn" data-dmc="${dmcStr}" title="Replace this color"><i class="ti ti-replace"></i></button>
        </div>`;
    }).join('');
}

/* ——— MARK NEED ——— */
async function markAllNeed() {
    const unowned = filteredLegend().filter(e => e.status === 'dont_own').map(e => e.dmc);
    if (!unowned.length) return;

    const btn = document.getElementById('mark-need-btn');
    btn.disabled = true;
    btn.textContent = 'Updating…';

    try {
        const resp = await fetch('/api/pattern/mark-need', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ thread_numbers: unowned, brand: paletteBrand }),
        });
        const data = await resp.json();

        if (!resp.ok) {
            btn.textContent = 'Error';
            setTimeout(() => { btn.textContent = 'Mark all unowned as Need'; btn.disabled = false; }, 2000);
            return;
        }

        legendData.forEach(e => {
            if (e.status === 'dont_own' && unowned.includes(e.dmc)) e.status = 'need';
        });

        btn.textContent = `Marked ${data.updated} as Need`;
        renderKey();
        setTimeout(() => { btn.textContent = 'Mark all unowned as Need'; }, 2500);

    } catch (err) {
        btn.textContent = 'Network error';
        setTimeout(() => { btn.textContent = 'Mark all unowned as Need'; btn.disabled = false; }, 2000);
    }
}

/* ——— PIXEL ART ——— */
function onPixelArtChange() {
    if (document.getElementById('ctrl-pixel-art').checked) {
        document.getElementById('ctrl-dither').checked = false;
        if (nativeW && nativeW >= 25 && nativeW <= 250) {
            document.getElementById('ctrl-grid-w').value = nativeW;
            updateVal('val-grid-w', nativeW);
        }
        if (nativeH && nativeH >= 25 && nativeH <= 250) {
            document.getElementById('ctrl-grid-h').value = nativeH;
            updateVal('val-grid-h', nativeH);
            heightLocked = false;
            applyHeightLockState();
        }
    } else {
        heightLocked = true;
        applyHeightLockState();
        recalcAutoHeight();
    }
    scheduleRegenerate();
}

/* ——— FABRIC SIZE TABLE ——— */
const FABRIC_COUNTS = [
    { count: 11, name: '11 Count', type: 'Aida' },
    { count: 14, name: '14 Count', type: 'Aida' },
    { count: 16, name: '16 Count', type: 'Aida' },
    { count: 18, name: '18 Count', type: 'Aida' },
    { count: 20, name: '20 Count', type: 'Aida' },
    { count: 22, name: '22 Count', type: 'Hardanger' },
    { count: 25, name: '25 over 2', type: 'Evenweave' },
    { count: 28, name: '28 over 2', type: 'Linen' },
    { count: 32, name: '32 over 2', type: 'Linen' },
];
/* Populate fabric dropdown */
(function() {
    const menu = document.getElementById('fabric-dropdown-menu');
    const sel = document.getElementById('dim-fabric-select');
    FABRIC_COUNTS.forEach((f, i) => {
        const btn = document.createElement('button');
        btn.textContent = `${f.name} ${f.type}`;
        btn.dataset.idx = i;
        if (i === dimFabricIdx) btn.classList.add('active');
        btn.onclick = () => selectFabric(i);
        menu.appendChild(btn);
        // Also populate the sidebar fabric <select>
        const opt = document.createElement('option');
        opt.textContent = `${f.name} ${f.type}`;
        opt.value = i;
        if (i === dimFabricIdx) opt.selected = true;
        sel.appendChild(opt);
    });
})();

function toggleFabricMenu(e) {
    e.stopPropagation();
    closeDownloadMenu();
    document.getElementById('fabric-dropdown-menu').classList.toggle('open');
}
function closeFabricMenu() {
    document.getElementById('fabric-dropdown-menu').classList.remove('open');
}
function selectFabric(idx) {
    dimFabricIdx = idx;
    const f = FABRIC_COUNTS[idx];
    document.getElementById('fabric-dropdown-btn').innerHTML =
        `${f.name} ${f.type} <span class="fabric-dd-arrow"><i class="ti ti-chevron-down"></i></span>`;
    document.getElementById('fabric-dropdown-menu').querySelectorAll('button').forEach((b, i) => {
        b.classList.toggle('active', i === idx);
    });
    // Sync sidebar fabric select
    document.getElementById('dim-fabric-select').selectedIndex = idx;
    closeFabricMenu();
    updateFabricSize();
}
document.addEventListener('click', closeFabricMenu);

function updateFabricSize() {
    if (!patternData) return;
    const { grid_w, grid_h } = patternData;
    const eff = getEffectiveFabricCount();
    const dw = (grid_w / eff).toFixed(1);
    const dh = (grid_h / eff).toFixed(1);
    const sw = (grid_w / eff + 6).toFixed(1);
    const sh = (grid_h / eff + 6).toFixed(1);
    document.getElementById('fabric-size-result').textContent =
        `${dw}″ × ${dh}″  ·  with margin: ${sw}″ × ${sh}″`;
    document.getElementById('fabric-size-panel').style.display = '';
}

/* ——— UI HELPERS ——— */
function showSpinner(on) {
    document.getElementById('gen-spinner').classList.toggle('visible', on);
}

function showError(msg) {
    const el = document.getElementById('gen-error');
    el.textContent = msg;
    el.classList.add('visible');
}

function clearError() {
    document.getElementById('gen-error').classList.remove('visible');
}

function showUploadError(msg) {
    const el = document.getElementById('upload-error');
    el.textContent = msg;
    el.classList.add('visible');
}

function clearUploadError() {
    document.getElementById('upload-error').classList.remove('visible');
}



/* ——— SAVE DIALOG ——— */
function openSaveDialog() {
    document.getElementById('save-name-input').value = '';
    document.getElementById('save-modal-error').style.display = 'none';
    document.getElementById('save-modal').style.display = 'flex';
    document.getElementById('save-name-input').focus();
}

function closeSaveDialog() {
    document.getElementById('save-modal').style.display = 'none';
}

async function confirmSave() {
    if (!patternData) return;
    const name = document.getElementById('save-name-input').value.trim() || 'Untitled';
    const btn = document.getElementById('save-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    document.getElementById('save-modal-error').style.display = 'none';

    const thumbnail = generateThumbnail(patternData);

    // Capture current generation settings
    const dimSave = getDimStitchValues();
    const genSettings = {
        grid_width:     dimSave.w,
        grid_height:    heightLocked ? 0 : dimSave.h,
        height_locked:  heightLocked,
        num_colors:     parseInt(document.getElementById('ctrl-colors').value),
        dither:         document.getElementById('ctrl-dither').checked,
        contrast:       parseFloat(document.getElementById('ctrl-contrast').value),
        brightness:     parseFloat(document.getElementById('ctrl-brightness').value),
        palette_brand:  paletteBrand,
        palette_filter: paletteFilter,
        pixel_art:      document.getElementById('ctrl-pixel-art').checked,
        crop_shape:     cropShape,
        dim_mode:       dimMode,
        dim_fabric_idx: dimFabricIdx,
    };

    // Determine image source reference
    const imageSource = regenSourcePatternSlug !== null
        ? `pattern:${regenSourcePatternSlug}`
        : (sessionImageAvailable ? 'session' : null);

    try {
        const resp = await fetch('/api/saved-patterns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                brand:                paletteBrand,
                grid_w:               patternData.grid_w,
                grid_h:               patternData.grid_h,
                grid_data:            patternData.grid,
                legend_data:          patternData.legend,
                part_stitches:        patternData.part_stitches || [],
                backstitches:         patternData.backstitches || [],
                knots:                patternData.knots || [],
                beads:                patternData.beads || [],
                thumbnail,
                generation_settings:  genSettings,
                image_source:         imageSource,
            }),
        });
        const data = await resp.json();

        if (!resp.ok || data.error) {
            const errEl = document.getElementById('save-modal-error');
            errEl.textContent = data.error || 'Save failed.';
            errEl.style.display = 'block';
            return;
        }

        closeSaveDialog();
        _clearAutosave();   // clear before slug changes (key is based on current slug)
        loadedPatternSlug = data.slug;
        savedPatternName = name;
        if (editorInstance) editorInstance.clearDirty();
        const saveBtn = document.getElementById('btn-save-pattern');
        const origText = saveBtn.textContent;
        saveBtn.textContent = 'Saved!';
        saveBtn.disabled = true;
        setTimeout(() => { saveBtn.textContent = origText; saveBtn.disabled = false; }, 2000);

    } catch (err) {
        const errEl = document.getElementById('save-modal-error');
        errEl.textContent = 'Network error: ' + err.message;
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
    }
}

/* ——— LOAD FROM ?load=ID ——— */
async function maybeLoadSavedPattern() {
    const params = new URLSearchParams(window.location.search);
    const loadId = params.get('load');
    if (!loadId) return;

    showStep('generate');
    showSpinner(true);
    document.getElementById('empty-state').style.display = '';
    document.getElementById('canvas-card').classList.remove('visible');
    document.getElementById('key-card').classList.remove('visible');

    try {
        const resp = await fetch('/api/saved-patterns/' + encodeURIComponent(loadId));
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            showError(data.error || 'Could not load saved pattern.');
            showSpinner(false);
            return;
        }
        const saved = await resp.json();

        loadedPatternSlug = saved.slug;
        savedPatternName = saved.name || null;
        selectedFile = null;
        sessionImageAvailable = false;

        // Restore generation settings and trigger regen if source image is available
        if (saved.has_source_image && saved.generation_settings) {
            const s = saved.generation_settings;
            if (s.grid_width  != null) { document.getElementById('ctrl-grid-w').value = s.grid_width;  updateVal('val-grid-w', s.grid_width); }
            if (s.height_locked != null) { heightLocked = s.height_locked; applyHeightLockState(); }
            if (s.grid_height != null && s.grid_height > 0) { document.getElementById('ctrl-grid-h').value = s.grid_height; updateVal('val-grid-h', s.grid_height); }
            if (s.num_colors  != null) { document.getElementById('ctrl-colors').value = s.num_colors;  updateVal('val-colors', s.num_colors); }
            if (s.dither      != null)  document.getElementById('ctrl-dither').checked    = s.dither;
            if (s.contrast    != null) { document.getElementById('ctrl-contrast').value   = s.contrast;   updateVal('val-contrast', parseFloat(s.contrast).toFixed(1)); }
            if (s.brightness  != null) { document.getElementById('ctrl-brightness').value = s.brightness; updateVal('val-brightness', parseFloat(s.brightness).toFixed(2)); }
            if (s.palette_brand != null) {
                setBrand(s.palette_brand);
            }
            if (s.palette_filter != null) {
                paletteFilter = s.palette_filter;
                document.querySelectorAll('#palette-filter-toggle .seg-btn').forEach((btn, i) => {
                    btn.classList.toggle('active', ['standard', 'special', 'both'][i] === paletteFilter);
                });
            }
            if (s.pixel_art  != null)  document.getElementById('ctrl-pixel-art').checked = s.pixel_art;
            if (s.crop_shape != null)   cropShape = s.crop_shape;
            if (s.dim_fabric_idx != null) {
                dimFabricIdx = s.dim_fabric_idx;
                document.getElementById('dim-fabric-select').selectedIndex = dimFabricIdx;
                selectFabric(dimFabricIdx);
            }
            if (s.dim_mode === 'inches') setDimMode('inches');

            regenSourcePatternSlug = saved.slug;
            nativeW = null;
            nativeH = null;

            // Load the stored grid data as initial display while regen runs
            patternData = {
                grid:   saved.grid_data,
                grid_w: saved.grid_w,
                grid_h: saved.grid_h,
                legend: saved.legend_data,
            };
            legendData = saved.legend_data.slice();
            _lookupDirty = true;

            document.getElementById('ctrl-grid-h').value = saved.grid_h;
            updateVal('val-grid-h', saved.grid_h);

            _showResultCards();

            renderCanvas();
            renderKey();

            // Draw thumbnail into source image preview
            if (saved.thumbnail) _showThumbnailPreview(saved.thumbnail);

            showSpinner(false);

            // Trigger regen from saved pattern's stored image
            scheduleRegenerate();
        } else {
            // No source image — render stored grid and lock controls
            setControlsReadOnly(true);
            patternData = {
                grid:   saved.grid_data,
                grid_w: saved.grid_w,
                grid_h: saved.grid_h,
                legend: saved.legend_data,
                part_stitches: saved.part_stitches || [],
                backstitches:  saved.backstitches || [],
                knots:         saved.knots || [],
                beads:         saved.beads || [],
            };
            legendData = saved.legend_data.slice();
            _lookupDirty = true;
            nativeW = null;
            nativeH = null;
            regenSourcePatternSlug = null;

            document.getElementById('ctrl-grid-w').value = saved.grid_w;
            updateVal('val-grid-w', saved.grid_w);
            document.getElementById('ctrl-grid-h').value = saved.grid_h;
            updateVal('val-grid-h', saved.grid_h);

            // Draw thumbnail into crop-preview-canvas if available
            if (saved.thumbnail) _showThumbnailPreview(saved.thumbnail);

            showSpinner(false);
            _showResultCards();
            // No source file — hide "Edit crop" button
            document.querySelector('.btn-edit-crop').style.display = 'none';
            ensureEditor();

            canvasCellPx = 19;
            renderCanvas();
            renderKey();
            _checkAutosaveRecovery();
        }

    } catch (err) {
        showError('Network error: ' + err.message);
        showSpinner(false);
    }
}

/* ——— CANVAS PAN / ZOOM EVENTS ——— */
(function() {
    const area = document.getElementById('canvas-area');

    // Wheel zoom / trackpad pan
    area.addEventListener('wheel', function(e) {
        e.preventDefault();
        if (e.ctrlKey) {
            // Pinch-to-zoom (trackpad) or Ctrl+wheel (mouse)
            const rect   = area.getBoundingClientRect();
            const mx     = e.clientX - rect.left;
            const my     = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
            cvPanX  = mx - (mx - cvPanX) * factor;
            cvPanY  = my - (my - cvPanY) * factor;
            const maxZoom = area.clientWidth / (canvasCellPx * 8);
            cvScale = Math.max(0.05, Math.min(maxZoom, cvScale * factor));
        } else {
            // Two-finger scroll (trackpad) or plain mouse wheel → pan
            cvPanX -= e.deltaX;
            cvPanY -= e.deltaY;
        }
        applyCanvasTransform();
        scheduleSnap();
    }, { passive: false });

    // Mouse drag pan (or editor tool in edit mode)
    area.addEventListener('mousedown', function(e) {
        if (editorInstance && editorInstance.isUIElement(e.target)) return;
        if (editorInstance && editorInstance.isActive() && !editorInstance.wantsPan() && e.button === 0) {
            e.preventDefault();
            editorInstance.handleMouseDown(e);
            return;
        }
        _cvDragging = true;
        _cvDragSX = e.clientX; _cvDragSY = e.clientY;
        _cvPanSX = cvPanX;     _cvPanSY = cvPanY;
        e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
        if (editorInstance && editorInstance.isActive() && !editorInstance.wantsPan()) {
            editorInstance.handleMouseMove(e);
        }
        if (!_cvDragging) return;
        cvPanX = _cvPanSX + (e.clientX - _cvDragSX) * 0.65;
        cvPanY = _cvPanSY + (e.clientY - _cvDragSY) * 0.65;
        applyCanvasTransform();
    });
    document.addEventListener('mouseup', function() {
        if (editorInstance && editorInstance.isActive()) editorInstance.handleMouseUp();
        _cvDragging = false;
    });

    // Hover cell highlight — clear on leave
    area.addEventListener('mouseleave', function() {
        if (editorInstance && editorInstance.isActive()) editorInstance.handleMouseLeave();
    });
    area.addEventListener('contextmenu', function(e) {
        if (editorInstance && editorInstance.isActive() && editorInstance.handleContextMenu(e)) return;
    });

    // Touch pan / pinch zoom / editor draw
    let _tStartDist = 0, _tStartScale = 1;
    let _tDragSX = 0, _tDragSY = 0, _tPanSX = 0, _tPanSY = 0;
    let _tDragging = false, _tEditorDrawing = false;

    function _touchToMouse(touch, target) {
        return { clientX: touch.clientX, clientY: touch.clientY, shiftKey: false, button: 0, target: target, preventDefault: function(){} };
    }

    area.addEventListener('touchstart', function(e) {
        const t = e.touches;
        if (t.length === 1) {
            if (editorInstance && editorInstance.isActive() && !editorInstance.wantsPan()) {
                e.preventDefault();
                _tEditorDrawing = true;
                editorInstance.handleMouseDown(_touchToMouse(t[0], e.target));
                return;
            }
            _tEditorDrawing = false;
            _tDragging = true;
            _tDragSX = t[0].clientX; _tDragSY = t[0].clientY;
            _tPanSX = cvPanX; _tPanSY = cvPanY;
            _tStartDist = 0;
        } else if (t.length >= 2) {
            e.preventDefault();
            _tEditorDrawing = false;
            _tDragging = false;
            _tStartDist  = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
            _tStartScale = cvScale;
        }
    }, { passive: false });

    area.addEventListener('touchmove', function(e) {
        const t = e.touches;
        if (_tEditorDrawing && t.length === 1) {
            e.preventDefault();
            editorInstance.handleMouseMove(_touchToMouse(t[0], e.target));
            return;
        }
        if (t.length === 1 && _tDragging) {
            e.preventDefault();
            cvPanX = _tPanSX + (t[0].clientX - _tDragSX) * 0.65;
            cvPanY = _tPanSY + (t[0].clientY - _tDragSY) * 0.65;
            applyCanvasTransform();
        } else if (t.length >= 2 && _tStartDist) {
            e.preventDefault();
            const dist = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
            const maxZoom = area.clientWidth / (canvasCellPx * 8);
            const newScale = Math.max(0.05, Math.min(maxZoom, _tStartScale * dist / _tStartDist));
            const rect = area.getBoundingClientRect();
            const mx = ((t[0].clientX + t[1].clientX) / 2) - rect.left;
            const my = ((t[0].clientY + t[1].clientY) / 2) - rect.top;
            const factor = newScale / cvScale;
            cvPanX = mx - (mx - cvPanX) * factor;
            cvPanY = my - (my - cvPanY) * factor;
            cvScale = newScale;
            applyCanvasTransform();
        }
    }, { passive: false });

    area.addEventListener('touchend', function() {
        if (_tEditorDrawing) { editorInstance.handleMouseUp(); _tEditorDrawing = false; return; }
        _tDragging = false; _tStartDist = 0;
        scheduleSnap();
    }, { passive: true });
})();

/* ——— ZOOM +/- BUTTONS ——— */
function _zoomByFactor(factor) {
    const area = document.getElementById('canvas-area');
    const cx = area.clientWidth / 2, cy = area.clientHeight / 2;
    const maxZoom = area.clientWidth / (canvasCellPx * 8);
    cvPanX = cx - (cx - cvPanX) * factor;
    cvPanY = cy - (cy - cvPanY) * factor;
    cvScale = Math.max(0.05, Math.min(maxZoom, cvScale * factor));
    applyCanvasTransform();
    scheduleSnap();
}
document.getElementById('zoom-in-btn').addEventListener('click', () => _zoomByFactor(1.3));
document.getElementById('zoom-out-btn').addEventListener('click', () => _zoomByFactor(1 / 1.3));

/* ——— EDITOR: Legend clicks ——— */
document.getElementById('key-table-wrap').addEventListener('click', function(e) {
    if (!editorInstance || !editorInstance.isActive()) return;
    const replBtn = e.target.closest('.leg-replace-btn');
    if (replBtn) {
        e.stopPropagation();
        editorInstance.startReplace(replBtn.dataset.dmc);
        return;
    }
    const row = e.target.closest('.legend-row, .key-row');
    if (row && row.dataset.dmc) editorInstance.setActiveColor(row.dataset.dmc);
});

/* ——— EDITOR KEYBOARD ——— */
document.addEventListener('keydown', function(e) {
    // Suppress editor shortcuts when dialogs are open
    if (document.querySelector('.notify-overlay')) return;
    const saveModal = document.getElementById('save-modal');
    if (saveModal && saveModal.style.display !== 'none') return;
    if (editorInstance && editorInstance.isActive()) {
        if (editorInstance.handleKeyDown(e)) return;
    }
});
document.addEventListener('keyup', function(e) {
    if (editorInstance && editorInstance.isActive()) editorInstance.handleKeyUp(e);
});
window.addEventListener('beforeunload', function(e) {
    if (editorInstance && editorInstance.isDirty()) {
        e.preventDefault();
        e.returnValue = '';
    }
});

/* ——— INIT ——— */
initCropOverlay();
window.addEventListener('resize', () => {
    if (patternData) fitCanvasToView();
});
maybeLoadSavedPattern();
