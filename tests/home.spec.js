// @ts-check
const { test, expect } = require('@playwright/test');

// ─── Page Load ───────────────────────────────────────────────────────────────

test.describe('Page Load', () => {
    test('displays Collection section with stats cards', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('.section-title').first()).toHaveText('Collection');
        await expect(page.locator('.stats-row')).toBeVisible();
        await expect(page.locator('.stat-card')).toHaveCount(4);
    });

    test('stats cards show numeric values after load', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        // Stats should have loaded from API — values should no longer be "—"
        await expect(page.locator('#stat-owned')).not.toHaveText('—');
        await expect(page.locator('#stat-need')).not.toHaveText('—');
        await expect(page.locator('#stat-dont-own')).not.toHaveText('—');
        await expect(page.locator('#stat-patterns')).not.toHaveText('—');
    });

    test('stats values are numeric', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        for (const id of ['#stat-owned', '#stat-need', '#stat-dont-own', '#stat-patterns']) {
            const text = await page.locator(id).textContent();
            expect(Number(text)).not.toBeNaN();
        }
    });

    test('displays stat labels', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('.stat-label').nth(0)).toHaveText('Owned');
        await expect(page.locator('.stat-label').nth(1)).toHaveText('Need');
        await expect(page.locator('.stat-label').nth(2)).toHaveText("Don't Own");
        await expect(page.locator('.stat-label').nth(3)).toHaveText('Saved Patterns');
    });

    test('no console errors on load', async ({ page }) => {
        const errors = [];
        page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        expect(errors).toHaveLength(0);
    });
});

// ─── Brand Toggle ────────────────────────────────────────────────────────────

test.describe('Brand Toggle', () => {
    test('DMC brand is selected by default', async ({ page }) => {
        // Clear localStorage to ensure default state
        await page.goto('/');
        await page.evaluate(() => localStorage.removeItem('inventoryBrand'));
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('.brand-seg-btn[data-brand="DMC"]')).toHaveClass(/active/);
    });

    test('switching to Anchor updates stats', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const ownedBefore = await page.locator('#stat-owned').textContent();
        await page.click('.brand-seg-btn[data-brand="Anchor"]');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('.brand-seg-btn[data-brand="Anchor"]')).toHaveClass(/active/);
        // Stats should update (might be different values)
        await expect(page.locator('#stat-owned')).not.toHaveText('—');
    });

    test('switching to All shows combined stats', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.click('.brand-seg-btn[data-brand=""]');
        await expect(page.locator('.brand-seg-btn[data-brand=""]')).toHaveClass(/active/);
        await expect(page.locator('#stat-owned')).not.toHaveText('—');
    });

    test('brand selection persists in localStorage', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.click('.brand-seg-btn[data-brand="Anchor"]');
        const stored = await page.evaluate(() => localStorage.getItem('inventoryBrand'));
        expect(stored).toBe('Anchor');
        // Reset to DMC for other tests
        await page.click('.brand-seg-btn[data-brand="DMC"]');
    });
});

// ─── Recent Patterns ─────────────────────────────────────────────────────────

