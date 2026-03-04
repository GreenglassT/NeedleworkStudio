// @ts-check
const { test, expect } = require('@playwright/test');

/*
 * Pattern Calculator E2E Tests
 *
 * Covers: three calculator modes (By Pattern, By Stitch Count, By Fabric Size),
 * mode switching, inputs/outputs, saved pattern loading, settings, results tables.
 *
 * Pre-requisites:
 *   - Server running on localhost:6969
 *   - Auth via storageState (see auth.setup.js)
 *   - At least one saved pattern in the database
 *
 * Run:  TEST_USER=<user> TEST_PASS=<pass> npx playwright test pattern-calculator
 */

/** Navigate to pattern calculator and wait for page load */
async function openCalc(page) {
    await page.goto('/pattern-calculator');
    await page.waitForLoadState('networkidle');
    // Mode toggle should be visible
    await expect(page.locator('.mode-btn[data-mode="pattern"]')).toBeVisible({ timeout: 10000 });
}

/** Cached slug for saved pattern loading */
let _cachedSlug = null;

/** Get a saved pattern slug */
async function getPatternSlug(page) {
    if (!_cachedSlug) {
        const resp = await page.request.get('/api/saved-patterns');
        const patterns = await resp.json();
        expect(patterns.length).toBeGreaterThan(0);
        _cachedSlug = patterns[0].slug;
    }
    return _cachedSlug;
}

// ——————————————————————————————————————————————
// PAGE LOAD & MODE SWITCHING
// ——————————————————————————————————————————————
test.describe('Page Load & Mode Switching', () => {
    test('starts in By Pattern mode by default', async ({ page }) => {
        await openCalc(page);

        await expect(page.locator('.mode-btn[data-mode="pattern"]')).toHaveClass(/active/);
        await expect(page.locator('.mode-btn[data-mode="stitch"]')).not.toHaveClass(/active/);
        await expect(page.locator('.mode-btn[data-mode="fabric"]')).not.toHaveClass(/active/);

        // Upload card visible in pattern mode
        await expect(page.locator('#pattern-upload-card')).toBeVisible();
    });

    test('switching to Stitch Count mode shows stitch inputs', async ({ page }) => {
        await openCalc(page);

        await page.click('.mode-btn[data-mode="stitch"]');
        await page.waitForTimeout(200);

        await expect(page.locator('.mode-btn[data-mode="stitch"]')).toHaveClass(/active/);
        await expect(page.locator('.mode-btn[data-mode="pattern"]')).not.toHaveClass(/active/);

        // Stitch count input should be visible
        await expect(page.locator('#q-stitch-count')).toBeVisible();
        // #q-strands is a native select hidden by custom dropdown — check label instead
        await expect(page.locator('label[for="q-strands"]')).toBeVisible();
        await expect(page.locator('#q-skein-length')).toBeVisible();

        // Pattern upload card should be hidden
        await expect(page.locator('#pattern-upload-card')).toBeHidden();
    });

    test('switching to Fabric Size mode shows fabric inputs', async ({ page }) => {
        await openCalc(page);

        await page.click('.mode-btn[data-mode="fabric"]');
        await page.waitForTimeout(200);

        await expect(page.locator('.mode-btn[data-mode="fabric"]')).toHaveClass(/active/);

        // Fabric inputs visible
        await expect(page.locator('#f-width')).toBeVisible();
        await expect(page.locator('#f-height')).toBeVisible();

        // Unit toggle visible
        await expect(page.locator('.f-unit-btn[data-funit="stitches"]')).toBeVisible();
        await expect(page.locator('.f-unit-btn[data-funit="inches"]')).toBeVisible();
    });

    test('modes cycle correctly: pattern → stitch → fabric → pattern', async ({ page }) => {
        await openCalc(page);

        // Start: pattern
        await expect(page.locator('.mode-btn[data-mode="pattern"]')).toHaveClass(/active/);

        // → stitch
        await page.click('.mode-btn[data-mode="stitch"]');
        await page.waitForTimeout(200);
        await expect(page.locator('.mode-btn[data-mode="stitch"]')).toHaveClass(/active/);
        await expect(page.locator('#q-stitch-count')).toBeVisible();

        // → fabric
        await page.click('.mode-btn[data-mode="fabric"]');
        await page.waitForTimeout(200);
        await expect(page.locator('.mode-btn[data-mode="fabric"]')).toHaveClass(/active/);
        await expect(page.locator('#f-width')).toBeVisible();

        // → pattern
        await page.click('.mode-btn[data-mode="pattern"]');
        await page.waitForTimeout(200);
        await expect(page.locator('.mode-btn[data-mode="pattern"]')).toHaveClass(/active/);
        await expect(page.locator('#pattern-upload-card')).toBeVisible();
    });

    test('no console errors on load', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await openCalc(page);
        expect(errors).toHaveLength(0);
    });

    test('?mode=stitch URL param opens stitch mode', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=stitch');
        await page.waitForLoadState('networkidle');

        await expect(page.locator('.mode-btn[data-mode="stitch"]')).toHaveClass(/active/, { timeout: 5000 });
        await expect(page.locator('#q-stitch-count')).toBeVisible();
    });

    test('?mode=fabric URL param opens fabric mode', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=fabric');
        await page.waitForLoadState('networkidle');

        await expect(page.locator('.mode-btn[data-mode="fabric"]')).toHaveClass(/active/);
        await expect(page.locator('#f-width')).toBeVisible();
    });
});

