import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests/browser', testMatch: ['staff-worklists.worklist.mjs', 'list-density.worklist.mjs'], timeout: 120_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
 reporter:'list', outputDir:'test-results/worklists',
 use: { baseURL:'http://localhost:3195', browserName:'chromium', launchOptions:process.env.BUBBLEWASH_TEST_CHROMIUM_PATH?{executablePath:process.env.BUBBLEWASH_TEST_CHROMIUM_PATH}:{}, screenshot:'off', trace:'off', video:'off' },
 projects:[{name:'desktop-1440',use:{viewport:{width:1440,height:1000}}},{name:'mobile-390',use:{viewport:{width:390,height:844}}}],
 webServer: { command:'node --conditions=react-server --experimental-strip-types --experimental-loader=./tests/alias-loader.mjs tests/browser/start-worklist-fixture.mjs',url:'http://localhost:3195/api/health',reuseExistingServer:false,timeout:60000 }
});
