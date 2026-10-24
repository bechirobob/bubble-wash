import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('worklist graphical CI has an explicit step and cannot be skipped by an earlier journey failure', () => {
  const workflow = read('.github/workflows/browser-regression.yml');
  assert.match(workflow, /name: Build production runtime for synthetic test data\n\s+id: build\n\s+run: npm run build/);
  const fullMode = "(github.event_name != 'workflow_dispatch' || inputs.mode != 'gps')";
  for (const command of ['test:worklist-fixture', 'test:browser-worklists']) {
    assert.ok(workflow.includes(`if: \${{ !cancelled() && steps.build.outcome == 'success' && ${fullMode} }}\n        run: npm run ${command}`));
  }
  assert.ok(workflow.includes("name: Run four-role journeys at mobile and desktop sizes\n        if: ${{ github.event_name != 'workflow_dispatch' || inputs.mode != 'gps' }}\n        run: npx playwright test"));
  // The exact condition above omits success(), so an earlier journey failure does not suppress worklists.
  const worklistsRun = (event, mode, cancelled = false, build = 'success') => !cancelled && build === 'success' && (event !== 'workflow_dispatch' || mode !== 'gps');
  for (const event of ['pull_request', 'push']) for (const mode of [undefined, 'full', 'gps']) assert.equal(worklistsRun(event, mode), true);
  for (const mode of [undefined, 'full']) assert.equal(worklistsRun('workflow_dispatch', mode), true);
  assert.equal(worklistsRun('workflow_dispatch', 'gps'), false);
  assert.equal(worklistsRun('pull_request', 'full', true), false);
  assert.equal(worklistsRun('pull_request', 'full', false, 'failure'), false);
  assert.equal((workflow.match(/npm run build/g) || []).length, 2, 'Main fixture and isolated open-survey fixture each build once');
  assert.match(workflow, /name: Build isolated open-survey fixture \(never a deployment artifact\)\n\s+if: \$\{\{ github.event_name != 'workflow_dispatch' \|\| inputs.mode != 'gps' \}\}[\s\S]*?npm run build/);
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
