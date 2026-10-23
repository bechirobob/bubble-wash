import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPaymentCallback, paidCallbackUrl, paymentCallbackStillCurrent } from "../src/lib/payment-callback.ts";

test("paid callback removes only its payment reference", () => {
  assert.equal(paidCallbackUrl("https://bubblewash.co/book?plan=Weekly&payment_reference=BW-PAY-123#status"), "/book?plan=Weekly#status");
});
test("callback verification supports retry after uncertain and pending outcomes", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const responses = [null, { ok: true, payment: { paid: false, status: "pending", amountGhs: 100 } }, { ok: true, payment: { paid: true, status: "success", amountGhs: 100 } }];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/payments/verify?reference=BW-PAY-123");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal);
    const body = responses[calls++];
    if (!body) throw new Error("synthetic timeout");
    return new Response(JSON.stringify(body));
  };
  try {
    await assert.rejects(checkPaymentCallback("BW-PAY-123"));
    assert.equal((await checkPaymentCallback("BW-PAY-123")).paid, false);
    assert.match((await checkPaymentCallback("BW-PAY-123")).message, /Payment verified/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
test("malformed callback payloads never show a paid result", async () => {
  const original = globalThis.fetch;
  try {
    for (const body of [null, {}, { ok: "true" }, { ok: true, payment: { paid: "false" } }, { ok: true, payment: { paid: true, status: "success", amountGhs: "100" } }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body));
      await assert.rejects(checkPaymentCallback("BW-PAY-123"));
    }
  } finally { globalThis.fetch = original; }
});

test("stale, cancelled and changed-reference results cannot alter navigation", () => {
  const href = "https://bubblewash.co/book?payment_reference=OLD";
  const controller = new AbortController();
  assert.equal(paymentCallbackStillCurrent("OLD", href, href, controller.signal), true);
  for (const changed of ["https://bubblewash.co/manage", "https://bubblewash.co/book?payment_reference=NEW"]) {
    assert.equal(paymentCallbackStillCurrent("OLD", href, changed, controller.signal), false);
  }
  assert.equal(paymentCallbackStillCurrent("NEW", href, href, controller.signal), false);
  assert.equal(paymentCallbackStillCurrent("OLD", href, href + "&plan=Weekly#new", controller.signal), true);
  controller.abort();
  assert.equal(paymentCallbackStillCurrent("OLD", href, href, controller.signal), false);
});
test("callback forwards cancellation to the request", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal.aborted, false);
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new DOMException("Cancelled", "AbortError");
  };
  try { await assert.rejects(checkPaymentCallback("OLD", controller.signal), {name: "AbortError"}); }
  finally { globalThis.fetch = original; }
});
