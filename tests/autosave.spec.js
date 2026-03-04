// @ts-check
const { test, expect } = require('@playwright/test');

/*
 * Autosave E2E Tests
 *
 * Verifies the autosave/recovery system across editor pages:
 *   1. Pattern viewer  — key: ns-autosave-{slug}
 *   2. Create pattern  — key: ns-autosave-create
 *
 * Also tests the toast action buttons system.
 *
 * Pre-requisites:
 *   - Server running on localhost:6969
 *   - Auth handled via storageState (see auth.setup.js)
 *   - At least one saved pattern in the database
 *
 * Run:  TEST_USER=<user> TEST_PASS=<pass> npx playwright test
 */

/** Cached slug to avoid hitting rate-limited API every beforeEach */
let _cachedSlug = null;

// ——————————————————————————————————————————————
// PATTERN VIEWER AUTOSAVE
// ——————————————————————————————————————————————
test.describe('Pattern Viewer Autosave', () => {
    let patternSlug;

    test.beforeEach(async ({ page }) => {
        // Get a pattern slug (cached to avoid rate limits)
        if (!_cachedSlug) {
            const resp = await page.request.get('/api/saved-patterns');
            const patterns = await resp.json();
            expect(patterns.length).toBeGreaterThan(0);
            _cachedSlug = patterns[0].slug;
        }
        patternSlug = _cachedSlug;

        // Clear any leftover autosave data
        await page.goto(`/view/${patternSlug}`);
        await page.waitForLoadState('networkidle');
        await page.evaluate((slug) => {
            localStorage.removeItem('ns-autosave-' + slug);
        }, patternSlug);
    });

    test('autosave triggers after edit and debounce', async ({ page }) => {
        // Trigger autosave by directly calling _scheduleAutosave
        await page.evaluate(() => {
            // Modify pattern data slightly
            patternData.grid[0] = patternData.legend[0]?.dmc || 'BG';
            // Call the autosave scheduler
            if (typeof _scheduleAutosave === 'function') _scheduleAutosave();
        });

        // Wait for the 5-second debounce + buffer
        await page.waitForTimeout(6500);

        // Check that autosave data exists in localStorage
        const saved = await page.evaluate((slug) => {
            const data = localStorage.getItem('ns-autosave-' + slug);
            return data ? JSON.parse(data) : null;
        }, patternSlug);

        expect(saved).not.toBeNull();
        expect(saved).toHaveProperty('grid');
        expect(saved).toHaveProperty('legend');
        expect(saved).toHaveProperty('grid_w');
        expect(saved).toHaveProperty('grid_h');
        expect(saved).toHaveProperty('timestamp');
        expect(saved.timestamp).toBeGreaterThan(Date.now() - 15000);
    });

    test('recovery toast appears when autosave data exists', async ({ page }) => {
        // Seed autosave data with a recent timestamp
        await page.evaluate((slug) => {
            const modified = {
                grid: patternData.grid.slice(),
                legend: patternData.legend.slice(),
                grid_w: patternData.grid_w,
                grid_h: patternData.grid_h,
                part_stitches: [], backstitches: [], knots: [], beads: [],
                timestamp: Date.now() - 60000,
            };
            if (modified.legend.length > 0) modified.grid[0] = modified.legend[0].dmc;
            localStorage.setItem('ns-autosave-' + slug, JSON.stringify(modified));
        }, patternSlug);

        // Reload — recovery toast should appear
        await page.reload();
        await page.waitForLoadState('networkidle');

        // Check for recovery toast with Recover/Discard buttons
        const toast = page.locator('.toast-info');
        await expect(toast).toBeVisible({ timeout: 5000 });
        await expect(toast).toContainText('Unsaved edits found');
        await expect(toast.locator('.toast-action-btn:has-text("Recover")')).toBeVisible();
        await expect(toast.locator('.toast-action-btn:has-text("Discard")')).toBeVisible();
    });

    test('Discard removes autosave data', async ({ page }) => {
        // Seed autosave
        await page.evaluate((slug) => {
            localStorage.setItem('ns-autosave-' + slug, JSON.stringify({
                grid: patternData.grid, legend: patternData.legend,
                grid_w: patternData.grid_w, grid_h: patternData.grid_h,
                part_stitches: [], backstitches: [], knots: [], beads: [],
                timestamp: Date.now() - 60000,
            }));
        }, patternSlug);

        await page.reload();
        await page.waitForLoadState('networkidle');

        // Click Discard
        const discardBtn = page.locator('.toast-action-btn:has-text("Discard")');
        await expect(discardBtn).toBeVisible({ timeout: 5000 });
        await discardBtn.click();

        // Verify autosave key is gone
        const remaining = await page.evaluate((slug) => {
            return localStorage.getItem('ns-autosave-' + slug);
        }, patternSlug);
        expect(remaining).toBeNull();
    });

    test('Recover restores edited pattern data', async ({ page }) => {
        // Seed autosave with a modified grid cell
        const modifiedDmc = await page.evaluate((slug) => {
            const modified = {
                grid: patternData.grid.slice(),
                legend: patternData.legend.slice(),
                grid_w: patternData.grid_w, grid_h: patternData.grid_h,
                part_stitches: [], backstitches: [], knots: [], beads: [],
                timestamp: Date.now() - 30000,
            };
            const target = modified.legend.length > 1 ? modified.legend[1].dmc : modified.legend[0].dmc;
            modified.grid[0] = target;
            localStorage.setItem('ns-autosave-' + slug, JSON.stringify(modified));
            return target;
        }, patternSlug);

        await page.reload();
        await page.waitForLoadState('networkidle');

        // Click Recover
        const recoverBtn = page.locator('.toast-action-btn:has-text("Recover")');
        await expect(recoverBtn).toBeVisible({ timeout: 5000 });
        await recoverBtn.click();

        // Verify grid was updated
        const cell0 = await page.evaluate(() => patternData.grid[0]);
        expect(cell0).toBe(modifiedDmc);

        // Verify success toast appeared
        await expect(page.locator('.toast-success')).toBeVisible({ timeout: 3000 });
    });

    test('expired autosave (>7 days) is silently removed', async ({ page }) => {
        // Seed autosave with 8-day-old timestamp
        await page.evaluate((slug) => {
            localStorage.setItem('ns-autosave-' + slug, JSON.stringify({
                grid: patternData.grid, legend: patternData.legend,
                grid_w: patternData.grid_w, grid_h: patternData.grid_h,
                part_stitches: [], backstitches: [], knots: [], beads: [],
                timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000,
            }));
        }, patternSlug);

        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        // No toast should appear
        await expect(page.locator('.toast-info')).not.toBeVisible();

        // Key should be removed
        const remaining = await page.evaluate((slug) => {
            return localStorage.getItem('ns-autosave-' + slug);
        }, patternSlug);
        expect(remaining).toBeNull();
    });

    test('autosave is cleared after successful save', async ({ page }) => {
        // Seed autosave
        await page.evaluate((slug) => {
            localStorage.setItem('ns-autosave-' + slug, JSON.stringify({
                grid: patternData.grid, legend: patternData.legend,
                grid_w: patternData.grid_w, grid_h: patternData.grid_h,
                part_stitches: [], backstitches: [], knots: [], beads: [],
                timestamp: Date.now(),
            }));
        }, patternSlug);

        // Verify it's set
        let hasSave = await page.evaluate((slug) =>
            localStorage.getItem('ns-autosave-' + slug) !== null, patternSlug);
        expect(hasSave).toBe(true);

        // Enter edit mode and save
        await page.click('button:has-text("Edit Pattern")');
        await page.click('button:has-text("Edit Original")');
        await page.waitForTimeout(500);
        await page.click('button:has-text("Save")');
        await page.waitForTimeout(3000);

        // Autosave should be cleared
        hasSave = await page.evaluate((slug) =>
            localStorage.getItem('ns-autosave-' + slug) !== null, patternSlug);
        expect(hasSave).toBe(false);
    });
});

