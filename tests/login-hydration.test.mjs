import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('login fails closed before hydration and never defaults to native GET', async () => {
  const source = await readFile(new URL('../src/components/LoginPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /useSyncExternalStore\(subscribeToHydration, clientReady, serverReady\)/);
  assert.match(source, /const serverReady = \(\) => false/);
  assert.match(source, /const clientReady = \(\) => true/);
  assert.match(source, /<form[^>]*method="post"[^>]*aria-busy=\{!hydrated\}/);
  const inputs = source.match(/<input\b[^\n]*?\/>/g);
  assert.equal(inputs.length, 3);
  for (const input of inputs) {
    assert.match(input, /disabled=\{!hydrated\}/);
    assert.doesNotMatch(input, /\bname=/);
  }
  assert.match(source, /<button[^>]*disabled=\{!hydrated\}[^>]*type="submit"/);
  assert.match(source, /event\.preventDefault\(\)/);
});
