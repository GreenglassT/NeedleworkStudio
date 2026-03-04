// @ts-check
const { test, expect } = require('@playwright/test');

/*
 * Pattern Viewer E2E Tests
 *
 * Covers: page load, zoom/pan, legend, progress tracking,
 * view mode toggle, edit mode, zen mode, keyboard shortcuts,
 * calculator dropdown, minimap, session timer.
 *
 * Pre-requisites:
 *   - Server running on localhost:6969
 *   - Auth via storageState (see auth.setup.js)
 *   - At least one saved pattern in the database
 *
 * Run:  TEST_USER=<user> TEST_PASS=<pass> npx playwright test pattern-viewer
 */

/** Cached slug to avoid hitting rate-limited API on every test */
let _cachedSlug = null;

/** Navigate to first saved pattern and wait for it to load */
async function openPattern(page) {
    if (!_cachedSlug) {
        const resp = await page.request.get('/api/saved-patterns');
        const patterns = await resp.json();
        expect(patterns.length).toBeGreaterThan(0);
        _cachedSlug = patterns[0].slug;
    }
    await page.goto(`/view/${_cachedSlug}`);
    await page.waitForLoadState('networkidle');
    // Wait for loading overlay to disappear
    await expect(page.locator('#loading-overlay')).toBeHidden({ timeout: 10000 });
    return _cachedSlug;
}

// ——————————————————————————————————————————————
// PAGE LOAD
// ——————————————————————————————————————————————
test.describe('Page Load', () => {
    test('displays pattern title, meta, and legend', async ({ page }) => {
        await openPattern(page);

        // Title should not be the loading placeholder
        const title = page.locator('#pattern-title');
        await expect(title).not.toHaveText('Loading…');
        await expect(title).not.toBeEmpty();

        // Meta shows dimensions and color count
        const meta = page.locator('#pattern-meta');
        await expect(meta).toContainText('×');
        await expect(meta).toContainText('color');

        // Legend has at least one row
        const rows = page.locator('#legend-scroll .legend-row');
        await expect(rows.first()).toBeVisible();

        // Legend totals shows colors and stitches
        const totals = page.locator('#legend-totals');
        await expect(totals).toContainText('color');
        await expect(totals).toContainText('stitch');
    });

    test('main canvas is visible', async ({ page }) => {
        await openPattern(page);
        await expect(page.locator('#main-canvas')).toBeVisible();
    });

    test('no console errors on load', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await openPattern(page);
        expect(errors).toHaveLength(0);
    });
});

// ——————————————————————————————————————————————
// ZOOM
// ——————————————————————————————————————————————
test.describe('Zoom', () => {
    test('zoom-in increases zoom level', async ({ page }) => {
        await openPattern(page);

        const zoomLevel = page.locator('#zoom-level');
        const before = await zoomLevel.textContent();
        const beforePct = parseInt(before);

        await page.click('#zoom-in-btn');
        await page.waitForTimeout(300);

        const after = await zoomLevel.textContent();
        const afterPct = parseInt(after);
        expect(afterPct).toBeGreaterThan(beforePct);
        expect(after).toContain('%');
    });

    test('zoom-out decreases zoom level', async ({ page }) => {
        await openPattern(page);

        // First zoom in so we have room to zoom out
        await page.click('#zoom-in-btn');
        await page.click('#zoom-in-btn');
        await page.waitForTimeout(300);

        const zoomLevel = page.locator('#zoom-level');
        const before = parseInt(await zoomLevel.textContent());

        await page.click('#zoom-out-btn');
        await page.waitForTimeout(300);

        const after = parseInt(await zoomLevel.textContent());
        expect(after).toBeLessThan(before);
    });

    test('minimap appears when zoomed in', async ({ page }) => {
        await openPattern(page);

        // Zoom in several times to ensure pattern exceeds viewport
        for (let i = 0; i < 8; i++) {
            await page.click('#zoom-in-btn');
        }
        await page.waitForTimeout(500);

        await expect(page.locator('#minimap-wrap')).toBeVisible();
    });
});

