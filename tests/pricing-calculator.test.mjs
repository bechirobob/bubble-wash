import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { plans, zones, addons, calculateQuote } from '../src/lib/pricing.ts';

// Exercise the component's edit and submit handlers without a browser dependency.
function calculator() {
  const slots = [];
  const requests = [];
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
    'lucide-react': { Calculator: 'icon', CalendarPlus: 'icon' },
    '@/lib/pricing': { plans, zones, addons },
    '@/lib/public-ui': {
      formatMoney: value => `GHS ${value}`,
      postJSON: async (url, payload) => {
        requests.push({ url, payload });
        return { ok: true, quote: calculateQuote(payload.plan, payload.kg, payload.addons, payload.zone) };
      },
    },
  };
  const source = readFileSync(new URL('../src/components/PricingCalculator.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  vm.runInNewContext(outputText, { exports, require: name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const render = () => { cursor = 0; return exports.PricingCalculator({ initialPlan: 'Weekly' }); };
  const find = (node, match) => {
    if (!node || typeof node !== 'object') return;
    if (match(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const found = find(child, match);
      if (found) return found;
    }
  };
  return {
    requests,
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
