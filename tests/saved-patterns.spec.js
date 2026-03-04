// @ts-check
const { test, expect } = require('@playwright/test');

/*
 * Saved Patterns Gallery E2E Tests
 *
 * Covers: page load, pattern cards, search/filter, sort, rename,
 * delete, duplicate, project status, export, selection mode,
 * bulk actions, shopping list modal, new pattern dropdown.
 *
 * Pre-requisites:
 *   - Server running on localhost:6969
 *   - Auth via storageState (see auth.setup.js)
 *   - At least one saved pattern in the database
 *
 * Run:  TEST_USER=<user> TEST_PASS=<pass> npx playwright test saved-patterns
 */

/** Navigate to saved patterns and wait for gallery to load */
async function openGallery(page) {
    await page.goto('/saved-patterns');
    await page.waitForLoadState('networkidle');
    // Wait for real cards to appear (skeletons gone)
    await expect(page.locator('#gallery .pattern-card').first()).toBeVisible({ timeout: 10000 });
}

// ——————————————————————————————————————————————
// PAGE LOAD
// ——————————————————————————————————————————————
test.describe('Page Load', () => {
    test('displays pattern cards with thumbnails and metadata', async ({ page }) => {
        await openGallery(page);

        const cards = page.locator('#gallery .pattern-card');
        const count = await cards.count();
        expect(count).toBeGreaterThan(0);

        // First card has a name, meta info
        const firstCard = cards.first();
        await expect(firstCard.locator('.card-name')).not.toBeEmpty();
        await expect(firstCard.locator('.card-meta').first()).toContainText('×');
    });

    test('count badge shows pattern count', async ({ page }) => {
        await openGallery(page);

        const badge = page.locator('#count-badge');
        const text = await badge.textContent();
        // Should be "(N)" where N > 0
        expect(text).toMatch(/\(\d+\)/);
    });

    test('no console errors on load', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await openGallery(page);
        expect(errors).toHaveLength(0);
    });

    test('pattern cards have View and Edit links', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();
        const viewLink = firstCard.locator('.card-btn:has-text("View")');
        const editLink = firstCard.locator('.card-btn:has-text("Edit")');

        await expect(viewLink).toBeVisible();
        await expect(editLink).toBeVisible();

        const slug = await firstCard.getAttribute('data-id');
        const viewHref = await viewLink.getAttribute('href');
        expect(viewHref).toBe(`/view/${slug}`);
    });
});

// ——————————————————————————————————————————————
// SEARCH
// ——————————————————————————————————————————————
test.describe('Search', () => {
    test('search filters cards by name', async ({ page }) => {
        await openGallery(page);

        const allCount = await page.locator('#gallery .pattern-card').count();
        expect(allCount).toBeGreaterThan(0);

        // Get a pattern name to search for
        const firstName = await page.locator('#gallery .pattern-card .card-name').first().textContent();

        await page.fill('#pattern-search', firstName.trim());
        await page.waitForTimeout(300);

        const filtered = await page.locator('#gallery .pattern-card').count();
        expect(filtered).toBeGreaterThan(0);
        expect(filtered).toBeLessThanOrEqual(allCount);
    });

    test('search with no results shows message', async ({ page }) => {
        await openGallery(page);

        await page.fill('#pattern-search', 'zzz_nonexistent_pattern_xyz');
        await page.waitForTimeout(300);

        const cards = await page.locator('#gallery .pattern-card').count();
        expect(cards).toBe(0);

        // Should show "No matching patterns" message
        await expect(page.locator('#gallery')).toContainText('No matching');
    });

    test('clearing search restores all cards', async ({ page }) => {
        await openGallery(page);

        const allCount = await page.locator('#gallery .pattern-card').count();

        await page.fill('#pattern-search', 'zzz_nonexistent');
        await page.waitForTimeout(200);

        await page.fill('#pattern-search', '');
        await page.waitForTimeout(200);

        const restored = await page.locator('#gallery .pattern-card').count();
        expect(restored).toBe(allCount);
    });
});

