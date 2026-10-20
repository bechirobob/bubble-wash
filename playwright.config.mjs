import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/browser',
  use: { baseURL: 'http://localhost:3100', browserName: 'chromium', launchOptions: process.env.BUBBLEWASH_TEST_CHROMIUM_PATH ? { executablePath: process.env.BUBBLEWASH_TEST_CHROMIUM_PATH } : {}, trace: 'off', video: 'off', screenshot: 'off' },
  projects: [
    { name: 'portrait-320', use: { viewport: { width: 320, height: 740 } } },
    { name: 'portrait-390', use: { viewport: { width: 390, height: 844 } } },
    { name: 'webkit-portrait-390', use: { browserName: 'webkit', launchOptions: {}, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: 'node --conditions=react-server --experimental-strip-types --experimental-loader=./tests/alias-loader.mjs tests/browser/start-fixture.mjs',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