// ——————————————————————————————————————————————
// CREATE PATTERN AUTOSAVE
// ——————————————————————————————————————————————
test.describe('Create Pattern Autosave', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/create-pattern');
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => localStorage.removeItem('ns-autosave-create'));
    });

    test('autosave triggers after editor edit', async ({ page }) => {
        // Create a small canvas
        await page.fill('#setup-w', '20');
        await page.fill('#setup-h', '20');
        await page.click('.setup-actions button');
        await page.waitForTimeout(500);

        // Trigger autosave
        await page.evaluate(() => {
            if (typeof _scheduleAutosave === 'function') _scheduleAutosave();
        });

        await page.waitForTimeout(6500);

        const saved = await page.evaluate(() => {
            const data = localStorage.getItem('ns-autosave-create');
            return data ? JSON.parse(data) : null;
        });

        expect(saved).not.toBeNull();
        expect(saved.grid_w).toBe(20);
        expect(saved.grid_h).toBe(20);
        expect(saved.grid).toHaveLength(400);
        expect(saved.timestamp).toBeGreaterThan(Date.now() - 15000);
    });

    test('recovery toast appears after creating canvas with existing autosave', async ({ page }) => {
        // Seed autosave
        await page.evaluate(() => {
            const grid = new Array(100).fill('BG');
            grid[0] = '310';
            localStorage.setItem('ns-autosave-create', JSON.stringify({
                grid,
                legend: [{ dmc: '310', hex: '#000000', symbol: '+', name: 'Black', stitches: 1 }],
                grid_w: 10, grid_h: 10,
                part_stitches: [], backstitches: [], knots: [], beads: [],
                timestamp: Date.now() - 120000,
            }));
        });

        // Create canvas — triggers recovery check
        await page.fill('#setup-w', '10');
        await page.fill('#setup-h', '10');
        await page.click('.setup-actions button');
        await page.waitForTimeout(1000);

        const toast = page.locator('.toast-info');
        await expect(toast).toBeVisible({ timeout: 5000 });
        await expect(toast).toContainText('Unsaved work found');
    });

    test('Recover restores grid data on create pattern', async ({ page }) => {
        // Seed autosave with colored cells
        await page.evaluate(() => {
            const grid = new Array(100).fill('BG');
            grid[0] = '310';
            grid[5] = '321';
            localStorage.setItem('ns-autosave-create', JSON.stringify({
                grid,
                legend: [
                    { dmc: '310', hex: '#000000', symbol: '+', name: 'Black', stitches: 1 },
                    { dmc: '321', hex: '#C43030', symbol: '×', name: 'Red', stitches: 1 },
                ],
                grid_w: 10, grid_h: 10,
                part_stitches: [], backstitches: [], knots: [], beads: [],
                timestamp: Date.now() - 60000,
            }));
        });

        await page.fill('#setup-w', '10');
        await page.fill('#setup-h', '10');
        await page.click('.setup-actions button');
        await page.waitForTimeout(1000);

        // Click Recover
        const recoverBtn = page.locator('.toast-action-btn:has-text("Recover")');
        await expect(recoverBtn).toBeVisible({ timeout: 5000 });
        await recoverBtn.click();

        // Verify grid was restored
        const result = await page.evaluate(() => ({
            cell0: patternData.grid[0],
            cell5: patternData.grid[5],
            legendLen: patternData.legend.length,
        }));
        expect(result.cell0).toBe('310');
        expect(result.cell5).toBe('321');
        expect(result.legendLen).toBe(2);
    });

    test('Discard clears autosave on create pattern', async ({ page }) => {
        // Seed autosave
        await page.evaluate(() => {
            localStorage.setItem('ns-autosave-create', JSON.stringify({
                grid: new Array(100).fill('BG'), legend: [],
                grid_w: 10, grid_h: 10,
                part_stitches: [], backstitches: [], knots: [], beads: [],
                timestamp: Date.now() - 60000,
            }));
        });

        await page.fill('#setup-w', '10');
        await page.fill('#setup-h', '10');
        await page.click('.setup-actions button');
        await page.waitForTimeout(1000);

        const discardBtn = page.locator('.toast-action-btn:has-text("Discard")');
        await expect(discardBtn).toBeVisible({ timeout: 5000 });
        await discardBtn.click();

        const remaining = await page.evaluate(() => localStorage.getItem('ns-autosave-create'));
        expect(remaining).toBeNull();
    });
});