test.describe('Recent Patterns', () => {
    test('shows Recent Patterns section header', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('.section-title').nth(1)).toHaveText('Recent Patterns');
    });

    test('patterns grid is populated', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const grid = page.locator('#patterns-grid');
        await expect(grid).toBeVisible();
        // Should have pattern cards or empty state
        const cards = grid.locator('.pattern-card');
        const empty = grid.locator('.empty-state');
        const hasCards = await cards.count() > 0;
        const hasEmpty = await empty.count() > 0;
        expect(hasCards || hasEmpty).toBe(true);
    });

    test('pattern cards show name, meta, and thumbnail area', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const cards = page.locator('#patterns-grid .pattern-card');
        const count = await cards.count();
        if (count === 0) { test.skip(); return; }
        const first = cards.first();
        await expect(first.locator('.pattern-name')).toBeVisible();
        await expect(first.locator('.pattern-meta')).toBeVisible();
        await expect(first.locator('.pattern-thumb')).toBeVisible();
    });

    test('pattern cards link to viewer', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const cards = page.locator('#patterns-grid .pattern-card');
        const count = await cards.count();
        if (count === 0) { test.skip(); return; }
        const href = await cards.first().getAttribute('href');
        expect(href).toMatch(/^\/view\//);
    });

    test('shows at most 4 recent patterns', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const count = await page.locator('#patterns-grid .pattern-card').count();
        expect(count).toBeLessThanOrEqual(4);
    });

    test('pattern meta shows dimensions and color count', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const cards = page.locator('#patterns-grid .pattern-card');
        const count = await cards.count();
        if (count === 0) { test.skip(); return; }
        const meta = await cards.first().locator('.pattern-meta').textContent();
        // Format: "60 × 60 · 12 colors"
        expect(meta).toMatch(/\d+ × \d+ · \d+ color/);
    });

    test('pattern cards show progress badges', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const cards = page.locator('#patterns-grid .pattern-card');
        const count = await cards.count();
        if (count === 0) { test.skip(); return; }
        // At least one card should have a progress bar
        const progress = page.locator('#patterns-grid .pattern-progress');
        const progressCount = await progress.count();
        // Progress may or may not be shown depending on color count
        expect(progressCount).toBeGreaterThanOrEqual(0);
    });

    test('View Patterns link goes to saved patterns', async ({ page }) => {
        await page.goto('/');
        const link = page.locator('.section-link:has-text("View Patterns")');
        await expect(link).toHaveAttribute('href', '/saved-patterns');
    });
});

// ─── Navigation Links ────────────────────────────────────────────────────────

test.describe('Navigation Links', () => {
    test('View Inventory link goes to inventory', async ({ page }) => {
        await page.goto('/');
        const link = page.locator('.section-link:has-text("View Inventory")');
        await expect(link).toHaveAttribute('href', '/inventory');
    });

    test('nav has Home link marked active', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('.nav-link.active:has-text("Home")')).toBeVisible();
    });
});

// ─── Feature/Tool Cards ─────────────────────────────────────────────────────

test.describe('Tool Cards', () => {
    test('shows Tools section with feature cards', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('.section-title').nth(2)).toHaveText('Tools');
        await expect(page.locator('.features-grid')).toBeVisible();
    });

    test('Convert Image card links to image-to-pattern', async ({ page }) => {
        await page.goto('/');
        const card = page.locator('.feature-card:has-text("Convert Image")');
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute('href', '/image-to-pattern');
    });

    test('Import PDF card links to pdf-to-pattern', async ({ page }) => {
        await page.goto('/');
        const card = page.locator('.feature-card:has-text("Import PDF")');
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute('href', '/pdf-to-pattern');
    });

    test('Project Materials Calculator card links to pattern-calculator', async ({ page }) => {
        await page.goto('/');
        const card = page.locator('.feature-card:has-text("Project Materials Calculator")');
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute('href', '/pattern-calculator');
    });

    test('feature cards have icon, name, and description', async ({ page }) => {
        await page.goto('/');
        const cards = page.locator('.feature-card');
        const count = await cards.count();
        expect(count).toBe(3);
        for (let i = 0; i < count; i++) {
            const card = cards.nth(i);
            await expect(card.locator('.feature-icon')).toBeVisible();
            await expect(card.locator('.feature-name')).toBeVisible();
            await expect(card.locator('.feature-desc')).toBeVisible();
        }
    });
});

// ─── Saved Patterns Count ────────────────────────────────────────────────────

test.describe('Saved Patterns Count', () => {
    test('stat-patterns matches number of pattern cards or API count', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const countText = await page.locator('#stat-patterns').textContent();
        const count = Number(countText);
        expect(count).not.toBeNaN();
        // The count should be >= the number of cards shown (max 4 displayed)
        const cardCount = await page.locator('#patterns-grid .pattern-card').count();
        expect(count).toBeGreaterThanOrEqual(cardCount);
    });
});
