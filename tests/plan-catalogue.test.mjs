import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { plans } from '../src/lib/pricing.ts';

const source = readFileSync(new URL('../src/components/PlanCatalogue.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
const jsx = (type, props) => ({ type, props });
const formatMoney = value => `GHS ${value.toFixed(2)}`;
const modules = {
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'lucide-react': { ArrowRight: 'icon', BadgeCheck: 'icon', CalendarDays: 'icon', ChevronDown: 'icon', Info: 'icon' },
  '@/lib/pricing': { plans },
  '@/lib/public-ui': { formatMoney },
};
const exports = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText, {
  exports,
  require: name => { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; },
});
function all(node, match) {
  if (!node || typeof node !== 'object') return [];
  return [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => all(child, match))];
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return [node.props?.children].flat(Infinity).map(text).join('');
}
const byClass = (tree, className) => all(tree, node => node.props?.className?.split(' ').includes(className));
function catalogue(initial = 'Twice weekly') {
  let selected = initial;
  return () => exports.PlanCatalogue({ selected, onSelect: name => { selected = name; } });
}

test('frequency controls remain one native radio group with full accessible names', () => {
  const tree = catalogue()();
  const groups = all(tree, node => node.type === 'fieldset');
  assert.equal(groups.length, 1);
  assert.equal(text(all(groups[0], node => node.type === 'legend')[0]), 'Pickups per week');
  const choices = byClass(tree, 'focusedPlanSegment');
  assert.equal(choices.length, 4);
  assert.deepEqual(choices.map(choice => text(all(choice, node => node.props?.['aria-hidden'] === 'true')[0])), ['1×', '2×', '3×', '5–6×']);
  choices.forEach((choice, index) => {
    const input = all(choice, node => node.type === 'input')[0];
    assert.equal(input.props.type, 'radio');
    assert.equal(input.props.name, 'catalogue-plan');
    assert.equal(input.props.value, plans[index].name);
    assert.equal(input.props.checked, plans[index].name === 'Twice weekly');
    assert.ok(text(choice).includes(`${plans[index].name}, ${plans[index].pickups}`));
    assert.equal(input.props.onKeyDown, undefined, 'native arrow-key behavior must not be overridden');
    assert.equal(input.props.tabIndex, undefined, 'native radio-group tab behavior must be preserved');
  });
});

test('all four selections show one accurate plan card, fee, schedule, benefits and weight bands', () => {
  const render = catalogue();
  for (const plan of plans) {
    all(render(), node => node.type === 'input' && node.props.value === plan.name)[0].props.onChange();
    const tree = render();
    const cards = byClass(tree, 'focusedPlanCard');
    assert.equal(cards.length, 1);
    assert.equal(text(all(cards[0], node => node.type === 'h3')[0]), plan.name);
    assert.ok(text(cards[0]).includes(formatMoney(plan.subscription)));
    assert.ok(text(cards[0]).includes(plan.pickups));
    assert.ok(text(cards[0]).includes(`${plan.monthlyPickups} pickups a month`));
    for (const feature of plan.features) assert.ok(text(byClass(tree, 'focusedPlanBenefits')[0]).includes(feature));
    const rates = byClass(tree, 'focusedPlanRates')[0];
    assert.equal(all(rates, node => node.type === 'dd').length, plan.bands.length);
    for (const band of plan.bands) assert.ok(text(rates).includes(`${formatMoney(band.rate)} / kg`));
    const status = all(tree, node => node.props?.role === 'status')[0];
    assert.equal(status.props['aria-live'], 'polite');
    assert.equal(status.props['aria-atomic'], 'true');
    assert.ok(text(status).includes(plan.name));
    assert.ok(text(status).includes(formatMoney(plan.subscription)));
  }
});

test('comparison choices reuse plan selection without submitting or navigating', () => {
  const render = catalogue();
  for (const plan of plans) {
    const choices = byClass(render(), 'focusedPlanCompareChoice');
    assert.equal(choices.length, 4);
    const choice = choices.find(node => node.props['aria-label'].startsWith(`Choose ${plan.name},`));
    assert.equal(choice.props.type, 'button');
    assert.ok(choice.props['aria-label'].includes(formatMoney(plan.subscription)));
    choice.props.onClick();
    const tree = render();
    assert.equal(text(all(byClass(tree, 'focusedPlanCard')[0], node => node.type === 'h3')[0]), plan.name);
    const selected = byClass(tree, 'focusedPlanCompareChoice').filter(node => node.props['aria-pressed']);
    assert.equal(selected.length, 1);
    assert.ok(text(selected[0]).includes(plan.name));
  }
});

test('native disclosures start closed and minimum and estimate destination stay explicit', () => {
  const tree = catalogue()();
  const disclosures = all(tree, node => node.type === 'details');
  assert.equal(disclosures.length, 3);
  assert.deepEqual(disclosures.map(node => text(all(node, child => child.type === 'summary')[0])), ['Compare all 4 plans', 'What’s included', 'Laundry rates']);
  assert.ok(disclosures.every(node => node.props.open === undefined));
  assert.equal(text(byClass(tree, 'focusedPlanMinimum')[0]), 'GHS 450.00 minimum per pickup.');
  const link = byClass(tree, 'focusedPlanEstimate')[0];
  assert.equal(link.type, 'a');
  assert.equal(link.props.href, '#estimate-heading');
  assert.equal(text(link), 'Estimate my cost ');
});

test('scoped layout uses bounded lists, full-width touch targets and no decorative shadows', () => {
  const focusedCSS = css.slice(css.indexOf('/* Accepted Commercial plans option C:'));
  assert.ok(focusedCSS.length > 0);
  for (const name of ['focusedPlanComparison', 'focusedPlanBenefits', 'focusedPlanRates']) {
    const rule = focusedCSS.match(new RegExp(`\\.${name} \\{([^}]+)\\}`))[1];
    assert.match(rule, /max-height:/);
    assert.match(rule, /overflow-y: auto/);
    assert.match(rule, /overscroll-behavior-y: auto/);
  }
  assert.match(focusedCSS, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(focusedCSS, /min-height: 48px/);
  assert.match(focusedCSS, /\.focusedPlanSegment:focus-within/);
  assert.match(focusedCSS, /@media \(forced-colors: active\)/);
  assert.doesNotMatch(focusedCSS, /(?:box-shadow|text-shadow|drop-shadow|gradient)\s*[:(]/);
});