// ——————————————————————————————————————————————
// FILTER
// ——————————————————————————————————————————————
test.describe('Filter', () => {
    test('filter pills toggle active state', async ({ page }) => {
        await openGallery(page);

        // Default: All is active
        await expect(page.locator('.filter-btn[data-filter=""]')).toHaveClass(/active/);

        // Click In Progress
        await page.click('.filter-btn[data-filter="in_progress"]');
        await page.waitForTimeout(200);
        await expect(page.locator('.filter-btn[data-filter="in_progress"]')).toHaveClass(/active/);
        await expect(page.locator('.filter-btn[data-filter=""]')).not.toHaveClass(/active/);

        // Click All to reset
        await page.click('.filter-btn[data-filter=""]');
        await page.waitForTimeout(200);
        await expect(page.locator('.filter-btn[data-filter=""]')).toHaveClass(/active/);
    });
});

// ——————————————————————————————————————————————
// SORT
// ——————————————————————————————————————————————
test.describe('Sort', () => {
    test('sort dropdown changes order', async ({ page }) => {
        await openGallery(page);

        // The sort select is upgraded to a custom dropdown — click the trigger
        const sortDropdown = page.locator('.dmc-dropdown--pill');

        // Click to open
        await sortDropdown.locator('.dmc-dropdown-trigger').click();
        await page.waitForTimeout(200);

        // Select "Name A-Z"
        await sortDropdown.locator('.dmc-dropdown-option[data-value="name-az"]').click();
        await page.waitForTimeout(300);

        // Verify trigger text changed
        await expect(sortDropdown.locator('.dmc-dropdown-trigger')).toContainText('Name A');

        // Reset to newest
        await sortDropdown.locator('.dmc-dropdown-trigger').click();
        await page.waitForTimeout(200);
        await sortDropdown.locator('.dmc-dropdown-option[data-value="newest"]').click();
        await page.waitForTimeout(200);
    });
});

// ——————————————————————————————————————————————
// RENAME
// ——————————————————————————————————————————————
test.describe('Rename', () => {
    test('clicking card name enables inline rename', async ({ page }) => {
        await openGallery(page);

        const nameSpan = page.locator('#gallery .pattern-card .card-name').first();
        const originalName = await nameSpan.textContent();

        // Click to start rename
        await nameSpan.click();
        await page.waitForTimeout(200);

        // Input should appear
        const nameInput = page.locator('#gallery .pattern-card .card-name-input').first();
        await expect(nameInput).toBeVisible();

        // Escape cancels
        await nameInput.press('Escape');
        await page.waitForTimeout(200);

        await expect(nameInput).toBeHidden();
        await expect(nameSpan).toBeVisible();
        expect(await nameSpan.textContent()).toBe(originalName);
    });

    test('rename commits on Enter and shows toast', async ({ page }) => {
        await openGallery(page);

        const nameSpan = page.locator('#gallery .pattern-card .card-name').first();
        const originalName = (await nameSpan.textContent()).trim();

        // Start rename
        await nameSpan.click();
        await page.waitForTimeout(200);

        const nameInput = page.locator('#gallery .pattern-card .card-name-input').first();
        await nameInput.fill(originalName + ' Renamed');
        await nameInput.press('Enter');
        await page.waitForTimeout(500);

        // Toast should appear
        await expect(page.locator('.toast-success')).toBeVisible({ timeout: 3000 });

        // Rename back to original
        const updatedSpan = page.locator('#gallery .pattern-card .card-name').first();
        await updatedSpan.click();
        await page.waitForTimeout(200);
        const input2 = page.locator('#gallery .pattern-card .card-name-input').first();
        await input2.fill(originalName);
        await input2.press('Enter');
        await page.waitForTimeout(500);
    });
});

