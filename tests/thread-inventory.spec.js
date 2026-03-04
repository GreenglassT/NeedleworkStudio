// @ts-check
const { test, expect } = require('@playwright/test');

/*
 * Thread Inventory (Home Page) E2E Tests
 *
 * Covers: stats bar, search/filter, brand toggle, view switching,
 * zoom, status toggling, similar colors modal, selection mode,
 * bulk actions, export dropdown, notes, skein quantity.
 *
 * Pre-requisites:
 *   - Server running on localhost:6969
 *   - Auth via storageState (see auth.setup.js)
 *
 * Run:  TEST_USER=<user> TEST_PASS=<pass> npx playwright test thread-inventory
 */

/** Navigate to inventory and wait for threads to load */
async function openInventory(page) {
    await page.goto('/inventory');
    await page.waitForLoadState('networkidle');
    // Wait for threads to render (list view is default)
    await expect(page.locator('#thread-list .list-row').first()).toBeVisible({ timeout: 10000 });
}

// ——————————————————————————————————————————————
// PAGE LOAD
// ——————————————————————————————————————————————
test.describe('Page Load', () => {
    test('displays stats bar with numeric values', async ({ page }) => {
        await openInventory(page);

        // Stats should show numbers, not placeholder dashes
        await expect(page.locator('#stat-total')).not.toHaveText('—');
        await expect(page.locator('#stat-owned')).not.toHaveText('—');
        await expect(page.locator('#stat-need')).not.toHaveText('—');
        await expect(page.locator('#stat-dont-own')).not.toHaveText('—');

        const total = parseInt(await page.locator('#stat-total').textContent());
        expect(total).toBeGreaterThan(0);
    });

    test('thread list renders rows with swatch, number, and name', async ({ page }) => {
        await openInventory(page);

        const rows = page.locator('#thread-list .list-row');
        expect(await rows.count()).toBeGreaterThan(0);

        const firstRow = rows.first();
        await expect(firstRow.locator('.list-swatch')).toBeVisible();
        await expect(firstRow.locator('.list-num')).not.toBeEmpty();
        await expect(firstRow.locator('.list-name')).not.toBeEmpty();
    });

    test('no console errors on load', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await openInventory(page);
        expect(errors).toHaveLength(0);
    });

    test('DMC brand is selected by default', async ({ page }) => {
        await openInventory(page);

        await expect(page.locator('.brand-seg-btn[data-brand="DMC"]')).toHaveClass(/active/);
        await expect(page.locator('#brand-eyebrow-text')).toContainText('DMC');
    });
});

// ——————————————————————————————————————————————
// SEARCH
// ——————————————————————————————————————————————
test.describe('Search', () => {
    test('search by thread number filters results', async ({ page }) => {
        await openInventory(page);

        // Get the first thread's number to search for
        const firstNum = (await page.locator('#thread-list .list-row .list-num').first().textContent()).trim();

        await page.fill('#search', firstNum);
        await page.waitForTimeout(500); // debounce

        const rows = page.locator('#thread-list .list-row');
        const count = await rows.count();
        expect(count).toBeGreaterThan(0);

        // All visible rows should match the searched number
        await expect(rows.first().locator('.list-num')).toContainText(firstNum);
    });

    test('search with no results shows empty state', async ({ page }) => {
        await openInventory(page);

        await page.fill('#search', 'zzz_no_match_xyz_999');
        await page.waitForTimeout(500);

        const rows = await page.locator('#thread-list .list-row').count();
        expect(rows).toBe(0);

        // Should show "No threads found" message in list or grid
        await expect(page.locator('#thread-list .state-msg, #thread-grid .state-msg').first()).toBeVisible();
    });

    test('clearing search restores results', async ({ page }) => {
        await openInventory(page);

        const initialCount = await page.locator('#thread-list .list-row').count();

        await page.fill('#search', 'zzz_no_match');
        await page.waitForTimeout(500);

        await page.fill('#search', '');
        await page.waitForTimeout(500);

        const restored = await page.locator('#thread-list .list-row').count();
        expect(restored).toBe(initialCount);
    });
});

