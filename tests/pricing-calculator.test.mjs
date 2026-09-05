import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { plans, zones, addons, calculateQuote } from '../src/lib/pricing.ts';

// Exercise the component's edit and submit handlers without a browser dependency.
function calculator({ deferred = false } = {}) {
  const slots = [];
  const requests = [];
  const responses = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useMemo: fn => fn(),
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/link': { default: 'a' },
    'lucide-react': { Calculator: 'icon', CalendarPlus: 'icon', BadgeCheck: 'icon' },
    '@/lib/pricing': { plans, zones, addons },
    '@/lib/public-ui': {
      formatMoney: value => `GHS ${value}`,
      postJSON: async (url, payload) => {
        requests.push({ url, payload });
        const result = { ok: true, quote: calculateQuote(payload.plan, payload.kg, payload.addons, payload.zone) };
        if (deferred) return new Promise(resolve => responses.push(() => resolve(result)));
        return result;
      },
    },
  };
  function loadComponent(file) {
    const source = readFileSync(new URL(`../src/components/${file}.tsx`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
    const exports = {};
    vm.runInNewContext(outputText, { exports, URLSearchParams, require: name => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    } });
    return exports;
  }
  modules['@/components/PlanCatalogue'] = loadComponent('PlanCatalogue');
  const { PricingCalculator } = loadComponent('PricingCalculator');
  const render = () => { cursor = 0; return PricingCalculator({ initialPlan: 'Weekly', showCatalogue: true }); };
  const find = (node, match) => {
    if (!node || typeof node !== 'object') return;
    if (match(node)) return node;
    if (typeof node.type === 'function') return find(node.type(node.props), match);
    for (const child of [node.props?.children].flat(Infinity)) {
      const found = find(child, match);
      if (found) return found;
    }
  };
  return {
    requests,
    responses,
    select: name => find(render(), n => n.type === 'input' && n.props.type === 'radio' && n.props.value === name),
    plan: () => find(render(), n => n.type === 'select' && plans.some(p => p.name === n.props.value)),
    extra: () => find(render(), n => n.type === 'input' && n.props.type === 'checkbox'),
    total: () => find(render(), n => n.props?.className === 'quotePeriod').props.children,
    weight: () => find(render(), n => n.type === 'input' && n.props.type === 'number'),
    submit: () => find(render(), n => n.type === 'form').props.onSubmit({ preventDefault() {} }),
  };
}

test('weight can be completely erased and replaced without an inserted zero', async () => {
  const view = calculator();
  for (const value of ['6', '', '2', '25', '250']) {
    view.weight().props.onChange({ target: { value } });
    assert.equal(view.weight().props.value, value);
  }
  await view.submit();
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].payload.kg, 250);
  assert.equal(typeof view.requests[0].payload.kg, 'number');
});

test('blank weights never request a quote, and decimal editing preserves precision', async () => {
  const view = calculator();
  view.weight().props.onChange({ target: { value: '' } });
  assert.equal(view.weight().props.required, true);
  await view.submit();
  assert.equal(view.requests.length, 0);
  for (const value of ['6', '60', '60.', '60.5']) {
    view.weight().props.onChange({ target: { value } });
    assert.equal(view.weight().props.value, value);
  }
  await view.submit();
  assert.equal(view.requests[0].payload.kg, 60.5);
});


test('catalogue and calculator stay aligned while weight and extras survive plan changes', async () => {
  const view = calculator();
  view.weight().props.onChange({ target: { value: '60.5' } });
  view.extra().props.onChange();
  await view.submit();
  assert.equal(view.total(), 'estimated monthly total');
  view.select('Twice weekly').props.onChange();
  assert.equal(view.select('Twice weekly').props.checked, true);
  assert.equal(view.select('Weekly').props.checked, false);
  assert.equal(view.plan().props.value, 'Twice weekly');
  assert.equal(view.weight().props.value, '60.5');
  assert.equal(view.extra().props.checked, true);
  assert.equal(view.total(), 'monthly service fee, before processing');
  await view.submit();
  assert.equal(view.requests.at(-1).payload.plan, 'Twice weekly');
  assert.equal(view.requests.at(-1).payload.kg, 60.5);
  assert.equal(view.requests.at(-1).payload.addons.length, 1);
  view.plan().props.onChange({ target: { value: 'Contract' } });
  assert.equal(view.select('Contract').props.checked, true);
  assert.equal(view.total(), 'monthly service fee, before processing');
});

test('changing a plan discards an in-flight estimate for the previous plan', async () => {
  const view = calculator({ deferred: true });
  const pending = view.submit();
  view.select('Contract').props.onChange();
  view.responses[0]();
  await pending;
  assert.equal(view.plan().props.value, 'Contract');
  assert.equal(view.total(), 'monthly service fee, before processing');
});