// ——————————————————————————————————————————————
// PROJECT STATUS
// ——————————————————————————————————————————————
test.describe('Project Status', () => {
    test('status dropdown changes card status', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();
        const slug = await firstCard.getAttribute('data-id');
        const originalStatus = await firstCard.getAttribute('data-status');

        // Find the status dropdown for this card
        const statusDropdown = firstCard.locator('.dmc-dropdown--status');
        await statusDropdown.locator('.dmc-dropdown-trigger').click();
        await page.waitForTimeout(200);

        // Click a different status
        const targetStatus = originalStatus === 'in_progress' ? 'not_started' : 'in_progress';
        await statusDropdown.locator(`.dmc-dropdown-option[data-value="${targetStatus}"]`).click();
        await page.waitForTimeout(500);

        // Toast should confirm
        await expect(page.locator('.toast-success')).toBeVisible({ timeout: 3000 });

        // Card data-status should update
        await expect(firstCard).toHaveAttribute('data-status', targetStatus);

        // Restore original status
        await statusDropdown.locator('.dmc-dropdown-trigger').click();
        await page.waitForTimeout(200);
        await statusDropdown.locator(`.dmc-dropdown-option[data-value="${originalStatus}"]`).click();
        await page.waitForTimeout(500);
    });
});

// ——————————————————————————————————————————————
// TOOLS DROPDOWN
// ——————————————————————————————————————————————
test.describe('Tools Dropdown', () => {
    test('tools menu opens and shows items', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();
        const toolsBtn = firstCard.locator('.card-dropdown-btn:has-text("Tools")');
        await toolsBtn.click();
        await page.waitForTimeout(200);

        const toolsMenu = firstCard.locator('.card-dropdown-menu[data-menu="tools"]');
        await expect(toolsMenu).toHaveClass(/open/);

        // Should have Shopping List, Calculator link, Duplicate, Delete
        await expect(toolsMenu.locator('button:has-text("Shopping List")')).toBeVisible();
        await expect(toolsMenu.locator('a:has-text("Project Materials")')).toBeVisible();
        await expect(toolsMenu.locator('button:has-text("Duplicate")')).toBeVisible();
        await expect(toolsMenu.locator('button:has-text("Delete")')).toBeVisible();

        // Close by clicking elsewhere
        await page.click('#gallery');
        await page.waitForTimeout(200);
        await expect(toolsMenu).not.toHaveClass(/open/);
    });
});

// ——————————————————————————————————————————————
// EXPORT DROPDOWN
// ——————————————————————————————————————————————
test.describe('Export Dropdown', () => {
    test('export menu opens with PDF/SVG/OXS/JSON options', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();
        const exportBtn = firstCard.locator('.card-dropdown-btn:has-text("Export")');
        await exportBtn.click();
        await page.waitForTimeout(200);

        const exportMenu = firstCard.locator('.card-dropdown-menu[data-menu="export"]');
        await expect(exportMenu).toHaveClass(/open/);

        await expect(exportMenu.locator('button:has-text("PDF")')).toBeVisible();
        await expect(exportMenu.locator('button:has-text("SVG")')).toBeVisible();
        await expect(exportMenu.locator('button:has-text("OXS")')).toBeVisible();
        await expect(exportMenu.locator('button:has-text("JSON")')).toBeVisible();
    });

    test('JSON export triggers download and shows toast', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();

        // Open export menu
        await firstCard.locator('.card-dropdown-btn:has-text("Export")').click();
        await page.waitForTimeout(200);

        // Listen for download
        const downloadPromise = page.waitForEvent('download', { timeout: 10000 });

        // Click JSON
        await firstCard.locator('.card-dropdown-menu[data-menu="export"] button:has-text("JSON")').click();

        const download = await downloadPromise;
        expect(download.suggestedFilename()).toContain('.json');

        // Success toast
        await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });
    });

    test('SVG export triggers download and shows toast', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();

        await firstCard.locator('.card-dropdown-btn:has-text("Export")').click();
        await page.waitForTimeout(200);

        const downloadPromise = page.waitForEvent('download', { timeout: 10000 });

        await firstCard.locator('.card-dropdown-menu[data-menu="export"] button:has-text("SVG")').click();

        const download = await downloadPromise;
        expect(download.suggestedFilename()).toContain('.svg');

        await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });
    });
});

