import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFocusModality } from '../src/lib/focus-modality.ts';

function fixture() {
  const listeners = new Map();
  const document = {
    documentElement: { dataset: {} },
    addEventListener(type, listener, capture) { assert.equal(capture, true); listeners.set(type, listener); },
    removeEventListener(type, listener, capture) { assert.equal(capture, true); assert.equal(listeners.get(type), listener); listeners.delete(type); },
  };
  const cleanup = installFocusModality(document);
  return { document, listeners, cleanup, mode: () => document.documentElement.dataset.inputModality,
    fire: (type, props = {}) => listeners.get(type)(props) };
}

test('unknown modality retains browser focus; pointer capture precedes modal focus', () => {
  const f = fixture(); assert.equal(f.mode(), undefined);
  for (const pointerType of ['touch', 'mouse', 'pen']) {
    f.fire('pointerdown', { pointerType }); assert.equal(f.mode(), 'pointer');
    f.fire('click', { detail: 1 }); assert.equal(f.mode(), 'pointer');
    f.fire('keydown', { key: 'Tab' }); assert.equal(f.mode(), 'keyboard');
  }
  f.cleanup(); assert.equal(f.mode(), undefined); assert.equal(f.listeners.size, 0);
});

test('keyboard switching, assistive activation and modifiers are preserved', () => {
  const f = fixture();
  f.fire('pointerdown');
  for (const key of ['Shift','Control','Alt','Meta']) { f.fire('keydown', { key }); assert.equal(f.mode(), 'pointer'); }
  f.fire('keydown', { key: 'a', ctrlKey: true }); assert.equal(f.mode(), 'pointer');
  f.fire('keydown', { key: 'ArrowDown' }); assert.equal(f.mode(), 'keyboard');
  f.fire('pointerdown'); f.fire('click', { detail: 0, isTrusted: false }); assert.equal(f.mode(), 'pointer');
  // Simulated trusted-event contract, not a real screen-reader test.
  f.fire('click', { detail: 0, isTrusted: true }); assert.equal(f.mode(), 'keyboard');
  f.cleanup();
});

test('one shared policy retains editing cues and all focusable keyboard targets', () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /:focus-visible, html\[data-input-modality="keyboard"\] :focus, input:focus/);
  assert.match(css, /html\[data-input-modality="pointer"\] :focus:not\(:is\(/);
  assert.match(css, /select, textarea, \[contenteditable\]:not\(\[contenteditable="false"\]\)/);
  assert.match(css, /html:not\(\[data-input-modality="pointer"\]\) \.planChoice:has\(input:focus-visible\)/);
  assert.equal((css.match(/outline: none/g) || []).length, 1);
  for (const file of ['research/research.module.css','research/results.module.css','BubbleWashOpening.module.css','WebAppInstall.module.css']) {
    const moduleCss = readFileSync(new URL('../src/components/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(moduleCss, /:focus(?:-visible)?[^{}]*\{[^}]*outline:/, file);
  }
  const provider = readFileSync(new URL('../src/components/WebAppProvider.tsx', import.meta.url), 'utf8');
  assert.match(provider, /useEffect\(\(\) => installFocusModality\(document\), \[\]\)/);
});
