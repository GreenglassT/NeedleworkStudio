// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

/* ─────────────────────────────────────────────
 *  JSON Import — /json-to-pattern
 * ───────────────────────────────────────────── */
test.describe('JSON Import', () => {

    test.describe('Page Load', () => {
        test('shows upload step by default', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await expect(page.locator('#step-upload')).toHaveClass(/active/);
            await expect(page.locator('#step-processing')).not.toHaveClass(/active/);
            await expect(page.locator('#step-preview')).not.toHaveClass(/active/);
        });

        test('import button is disabled initially', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await expect(page.locator('#import-btn')).toBeDisabled();
        });

        test('shows page title and description', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await expect(page.locator('.page-title')).toHaveText('JSON Import');
            await expect(page.locator('.page-sub')).toContainText('JSON export file');
        });
    });

    test.describe('File Selection', () => {
        test('selecting a JSON file enables import button', async ({ page }) => {
            await page.goto('/json-to-pattern');
            const fileInput = page.locator('#json-input');
            await fileInput.setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await expect(page.locator('#import-btn')).toBeEnabled();
            await expect(page.locator('#filename-display')).toHaveText('valid-pattern.json');
        });

        test('re-selecting clears previous filename', async ({ page }) => {
            await page.goto('/json-to-pattern');
            const fileInput = page.locator('#json-input');
            await fileInput.setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await expect(page.locator('#filename-display')).toHaveText('valid-pattern.json');
            // Select a different file
            await fileInput.setInputFiles(path.join(FIXTURES, 'invalid-pattern.json'));
            await expect(page.locator('#filename-display')).toHaveText('invalid-pattern.json');
        });
    });

    test.describe('Validation Errors', () => {
        test('shows error for mismatched grid_data length', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'invalid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#upload-error')).toBeVisible();
            await expect(page.locator('#upload-error')).toContainText('grid_data length');
        });

        test('shows error for non-JSON file content', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'not-json.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#upload-error')).toBeVisible();
            await expect(page.locator('#upload-error')).toContainText('parse JSON');
        });

        test('shows error for wrong format field', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'wrong-format.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#upload-error')).toBeVisible();
            await expect(page.locator('#upload-error')).toContainText('Not a Needlework Studio');
        });
    });

    test.describe('Successful Import', () => {
        test('shows preview step after valid import', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
        });

        test('populates pattern name from JSON', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await expect(page.locator('#pattern-name')).toHaveValue('Test Pattern JSON');
        });

        test('shows dimension line with grid size and color count', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await expect(page.locator('#dim-line')).toContainText('3');
            await expect(page.locator('#dim-line')).toContainText('2 colors');
        });

        test('renders preview canvas', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            const canvas = page.locator('#preview-canvas');
            await expect(canvas).toBeVisible();
            // Canvas should have non-zero dimensions
            const width = await canvas.getAttribute('width');
            expect(parseInt(width)).toBeGreaterThan(0);
        });

        test('renders legend list with correct color count', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await expect(page.locator('#color-count')).toHaveText('2');
            const rows = page.locator('#legend-list .legend-row');
            await expect(rows).toHaveCount(2);
        });

        test('save button is visible in preview step', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await expect(page.locator('#save-btn')).toBeVisible();
            await expect(page.locator('#save-btn')).toBeEnabled();
        });
    });

    test.describe('Save Pattern', () => {
        test('saving shows post-save actions with links', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await page.locator('#save-btn').click();
            await expect(page.locator('#post-save-actions')).toBeVisible({ timeout: 10000 });
            await expect(page.locator('#link-view')).toBeVisible();
            await expect(page.locator('#link-stash')).toBeVisible();
            // Link-view should point to /view/<slug>
            const href = await page.locator('#link-view').getAttribute('href');
            expect(href).toMatch(/^\/view\/[A-Za-z0-9]+$/);
        });

        test('pre-save actions hidden after save', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await page.locator('#save-btn').click();
            await expect(page.locator('#post-save-actions')).toBeVisible({ timeout: 10000 });
            await expect(page.locator('#pre-save-actions')).not.toBeVisible();
        });
    });

    test.describe('Re-import', () => {
        test('re-import button returns to upload step', async ({ page }) => {
            await page.goto('/json-to-pattern');
            await page.locator('#json-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.json'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await page.getByRole('button', { name: 'Re-import' }).click();
            await expect(page.locator('#step-upload')).toHaveClass(/active/);
            await expect(page.locator('#import-btn')).toBeDisabled();
        });
    });
});


/* ─────────────────────────────────────────────
 *  OXS Import — /oxs-to-pattern
 * ───────────────────────────────────────────── */
