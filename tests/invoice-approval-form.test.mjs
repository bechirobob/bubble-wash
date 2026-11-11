import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(new URL('../src/components/InvoiceApprovalForm.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function harness() {
  let cursor = 0, effect = null, cleanup = null, oldDeps;
  const states = [], requests = [], exports = {};
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useEffect(fn, deps) { if (!oldDeps || deps.some((d, i) => d !== oldDeps[i])) { cleanup?.(); effect = fn; oldDeps = deps; } },
  };
  const element = (type, props) => ({ type, props });
  vm.runInNewContext(code, { exports, require: name => name === 'react' ? hooks : { jsx: element, jsxs: element }, AbortController,
    window: { setTimeout, clearTimeout }, fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
  let submits = 0, cancels = 0;
  const props = { orderId: 'private-order-1', pending: false, onSubmit: () => submits++, onCancel: () => cancels++ };
  const render = () => { cursor = 0; const tree = exports.InvoiceApprovalForm(props); if (effect) { const fn = effect; effect = null; cleanup = fn(); } return tree; };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { render, requests, flush, props, close: () => cleanup?.(), submitted: () => submits, cancelled: () => cancels };
}
function elements(tree) { return tree && typeof tree === 'object' ? [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)] : []; }
function input(tree, name) { return elements(tree).find(e => e.props?.name === name); }
function button(tree, label) { return elements(tree).find(e => e.type === 'button' && e.props.children === label); }
const response = invoice => ({ ok: true, json: async () => ({ invoice }) });

test('approval fetches exact invoice ID and outstanding decimal balance, blocks loading and duplicate submission', async () => {
  const h = harness(); let tree = h.render();
  assert.equal(button(tree, 'Save invoice approval').props.disabled, true);
  tree.props.onSubmit({ preventDefault() {} }); assert.equal(h.submitted(), 0);
  assert.match(h.requests[0].url, /private-order-1/); assert.equal(h.requests[0].options.cache, 'no-store');
  h.requests[0].resolve(response({ invoiceId: 'INV-actual-123', balanceMinor: 270001 })); await h.flush(); tree = h.render();
  assert.equal(input(tree, 'paymentReference').props.value, 'INV-actual-123');
  assert.equal(input(tree, 'paymentAmount').props.value, '2700.01');
  assert.equal(input(tree, 'paymentReference').props.readOnly, true);
  tree.props.onSubmit({ preventDefault() {} }); assert.equal(h.submitted(), 1);
  h.props.pending = true; tree = h.render(); tree.props.onSubmit({ preventDefault() {} }); assert.equal(h.submitted(), 1);
  h.close();
});
test('refresh cancels old read and ignores late response, showing only the current invoice', async () => {
  const h = harness(); let tree = h.render();
  button(tree, 'Refresh invoice').props.onClick(); tree = h.render();
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[1].resolve(response({ invoiceId: 'INV-new', balanceMinor: 550 })); await h.flush();
  h.requests[0].resolve(response({ invoiceId: 'INV-old', balanceMinor: 900 })); await h.flush(); tree = h.render();
  assert.equal(input(tree, 'paymentReference').props.value, 'INV-new'); h.close();
});
test('missing, paid, invalid and denied invoices never enable approval; retry recovers', async () => {
  for (const invoice of [null, { invoiceId: 'I', balanceMinor: 0 }, { invoiceId: 'I', balanceMinor: -1 }, { invoiceId: 'I', balanceMinor: 1.1 }, { invoiceId: '', balanceMinor: 100 }, { invoiceId: 'I', balanceMinor: 25000001 }]) {
    const h = harness(); h.render(); h.requests[0].resolve(response(invoice)); await h.flush();
    assert.equal(button(h.render(), 'Save invoice approval').props.disabled, true); h.close();
  }
  const h = harness(); h.render(); h.requests[0].resolve({ ok: false }); await h.flush(); let tree = h.render();
  assert.equal(button(tree, 'Save invoice approval').props.disabled, true);
  button(tree, 'Refresh invoice').props.onClick(); h.render(); h.requests[1].resolve(response({ invoiceId: 'I', balanceMinor: 100 })); await h.flush();
  assert.equal(button(h.render(), 'Save invoice approval').props.disabled, false); h.close();
});
test('cancel/unmount aborts pending reads and parent keys approval by order ID', () => {
  const h = harness(); const tree = h.render(); button(tree, 'Cancel').props.onClick(); assert.equal(h.cancelled(), 1); h.close(); assert.equal(h.requests[0].options.signal.aborted, true);
  const source = fs.readFileSync(new URL('../src/components/StaffWorkspaces.tsx', import.meta.url), 'utf8');
  assert.match(source, /InvoiceApprovalForm key=\{order.orderId\}/);
  const api = fs.readFileSync(new URL('../src/app/api/orders/advance/route.ts', import.meta.url), 'utf8');
  assert.match(api, /paymentReference !== invoice.invoiceId/); assert.match(api, /!== invoice.balanceMinor/);
});
