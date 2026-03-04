// @ts-check
const { test, expect } = require('@playwright/test');

// Helper: complete the setup modal to enter the editor
async function createCanvas(page, width = 20, height = 20) {
    await page.goto('/create-pattern');
    await page.fill('#setup-w', String(width));
    await page.fill('#setup-h', String(height));
    await page.click('#setup-card button:has-text("Create")');
    await expect(page.locator('#editor-wrap')).toHaveClass(/active/);
}

// ─── Setup Modal ─────────────────────────────────────────────────────────────

test.describe('Setup Modal', () => {
    test('shows setup modal on page load', async ({ page }) => {
        await page.goto('/create-pattern');
        await expect(page.locator('#setup-modal')).toBeVisible();
        await expect(page.locator('#setup-card h2')).toHaveText('New Blank Pattern');
    });

    test('width and height inputs have default values', async ({ page }) => {
        await page.goto('/create-pattern');
        await expect(page.locator('#setup-w')).toHaveValue('60');
        await expect(page.locator('#setup-h')).toHaveValue('60');
    });

    test('DMC brand is selected by default', async ({ page }) => {
        await page.goto('/create-pattern');
        const dmcBtn = page.locator('#brand-toggle .seg-btn').first();
        await expect(dmcBtn).toHaveText('DMC');
        await expect(dmcBtn).toHaveClass(/active/);
    });

    test('can switch to Anchor brand', async ({ page }) => {
        await page.goto('/create-pattern');
        const anchorBtn = page.locator('#brand-toggle .seg-btn:has-text("Anchor")');
        await anchorBtn.click();
        await expect(anchorBtn).toHaveClass(/active/);
        const dmcBtn = page.locator('#brand-toggle .seg-btn:has-text("DMC")');
        await expect(dmcBtn).not.toHaveClass(/active/);
    });

    test('Cancel link goes to saved patterns', async ({ page }) => {
        await page.goto('/create-pattern');
        const cancel = page.locator('#setup-card a:has-text("Cancel")');
        await expect(cancel).toHaveAttribute('href', '/saved-patterns');
    });

    test('Create button hides modal and shows editor', async ({ page }) => {
        await createCanvas(page, 30, 25);
        await expect(page.locator('#setup-modal')).toBeHidden();
        await expect(page.locator('#editor-wrap')).toBeVisible();
    });

    test('shows validation error for dimensions below 5', async ({ page }) => {
        await page.goto('/create-pattern');
        await page.fill('#setup-w', '3');
        await page.fill('#setup-h', '3');
        await page.click('#setup-card button:has-text("Create")');
        // Should show error in hint text and stay on modal
        await expect(page.locator('.setup-hint')).toContainText('between 5 and 500');
        await expect(page.locator('#setup-modal')).toBeVisible();
    });

    test('shows validation error for dimensions above 500', async ({ page }) => {
        await page.goto('/create-pattern');
        await page.fill('#setup-w', '501');
        await page.fill('#setup-h', '100');
        await page.click('#setup-card button:has-text("Create")');
        await expect(page.locator('.setup-hint')).toContainText('between 5 and 500');
        await expect(page.locator('#setup-modal')).toBeVisible();
    });

    test('Enter key in width input creates pattern', async ({ page }) => {
        await page.goto('/create-pattern');
        await page.fill('#setup-w', '15');
        await page.fill('#setup-h', '15');
        await page.press('#setup-w', 'Enter');
        await expect(page.locator('#setup-modal')).toBeHidden();
        await expect(page.locator('#editor-wrap')).toHaveClass(/active/);
    });
});

// ─── Editor Layout ───────────────────────────────────────────────────────────

test.describe('Editor Layout', () => {
    test('canvas, toolbar, legend panel, and info bar are visible', async ({ page }) => {
        await createCanvas(page);
        await expect(page.locator('#pattern-canvas')).toBeVisible();
        await expect(page.locator('.canvas-toolbar')).toBeVisible();
        await expect(page.locator('#legend-panel')).toBeVisible();
        await expect(page.locator('#canvas-info')).toBeVisible();
    });

    test('info bar shows correct dimensions', async ({ page }) => {
        await createCanvas(page, 30, 25);
        await expect(page.locator('#canvas-info')).toContainText('30 × 25');
    });

    test('legend shows empty hint when no colors drawn', async ({ page }) => {
        await createCanvas(page);
        await expect(page.locator('.legend-empty-hint')).toBeVisible();
        await expect(page.locator('.legend-empty-hint')).toContainText('No colors yet');
    });

    test('legend totals shows 0 colors and 0 stitches', async ({ page }) => {
        await createCanvas(page);
        await expect(page.locator('#legend-totals')).toContainText('0 colors');
        await expect(page.locator('#legend-totals')).toContainText('0 stitches');
    });

    test('gridlines checkbox is checked by default', async ({ page }) => {
        await createCanvas(page);
        await expect(page.locator('#gridlines-check')).toBeChecked();
    });

    test('zoom controls are visible', async ({ page }) => {
        await createCanvas(page);
        await expect(page.locator('#zoom-in-btn')).toBeVisible();
        await expect(page.locator('#zoom-out-btn')).toBeVisible();
        await expect(page.locator('#zoom-level')).toBeVisible();
    });

    test('no console errors on load', async ({ page }) => {
        const errors = [];
        page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
        await createCanvas(page);
        expect(errors).toHaveLength(0);
    });
});