// ——————————————————————————————————————————————
// TOAST ACTION BUTTONS
// ——————————————————————————————————————————————
test.describe('Toast Action Buttons', () => {
    test('toast with actions renders buttons and is persistent', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // Create a toast with action buttons
        await page.evaluate(() => {
            window._testActionClicked = null;
            toast('Test action toast', {
                type: 'info', duration: 0,
                actions: [
                    { label: 'Accept', onClick: () => { window._testActionClicked = 'accept'; } },
                    { label: 'Reject', onClick: () => { window._testActionClicked = 'reject'; } },
                ],
            });
        });

        const toastEl = page.locator('.toast-info');
        await expect(toastEl).toBeVisible();
        await expect(toastEl).toContainText('Test action toast');

        // Verify both action buttons exist
        await expect(toastEl.locator('.toast-action-btn:has-text("Accept")')).toBeVisible();
        await expect(toastEl.locator('.toast-action-btn:has-text("Reject")')).toBeVisible();

        // Persistent toast should still be there after 4 seconds
        await page.waitForTimeout(4000);
        await expect(toastEl).toBeVisible();

        // Click Accept — should dismiss and fire callback
        await toastEl.locator('.toast-action-btn:has-text("Accept")').click();
        await page.waitForTimeout(300);

        await expect(toastEl).not.toBeVisible({ timeout: 3000 });

        const clicked = await page.evaluate(() => window._testActionClicked);
        expect(clicked).toBe('accept');
    });

    test('toast without actions auto-dismisses', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await page.evaluate(() => {
            toast('Brief message', { type: 'success', duration: 1500 });
        });

        const toastEl = page.locator('.toast-success');
        await expect(toastEl).toBeVisible();

        // Wait for auto-dismiss
        await page.waitForTimeout(2000);
        await expect(toastEl).not.toBeVisible({ timeout: 3000 });
    });
});