// ——————————————————————————————————————————————
// DUPLICATE
// ——————————————————————————————————————————————
test.describe('Duplicate', () => {
    test('duplicate creates a copy and shows toast', async ({ page }) => {
        await openGallery(page);

        const initialCount = await page.locator('#gallery .pattern-card').count();
        const firstCard = page.locator('#gallery .pattern-card').first();

        // Open tools menu
        await firstCard.locator('.card-dropdown-btn:has-text("Tools")').click();
        await page.waitForTimeout(200);

        // Click Duplicate
        await firstCard.locator('.card-dropdown-menu[data-menu="tools"] button:has-text("Duplicate")').click();
        await page.waitForTimeout(2000);

        // Toast
        await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });

        // Count should increase by 1
        const newCount = await page.locator('#gallery .pattern-card').count();
        expect(newCount).toBe(initialCount + 1);
    });
});

// ——————————————————————————————————————————————
// DELETE (single)
// ——————————————————————————————————————————————
test.describe('Delete', () => {
    test('delete shows confirm dialog and cancel works', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();
        const initialCount = await page.locator('#gallery .pattern-card').count();

        // Open tools menu
        await firstCard.locator('.card-dropdown-btn:has-text("Tools")').click();
        await page.waitForTimeout(200);

        // Click Delete
        await firstCard.locator('.card-dropdown-menu[data-menu="tools"] button:has-text("Delete")').click();
        await page.waitForTimeout(300);

        // Confirm dialog should appear
        const dialog = page.locator('.notify-dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.notify-dialog-body')).toContainText('Delete');

        // Click Cancel
        await dialog.locator('.notify-btn:not(.notify-btn-danger)').click();
        await page.waitForTimeout(300);

        // Dialog gone, card count unchanged
        await expect(dialog).toBeHidden();
        const afterCount = await page.locator('#gallery .pattern-card').count();
        expect(afterCount).toBe(initialCount);
    });

    test('delete confirm removes card and shows toast', async ({ page }) => {
        await openGallery(page);

        // First duplicate so we have a card to safely delete
        const firstCard = page.locator('#gallery .pattern-card').first();
        await firstCard.locator('.card-dropdown-btn:has-text("Tools")').click();
        await page.waitForTimeout(200);
        await firstCard.locator('.card-dropdown-menu[data-menu="tools"] button:has-text("Duplicate")').click();
        await page.waitForTimeout(2000);

        const countBefore = await page.locator('#gallery .pattern-card').count();

        // Now delete the first card (the duplicate we just made)
        const targetCard = page.locator('#gallery .pattern-card').first();
        await targetCard.locator('.card-dropdown-btn:has-text("Tools")').click();
        await page.waitForTimeout(200);
        await targetCard.locator('.card-dropdown-menu[data-menu="tools"] button:has-text("Delete")').click();
        await page.waitForTimeout(300);

        // Confirm delete
        await page.locator('.notify-btn-danger').click();
        await page.waitForTimeout(1000);

        // Toast and reduced count
        await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });
        const countAfter = await page.locator('#gallery .pattern-card').count();
        expect(countAfter).toBe(countBefore - 1);
    });
});

// ——————————————————————————————————————————————
// SELECTION MODE
// ——————————————————————————————————————————————
test.describe('Selection Mode', () => {
    test('toggle selection mode shows checkboxes', async ({ page }) => {
        await openGallery(page);

        // Enter selection mode
        await page.click('#select-btn');
        await page.waitForTimeout(200);

        await expect(page.locator('body')).toHaveClass(/selection-mode/);
        await expect(page.locator('#select-btn')).toHaveClass(/active/);
        await expect(page.locator('#select-all-bar')).toBeVisible();

        // Exit selection mode
        await page.click('#select-btn');
        await page.waitForTimeout(200);

        await expect(page.locator('body')).not.toHaveClass(/selection-mode/);
    });

    test('Escape exits selection mode', async ({ page }) => {
        await openGallery(page);

        await page.click('#select-btn');
        await page.waitForTimeout(200);
        await expect(page.locator('body')).toHaveClass(/selection-mode/);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        await expect(page.locator('body')).not.toHaveClass(/selection-mode/);
    });

    test('clicking card selects it and shows bulk bar', async ({ page }) => {
        await openGallery(page);

        // Enter selection mode
        await page.click('#select-btn');
        await page.waitForTimeout(200);

        // Click first card
        await page.locator('#gallery .pattern-card').first().click();
        await page.waitForTimeout(200);

        // Card should be selected
        await expect(page.locator('#gallery .pattern-card').first()).toHaveClass(/selected/);

        // Bulk bar should appear
        await expect(page.locator('#bulk-bar')).toBeVisible();
        await expect(page.locator('#bulk-count')).toContainText('1 selected');

        // Exit selection mode
        await page.click('#select-btn');
    });

    test('select all visible selects all cards', async ({ page }) => {
        await openGallery(page);

        await page.click('#select-btn');
        await page.waitForTimeout(200);

        // Click "Select all visible"
        await page.click('#select-all-bar button:has-text("Select all")');
        await page.waitForTimeout(200);

        const totalCards = await page.locator('#gallery .pattern-card').count();
        const selectedCards = await page.locator('#gallery .pattern-card.selected').count();
        expect(selectedCards).toBe(totalCards);

        // Bulk bar shows correct count
        await expect(page.locator('#bulk-count')).toContainText(`${totalCards} selected`);

        // Exit
        await page.click('#select-btn');
    });
});

