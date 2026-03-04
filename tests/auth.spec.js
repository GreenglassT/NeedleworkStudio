// @ts-check
const { test, expect } = require('@playwright/test');

const USER = process.env.TEST_USER || 'Claude';
const PASS = process.env.TEST_PASS || 'testpass123';

// ─── Unauthenticated tests ───────────────────────────────────────────────────

test.describe('Login Page (unauthenticated)', () => {
    // Clear auth state so these tests hit the login page fresh
    test.use({ storageState: { cookies: [], origins: [] } });

    test.describe('Page Load', () => {
        test('shows login form with all fields', async ({ page }) => {
            await page.goto('/login');
            await expect(page.locator('#username')).toBeVisible();
            await expect(page.locator('#password')).toBeVisible();
            await expect(page.locator('#remember')).toBeVisible();
            await expect(page.locator('button[type="submit"]')).toBeVisible();
            await expect(page.locator('button[type="submit"]')).toHaveText('Sign In');
        });

        test('shows branding in login header', async ({ page }) => {
            await page.goto('/login');
            await expect(page.locator('.login-header')).toBeVisible();
            await expect(page.locator('.login-header p')).toContainText('Sign in');
        });

        test('has theme toggle button', async ({ page }) => {
            await page.goto('/login');
            await expect(page.locator('#theme-toggle')).toBeVisible();
        });
    });

    test.describe('Validation Errors', () => {
        test('shows error for empty username', async ({ page }) => {
            await page.goto('/login');
            await page.fill('#password', 'something');
            await page.click('button[type="submit"]');
            // HTML5 required attribute prevents submission — username should still be empty
            await expect(page.locator('#username')).toHaveValue('');
            // Should still be on login page
            expect(page.url()).toContain('/login');
        });

        test('shows error for empty password', async ({ page }) => {
            await page.goto('/login');
            await page.fill('#username', 'someone');
            await page.click('button[type="submit"]');
            expect(page.url()).toContain('/login');
        });

        test('shows error for invalid credentials', async ({ page }) => {
            await page.goto('/login');
            await page.fill('#username', 'nonexistent_user');
            await page.fill('#password', 'wrongpassword');
            await page.click('button[type="submit"]');
            await expect(page.locator('.error-message')).toBeVisible();
            await expect(page.locator('.error-message')).toContainText('Invalid username or password');
        });

        test('button shows loading state during submission', async ({ page }) => {
            await page.goto('/login');
            await page.fill('#username', 'nonexistent_user');
            await page.fill('#password', 'wrongpassword');
            // Intercept to slow down the response so we can see the loading state
            await page.route('**/login', async (route) => {
                if (route.request().method() === 'POST') {
                    await new Promise(r => setTimeout(r, 500));
                    await route.continue();
                } else {
                    await route.continue();
                }
            });
            await page.click('button[type="submit"]');
            await expect(page.locator('button[type="submit"]')).toHaveText('Signing in…');
            // Wait for error to appear, button should reset
            await expect(page.locator('.error-message')).toBeVisible();
            await expect(page.locator('button[type="submit"]')).toHaveText('Sign In');
            await expect(page.locator('button[type="submit"]')).toBeEnabled();
        });
    });

    test.describe('Successful Login', () => {
        test('redirects away from login on valid credentials with remember me', async ({ page }) => {
            await page.goto('/login');
            // Remember me unchecked by default
            await expect(page.locator('#remember')).not.toBeChecked();
            await page.fill('#username', USER);
            await page.fill('#password', PASS);
            await page.check('#remember');
            await expect(page.locator('#remember')).toBeChecked();
            await page.click('button[type="submit"]');
            // Server redirects to / (root) after login
            await page.waitForURL((url) => !url.pathname.includes('/login'));
            expect(page.url()).not.toContain('/login');
        });
    });

    test.describe('Protected Routes', () => {
        test('unauthenticated access to home redirects to login', async ({ page }) => {
            await page.goto('/');
            await page.waitForURL('**/login**');
            expect(page.url()).toContain('/login');
        });

        test('unauthenticated access to inventory redirects to login', async ({ page }) => {
            await page.goto('/inventory');
            await page.waitForURL('**/login**');
            expect(page.url()).toContain('/login');
        });

        test('unauthenticated access to saved-patterns redirects to login', async ({ page }) => {
            await page.goto('/saved-patterns');
            await page.waitForURL('**/login**');
            expect(page.url()).toContain('/login');
        });

        test('redirect includes next parameter', async ({ page }) => {
            await page.goto('/saved-patterns');
            await page.waitForURL('**/login**');
            expect(page.url()).toContain('next=');
        });

        test('login redirects back to intended page via next param', async ({ page }) => {
            await page.goto('/saved-patterns');
            await page.waitForURL('**/login**');
            await page.fill('#username', USER);
            await page.fill('#password', PASS);
            await page.click('button[type="submit"]');
            await page.waitForURL('**/saved-patterns');
            expect(page.url()).toContain('/saved-patterns');
        });
    });
});

// ─── Authenticated tests ─────────────────────────────────────────────────────

test.describe('Logout (authenticated)', () => {
    test('logout redirects to login page', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.goto('/logout');
        await page.waitForURL('**/login');
        expect(page.url()).toContain('/login');
    });

    test('after logout, visiting home redirects to login', async ({ page }) => {
        // First logout
        await page.goto('/logout');
        await page.waitForURL('**/login');
        // Now try accessing protected page
        await page.goto('/');
        await page.waitForURL('**/login**');
        expect(page.url()).toContain('/login');
    });
});

test.describe('Session Timeout Handling', () => {
    test('API 401 response triggers redirect to login', async ({ page, context }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // Mock an API endpoint to return 401 (simulating expired session)
        await page.route('**/api/saved-patterns*', (route) => {
            route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Session expired. Please log in again.' }),
            });
        });

        // Clear cookies to simulate expired session on server side too,
        // so the /login redirect doesn't bounce back to /
        await context.clearCookies();

        // Trigger a fetch to the mocked endpoint
        await page.evaluate(() => {
            fetch('/api/saved-patterns').catch(() => {});
        });

        // The global fetch interceptor should redirect to /login
        await page.waitForURL('**/login**', { timeout: 10000 });
        expect(page.url()).toContain('/login');
    });

    test('401 on login page does not cause redirect loop', async ({ page }) => {
        // Use unauthenticated context: clear cookies, go to login
        await page.context().clearCookies();
        await page.goto('/login');

        // Mock a 401 response for a login POST (simulating the interceptor scenario)
        await page.route('**/login', (route) => {
            if (route.request().method() === 'POST') {
                route.fulfill({
                    status: 401,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'Invalid username or password.' }),
                });
            } else {
                route.continue();
            }
        });

        // The fetch interceptor checks `!resp.url.includes('/login')` to avoid loop
        const result = await page.evaluate(async () => {
            const resp = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'bad', password: 'bad' }),
            });
            return { status: resp.status, url: window.location.href };
        });
        expect(result.status).toBe(401);
        // Should still be on login page, not redirected away
        expect(result.url).toContain('/login');
    });
});