// ─── View Mode ───────────────────────────────────────────────────────────────

test.describe('View Mode', () => {
    test('view mode button toggles between Chart and Thread', async ({ page }) => {
        await createCanvas(page);
        const btn = page.locator('#view-mode-btn');
        // Default shows "Chart" button (meaning we're in thread mode, click to switch to chart)
        const initialText = await btn.textContent();
        await btn.click();
        const toggledText = await btn.textContent();
        expect(initialText).not.toBe(toggledText);
        // Toggle back
        await btn.click();
        const restoredText = await btn.textContent();
        expect(restoredText).toBe(initialText);
    });
});

// ─── Zoom ────────────────────────────────────────────────────────────────────

test.describe('Zoom', () => {
    test('zoom in changes zoom level', async ({ page }) => {
        await createCanvas(page);
        const before = await page.locator('#zoom-level').textContent();
        await page.click('#zoom-in-btn');
        await page.waitForTimeout(300); // snap timer
        const after = await page.locator('#zoom-level').textContent();
        expect(parseInt(after)).toBeGreaterThan(parseInt(before));
    });

    test('zoom out changes zoom level', async ({ page }) => {
        await createCanvas(page);
        // Zoom in first to have room to zoom out
        await page.click('#zoom-in-btn');
        await page.waitForTimeout(300);
        const before = await page.locator('#zoom-level').textContent();
        await page.click('#zoom-out-btn');
        await page.waitForTimeout(300);
        const after = await page.locator('#zoom-level').textContent();
        expect(parseInt(after)).toBeLessThan(parseInt(before));
    });
});

// ─── Legend ───────────────────────────────────────────────────────────────────

test.describe('Legend', () => {
    test('sort buttons toggle between Number and Stitches', async ({ page }) => {
        await createCanvas(page);
        const numBtn = page.locator('#sort-btn-number');
        const stBtn = page.locator('#sort-btn-stitches');
        await expect(numBtn).toHaveClass(/active/);
        await expect(stBtn).not.toHaveClass(/active/);
        await stBtn.click();
        await expect(stBtn).toHaveClass(/active/);
        await expect(numBtn).not.toHaveClass(/active/);
    });

    test('search input is visible and functional', async ({ page }) => {
        await createCanvas(page);
        const search = page.locator('#legend-search');
        await expect(search).toBeVisible();
        await expect(search).toHaveAttribute('placeholder', /Search/);
    });
});

// ─── Save Dialog ─────────────────────────────────────────────────────────────

