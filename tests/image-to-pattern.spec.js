// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

/*
 * Image-to-Pattern E2E Tests
 *
 * Covers: upload flow, image generation, controls, color key, zoom,
 * save dialog, edit mode, crop modal, autosave/recovery, download menu.
 *
 * The generation endpoint is rate-limited to 10/min, so tests that need
 * a generated pattern use ?load=<slug> to load an existing saved pattern
 * instead of re-generating each time. Only the generation tests actually
 * hit the POST /api/image/generate endpoint.
 *
 * Pre-requisites:
 *   - Server running on localhost:6969
 *   - Auth via storageState (see auth.setup.js)
 *   - At least one saved pattern in the database
 *
 * Run:  TEST_USER=<user> TEST_PASS=<pass> npx playwright test image-to-pattern
 */

const TEST_IMAGE = path.join(__dirname, 'test-image.png');
const AUTH_FILE = path.join(__dirname, '.auth-state.json');

/** Cached slug for loading saved patterns */
let _cachedSlug = null;

/** Get a saved pattern slug (cached to avoid rate limits) */
async function getPatternSlug(page) {
    if (!_cachedSlug) {
        const resp = await page.request.get('/api/saved-patterns');
        const patterns = await resp.json();
        expect(patterns.length).toBeGreaterThan(0);
        _cachedSlug = patterns[0].slug;
    }
    return _cachedSlug;
}

/** Load an existing pattern into image-to-pattern via ?load= query param.
 *  This avoids hitting the rate-limited generation endpoint. */
async function loadExistingPattern(page) {
    const slug = await getPatternSlug(page);
    await page.goto(`/image-to-pattern?load=${slug}`);
    await page.waitForLoadState('networkidle');
    // Wait for pattern to render
    await expect(page.locator('#canvas-card')).toHaveClass(/visible/, { timeout: 15000 });
    return slug;
}

// ——————————————————————————————————————————————
// UPLOAD STEP
// ——————————————————————————————————————————————
test.describe('Upload Step', () => {
    test('starts on upload step with convert button disabled', async ({ page }) => {
        await page.goto('/image-to-pattern');
        await page.waitForLoadState('networkidle');

        await expect(page.locator('#step-upload')).toHaveClass(/active/);
        await expect(page.locator('#convert-btn')).toBeDisabled();
        await expect(page.locator('#upload-filename')).toBeEmpty();
    });

    test('valid file enables convert button and shows filename', async ({ page }) => {
        await page.goto('/image-to-pattern');
        await page.waitForLoadState('networkidle');

        await page.locator('#img-input').setInputFiles(TEST_IMAGE);
        await page.waitForTimeout(200);

        await expect(page.locator('#convert-btn')).toBeEnabled();
        await expect(page.locator('#upload-filename')).toContainText('test-image.png');
    });

    test('no console errors on load', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await page.goto('/image-to-pattern');
        await page.waitForLoadState('networkidle');
        expect(errors).toHaveLength(0);
    });
});

// ——————————————————————————————————————————————
// PATTERN GENERATION (uploads image, hits generation API)
// ——————————————————————————————————————————————
test.describe('Pattern Generation', () => {
    test('convert generates pattern with canvas, key, and info', async ({ page }) => {
        await page.goto('/image-to-pattern');
        await page.waitForLoadState('networkidle');

        // Upload test image
        await page.locator('#img-input').setInputFiles(TEST_IMAGE);
        await page.waitForTimeout(200);
        await page.click('#convert-btn');

        // Wait for generation
        await expect(page.locator('#canvas-card')).toHaveClass(/visible/, { timeout: 30000 });
        await expect(page.locator('#key-card')).toHaveClass(/visible/);

        // Canvas info shows stitch dimensions
        await expect(page.locator('#canvas-info')).toContainText('stitch');
        await expect(page.locator('#canvas-info')).toContainText('color');

        // Empty state hidden
        await expect(page.locator('#empty-state')).toBeHidden();

        // Edit and Save buttons visible
        await expect(page.locator('#edit-toggle-btn')).toBeVisible();
        await expect(page.locator('#btn-save-pattern')).toBeVisible();

        // Zoom controls visible
        await expect(page.locator('#zoom-controls')).toBeVisible();

        // Fabric size panel visible
        await expect(page.locator('#fabric-size-panel')).toBeVisible();
        await expect(page.locator('#fabric-size-result')).toContainText('″');
    });
});

// ——————————————————————————————————————————————
// LOAD EXISTING PATTERN (via ?load=slug)
// ——————————————————————————————————————————————
test.describe('Load Existing Pattern', () => {
    test('load=slug shows pattern without upload step', async ({ page }) => {
        await loadExistingPattern(page);

        // Should be on generate step
        await expect(page.locator('#step-generate')).toHaveClass(/active/);
        await expect(page.locator('#step-upload')).not.toHaveClass(/active/);

        // Canvas and key visible
        await expect(page.locator('#pattern-canvas')).toBeVisible();
        await expect(page.locator('#key-card')).toBeVisible();
    });
});

