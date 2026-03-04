/* ── Brand Toggle ──────────────────────────────────────────── */
/* Shared JS for the DMC/Anchor/All segmented control.         */
/* Requires: a .brand-seg container with .brand-seg-btn and    */
/* .brand-seg-indicator children.                              */

function _positionIndicator(seg) {
    const active = seg.querySelector('.brand-seg-btn.active');
    const ind = seg.querySelector('.brand-seg-indicator');
    if (!active || !ind) return;
    const sr = seg.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    ind.style.left = (ar.left - sr.left) + 'px';
    ind.style.width = ar.width + 'px';
}

function initBrandToggle(seg) {
    const ind = seg.querySelector('.brand-seg-indicator');
    if (!ind) return;
    ind.style.transition = 'none';
    _positionIndicator(seg);
    ind.offsetHeight; // force reflow
    ind.style.transition = '';
}
