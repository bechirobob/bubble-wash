import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFocusModality } from '../src/lib/focus-modality.ts';

function fixture() {
  const listeners = new Map();
  const windowListeners = new Map();
  const timers = new Map(); let timerId = 0;
  const document = {
    documentElement: { dataset: {} },
    defaultView: {
      setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener(type, listener) { windowListeners.set(type, listener); },
      removeEventListener(type, listener) { assert.equal(windowListeners.get(type), listener); windowListeners.delete(type); },
    },
    addEventListener(type, listener, capture) { assert.equal(capture, true); listeners.set(type, listener); },
    removeEventListener(type, listener, capture) { assert.equal(capture, true); assert.equal(listeners.get(type), listener); listeners.delete(type); },
  };
  const cleanup = installFocusModality(document);
  return { document, listeners, windowListeners, cleanup, pendingTimers: () => timers.size, flush: () => { for (const fn of [...timers.values()]) fn(); }, mode: () => document.documentElement.dataset.inputModality,
    fire: (type, props = {}) => listeners.get(type)(props) };
}

test('unknown modality retains browser focus; pointer capture precedes modal focus', () => {
  const f = fixture(); assert.equal(f.mode(), undefined);
  for (const pointerType of ['touch', 'mouse', 'pen']) {
    f.fire('pointerdown', { pointerType }); assert.equal(f.mode(), 'pointer');
    f.fire('click', { detail: 1 }); assert.equal(f.mode(), 'pointer');
    f.fire('keydown', { key: 'Tab' }); assert.equal(f.mode(), 'keyboard');
  }
  f.cleanup(); assert.equal(f.mode(), undefined); assert.equal(f.listeners.size, 0); assert.equal(f.windowListeners.size, 0);
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

test('leaving the document resets to native focus, then the next input selects modality', () => {
  const f = fixture();
  f.fire('pointerdown'); f.windowListeners.get('blur')(); assert.equal(f.mode(), undefined);
  f.fire('keydown', { key: 'Tab' }); assert.equal(f.mode(), 'keyboard');
  f.windowListeners.get('blur')(); assert.equal(f.mode(), undefined);
  f.fire('pointerdown'); assert.equal(f.mode(), 'pointer'); f.cleanup();
});

test('one shared policy retains editing cues and all focusable keyboard targets', () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /:focus-visible, html\[data-input-modality="keyboard"\] :focus, input:focus/);
  assert.match(css, /html\[data-input-modality="pointer"\] :focus:not\(:is\(/);
  assert.match(css, /select, textarea, \[contenteditable\]:not\(\[contenteditable="false"\]\)/);
  assert.match(css, /html:not\(\[data-input-modality="pointer"\]\) \.planChoice:has\(input:focus-visible\)/);
  assert.equal((css.match(/outline: none/g) || []).length, 1);
  assert.match(css, /@media \(forced-colors: none\) \{\s*html\[data-input-modality="pointer"\]/);
  for (const file of ['research/research.module.css','BubbleWashOpening.module.css','WebAppInstall.module.css']) {
    const moduleCss = readFileSync(new URL('../src/components/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(moduleCss, /:focus(?:-visible)?[^{}]*\{[^}]*outline:/, file);
  }
  const provider = readFileSync(new URL('../src/components/WebAppProvider.tsx', import.meta.url), 'utf8');
  assert.match(provider, /useEffect\(\(\) => installFocusModality\(document\), \[\]\)/);
});

// Visible native-radio wrappers follow the same explicit keyboard policy as the
// input itself: WebKit need not expose :focus-visible after native arrow changes.
test('native radio wrappers show keyboard focus without reintroducing pointer rings', () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  for (const wrapper of ['planChoice', 'focusedPlanSegment']) {
    assert.ok(css.includes(`html[data-input-modality="keyboard"] .${wrapper}:has(input:focus),\nhtml:not([data-input-modality="pointer"]) .${wrapper}:has(input:focus-visible) {`));
    assert.ok(!css.includes(`.${wrapper}:focus-within`));
  }
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.focusedPlanSegment:has\(input:checked\)/);
});

test('pointer label forwarding is causal, one-shot, and does not swallow assistive activation', () => {
  const f = fixture();
  const input = { closest: () => null };
  const other = { closest: () => null };
  const labelText = { closest: () => ({ control: input }) };
  f.fire('pointerdown');
  f.fire('click', { isTrusted: true, detail: 1, target: labelText });
  f.fire('click', { isTrusted: true, detail: 0, target: input });
  assert.equal(f.mode(), 'pointer', 'native label forwarding retains touch/mouse provenance');
  f.fire('click', { isTrusted: true, detail: 0, target: input });
  assert.equal(f.mode(), 'keyboard', 'a subsequent genuine assistive activation is not suppressed');
  f.fire('pointerdown');
  f.fire('click', { isTrusted: true, detail: 1, target: labelText });
  f.fire('click', { isTrusted: true, detail: 0, target: other });
  assert.equal(f.mode(), 'keyboard', 'unrelated control never inherits label provenance');
  f.fire('pointerdown');
  f.fire('click', { isTrusted: true, detail: 1, target: labelText });
  f.flush();
  f.fire('click', { isTrusted: true, detail: 0, target: input });
  assert.equal(f.mode(), 'keyboard', 'cancelled label activation expires after its event turn');
  f.fire('pointerdown');
  f.fire('click', { isTrusted: true, detail: 1, target: labelText });
  f.fire('keydown', { key: 'ArrowRight' });
  f.fire('click', { isTrusted: true, detail: 0, target: input });
  assert.equal(f.mode(), 'keyboard', 'keyboard activation clears pointer-label provenance');
  f.cleanup();
});

test('blur and cleanup discard a pending label-forwarding target and timer', () => {
  const f = fixture();
  const input = { closest: () => null };
  const labelText = { closest: () => ({ control: input }) };
  f.fire('pointerdown');
  f.fire('click', { isTrusted: true, detail: 1, target: labelText });
  assert.equal(f.pendingTimers(), 1);
  f.windowListeners.get('blur')();
  assert.equal(f.mode(), undefined);
  assert.equal(f.pendingTimers(), 0);
  f.fire('click', { isTrusted: true, detail: 0, target: input });
  assert.equal(f.mode(), 'keyboard', 'activation after window return uses native assistive fallback');
  f.fire('pointerdown');
  f.fire('click', { isTrusted: true, detail: 1, target: labelText });
  assert.equal(f.pendingTimers(), 1);
  f.cleanup();
  assert.equal(f.pendingTimers(), 0);
  assert.equal(f.mode(), undefined);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.windowListeners.size, 0);
});

test('owner research selects keep normal pointer appearance without removing keyboard or forced-color focus', () => {
  const css = readFileSync(new URL('../src/components/research/results.module.css', import.meta.url), 'utf8');
  assert.ok(css.includes('@media(forced-colors:none){.page select:focus{outline:2px solid var(--focus-ring);outline-offset:2px}'));
  assert.ok(css.includes(':global(html[data-input-modality="pointer"]) .page select:focus{outline:none;border-color:var(--line)}'));
  assert.doesNotMatch(css, /\.page\s+:focus\s*\{[^}]*outline:none/);
});
