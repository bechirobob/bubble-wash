import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { readPricingHistory, withPricingHistory } from '../src/lib/pricing-history.ts';
import { plans, zones, addons, calculateQuote } from '../src/lib/pricing.ts';

// Exercise the component's edit and submit handlers without a browser dependency.
function calculator({ deferred = false, hydrated = true, available = true, initialHistory = null } = {}) {
  const browser = { location: { pathname: "/services", search: "?plan=Weekly" }, history: { state: initialHistory, replaceState(state) { this.state = state; } }, requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} };
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
    useEffect(callback) { const index = cursor++; if (!slots[index]) { slots[index] = true; callback(); } },
    useMemo: fn => fn(),
    useSyncExternalStore: (_subscribe, clientReady, serverReady) => hydrated ? clientReady() : serverReady(),
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/link': { default: 'a' },
    'lucide-react': { Calculator: 'icon', CalendarPlus: 'icon', BadgeCheck: 'icon', ArrowRight: 'icon', CalendarDays: 'icon', ChevronDown: 'icon', Info: 'icon' },
    '@/lib/pricing': { plans, zones, addons },
    '@/lib/pricing-history': { readPricingHistory, withPricingHistory },
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
    vm.runInNewContext(outputText, { exports, URLSearchParams, window: browser, require: name => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    } });
    return exports;
  }
  modules['@/components/PlanCatalogue'] = loadComponent('PlanCatalogue');
  const { PricingCalculator } = loadComponent('PricingCalculator');
  const render = () => { cursor = 0; PricingCalculator({ initialPlan: 'Weekly', showCatalogue: true, available }); cursor = 0; return PricingCalculator({ initialPlan: 'Weekly', showCatalogue: true, available }); };
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
    history: browser.history,
    bookingLink: () => find(render(), n => n.type === "a" && n.props.href?.startsWith("/book?")),
    responses,
    render,
    find,
    hydrate: () => { hydrated = true; },
    form: () => find(render(), n => n.type === "form"),
    zone: () => find(render(), n => n.type === "select" && Object.hasOwn(zones, n.props.value)),
    submitButton: () => find(render(), n => n.type === "button" && n.props.type === "submit"),
    select: name => find(render(), n => n.type === 'input' && n.props.type === 'radio' && n.props.value === name),
    compare: name => find(render(), n => n.type === 'input' && n.props.name === 'comparison-plan' && n.props['aria-label'].startsWith(`Choose ${name},`)),
    plan: () => find(render(), n => n.type === 'select' && plans.some(p => p.name === n.props.value)),
    extra: () => find(render(), n => n.type === 'input' && n.props.type === 'checkbox'),
    addon: label => find(render(), n => n.type === 'label' && n.props.className === 'checkOption' && JSON.stringify(n.props.children).includes(label)).props.children[0],
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

test('comparison selection preserves calculator inputs and discards an old in-flight estimate', async () => {
  const view = calculator({ deferred: true });
  view.weight().props.onChange({ target: { value: '60.5' } });
  view.extra().props.onChange();
  const pending = view.submit();
  view.compare('Three times weekly').props.onChange();
  assert.equal(view.select('Three times weekly').props.checked, true);
  assert.equal(view.plan().props.value, 'Three times weekly');
  assert.equal(view.weight().props.value, '60.5');
  assert.equal(view.extra().props.checked, true);
  assert.equal(view.requests.length, 1, 'choosing a comparison plan must not submit a quote');
  view.responses[0]();
  await pending;
  assert.equal(view.total(), 'monthly service fee, before processing');
  const next = view.submit();
  assert.equal(view.requests.at(-1).payload.plan, 'Three times weekly');
  assert.equal(view.requests.at(-1).payload.kg, 60.5);
  assert.equal(view.requests.at(-1).payload.addons.length, 1);
  view.responses[1]();
  await next;
  assert.equal(view.total(), 'estimated monthly total');
});