// ——————————————————————————————————————————————
// CONTROLS (loaded pattern — no generation needed)
// ——————————————————————————————————————————————
test.describe('Controls', () => {
    test('gridlines and symbols checkboxes toggle independently', async ({ page }) => {
        await loadExistingPattern(page);

        const gridlines = page.locator('#gridlines-check');
        const symbols = page.locator('#symbols-check');

        await expect(gridlines).toBeChecked();
        await expect(symbols).toBeChecked();

        await gridlines.uncheck();
        await expect(gridlines).not.toBeChecked();
        await expect(symbols).toBeChecked();

        await gridlines.check();
        await expect(gridlines).toBeChecked();
    });

    test('stitch view and symbols are mutually exclusive', async ({ page }) => {
        await loadExistingPattern(page);

        const symbols = page.locator('#symbols-check');
        const stitch = page.locator('#stitch-check');

        await expect(symbols).toBeChecked();
        await expect(stitch).not.toBeChecked();

        await stitch.check();
        await page.waitForTimeout(200);
        await expect(stitch).toBeChecked();
        await expect(symbols).not.toBeChecked();

        await symbols.check();
        await page.waitForTimeout(200);
        await expect(symbols).toBeChecked();
        await expect(stitch).not.toBeChecked();
    });
});

// ——————————————————————————————————————————————
// ZOOM
// ——————————————————————————————————————————————
test.describe('Zoom', () => {
    test('zoom in/out changes zoom level', async ({ page }) => {
        await loadExistingPattern(page);

        const zoomLevel = page.locator('#zoom-level');
        const before = parseInt(await zoomLevel.textContent());

        await page.click('#zoom-in-btn');
        await page.waitForTimeout(300);
        const after = parseInt(await zoomLevel.textContent());
        expect(after).toBeGreaterThan(before);

        await page.click('#zoom-out-btn');
        await page.waitForTimeout(300);
        const final = parseInt(await zoomLevel.textContent());
        expect(final).toBeLessThan(after);
    });
});

// ——————————————————————————————————————————————
// COLOR KEY / LEGEND
// ——————————————————————————————————————————————
test.describe('Color Key', () => {
    test('key table shows color rows with swatch, DMC, name', async ({ page }) => {
        await loadExistingPattern(page);

        const rows = page.locator('#key-table-wrap .key-row');
        const count = await rows.count();
        expect(count).toBeGreaterThan(0);

        const firstRow = rows.first();
        await expect(firstRow.locator('.swatch')).toBeVisible();
        await expect(firstRow.locator('.dmc-num')).not.toBeEmpty();
        await expect(firstRow.locator('.thread-name')).not.toBeEmpty();
    });

    test('legend sort toggles between number and stitches', async ({ page }) => {
        await loadExistingPattern(page);

        await expect(page.locator('#sort-btn-number')).toHaveClass(/active/);

        await page.click('#sort-btn-stitches');
        await expect(page.locator('#sort-btn-stitches')).toHaveClass(/active/);
        await expect(page.locator('#sort-btn-number')).not.toHaveClass(/active/);

        await page.click('#sort-btn-number');
        await expect(page.locator('#sort-btn-number')).toHaveClass(/active/);
    });

    test('display filter toggles between standard, special, both', async ({ page }) => {
        await loadExistingPattern(page);

        const btns = page.locator('#display-filter-toggle .seg-btn');

        // Default: "Both" is active (3rd button)
        await expect(btns.nth(2)).toHaveClass(/active/);

        await btns.nth(0).click();
        await page.waitForTimeout(200);
        await expect(btns.nth(0)).toHaveClass(/active/);
        await expect(btns.nth(2)).not.toHaveClass(/active/);

        await btns.nth(2).click();
        await page.waitForTimeout(200);
        await expect(btns.nth(2)).toHaveClass(/active/);
    });
});

// ——————————————————————————————————————————————
// DOWNLOAD MENU
// ——————————————————————————————————————————————
test.describe('Download Menu', () => {
    test('opens and shows PNG and PDF options', async ({ page }) => {
        await loadExistingPattern(page);

        await page.click('#download-dropdown .download-btn');
        await expect(page.locator('#download-menu')).toHaveClass(/open/);

        await expect(page.locator('#download-menu button:has-text("PNG")')).toBeVisible();
        await expect(page.locator('#download-menu button:has-text("PDF")')).toBeVisible();
    });

    test('closes on outside click', async ({ page }) => {
        await loadExistingPattern(page);

        await page.click('#download-dropdown .download-btn');
        await expect(page.locator('#download-menu')).toHaveClass(/open/);

        await page.click('#canvas-info');
        await page.waitForTimeout(200);
        await expect(page.locator('#download-menu')).not.toHaveClass(/open/);
    });
});