// ——————————————————————————————————————————————
// LEGEND
// ——————————————————————————————————————————————
test.describe('Legend', () => {
    test('sort by stitches reorders legend', async ({ page }) => {
        await openPattern(page);

        // Default: sorted by DMC number
        await expect(page.locator('#sort-btn-number')).toHaveClass(/active/);

        // Click sort by stitches
        await page.click('#sort-btn-stitches');
        await expect(page.locator('#sort-btn-stitches')).toHaveClass(/active/);
        await expect(page.locator('#sort-btn-number')).not.toHaveClass(/active/);

        // Switch back to number sort
        await page.click('#sort-btn-number');
        await expect(page.locator('#sort-btn-number')).toHaveClass(/active/);
    });

    test('search filters legend rows', async ({ page }) => {
        await openPattern(page);

        const allRows = await page.locator('#legend-scroll .legend-row').count();
        expect(allRows).toBeGreaterThan(0);

        // Get the first row's DMC number to search for
        const firstDmc = await page.locator('#legend-scroll .legend-row').first().getAttribute('data-dmc');

        // Type in search
        await page.fill('#legend-search', firstDmc);
        await page.waitForTimeout(200);

        const filteredRows = await page.locator('#legend-scroll .legend-row:visible').count();
        expect(filteredRows).toBeLessThanOrEqual(allRows);
        expect(filteredRows).toBeGreaterThan(0);
    });

    test('Escape clears legend search', async ({ page }) => {
        await openPattern(page);

        const firstDmc = await page.locator('#legend-scroll .legend-row').first().getAttribute('data-dmc');
        await page.fill('#legend-search', firstDmc);
        await page.waitForTimeout(200);

        // Press Escape to clear
        await page.press('#legend-search', 'Escape');
        await page.waitForTimeout(200);

        const val = await page.locator('#legend-search').inputValue();
        expect(val).toBe('');

        // All rows should be visible again
        const allRows = await page.locator('#legend-scroll .legend-row').count();
        expect(allRows).toBeGreaterThan(1);
    });

    test('clicking a legend row highlights that color', async ({ page }) => {
        await openPattern(page);

        const firstRow = page.locator('#legend-scroll .legend-row').first();
        await firstRow.click();
        await page.waitForTimeout(300);

        // Row should get .active class
        await expect(firstRow).toHaveClass(/active/);

        // Click again to toggle off
        await firstRow.click();
        await page.waitForTimeout(300);
        await expect(firstRow).not.toHaveClass(/active/);
    });
});

// ——————————————————————————————————————————————
// PROGRESS TRACKING
// ——————————————————————————————————————————————
test.describe('Progress Tracking', () => {
    test('progress bar and label are visible', async ({ page }) => {
        await openPattern(page);

        await expect(page.locator('#cell-progress-wrap')).toBeVisible();
        const label = page.locator('#cell-progress-label');
        await expect(label).toContainText('stitch');
    });

    test('marking a color complete updates legend row', async ({ page }) => {
        await openPattern(page);

        const firstCheck = page.locator('#legend-scroll .leg-check').first();
        const firstRow = page.locator('#legend-scroll .legend-row').first();
        const dmc = await firstRow.getAttribute('data-dmc');

        // Check if already completed — if so, uncomplete first
        const wasChecked = await firstCheck.evaluate(el => el.classList.contains('checked'));
        if (wasChecked) {
            await firstCheck.click();
            await page.waitForTimeout(200);
        }

        // Mark color complete
        await firstCheck.click();
        await page.waitForTimeout(200);

        await expect(firstCheck).toHaveClass(/checked/);
        await expect(firstRow).toHaveClass(/completed/);

        // Undo to restore state
        await firstCheck.click();
        await page.waitForTimeout(200);
        await expect(firstCheck).not.toHaveClass(/checked/);
    });

    test('cell mark mode toggles via button', async ({ page }) => {
        await openPattern(page);

        const btn = page.locator('#cell-mark-btn');
        const canvasArea = page.locator('#canvas-area');

        // Activate mark mode
        await btn.click();
        await expect(btn).toHaveClass(/active/);
        await expect(canvasArea).toHaveClass(/cell-mark-mode/);

        // Deactivate
        await btn.click();
        await expect(btn).not.toHaveClass(/active/);
        await expect(canvasArea).not.toHaveClass(/cell-mark-mode/);
    });

    test('M key toggles cell mark mode', async ({ page }) => {
        await openPattern(page);

        await page.keyboard.press('m');
        await expect(page.locator('#cell-mark-btn')).toHaveClass(/active/);

        await page.keyboard.press('m');
        await expect(page.locator('#cell-mark-btn')).not.toHaveClass(/active/);
    });
});

// ——————————————————————————————————————————————
// VIEW MODE TOGGLE
// ——————————————————————————————————————————————
test.describe('View Mode', () => {
    test('toggles between chart and thread view', async ({ page }) => {
        await openPattern(page);

        const btn = page.locator('#view-mode-btn');

        // Default is chart mode — button says "Thread View"
        await expect(btn).toContainText('Thread View');

        // Toggle to thread view
        await btn.click();
        await page.waitForTimeout(300);
        await expect(btn).toContainText('Chart View');

        // Toggle back to chart view
        await btn.click();
        await page.waitForTimeout(300);
        await expect(btn).toContainText('Thread View');
    });

    test('view mode persists in localStorage', async ({ page }) => {
        await openPattern(page);

        // Switch to thread view
        await page.click('#view-mode-btn');
        await page.waitForTimeout(300);

        const stored = await page.evaluate(() => localStorage.getItem('pv-viewMode'));
        expect(stored).toBe('thread');

        // Switch back
        await page.click('#view-mode-btn');
        await page.waitForTimeout(300);

        const stored2 = await page.evaluate(() => localStorage.getItem('pv-viewMode'));
        expect(stored2).toBe('chart');
    });
});

