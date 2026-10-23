import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('worklist graphical CI has an explicit step and cannot be skipped by an earlier journey failure', () => {
  const workflow = read('.github/workflows/browser-regression.yml');
  assert.match(workflow, /name: Build production runtime for synthetic test data\n\s+id: build\n\s+run: npm run build/);
  for (const command of ['test:worklist-fixture', 'test:browser-worklists']) {
    assert.ok(workflow.includes(`if: \${{ !cancelled() && steps.build.outcome == 'success' }}\n        run: npm run ${command}`));
  }
  assert.match(workflow, /name: Run four-role journeys at mobile and desktop sizes\n\s+run: npx playwright test/);
  assert.equal((workflow.match(/run: npm run build/g) || []).length, 1, 'Existing browser job builds once');
});

test('worklist screenshots are explicit synthetic workspace captures only', () => {
  const config = read('playwright.worklists.config.mjs');
  assert.match(config, /screenshot:'off', trace:'off', video:'off'/);
  const workflow = read('.github/workflows/browser-regression.yml');
  assert.match(workflow, /name: synthetic-staff-worklist-screenshots\n\s+path: test-results\/worklists\/\*\*\/\*\.png\n\s+if-no-files-found: error\n\s+retention-days: 7/);
  assert.ok(read('tests/browser/start-worklist-fixture.mjs').startsWith("import './block-egress.mjs';"));
  assert.ok(read('tests/browser/worklist-fixture-smoke.mjs').startsWith("import './block-egress.mjs';"));
});

test('ordinary verification scripts retain their prior suites and include worklists', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(scripts['test:browser'], 'playwright test && npm run test:browser-worklists');
  assert.ok(scripts['test:workflow'].includes('tests/personal-owner-http.integration.mjs'));
  assert.ok(scripts['test:workflow'].endsWith('npm run test:capacity-parity && npm run test:staff-worklists'));
  assert.equal(scripts['test:worklist-fixture'], 'node tests/browser/worklist-fixture-smoke.mjs');
  const workflow = read('.github/workflows/backup-transport-checks.yml');
  assert.equal((workflow.match(/- playwright\.worklists\.config\.mjs/g) || []).length, 2, 'Exact contract checks trigger for worklist config changes');
});


test('bounded-list browser cases are included without replacing existing staff journeys', () => {
 const config=read('playwright.worklists.config.mjs');
 assert.ok(config.includes("'staff-worklists.worklist.mjs'"));
 assert.ok(config.includes("'list-density.worklist.mjs'"));
 const checks=read('tests/browser/list-density.worklist.mjs');
 for(const requirement of ['length:51','length:50',"page.keyboard.press('Enter')",'Unsaved draft stays with this task','toBeFocused()','No tasks to show','dl > div:not([hidden])','::before','::after']) assert.ok(checks.includes(requirement));
});