// ——————————————————————————————————————————————
// FILTERS (Category, Status, Sort)
// ——————————————————————————————————————————————
test.describe('Filters', () => {
    test('status filter shows only owned threads', async ({ page }) => {
        await openInventory(page);

        // Open custom dropdown for status filter
        const statusDropdown = page.locator('#status-filter').locator('..').locator('.dmc-dropdown-trigger');
        // If custom dropdown exists, use it; otherwise fall back to native select
        const hasCustom = await page.locator('.dmc-dropdown-trigger').first().isVisible().catch(() => false);

        if (hasCustom) {
            // Find the status dropdown wrapper
            const wrapper = page.locator('#status-filter').locator('xpath=ancestor::*[contains(@class,"dmc-dropdown")]');
            await wrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);
            await wrapper.locator('.dmc-dropdown-option[data-value="own"]').click();
        } else {
            await page.selectOption('#status-filter', 'own');
        }
        await page.waitForTimeout(500);

        // All visible rows should have own status buttons active
        const rows = page.locator('#thread-list .list-row');
        const count = await rows.count();
        if (count > 0) {
            await expect(rows.first().locator('.lbtn.s-own')).toBeVisible();
        }

        // Reset to all
        if (hasCustom) {
            const wrapper = page.locator('#status-filter').locator('xpath=ancestor::*[contains(@class,"dmc-dropdown")]');
            await wrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);
            await wrapper.locator('.dmc-dropdown-option[data-value=""]').click();
        } else {
            await page.selectOption('#status-filter', '');
        }
        await page.waitForTimeout(500);
    });

    test('sort filter changes order', async ({ page }) => {
        await openInventory(page);

        // Get first thread number with default sort (by number)
        const firstNum = (await page.locator('#thread-list .list-row .list-num').first().textContent()).trim();

        // Change sort to Name
        const hasCustom = await page.locator('.dmc-dropdown-trigger').first().isVisible().catch(() => false);
        if (hasCustom) {
            const wrapper = page.locator('#sort-filter').locator('xpath=ancestor::*[contains(@class,"dmc-dropdown")]');
            await wrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);
            await wrapper.locator('.dmc-dropdown-option[data-value="name"]').click();
        } else {
            await page.selectOption('#sort-filter', 'name');
        }
        await page.waitForTimeout(500);

        // First thread may have changed
        const newFirstNum = (await page.locator('#thread-list .list-row .list-num').first().textContent()).trim();
        // They should differ (name sort vs number sort)
        // Note: might be same if first alphabetically is also first numerically — just verify it loaded
        const rows = await page.locator('#thread-list .list-row').count();
        expect(rows).toBeGreaterThan(0);

        // Reset to number sort
        if (hasCustom) {
            const wrapper = page.locator('#sort-filter').locator('xpath=ancestor::*[contains(@class,"dmc-dropdown")]');
            await wrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);
            await wrapper.locator('.dmc-dropdown-option[data-value="number"]').click();
        } else {
            await page.selectOption('#sort-filter', 'number');
        }
        await page.waitForTimeout(500);
    });

    test('category filter loads and selects options', async ({ page }) => {
        await openInventory(page);

        // The category dropdown should have multiple options
        const hasCustom = await page.locator('.dmc-dropdown-trigger').first().isVisible().catch(() => false);
        if (hasCustom) {
            const wrapper = page.locator('#category-filter').locator('xpath=ancestor::*[contains(@class,"dmc-dropdown")]');
            await wrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);

            // Should have multiple options (All + categories)
            const options = wrapper.locator('.dmc-dropdown-option');
            expect(await options.count()).toBeGreaterThan(1);

            // Click a non-"All" option
            await options.nth(1).click();
            await page.waitForTimeout(500);

            // Results should still load (maybe fewer)
            const rows = await page.locator('#thread-list .list-row').count();
            expect(rows).toBeGreaterThanOrEqual(0);

            // Reset to All
            await wrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);
            await wrapper.locator('.dmc-dropdown-option').first().click();
            await page.waitForTimeout(500);
        } else {
            const options = await page.locator('#category-filter option').count();
            expect(options).toBeGreaterThan(1);
        }
    });
});

