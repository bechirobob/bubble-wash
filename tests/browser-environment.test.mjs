import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateVersions, verifyBrowser } from '../scripts/verify-browser-environment.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const config = JSON.parse(read('scripts/browser-environment.json'));
const lock = JSON.parse(read('package-lock.json'));
const installed = Object.fromEntries(['@playwright/test', 'playwright', 'playwright-core', 'better-sqlite3', 'sharp']
  .map(name => [name, lock.packages[`node_modules/${name}`].version]));
const os = 'ID=ubuntu\nVERSION_ID="24.04"\n';
const check = (changes = {}) => validateVersions(changes.config ?? config, changes.lock ?? lock,
  changes.installed ?? installed, changes.node ?? '22.23.4', changes.python ?? '3.12', changes.os ?? os);

test('prepared image matches the locked browser and native packages without runtime upgrades', () => check());
for (const [name, changes] of Object.entries({
  'mutable image tag': { config: { ...config, image: config.image.split('@')[0] } },
  'wrong image version': { config: { ...config, image: config.image.replace('v1.64.1', 'v1.62.1') } },
  'bad digest': { config: { ...config, image: config.image.slice(0, -1) + 'z' } },
  'different Node major': { node: '24.0.0' },
  'different Python minor': { python: '3.13' },
  'different Linux distribution': { os: os.replace('ubuntu', 'debian') },
  'different Ubuntu release': { os: os.replace('24.04', '22.04') },
  'different locked browser': { lock: { packages: { ...lock.packages, 'node_modules/playwright': { version: '0.0.0' } } } },
  ...Object.fromEntries(Object.keys(installed).map(name => [`different installed ${name}`, { installed: { ...installed, [name]: '0.0.0' } }])),
})) test(`readiness rejects ${name}`, () => assert.throws(() => check(changes)));

test('Node22 patch releases remain compatible with the existing setup-node22 policy', () => check({ node: '22.24.0' }));

function fakeEngines({ content = 'Prepared browser ready', path = '/ms-playwright/fake/browser' } = {}) {
  const events = [];
  const engines = Object.fromEntries(['chromium', 'webkit'].map(name => [name, {
    executablePath: () => path,
    launch: async () => {
      events.push(`${name}:launch`);
      return {
        newPage: async () => ({
          setContent: async html => { assert.equal(html, '<main>Prepared browser ready</main>'); },
          locator: selector => { assert.equal(selector, 'main'); return { textContent: async () => content }; },
        }),
        version: () => 'test-version',
        close: async () => { events.push(`${name}:close`); },
      };
    },
  }]));
  return { engines, events };
}

test('readiness exercises both actual configured engines and closes them', async () => {
  const { engines, events } = fakeEngines();
  const paths = [];
  const checks = await verifyBrowser(engines, async path => { paths.push(path); });
  assert.deepEqual(checks.map(check => check.engine), ['chromium', 'webkit']);
  assert.deepEqual(events, ['chromium:launch', 'chromium:close', 'webkit:launch', 'webkit:close']);
  assert.equal(paths.length, 2);
});
test('failed page assertion closes the browser and fails readiness', async () => {
  const { engines, events } = fakeEngines({ content: 'wrong' });
  await assert.rejects(verifyBrowser(engines, async () => {}));
  assert.deepEqual(events, ['chromium:launch', 'chromium:close']);
});
test('unprepared executable path is rejected before launch', async () => {
  const { engines, events } = fakeEngines({ path: '/ms-playwright-other/browser' });
  await assert.rejects(verifyBrowser(engines, async () => {}));
  assert.deepEqual(events, []);
});
test('unavailable executable fails without installing or falling back', async () => {
  const { engines, events } = fakeEngines();
  await assert.rejects(verifyBrowser(engines, async () => { throw new Error('not executable'); }), /not executable/);
  assert.deepEqual(events, []);
});

test('browser workflow uses prepared dependencies with the existing least-privilege scope', () => {
  const workflow = read('.github/workflows/browser-regression.yml');
  assert.ok(workflow.includes(`      image: ${config.image}\n`));
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /options: --user 1001 --shm-size=1g/);
  assert.match(workflow, /defaults:\n      run:\n        shell: bash/);
  assert.match(workflow, /node-version: 22\n/);
  assert.match(workflow, /python-version: '3\.12'/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: node scripts\/verify-browser-environment\.mjs/);
  assert.doesNotMatch(workflow, /playwright install|apt-get|sudo |--privileged|SYS_ADMIN|--ipc=host/);
  assert.ok(workflow.indexOf('Verify prepared browsers') < workflow.indexOf('Verify fixture egress guard'));
  for (const flag of ['ADMIN_MFA_REQUIRED', 'AUTOMATED_UPDATES_ENABLED', 'ONLINE_PAYMENTS_ENABLED']) {
    assert.ok(workflow.includes(`NEXT_PUBLIC_BUBBLEWASH_${flag}: 'false'`));
  }
});

test('full/GPS separation and survey fixture boundaries remain explicit', () => {
  const workflow = read('.github/workflows/browser-regression.yml');
  assert.match(workflow, /default: full\n        options: \[full, gps\]/);
  assert.ok(workflow.includes("if: ${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'gps' && github.ref == 'refs/heads/main' }}"));
  assert.match(workflow, /Focused GPS checks cannot satisfy the production full Browser gate\./);
  assert.match(workflow, /run: node --test tests\/browser-egress.test.mjs/);
  assert.match(workflow, /Build isolated open-survey fixture \(never a deployment artifact\)/);
  assert.match(workflow, /BUBBLEWASH_TEST_RESEARCH_OPEN: 'true'/);
  assert.match(workflow, /for flag in \['launchApproved', 'deliveryApproved', 'retentionReviewApproved'\]/);
  assert.match(read('playwright.config.mjs'), /retries: 0/);
});
