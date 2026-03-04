// @ts-check
const { defineConfig } = require('@playwright/test');
const path = require('path');

const AUTH_FILE = path.join(__dirname, 'tests', '.auth-state.json');

module.exports = defineConfig({
    testDir: './tests',
    timeout: 45000,
    retries: 0,
    workers: 1,  // serial — server rate limits (30/min) break parallel runs
    use: {
        baseURL: 'http://localhost:6969',
        headless: true,
    },
    projects: [
        {
            name: 'setup',
            testMatch: /auth\.setup\.js/,
        },
        {
            name: 'chromium',
            use: {
                browserName: 'chromium',
                storageState: AUTH_FILE,
            },
            dependencies: ['setup'],
        },
    ],
});