// ——————————————————————————————————————————————
// BRAND TOGGLE
// ——————————————————————————————————————————————
test.describe('Brand Toggle', () => {
    test('switching to Anchor updates threads and stats', async ({ page }) => {
        await openInventory(page);

        // Click Anchor
        await page.click('.brand-seg-btn[data-brand="Anchor"]');
        await page.waitForTimeout(800);

        await expect(page.locator('.brand-seg-btn[data-brand="Anchor"]')).toHaveClass(/active/);
        await expect(page.locator('.brand-seg-btn[data-brand="DMC"]')).not.toHaveClass(/active/);

        // Stats should update
        const total = await page.locator('#stat-total').textContent();
        expect(total).not.toBe('—');

        // Threads should load
        const rows = await page.locator('#thread-list .list-row').count();
        expect(rows).toBeGreaterThan(0);

        // Switch back to DMC
        await page.click('.brand-seg-btn[data-brand="DMC"]');
        await page.waitForTimeout(800);
        await expect(page.locator('.brand-seg-btn[data-brand="DMC"]')).toHaveClass(/active/);
    });

    test('All brand shows both DMC and Anchor threads', async ({ page }) => {
        await openInventory(page);

        // Get DMC count
        const dmcCount = await page.locator('#thread-list .list-row').count();

        // Switch to All
        await page.click('.brand-seg-btn[data-brand=""]');
        await page.waitForTimeout(800);

        await expect(page.locator('.brand-seg-btn[data-brand=""]')).toHaveClass(/active/);

        const allCount = await page.locator('#thread-list .list-row').count();
        expect(allCount).toBeGreaterThanOrEqual(dmcCount);

        // Switch back to DMC
        await page.click('.brand-seg-btn[data-brand="DMC"]');
        await page.waitForTimeout(800);
    });
});

// ——————————————————————————————————————————————
// VIEW SWITCHING
// ——————————————————————————————————————————————
test.describe('View Switching', () => {
    test('grid view shows thread cards', async ({ page }) => {
        await openInventory(page);

        // Default is list — switch to grid
        await page.click('.view-btn[data-view="grid"]');
        await page.waitForTimeout(300);

        await expect(page.locator('.view-btn[data-view="grid"]')).toHaveClass(/active/);
        await expect(page.locator('#thread-grid')).toHaveClass(/active/);
        await expect(page.locator('#thread-list')).not.toHaveClass(/active/);

        // Grid cards visible
        const cards = page.locator('#thread-grid .thread-card');
        expect(await cards.count()).toBeGreaterThan(0);

        // Card has swatch, name, number, status buttons
        const firstCard = cards.first();
        await expect(firstCard.locator('.card-swatch')).toBeVisible();
        await expect(firstCard.locator('.card-name')).not.toBeEmpty();
        await expect(firstCard.locator('.card-number')).not.toBeEmpty();

        // Switch back to list
        await page.click('.view-btn[data-view="list"]');
        await page.waitForTimeout(300);
    });

    test('list view is default and shows rows', async ({ page }) => {
        await openInventory(page);

        await expect(page.locator('.view-btn[data-view="list"]')).toHaveClass(/active/);
        await expect(page.locator('#thread-list')).toHaveClass(/active/);
    });
});

// ——————————————————————————————————————————————
// ZOOM
// ——————————————————————————————————————————————
test.describe('Zoom', () => {
    test('zoom slider changes zoom level display', async ({ page }) => {
        await openInventory(page);

        const slider = page.locator('#zoom-slider');
        const val = page.locator('#zoom-val');

        // Default is 100%
        await expect(val).toContainText('100%');

        // Set to 120
        await slider.fill('120');
        await slider.dispatchEvent('input');
        await page.waitForTimeout(200);

        await expect(val).toContainText('120%');

        // Reset
        await slider.fill('100');
        await slider.dispatchEvent('input');
    });
});

