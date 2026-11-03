import test from 'node:test';
import assert from 'node:assert/strict';
import { readPricingHistory, withPricingHistory } from '../src/lib/pricing-history.ts';
const draft = { plan: 'Twice weekly', zone: 'core', kg: '60.5', addons: ['ironing'] };
const href = '/services?plan=Weekly';
test('history preserves framework fields and returns validated independent draft values', () => {
  const tree = ['framework'];
  const state = withPricingHistory({ __NA: true, tree }, href, draft);
  assert.equal(state.tree, tree);
  assert.equal(state.__NA, true);
  assert.deepEqual(readPricingHistory(state, href), draft);
  assert.equal(readPricingHistory(state, '/services?plan=Contract'), null);
  assert.equal(readPricingHistory(state, '/book'), null);
  const restored = readPricingHistory(state, href);
  restored.addons.push('premium');
  assert.deepEqual(state.bubblewashPricingDraft.addons, ['ironing']);
});
test('malformed, unknown and incompatible choices cannot become a restored estimate', () => {
  for (const mutation of [{ version: 2 }, { plan: 'Unknown' }, { zone: 'constructor' }, { kg: 'Infinity' }, { kg: '10001' }, { kg: '' }, { addons: ['unknown'] }, { addons: ['ironing', 'ironing'] }, { addons: ['premium', 'ironing'] }]) {
    const state = withPricingHistory(null, href, draft);
    Object.assign(state.bubblewashPricingDraft, mutation);
    assert.equal(readPricingHistory(state, href), null);
  }
  assert.equal(readPricingHistory(null, href), null);
});