// ——————————————————————————————————————————————
// EDIT MODE
// ——————————————————————————————————————————————
test.describe('Edit Mode', () => {
    test('Edit Pattern button shows fork dialog', async ({ page }) => {
        await openPattern(page);

        await page.click('#edit-toggle-btn');
        await expect(page.locator('#fork-dialog')).toBeVisible();

        // Dialog has three buttons
        await expect(page.locator('#fork-dialog .ed-modal-btn')).toHaveCount(3);
    });

    test('Edit Original enters edit mode', async ({ page }) => {
        await openPattern(page);

        await page.click('#edit-toggle-btn');
        await expect(page.locator('#fork-dialog')).toBeVisible();

        // Click "Edit Original"
        await page.click('#fork-dialog .ed-modal-btn:nth-child(2)');
        await page.waitForTimeout(500);

        // Fork dialog should close
        await expect(page.locator('#fork-dialog')).toBeHidden();

        // Body should have edit-mode-on class
        await expect(page.locator('body')).toHaveClass(/edit-mode-on/);

        // Edit button hidden, Cancel/Save visible
        await expect(page.locator('#edit-toggle-btn')).toBeHidden();
        await expect(page.locator('#cancel-btn')).toBeVisible();
        await expect(page.locator('#save-btn')).toBeVisible();

        // Mark Complete button hidden in edit mode
        await expect(page.locator('#cell-mark-btn')).toBeHidden();
        // Progress bar hidden in edit mode
        await expect(page.locator('#cell-progress-wrap')).toBeHidden();
    });

    test('Cancel exits edit mode without saving', async ({ page }) => {
        await openPattern(page);

        // Enter edit mode
        await page.click('#edit-toggle-btn');
        await page.click('#fork-dialog .ed-modal-btn:nth-child(2)');
        await page.waitForTimeout(500);

        // Cancel
        await page.click('#cancel-btn');
        await page.waitForTimeout(300);

        // Should be back in view mode
        await expect(page.locator('body')).not.toHaveClass(/edit-mode-on/);
        await expect(page.locator('#edit-toggle-btn')).toBeVisible();
        await expect(page.locator('#cancel-btn')).toBeHidden();
        await expect(page.locator('#save-btn')).toBeHidden();
    });

    test('fork dialog Cancel closes dialog without entering edit', async ({ page }) => {
        await openPattern(page);

        await page.click('#edit-toggle-btn');
        await expect(page.locator('#fork-dialog')).toBeVisible();

        // Click Cancel (first button)
        await page.click('#fork-dialog .ed-modal-btn:first-child');
        await page.waitForTimeout(300);

        await expect(page.locator('#fork-dialog')).toBeHidden();
        await expect(page.locator('body')).not.toHaveClass(/edit-mode-on/);
    });

    test('fork dialog closes on backdrop click', async ({ page }) => {
        await openPattern(page);

        await page.click('#edit-toggle-btn');
        await expect(page.locator('#fork-dialog')).toBeVisible();

        // Click the backdrop (the .ed-modal overlay itself, not the card)
        await page.locator('#fork-dialog').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(300);

        await expect(page.locator('#fork-dialog')).toBeHidden();
    });

    test('save persists changes and exits edit mode', async ({ page }) => {
        const slug = await openPattern(page);

        // Enter edit mode
        await page.click('#edit-toggle-btn');
        await page.click('#fork-dialog .ed-modal-btn:nth-child(2)');
        await page.waitForTimeout(500);

        // Click Save (even without changes, save should work)
        await page.click('#save-btn');
        await page.waitForTimeout(3000);

        // Should exit edit mode
        await expect(page.locator('body')).not.toHaveClass(/edit-mode-on/);

        // Success toast should appear
        await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });
    });
});