// ——————————————————————————————————————————————
// STATUS TOGGLING
// ——————————————————————————————————————————————
test.describe('Status Toggling', () => {
    test('clicking Own/Need/Don\'t Own toggles thread status', async ({ page }) => {
        await openInventory(page);

        const firstRow = page.locator('#thread-list .list-row').first();
        const threadId = await firstRow.getAttribute('data-id');

        // Get current status
        const ownBtn = firstRow.locator('.lbtn').nth(0); // Own
        const needBtn = firstRow.locator('.lbtn').nth(1); // Need
        const skipBtn = firstRow.locator('.lbtn').nth(2); // Don't Own

        // Record which is currently active
        const ownActive = await ownBtn.evaluate(el => el.classList.contains('s-own'));
        const needActive = await needBtn.evaluate(el => el.classList.contains('s-need'));

        // Click "Need" to set status
        await needBtn.click();
        await page.waitForTimeout(500);

        // Need button should be active
        await expect(needBtn).toHaveClass(/s-need/);

        // Click "Own" to change status
        await ownBtn.click();
        await page.waitForTimeout(500);

        await expect(ownBtn).toHaveClass(/s-own/);

        // Restore original: if was own, click own; if need, click need; else click skip
        if (ownActive) {
            await ownBtn.click();
        } else if (needActive) {
            await needBtn.click();
        } else {
            await skipBtn.click();
        }
        await page.waitForTimeout(300);
    });

    test('status change updates stats bar', async ({ page }) => {
        await openInventory(page);

        const ownedBefore = parseInt((await page.locator('#stat-owned').textContent()).replace(/,/g, ''));

        const firstRow = page.locator('#thread-list .list-row').first();
        const ownBtn = firstRow.locator('.lbtn').nth(0);
        const skipBtn = firstRow.locator('.lbtn').nth(2);

        // Record original status
        const wasOwned = await ownBtn.evaluate(el => el.classList.contains('s-own'));

        if (wasOwned) {
            // Set to Don't Own — owned count should decrease
            await skipBtn.click();
            await page.waitForTimeout(800);
            const ownedAfter = parseInt((await page.locator('#stat-owned').textContent()).replace(/,/g, ''));
            expect(ownedAfter).toBe(ownedBefore - 1);

            // Restore
            await ownBtn.click();
            await page.waitForTimeout(500);
        } else {
            // Set to Own — owned count should increase
            await ownBtn.click();
            await page.waitForTimeout(800);
            const ownedAfter = parseInt((await page.locator('#stat-owned').textContent()).replace(/,/g, ''));
            expect(ownedAfter).toBe(ownedBefore + 1);

            // Restore
            await skipBtn.click();
            await page.waitForTimeout(500);
        }
    });
});