// ——————————————————————————————————————————————
// BY PATTERN MODE
// ——————————————————————————————————————————————
test.describe('By Pattern Mode', () => {
    test('saved pattern dropdown populates with patterns', async ({ page }) => {
        await openCalc(page);

        // The select is upgraded to custom dropdown
        const wrapper = page.locator('#pattern-select').locator('xpath=ancestor::*[contains(@class,"dmc-dropdown")]');
        const hasCustom = await wrapper.count() > 0;

        if (hasCustom) {
            await wrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);
            const options = wrapper.locator('.dmc-dropdown-option');
            expect(await options.count()).toBeGreaterThan(1); // first is placeholder
        } else {
            const options = await page.locator('#pattern-select option').count();
            expect(options).toBeGreaterThan(1);
        }
    });

    test('loading saved pattern shows results', async ({ page }) => {
        const slug = await getPatternSlug(page);
        await page.goto(`/pattern-calculator?pattern=${slug}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        // Summary bar should become visible
        await expect(page.locator('#summary-bar')).toHaveClass(/visible/, { timeout: 20000 });

        // Stats should show values
        await expect(page.locator('#stat-colors')).not.toBeEmpty();
        await expect(page.locator('#stat-stitches')).not.toBeEmpty();

        // Pattern name shown
        await expect(page.locator('#pattern-name')).not.toBeEmpty();

        // Results table should be visible
        await expect(page.locator('#results-card')).toHaveClass(/visible/);
    });

    test('settings bar shows after pattern load', async ({ page }) => {
        const slug = await getPatternSlug(page);
        await page.goto(`/pattern-calculator?pattern=${slug}`);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#summary-bar')).toHaveClass(/visible/, { timeout: 20000 });

        await expect(page.locator('#settings-bar')).toHaveClass(/visible/);

        // Settings bar controls visible (native selects hidden by custom dropdowns — check labels)
        await expect(page.locator('label[for="fabric-count"]')).toBeVisible();
        await expect(page.locator('label[for="strands"]')).toBeVisible();
        await expect(page.locator('#skein-length')).toBeVisible();
        await expect(page.locator('.efficiency-btn[data-eff="average"]')).toHaveClass(/active/);
    });

    test('efficiency buttons toggle correctly', async ({ page }) => {
        const slug = await getPatternSlug(page);
        await page.goto(`/pattern-calculator?pattern=${slug}`);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#summary-bar')).toHaveClass(/visible/, { timeout: 20000 });

        // Default: Average
        await expect(page.locator('.efficiency-btn[data-eff="average"]')).toHaveClass(/active/);

        // Click Efficient
        await page.click('.efficiency-btn[data-eff="efficient"]');
        await page.waitForTimeout(300);
        await expect(page.locator('.efficiency-btn[data-eff="efficient"]')).toHaveClass(/active/);
        await expect(page.locator('.efficiency-btn[data-eff="average"]')).not.toHaveClass(/active/);

        // Click Inefficient
        await page.click('.efficiency-btn[data-eff="inefficient"]');
        await page.waitForTimeout(300);
        await expect(page.locator('.efficiency-btn[data-eff="inefficient"]')).toHaveClass(/active/);
        await expect(page.locator('.efficiency-btn[data-eff="efficient"]')).not.toHaveClass(/active/);

        // Reset to Average
        await page.click('.efficiency-btn[data-eff="average"]');
        await page.waitForTimeout(200);
    });

    test('view toggle filters results table', async ({ page }) => {
        const slug = await getPatternSlug(page);
        await page.goto(`/pattern-calculator?pattern=${slug}`);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#summary-bar')).toHaveClass(/visible/, { timeout: 20000 });

        // View bar should be visible
        await expect(page.locator('#view-bar')).toHaveClass(/visible/, { timeout: 5000 });

        // Default: All Colors active
        await expect(page.locator('.view-btn[data-view="all"]')).toHaveClass(/active/);

        const allRows = await page.locator('#results-card tbody tr').count();
        expect(allRows).toBeGreaterThan(0);

        // Switch to Shopping List
        await page.click('.view-btn[data-view="buy"]');
        await page.waitForTimeout(300);
        await expect(page.locator('.view-btn[data-view="buy"]')).toHaveClass(/active/);

        // Switch to Have Enough
        await page.click('.view-btn[data-view="have"]');
        await page.waitForTimeout(300);
        await expect(page.locator('.view-btn[data-view="have"]')).toHaveClass(/active/);

        // Reset to All
        await page.click('.view-btn[data-view="all"]');
        await page.waitForTimeout(200);
    });

    test('table headers are sortable', async ({ page }) => {
        const slug = await getPatternSlug(page);
        await page.goto(`/pattern-calculator?pattern=${slug}`);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#summary-bar')).toHaveClass(/visible/, { timeout: 20000 });

        // Click "DMC #" header to sort
        await page.click('th:has-text("DMC")');
        await page.waitForTimeout(300);

        // Should have a sorted column with arrow indicator
        const sortedTh = page.locator('th.sorted');
        expect(await sortedTh.count()).toBe(1);

        // Click again to reverse sort direction
        await page.click('th:has-text("DMC")');
        await page.waitForTimeout(300);

        expect(await page.locator('th.sorted').count()).toBe(1);
    });

    test('CSV download triggers file download', async ({ page }) => {
        const slug = await getPatternSlug(page);
        await page.goto(`/pattern-calculator?pattern=${slug}`);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#summary-bar')).toHaveClass(/visible/, { timeout: 20000 });

        const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
        await page.click('.action-btn:has-text("CSV")');

        const download = await downloadPromise;
        expect(download.suggestedFilename()).toContain('.csv');
    });
});

// ——————————————————————————————————————————————
// BY STITCH COUNT MODE
// ——————————————————————————————————————————————
test.describe('By Stitch Count Mode', () => {
    test('entering stitch count shows results table', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=stitch');
        await page.waitForLoadState('networkidle');

        await page.fill('#q-stitch-count', '5000');
        await page.waitForTimeout(500);

        // Results should appear
        const resultsDiv = page.locator('#q-skein-results');
        await expect(resultsDiv.locator('table')).toBeVisible({ timeout: 5000 });

        // Table should have rows (9 fabric counts)
        const rows = resultsDiv.locator('tbody tr');
        expect(await rows.count()).toBeGreaterThan(0);
    });

    test('changing strands recalculates', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=stitch');
        await page.waitForLoadState('networkidle');

        await page.fill('#q-stitch-count', '5000');
        await page.waitForTimeout(500);

        // Get results with 2 strands (default)
        const firstValue = await page.locator('#q-skein-results tbody tr').first().locator('td').nth(2).textContent();

        // Change to 1 strand — use custom dropdown
        const wrapper = page.locator('#q-strands').locator('xpath=ancestor::*[contains(@class,"dmc-dropdown")]');
        const hasCustom = await wrapper.count() > 0;
        if (hasCustom) {
            await wrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);
            await wrapper.locator('.dmc-dropdown-option[data-value="1"]').click();
        } else {
            await page.selectOption('#q-strands', '1');
        }
        await page.waitForTimeout(500);

        // Value should change (fewer strands = fewer skeins)
        const newValue = await page.locator('#q-skein-results tbody tr').first().locator('td').nth(2).textContent();
        expect(newValue).not.toBe(firstValue);
    });

    test('efficiency buttons toggle in stitch mode', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=stitch');
        await page.waitForLoadState('networkidle');

        // Default: Average
        await expect(page.locator('.efficiency-btn[data-qeff="average"]')).toHaveClass(/active/);

        await page.click('.efficiency-btn[data-qeff="efficient"]');
        await page.waitForTimeout(200);
        await expect(page.locator('.efficiency-btn[data-qeff="efficient"]')).toHaveClass(/active/);
        await expect(page.locator('.efficiency-btn[data-qeff="average"]')).not.toHaveClass(/active/);

        // Reset
        await page.click('.efficiency-btn[data-qeff="average"]');
    });

    test('empty stitch count shows no results', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=stitch');
        await page.waitForLoadState('networkidle');

        // Don't enter anything — results should be empty or show message
        const table = page.locator('#q-skein-results table');
        await expect(table).not.toBeVisible();
    });

    test('stitch count results show 9 fabric rows', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=stitch');
        await page.waitForLoadState('networkidle');

        await page.fill('#q-stitch-count', '10000');
        await page.waitForTimeout(500);

        const rows = page.locator('#q-skein-results tbody tr');
        expect(await rows.count()).toBe(9); // 11, 14, 16, 18, 20, 22, 25, 28, 32
    });
});

// ——————————————————————————————————————————————
// BY FABRIC SIZE MODE
// ——————————————————————————————————————————————
test.describe('By Fabric Size Mode', () => {
    test('entering dimensions shows fabric results table', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=fabric');
        await page.waitForLoadState('networkidle');

        await page.fill('#f-width', '100');
        await page.fill('#f-height', '150');
        await page.waitForTimeout(500);

        // Results table should appear
        const resultsDiv = page.locator('#f-fabric-results');
        await expect(resultsDiv.locator('table')).toBeVisible({ timeout: 5000 });

        // Should have 9 rows (one per fabric count)
        const rows = resultsDiv.locator('tbody tr');
        expect(await rows.count()).toBe(9);
    });

    test('results show design size with suggested fabric', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=fabric');
        await page.waitForLoadState('networkidle');

        await page.fill('#f-width', '100');
        await page.fill('#f-height', '100');
        await page.waitForTimeout(500);

        // First row should contain dimensions with inch symbol
        const firstRow = page.locator('#f-fabric-results tbody tr').first();
        const designSize = await firstRow.locator('td').nth(1).textContent();
        expect(designSize).toContain('"');

        const suggestedFabric = await firstRow.locator('td').nth(2).textContent();
        expect(suggestedFabric).toContain('"');
    });

    test('unit toggle switches between Stitches and Inches', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=fabric');
        await page.waitForLoadState('networkidle');

        // Default: Stitches active
        await expect(page.locator('.f-unit-btn[data-funit="stitches"]')).toHaveClass(/active/);

        // Original count container should be hidden
        await expect(page.locator('#f-original-count-container')).not.toHaveClass(/visible/);

        // Switch to Inches
        await page.click('.f-unit-btn[data-funit="inches"]');
        await page.waitForTimeout(200);

        await expect(page.locator('.f-unit-btn[data-funit="inches"]')).toHaveClass(/active/);
        await expect(page.locator('.f-unit-btn[data-funit="stitches"]')).not.toHaveClass(/active/);

        // Original count container should become visible
        await expect(page.locator('#f-original-count-container')).toHaveClass(/visible/);

        // Switch back
        await page.click('.f-unit-btn[data-funit="stitches"]');
        await page.waitForTimeout(200);
        await expect(page.locator('#f-original-count-container')).not.toHaveClass(/visible/);
    });

    test('inches mode shows original count selector and calculates', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=fabric');
        await page.waitForLoadState('networkidle');

        // Switch to Inches
        await page.click('.f-unit-btn[data-funit="inches"]');
        await page.waitForTimeout(200);

        await page.fill('#f-width', '7');
        await page.fill('#f-height', '9');
        await page.waitForTimeout(500);

        // Results should appear
        const resultsDiv = page.locator('#f-fabric-results');
        await expect(resultsDiv.locator('table')).toBeVisible({ timeout: 5000 });
    });

    test('empty dimensions show no results', async ({ page }) => {
        await page.goto('/pattern-calculator?mode=fabric');
        await page.waitForLoadState('networkidle');

        const table = page.locator('#f-fabric-results table');
        await expect(table).not.toBeVisible();
    });
});

// ——————————————————————————————————————————————
// URL DEEP LINKING
// ——————————————————————————————————————————————
test.describe('URL Deep Linking', () => {
    test('?pattern=slug auto-loads pattern and shows results', async ({ page }) => {
        const slug = await getPatternSlug(page);
        await page.goto(`/pattern-calculator?pattern=${slug}`);
        await page.waitForLoadState('networkidle');

        await expect(page.locator('#summary-bar')).toHaveClass(/visible/, { timeout: 20000 });
        await expect(page.locator('#pattern-name')).not.toBeEmpty();
    });

    test('redirects from /stash-calculator work', async ({ page }) => {
        const resp = await page.goto('/stash-calculator');
        // Should redirect to /pattern-calculator
        expect(page.url()).toContain('/pattern-calculator');
    });

    test('redirects from /skein-calculator open stitch mode', async ({ page }) => {
        await page.goto('/skein-calculator');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        expect(page.url()).toContain('mode=stitch');
        await expect(page.locator('.mode-btn[data-mode="stitch"]')).toHaveClass(/active/, { timeout: 5000 });
    });

    test('redirects from /calculator open fabric mode', async ({ page }) => {
        await page.goto('/calculator');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        expect(page.url()).toContain('mode=fabric');
        await expect(page.locator('.mode-btn[data-mode="fabric"]')).toHaveClass(/active/, { timeout: 5000 });
    });
});