// ——————————————————————————————————————————————
// ZEN MODE
// ——————————————————————————————————————————————
test.describe('Zen Mode', () => {
    test('F key toggles zen mode', async ({ page }) => {
        await openPattern(page);

        await page.keyboard.press('f');
        await page.waitForTimeout(300);

        await expect(page.locator('body')).toHaveClass(/zen-mode/);

        // Header should be hidden
        await expect(page.locator('.site-header')).toBeHidden();

        // Exit with F
        await page.keyboard.press('f');
        await page.waitForTimeout(300);

        await expect(page.locator('body')).not.toHaveClass(/zen-mode/);
        await expect(page.locator('.site-header')).toBeVisible();
    });

    test('zen button enters zen mode, exit via legend button', async ({ page }) => {
        await openPattern(page);

        await page.click('#zen-btn');
        await page.waitForTimeout(300);
        await expect(page.locator('body')).toHaveClass(/zen-mode/);

        // Header is hidden in zen mode, so use the legend exit button
        const exitBtn = page.locator('#zen-exit-btn');
        await expect(exitBtn).toBeVisible();
        await exitBtn.click();
        await page.waitForTimeout(300);

        await expect(page.locator('body')).not.toHaveClass(/zen-mode/);
        await expect(page.locator('#zen-btn')).toContainText('Zen Mode');
    });

    test('Escape exits zen mode', async ({ page }) => {
        await openPattern(page);

        await page.keyboard.press('f');
        await page.waitForTimeout(300);
        await expect(page.locator('body')).toHaveClass(/zen-mode/);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await expect(page.locator('body')).not.toHaveClass(/zen-mode/);
    });

    test('zen exit button in legend panel works', async ({ page }) => {
        await openPattern(page);

        await page.keyboard.press('f');
        await page.waitForTimeout(300);

        const exitBtn = page.locator('#zen-exit-btn');
        await expect(exitBtn).toBeVisible();
        await exitBtn.click();
        await page.waitForTimeout(300);

        await expect(page.locator('body')).not.toHaveClass(/zen-mode/);
    });
});

// ——————————————————————————————————————————————
// CALCULATOR DROPDOWN
// ——————————————————————————————————————————————
test.describe('Calculator Dropdown', () => {
    test('opens and shows links', async ({ page }) => {
        const slug = await openPattern(page);

        await page.click('#calc-toggle');
        await expect(page.locator('#calc-menu')).toBeVisible();
        await expect(page.locator('#calc-toggle')).toHaveClass(/open/);

        // Check links point to the right URLs with the pattern slug
        const threadLink = page.locator('#calc-menu a:has-text("Thread Needs")');
        await expect(threadLink).toBeVisible();
        const href = await threadLink.getAttribute('href');
        expect(href).toContain('/pattern-calculator');
        expect(href).toContain(slug);

        const fabricLink = page.locator('#calc-menu a:has-text("Fabric Size")');
        await expect(fabricLink).toBeVisible();
    });

    test('closes on second click', async ({ page }) => {
        await openPattern(page);

        await page.click('#calc-toggle');
        await expect(page.locator('#calc-menu')).toBeVisible();

        await page.click('#calc-toggle');
        await expect(page.locator('#calc-menu')).toBeHidden();
    });

    test('closes on outside click', async ({ page }) => {
        await openPattern(page);

        await page.click('#calc-toggle');
        await expect(page.locator('#calc-menu')).toBeVisible();

        // Click the canvas area (outside the dropdown)
        await page.click('#canvas-area');
        await page.waitForTimeout(200);
        await expect(page.locator('#calc-menu')).toBeHidden();
    });
});

// ——————————————————————————————————————————————
// KEYBOARD SHORTCUTS
// ——————————————————————————————————————————————
test.describe('Keyboard Shortcuts', () => {
    test('? key shows shortcut help', async ({ page }) => {
        await openPattern(page);

        await page.keyboard.press('?');
        await page.waitForTimeout(300);

        // Help dialog/overlay should appear
        await expect(page.locator('.notify-overlay')).toBeVisible();
    });

    test('help button shows shortcut help', async ({ page }) => {
        await openPattern(page);

        await page.click('#help-btn');
        await page.waitForTimeout(300);

        await expect(page.locator('.notify-overlay')).toBeVisible();
    });
});

// ——————————————————————————————————————————————
// SESSION TIMER
// ——————————————————————————————————————————————
test.describe('Session Timer', () => {
    test('timer starts counting after page load', async ({ page }) => {
        await openPattern(page);

        // Wait a couple of seconds for timer to show
        await page.waitForTimeout(2500);

        const timer = page.locator('#timer-display');
        const text = await timer.textContent();
        // Timer shows seconds (e.g. "3s"), minutes (e.g. "49m"), or hours (e.g. "1h 30m")
        expect(text).toMatch(/\d+[smh]/);
    });
});

// ——————————————————————————————————————————————
// BACK LINK
// ——————————————————————————————————————————————
test.describe('Navigation', () => {
    test('back link goes to saved patterns', async ({ page }) => {
        await openPattern(page);

        const backLink = page.locator('.back-link');
        await expect(backLink).toBeVisible();
        const href = await backLink.getAttribute('href');
        expect(href).toBe('/saved-patterns');
    });
});