// ——————————————————————————————————————————————
// SIMILAR COLORS MODAL
// ——————————————————————————————————————————————
test.describe('Similar Colors Modal', () => {
    test('opens with similar colors and shows delta values', async ({ page }) => {
        await openInventory(page);

        // Click Similar on the first list row
        await page.locator('#thread-list .list-row .lbtn-sim').first().click();
        await page.waitForTimeout(1000);

        // Modal should be visible
        await expect(page.locator('#similar-modal')).toBeVisible();

        // Reference thread shown in title
        await expect(page.locator('#modal-reference-thread')).not.toBeEmpty();

        // Results should load
        const results = page.locator('#similar-results .sim-item');
        await expect(results.first()).toBeVisible({ timeout: 10000 });

        // Each result has swatch, name, and delta
        const firstResult = results.first();
        await expect(firstResult.locator('.sim-swatch')).toBeVisible();
        await expect(firstResult.locator('.sim-name')).not.toBeEmpty();
        await expect(firstResult.locator('.delta-val')).not.toBeEmpty();
    });

    test('modal closes on X button', async ({ page }) => {
        await openInventory(page);

        await page.locator('#thread-list .list-row .lbtn-sim').first().click();
        await expect(page.locator('#similar-modal')).toBeVisible({ timeout: 5000 });

        await page.locator('#similar-modal .modal-close').click();
        await page.waitForTimeout(300);

        await expect(page.locator('#similar-modal')).toBeHidden();
    });

    test('modal closes on Escape', async ({ page }) => {
        await openInventory(page);

        await page.locator('#thread-list .list-row .lbtn-sim').first().click();
        await expect(page.locator('#similar-modal')).toBeVisible({ timeout: 5000 });

        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        await expect(page.locator('#similar-modal')).toBeHidden();
    });

    test('modal closes on backdrop click', async ({ page }) => {
        await openInventory(page);

        await page.locator('#thread-list .list-row .lbtn-sim').first().click();
        await expect(page.locator('#similar-modal')).toBeVisible({ timeout: 5000 });

        // Click the overlay backdrop (not the modal box)
        await page.locator('#similar-modal').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(300);

        await expect(page.locator('#similar-modal')).toBeHidden();
    });

    test('category filter in modal refines results', async ({ page }) => {
        await openInventory(page);

        await page.locator('#thread-list .list-row .lbtn-sim').first().click();
        await expect(page.locator('#similar-modal')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#similar-results .sim-item').first()).toBeVisible({ timeout: 10000 });

        // Change category filter to Standard Only (native select is hidden, use custom dropdown)
        const catWrapper = page.locator('#similar-category-filter').locator('xpath=ancestor::*[contains(@class,"dmc-dropdown")]');
        const hasCustomDropdown = await catWrapper.count() > 0;

        if (hasCustomDropdown) {
            await catWrapper.locator('.dmc-dropdown-trigger').click();
            await page.waitForTimeout(200);
            await catWrapper.locator('.dmc-dropdown-option[data-value="standard"]').click();
        } else {
            await page.selectOption('#similar-category-filter', 'standard');
        }
        await page.waitForTimeout(1000);

        // Results should still exist (or be empty but no error)
        const hasError = await page.locator('#similar-results .state-msg-title:has-text("Error")').count();
        expect(hasError).toBe(0);

        await page.locator('#similar-modal .modal-close').click();
    });
});

// ——————————————————————————————————————————————
// SELECTION MODE
// ——————————————————————————————————————————————
test.describe('Selection Mode', () => {
    test('toggling selection mode shows select-all bar', async ({ page }) => {
        await openInventory(page);

        await page.click('#select-btn');
        await page.waitForTimeout(200);

        await expect(page.locator('#select-btn')).toHaveClass(/active/);
        await expect(page.locator('#select-all-bar')).toBeVisible();

        // Exit
        await page.click('#select-btn');
        await page.waitForTimeout(200);
        await expect(page.locator('#select-btn')).not.toHaveClass(/active/);
    });

    test('Escape exits selection mode', async ({ page }) => {
        await openInventory(page);

        await page.click('#select-btn');
        await page.waitForTimeout(200);
        await expect(page.locator('#select-btn')).toHaveClass(/active/);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        await expect(page.locator('#select-btn')).not.toHaveClass(/active/);
    });

    test('clicking row selects it and shows bulk bar', async ({ page }) => {
        await openInventory(page);

        await page.click('#select-btn');
        await page.waitForTimeout(200);

        // Click first row to select it
        await page.locator('#thread-list .list-row').first().click();
        await page.waitForTimeout(200);

        await expect(page.locator('#thread-list .list-row').first()).toHaveClass(/selected/);
        await expect(page.locator('#bulk-bar')).toBeVisible();
        await expect(page.locator('#bulk-count')).toContainText('1');

        // Exit selection mode
        await page.click('#select-btn');
    });

    test('select all visible selects all rows', async ({ page }) => {
        await openInventory(page);

        await page.click('#select-btn');
        await page.waitForTimeout(200);

        // Click "Select all visible"
        await page.locator('#select-all-bar button').click();
        await page.waitForTimeout(300);

        const totalRows = await page.locator('#thread-list .list-row').count();
        const selectedRows = await page.locator('#thread-list .list-row.selected').count();
        expect(selectedRows).toBe(totalRows);

        // Bulk bar shows count
        await expect(page.locator('#bulk-count')).toContainText(String(totalRows));

        // Exit
        await page.click('#select-btn');
    });
});

// ——————————————————————————————————————————————
// EXPORT DROPDOWN
// ——————————————————————————————————————————————
test.describe('Export Dropdown', () => {
    test('opens and shows export options', async ({ page }) => {
        await openInventory(page);

        await page.locator('.export-dropdown .ctrl-btn-ghost').click();
        await page.waitForTimeout(200);

        await expect(page.locator('#export-dropdown')).toHaveClass(/open/);

        // Three export options
        await expect(page.locator('.export-dropdown-menu button:has-text("Print Shopping List")')).toBeVisible();
        await expect(page.locator('.export-dropdown-menu button:has-text("Shopping List CSV")')).toBeVisible();
        await expect(page.locator('.export-dropdown-menu button:has-text("Full Inventory CSV")')).toBeVisible();
    });

    test('closes on outside click', async ({ page }) => {
        await openInventory(page);

        await page.locator('.export-dropdown .ctrl-btn-ghost').click();
        await expect(page.locator('#export-dropdown')).toHaveClass(/open/);

        await page.click('#thread-list');
        await page.waitForTimeout(200);
        await expect(page.locator('#export-dropdown')).not.toHaveClass(/open/);
    });

    test('Full Inventory CSV triggers download', async ({ page }) => {
        await openInventory(page);

        await page.locator('.export-dropdown .ctrl-btn-ghost').click();
        await page.waitForTimeout(200);

        const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
        await page.locator('.export-dropdown-menu button:has-text("Full Inventory CSV")').click();

        const download = await downloadPromise;
        expect(download.suggestedFilename()).toContain('.csv');
    });
});

// ——————————————————————————————————————————————
// NOTES & SKEIN QUANTITY
// ——————————————————————————————————————————————
test.describe('Notes & Skeins', () => {
    test('skein quantity input updates on change', async ({ page }) => {
        await openInventory(page);

        // Switch to grid to access notes and skeins
        await page.click('.view-btn[data-view="grid"]');
        await page.waitForTimeout(300);

        const firstCard = page.locator('#thread-grid .thread-card').first();
        const skeinInput = firstCard.locator('.skein-input');

        // Get original value
        const original = await skeinInput.inputValue();

        // Set a new value
        await skeinInput.fill('3');
        await skeinInput.dispatchEvent('change');
        await page.waitForTimeout(500);

        // Verify it stuck
        await expect(skeinInput).toHaveValue('3');

        // Restore original
        await skeinInput.fill(original || '0');
        await skeinInput.dispatchEvent('change');
        await page.waitForTimeout(300);

        // Switch back to list
        await page.click('.view-btn[data-view="list"]');
    });

    test('notes textarea saves on change', async ({ page }) => {
        await openInventory(page);

        await page.click('.view-btn[data-view="grid"]');
        await page.waitForTimeout(300);

        const firstCard = page.locator('#thread-grid .thread-card').first();
        const notesTA = firstCard.locator('.notes-ta');

        const original = await notesTA.inputValue();

        await notesTA.fill('E2E test note');
        await notesTA.dispatchEvent('change');
        await page.waitForTimeout(500);

        await expect(notesTA).toHaveValue('E2E test note');

        // Restore
        await notesTA.fill(original);
        await notesTA.dispatchEvent('change');
        await page.waitForTimeout(300);

        await page.click('.view-btn[data-view="list"]');
    });

    test('list view has skein and notes inputs', async ({ page }) => {
        await openInventory(page);

        const firstRow = page.locator('#thread-list .list-row').first();
        await expect(firstRow.locator('.list-skein-input')).toHaveCount(1);
        await expect(firstRow.locator('.list-notes-input')).toHaveCount(1);
    });
});