test.describe('OXS Import', () => {

    test.describe('Page Load', () => {
        test('shows upload step by default', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await expect(page.locator('#step-upload')).toHaveClass(/active/);
            await expect(page.locator('#import-btn')).toBeDisabled();
        });

        test('shows page title and description', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await expect(page.locator('.page-title')).toHaveText('OXS Import');
            await expect(page.locator('.page-sub')).toContainText('Open Cross Stitch');
        });
    });

    test.describe('File Selection', () => {
        test('selecting an OXS file enables import button', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.oxs'));
            await expect(page.locator('#import-btn')).toBeEnabled();
            await expect(page.locator('#filename-display')).toHaveText('valid-pattern.oxs');
        });
    });

    test.describe('Validation Errors', () => {
        test('shows error for invalid XML', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'invalid.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#upload-error')).toBeVisible();
            await expect(page.locator('#upload-error')).toContainText(/parse|Missing/);
        });

        test('shows error for missing properties element', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'no-props.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#upload-error')).toBeVisible();
            await expect(page.locator('#upload-error')).toContainText('Missing');
        });

        test('shows error for no stitches found', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'empty-stitches.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#upload-error')).toBeVisible();
            await expect(page.locator('#upload-error')).toContainText('No stitches');
        });
    });

    test.describe('Successful Import', () => {
        test('shows preview step after valid import', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
        });

        test('populates pattern name from OXS title', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await expect(page.locator('#pattern-name')).toHaveValue('Test Pattern OXS');
        });

        test('shows dimension line with grid size', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await expect(page.locator('#dim-line')).toContainText('3');
            await expect(page.locator('#dim-line')).toContainText('2 colors');
        });

        test('renders legend with correct colors', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await expect(page.locator('#color-count')).toHaveText('2');
            const rows = page.locator('#legend-list .legend-row');
            await expect(rows).toHaveCount(2);
        });

        test('renders preview canvas', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            const canvas = page.locator('#preview-canvas');
            await expect(canvas).toBeVisible();
            const width = await canvas.getAttribute('width');
            expect(parseInt(width)).toBeGreaterThan(0);
        });
    });

    test.describe('Save Pattern', () => {
        test('saving shows post-save links', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await page.locator('#save-btn').click();
            await expect(page.locator('#post-save-actions')).toBeVisible({ timeout: 10000 });
            const href = await page.locator('#link-view').getAttribute('href');
            expect(href).toMatch(/^\/view\/[A-Za-z0-9]+$/);
        });
    });

    test.describe('Re-import', () => {
        test('re-import resets to upload step', async ({ page }) => {
            await page.goto('/oxs-to-pattern');
            await page.locator('#oxs-input').setInputFiles(path.join(FIXTURES, 'valid-pattern.oxs'));
            await page.locator('#import-btn').click();
            await expect(page.locator('#step-preview')).toHaveClass(/active/);
            await page.getByRole('button', { name: 'Re-import' }).click();
            await expect(page.locator('#step-upload')).toHaveClass(/active/);
            await expect(page.locator('#import-btn')).toBeDisabled();
        });
    });
});


/* ─────────────────────────────────────────────
 *  PDF Import — /pdf-to-pattern
 * ───────────────────────────────────────────── */
test.describe('PDF Import', () => {

    test.describe('Page Load', () => {
        test('shows upload step by default', async ({ page }) => {
            await page.goto('/pdf-to-pattern');
            await expect(page.locator('#step-upload')).toHaveClass(/active/);
            await expect(page.locator('#import-btn')).toBeDisabled();
        });

        test('shows page title and description', async ({ page }) => {
            await page.goto('/pdf-to-pattern');
            await expect(page.locator('.page-title')).toHaveText('PDF Import');
            await expect(page.locator('.page-sub')).toContainText('cross-stitch PDF');
        });

        test('drop zone is visible with correct label', async ({ page }) => {
            await page.goto('/pdf-to-pattern');
            await expect(page.locator('#drop-zone')).toBeVisible();
            await expect(page.locator('.upload-label')).toContainText('Drop a PDF');
        });
    });

    test.describe('File Selection', () => {
        test('selecting a PDF file enables import button', async ({ page }) => {
            await page.goto('/pdf-to-pattern');
            await page.locator('#pdf-input').setInputFiles(path.join(FIXTURES, 'fake.pdf'));
            await expect(page.locator('#import-btn')).toBeEnabled();
            await expect(page.locator('#filename-display')).toHaveText('fake.pdf');
        });
    });

    test.describe('Import Error Handling', () => {
        test('shows error for invalid PDF', async ({ page }) => {
            await page.goto('/pdf-to-pattern');
            await page.locator('#pdf-input').setInputFiles(path.join(FIXTURES, 'fake.pdf'));
            await page.locator('#import-btn').click();
            // Server-side parsing will fail — should show error and return to upload step
            await expect(page.locator('#upload-error')).toBeVisible({ timeout: 15000 });
            await expect(page.locator('#step-upload')).toHaveClass(/active/);
        });
    });

    test.describe('Re-import', () => {
        test('upload step structure is correct', async ({ page }) => {
            await page.goto('/pdf-to-pattern');
            // Verify all 3 step divs exist
            await expect(page.locator('#step-upload')).toHaveCount(1);
            await expect(page.locator('#step-processing')).toHaveCount(1);
            await expect(page.locator('#step-preview')).toHaveCount(1);
            // Verify buttons
            await expect(page.locator('#import-btn')).toHaveText('Import PDF');
            await expect(page.locator('#save-btn')).toHaveCount(1);
        });
    });
});