// ——————————————————————————————————————————————
// SHOPPING LIST MODAL
// ——————————————————————————————————————————————
test.describe('Shopping List Modal', () => {
    test('opens with pattern name and shows thread info', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();
        const patternName = (await firstCard.locator('.card-name').textContent()).trim();

        // Open tools menu and click Shopping List
        await firstCard.locator('.card-dropdown-btn:has-text("Tools")').click();
        await page.waitForTimeout(200);
        await firstCard.locator('.card-dropdown-menu[data-menu="tools"] button:has-text("Shopping List")').click();

        // Modal should appear
        await expect(page.locator('#shopping-modal')).toBeVisible({ timeout: 5000 });

        // Title should contain pattern name
        await expect(page.locator('#shopping-modal-title')).toContainText(patternName);

        // Body should have loaded (spinner gone, content visible)
        await expect(page.locator('#shopping-modal-body')).not.toBeEmpty();

        // Close modal
        await page.locator('#shopping-modal .modal-close').click();
        await page.waitForTimeout(300);
        await expect(page.locator('#shopping-modal')).toBeHidden();
    });

    test('modal closes on Escape', async ({ page }) => {
        await openGallery(page);

        const firstCard = page.locator('#gallery .pattern-card').first();
        await firstCard.locator('.card-dropdown-btn:has-text("Tools")').click();
        await page.waitForTimeout(200);
        await firstCard.locator('.card-dropdown-menu[data-menu="tools"] button:has-text("Shopping List")').click();

        await expect(page.locator('#shopping-modal')).toBeVisible({ timeout: 5000 });

        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await expect(page.locator('#shopping-modal')).toBeHidden();
    });
});

// ——————————————————————————————————————————————
// NEW PATTERN DROPDOWN
// ——————————————————————————————————————————————
test.describe('New Pattern Dropdown', () => {
    test('opens and shows creation options', async ({ page }) => {
        await openGallery(page);

        await page.click('.btn-new-pattern');
        await expect(page.locator('#new-pattern-menu')).toHaveClass(/open/);

        await expect(page.locator('#new-pattern-menu a:has-text("Convert Image")')).toBeVisible();
        await expect(page.locator('#new-pattern-menu a:has-text("Blank Canvas")')).toBeVisible();

        // Close by clicking elsewhere
        await page.click('#gallery');
        await page.waitForTimeout(200);
        await expect(page.locator('#new-pattern-menu')).not.toHaveClass(/open/);
    });
});

// ——————————————————————————————————————————————
// PROGRESS BADGES
// ——————————————————————————————————————————————
test.describe('Progress Badges', () => {
    test('cards show progress badges with fill bars', async ({ page }) => {
        await openGallery(page);

        // At least some cards should have progress badges
        const badges = page.locator('#gallery .progress-badge');
        const count = await badges.count();
        expect(count).toBeGreaterThan(0);

        // Each badge has a fill bar element and text
        const firstBadge = badges.first();
        await expect(firstBadge.locator('.progress-fill')).toHaveCount(1);
        await expect(firstBadge.locator('.progress-text')).not.toBeEmpty();
    });
});