// ——————————————————————————————————————————————
// SAVE DIALOG
// ——————————————————————————————————————————————
test.describe('Save Dialog', () => {
    test('opens save modal and can close via backdrop', async ({ page }) => {
        await loadExistingPattern(page);

        await page.click('#btn-save-pattern');
        await expect(page.locator('#save-modal')).toBeVisible();
        await expect(page.locator('#save-name-input')).toBeFocused();

        // Close via backdrop click
        await page.locator('#save-modal').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(300);
        await expect(page.locator('#save-modal')).toBeHidden();
    });

    test('saves pattern with name and shows confirmation', async ({ page }) => {
        await loadExistingPattern(page);

        await page.click('#btn-save-pattern');
        await page.fill('#save-name-input', 'ITP E2E Test');
        await page.click('#save-confirm-btn');

        await expect(page.locator('#save-modal')).toBeHidden({ timeout: 10000 });
        await expect(page.locator('#btn-save-pattern')).toContainText('Saved');
    });

    test('Enter key submits save dialog', async ({ page }) => {
        await loadExistingPattern(page);

        await page.click('#btn-save-pattern');
        await page.fill('#save-name-input', 'Enter Key ITP');
        await page.press('#save-name-input', 'Enter');

        await expect(page.locator('#save-modal')).toBeHidden({ timeout: 10000 });
    });
});

// ——————————————————————————————————————————————
// EDIT MODE (FULLSCREEN)
// ——————————————————————————————————————————————
test.describe('Edit Mode', () => {
    test('enter and exit fullscreen edit mode', async ({ page }) => {
        await loadExistingPattern(page);

        await page.click('#edit-toggle-btn');
        await page.waitForTimeout(500);

        await expect(page.locator('#step-generate')).toHaveClass(/edit-fullscreen/);
        await expect(page.locator('#edit-toggle-btn')).toContainText('Done');

        // Edit totals shown
        await expect(page.locator('#key-edit-totals')).toBeVisible();

        // Exit
        await page.click('#edit-toggle-btn');
        await page.waitForTimeout(500);

        await expect(page.locator('#step-generate')).not.toHaveClass(/edit-fullscreen/);
        await expect(page.locator('#edit-toggle-btn')).toContainText('Edit');
    });

    test('legend switches to compact rows in edit mode', async ({ page }) => {
        await loadExistingPattern(page);

        // Normal: key-row table rows
        await expect(page.locator('#key-table-wrap .key-row').first()).toBeVisible();

        await page.click('#edit-toggle-btn');
        await page.waitForTimeout(500);

        // Edit: legend-row divs
        await expect(page.locator('#key-table-wrap .legend-row').first()).toBeVisible();

        await page.click('#edit-toggle-btn');
        await page.waitForTimeout(500);

        // Back to table
        await expect(page.locator('#key-table-wrap .key-row').first()).toBeVisible();
    });
});

// ——————————————————————————————————————————————
// AUTOSAVE / RECOVERY
// ——————————————————————————————————————————————
test.describe('Autosave', () => {
    test('autosave triggers after edit', async ({ page }) => {
        await loadExistingPattern(page);

        // Trigger autosave manually
        await page.evaluate(() => {
            if (typeof _scheduleAutosave === 'function') _scheduleAutosave();
        });

        await page.waitForTimeout(6500);

        const saved = await page.evaluate(() => {
            // Find any ns-autosave-itp-* key
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('ns-autosave-itp-')) {
                    return JSON.parse(localStorage.getItem(k));
                }
            }
            return null;
        });

        expect(saved).not.toBeNull();
        expect(saved).toHaveProperty('grid');
        expect(saved).toHaveProperty('legend');
        expect(saved).toHaveProperty('timestamp');
    });

    test('save clears autosave data', async ({ page }) => {
        await loadExistingPattern(page);

        // Trigger and wait for autosave
        await page.evaluate(() => {
            if (typeof _scheduleAutosave === 'function') _scheduleAutosave();
        });
        await page.waitForTimeout(6500);

        // Verify autosave exists
        const hasSave = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('ns-autosave-itp-')) return true;
            }
            return false;
        });
        expect(hasSave).toBe(true);

        // Save the pattern
        await page.click('#btn-save-pattern');
        await page.fill('#save-name-input', 'Autosave Clear ITP');
        await page.click('#save-confirm-btn');
        await expect(page.locator('#save-modal')).toBeHidden({ timeout: 10000 });
        await page.waitForTimeout(500);

        // Autosave should be cleared
        const remaining = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('ns-autosave-itp-')) return k;
            }
            return null;
        });
        expect(remaining).toBeNull();
    });
});
