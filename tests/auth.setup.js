// @ts-check
const { test: setup, expect } = require('@playwright/test');
const path = require('path');

const AUTH_FILE = path.join(__dirname, '.auth-state.json');
const USER = process.env.TEST_USER;
const PASS = process.env.TEST_PASS;

setup('authenticate', async ({ page }) => {
    if (!USER || !PASS) {
        throw new Error(
            'Missing TEST_USER / TEST_PASS env vars.\n' +
            'Run: TEST_USER=<user> TEST_PASS=<pass> npx playwright test'
        );
    }

    await page.goto('/login');

    // If already redirected to home (session still valid), skip login
    if (!page.url().includes('/login')) {
        await page.context().storageState({ path: AUTH_FILE });
        return;
    }

    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await page.click('button[type="submit"]');

    // Wait for navigation to complete
    await page.waitForLoadState('networkidle');

    // Check if login succeeded — should redirect away from /login
    const url = page.url();
    if (url.includes('/login')) {
        // Grab error message for diagnostics
        const error = await page.textContent('.error-box').catch(() => null);
        throw new Error(`Login failed. URL: ${url}, error: ${error}`);
    }

    // Save auth state for other tests
    await page.context().storageState({ path: AUTH_FILE });
});