test('server-rendered pricing controls remain disabled until handlers are ready', async () => {
  const view = calculator({ hydrated: false });
  assert.equal(view.form().props['aria-busy'], true);
  for (const control of [view.weight(), view.plan(), view.zone(), view.extra(), view.submitButton(), ...plans.flatMap(plan => [view.select(plan.name), view.compare(plan.name)])]) {
    assert.equal(control.props.disabled, true);
  }
  await view.submit();
  assert.equal(view.requests.length, 0);
  view.hydrate();
  assert.equal(view.form().props['aria-busy'], false);
  for (const control of [view.weight(), view.plan(), view.zone(), view.extra(), view.submitButton(), ...plans.flatMap(plan => [view.select(plan.name), view.compare(plan.name)])]) {
    assert.equal(control.props.disabled, false);
  }
  view.weight().props.onChange({ target: { value: '60.5' } });
  view.extra().props.onChange();
  view.compare('Twice weekly').props.onChange();
  assert.equal(view.weight().props.value, '60.5');
  assert.equal(view.extra().props.checked, true);
  await view.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(view.requests[0].payload)), { plan: 'Twice weekly', kg: 60.5, addons: ['ironing'], zone: 'core', discount: 'none' });
});


test('custom route estimate never presents the zero placeholder as free delivery', async () => {
  const view = calculator({ available: false });
  view.zone().props.onChange({ target: { value: 'custom' } });
  await view.submit();
  assert.equal(view.total(), 'monthly estimate excluding custom delivery');
  const tree = JSON.stringify(view.render());
  assert.match(tree, /To be confirmed/);
  assert.match(tree, /Custom delivery is not included/);
  assert.match(tree, /Check pickup availability/);
  assert.doesNotMatch(tree, /Continue to booking/);
});


test('occasional selections remain requested but are clearly excluded from monthly totals', async () => {
  const view = calculator();
  view.addon('Weekend pickup / delivery').props.onChange();
  view.addon('Extra unscheduled pickup').props.onChange();
  await view.submit();
  assert.deepEqual(Array.from(view.requests[0].payload.addons), ['weekend', 'extraPickup']);
  const tree = JSON.stringify(view.render());
  assert.match(tree, /Quoted separately, not included above/);
  assert.match(tree, /GHS 75/);
  assert.match(tree, /GHS 90/);
  assert.match(tree, /actual load, route/);
  view.addon('Premium wash + iron + fold').props.onChange();
  view.addon('Ironing').props.onChange();
  assert.equal(view.addon('Premium wash + iron + fold').props.checked, false);
  view.addon('Premium wash + iron + fold').props.onChange();
  assert.equal(view.addon('Ironing').props.checked, false);
});


test('minimum adjustment displays the rounded domain value, never floating-point negative zero', async () => {
  const view = calculator();
  view.weight().props.onChange({ target: { value: '100.03' } });
  view.extra().props.onChange();
  await view.submit();
  const row = view.find(view.render(), n => n.type === 'div' && Array.isArray(n.props.children) && n.props.children[0]?.props?.children === 'Minimum adjustment per pickup');
  assert.equal(row.props.children[1].props.children, 'GHS 0');
});


test('booking navigation saves only estimate choices in the current history entry and Back restores without quoting', async () => {
  const nextState = { __NA: true, tree: ['preserved-next-tree'], unrelated: 'keep' };
  const view = calculator({ initialHistory: nextState });
  view.plan().props.onChange({ target: { value: 'Twice weekly' } });
  view.weight().props.onChange({ target: { value: '60.5' } });
  view.zone().props.onChange({ target: { value: Object.keys(zones).find(key => key !== 'core') } });
  view.extra().props.onChange();
  await view.submit();
  view.bookingLink().props.onClick();
  assert.equal(view.history.state.__NA, true);
  assert.equal(view.history.state.tree, nextState.tree);
  assert.equal(view.history.state.unrelated, 'keep');
  const returned = calculator({ initialHistory: view.history.state });
  assert.equal(returned.plan().props.value, 'Twice weekly');
  assert.equal(returned.weight().props.value, '60.5');
  assert.equal(returned.zone().props.value, Object.keys(zones).find(key => key !== 'core'));
  assert.equal(returned.extra().props.checked, true);
  assert.equal(returned.requests.length, 0);
  assert.equal(returned.bookingLink(), undefined, 'saved estimates are not restored as fresh quotes');
});