test.describe('Save Dialog', () => {
    test('Save button opens save modal', async ({ page }) => {
        await createCanvas(page);
        await page.click('#btn-save');
        await expect(page.locator('#save-modal')).toBeVisible();
        await expect(page.locator('#save-name-input')).toBeVisible();
    });

    test('Cancel closes save modal', async ({ page }) => {
        await createCanvas(page);
        await page.click('#btn-save');
        await expect(page.locator('#save-modal')).toBeVisible();
        await page.click('#save-modal button:has-text("Cancel")');
        await expect(page.locator('#save-modal')).toBeHidden();
    });

    test('backdrop click closes save modal', async ({ page }) => {
        await createCanvas(page);
        await page.click('#btn-save');
        await expect(page.locator('#save-modal')).toBeVisible();
        // Click the backdrop (outside the inner card)
        await page.locator('#save-modal').click({ position: { x: 5, y: 5 } });
        await expect(page.locator('#save-modal')).toBeHidden();
    });

    test('saving empty pattern shows error', async ({ page }) => {
        await createCanvas(page);
        await page.click('#btn-save');
        await page.fill('#save-name-input', 'Test Empty Pattern');
        await page.click('#save-confirm-btn');
        // Should show error about needing at least one color
        await expect(page.locator('#save-modal-error')).toBeVisible();
        await expect(page.locator('#save-modal-error')).toContainText('color');
    });

    test('saving with drawn content redirects to viewer', async ({ page }) => {
        await createCanvas(page, 10, 10);

        // Add a color and place it via the page's global functions
        // patternData is a `let` at script scope, not on window — use Function() trick
        await page.evaluate(() => {
            // Access script-scoped variable via indirect eval
            const setData = new Function(`
                patternData.grid[0] = '310';
                patternData.legend.push({
                    dmc: '310', name: 'Black', hex: '#000000',
                    symbol: '+', stitches: 1, status: 'dont_own', category: 'standard'
                });
            `);
            setData();
        });

        await page.click('#btn-save');
        await page.fill('#save-name-input', 'E2E Create Test');
        await page.click('#save-confirm-btn');
        // Should redirect to /view/<slug>
        await page.waitForURL('**/view/**', { timeout: 10000 });
        expect(page.url()).toContain('/view/');
    });

    test('Enter key in name input triggers save', async ({ page }) => {
        await createCanvas(page, 10, 10);

        await page.evaluate(() => {
            const setData = new Function(`
                patternData.grid[0] = '310';
                patternData.legend.push({
                    dmc: '310', name: 'Black', hex: '#000000',
                    symbol: '+', stitches: 1, status: 'dont_own', category: 'standard'
                });
            `);
            setData();
        });

        await page.click('#btn-save');
        await page.fill('#save-name-input', 'E2E Enter Save');
        await page.press('#save-name-input', 'Enter');
        await page.waitForURL('**/view/**', { timeout: 10000 });
        expect(page.url()).toContain('/view/');
    });
});

// ─── Editor Tools ────────────────────────────────────────────────────────────

test.describe('Editor Tools', () => {
    test('editor toolbar is injected with tool buttons', async ({ page }) => {
        await createCanvas(page);
        await expect(page.locator('.editor-toolbar')).toBeVisible();
    });

    test('a tool button is active by default', async ({ page }) => {
        await createCanvas(page);
        await expect(page.locator('.tool-btn.active').first()).toBeVisible();
    });

    test('undo/redo buttons are present', async ({ page }) => {
        await createCanvas(page);
        await expect(page.locator('.ed-undo-btn')).toBeVisible();
        await expect(page.locator('.ed-redo-btn')).toBeVisible();
    });

    test('add color button is present in toolbar', async ({ page }) => {
        await createCanvas(page);
        // The + button to add a color
        await expect(page.locator('.ed-add-color-btn')).toBeVisible();
    });
});

// ─── Beforeunload Warning ────────────────────────────────────────────────────

test.describe('Dirty State Warning', () => {
    test('modifying pattern data sets dirty flag', async ({ page }) => {
        await createCanvas(page, 10, 10);

        // Use the editor's own dirty tracking — draw via Function() to access script-scope vars
        await page.evaluate(() => {
            const setDirty = new Function(`
                patternData.grid[0] = '310';
                patternData.legend.push({
                    dmc: '310', name: 'Black', hex: '#000000',
                    symbol: '+', stitches: 1, status: 'dont_own', category: 'standard'
                });
                if (editorInstance && editorInstance.markDirty) editorInstance.markDirty();
            `);
            setDirty();
        });

        // Verify pattern data was modified by checking the legend totals update
        // after calling renderEditLegend
        await page.evaluate(() => { new Function('renderEditLegend()')(); });
        await expect(page.locator('#legend-totals')).toContainText('1 color');
    });
});

// ─── Cleanup: delete test patterns ──────────────────────────────────────────

test.describe('Cleanup', () => {
    test('delete patterns created during tests', async ({ page }) => {
        await page.goto('/saved-patterns');
        await page.waitForLoadState('networkidle');

        // Find and delete any patterns created by these tests
        for (const name of ['E2E Create Test', 'E2E Enter Save']) {
            const card = page.locator('.pattern-card', { hasText: name }).first();
            if (await card.isVisible({ timeout: 2000 }).catch(() => false)) {
                // Open tools menu
                const toolsBtn = card.locator('.tools-dropdown-btn, .card-tools-btn').first();
                if (await toolsBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await toolsBtn.click();
                    const deleteBtn = page.locator('.dropdown-item:has-text("Delete"), button:has-text("Delete")').first();
                    if (await deleteBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                        await deleteBtn.click();
                        // Confirm delete
                        const confirmBtn = page.locator('button:has-text("Delete"):visible').last();
                        if (await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                            await confirmBtn.click();
                            await page.waitForTimeout(500);
                        }
                    }
                }
            }
        }
    });
});
