import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
const directory = mkdtempSync(join(tmpdir(), "bubblewash-checkout-"));
process.env.BUBBLEWASH_DATABASE_PATH = join(directory, "isolated.sqlite");
process.env.BUBBLEWASH_SESSION_SECRET = "isolated-checkout-secret-more-than-32-characters";
process.env.BUBBLEWASH_TRUST_EDGE_HEADERS = "true";
process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED = "false";
process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED = "true";
process.env.RESEND_API_KEY = "";
process.env.PAYSTACK_SECRET_KEY = "synthetic-not-a-credential";
const { NextRequest } = await import("next/server.js");
const { appendSubmissionRecord } = await import("../src/lib/data-store.ts");
const { operationalDatabase } = await import("../src/lib/operational-store.ts");
const { issueIntakeInvoice, invoiceForOrder } = await import("../src/lib/billing.ts");
const db = operationalDatabase();
const realFetch = globalThis.fetch;
let calls = 0;
let handler;
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/api\.paystack\.co\/transaction\/(initialize|verify\/)/);
  calls++;
  return handler(String(url), options);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function booking() {
  const id = `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
  appendSubmissionRecord({ id, createdAt: new Date().toISOString(), data: { submissionType: "pickup-booking", name: "Synthetic Customer", email: `${id}@example.invalid`, phone: "0200000000", company: "Synthetic Account", plan: "Weekly", zone: "core", addons: [] } });
  issueIntakeInvoice(id, 10);
  return id;
}
function legacy(id) {
  const reference = `BW-PAY-${randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`;
  appendSubmissionRecord({ id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), data: { submissionType: "checkout-request", orderId: id, paymentReference: reference, paymentAmountMinor: invoiceForOrder(id).balanceMinor, paymentCurrency: "GHS", paymentStatus: "Checkout preparing" } });
  return reference;
}
const { verifyPaymentReference } = await import("../src/lib/payment-reconciliation.ts");
const { POST: webhook } = await import("../src/app/api/payments/webhook/route.ts");
function signed(body, signature) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("https://bubblewash.co/api/payments/webhook", { method: "POST", body: raw,
    headers: { "x-paystack-signature": signature ?? createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex") } });
}
try {
  const id = booking();
  const reference = legacy(id);
  const amount = invoiceForOrder(id).balanceMinor;
  const valid = { reference, amount, currency: "GHS", status: "success", id: 1234 };
  const before = calls;
  assert.equal((await webhook(signed({ event: "charge.success", data: { reference } }, "bad"))).status, 401);
  assert.equal((await webhook(signed({ event: "charge.success", data: { reference } }, "a".repeat(128)))).status, 401);
  assert.equal((await webhook(signed("{"))).status, 400);
  assert.equal((await webhook(signed({ event: "transfer.success", data: { reference } }))).status, 200);
  assert.equal((await webhook(signed({ event: "charge.success", data: { reference: "invalid" } }))).status, 200);
  assert.equal((await webhook(signed("a".repeat(100001)))).status, 413);
  assert.equal(calls, before, "invalid and irrelevant webhooks never query the provider");
  for (const envelope of [null, [], {}, { status: "true", data: valid }, { status: 1, data: valid }, { status: false, data: valid }, { status: true, data: [] }, { status: true, data: { ...valid, status: null } }, { status: true, data: { ...valid, status: " " } }]) {
    handler = () => json(envelope);
    assert.equal((await verifyPaymentReference(reference)).status, 502);
    assert.equal(invoiceForOrder(id).balanceMinor, amount);
    assert.equal(db.prepare("SELECT count(*) AS n FROM payment_verifications WHERE reference = ?").get(reference).n, 0);
  }
  for (const change of [{ reference: "different" }, { amount: amount + 1 }, { amount: String(amount) }, { currency: "USD" }]) {
    handler = () => json({ status: true, data: { ...valid, ...change } });
    assert.equal((await verifyPaymentReference(reference)).status, 409);
    assert.equal(invoiceForOrder(id).balanceMinor, amount);
  }
  handler = () => json({ status: true, data: { ...valid, status: "pending" } });
  assert.equal((await (await verifyPaymentReference(reference)).json()).payment.paid, false);
  assert.equal(invoiceForOrder(id).balanceMinor, amount);
  handler = () => json({ status: true, data: valid });
  const event = { event: "charge.success", data: { reference, amount: 1, currency: "USD" } };
  assert.equal((await webhook(signed(event))).status, 200, "signed event contents do not bypass authoritative verification");
  assert.equal((await webhook(signed(event))).status, 200);
  assert.equal((await verifyPaymentReference(reference)).status, 200);
  assert.equal(invoiceForOrder(id).balanceMinor, 0);
  assert.equal(invoiceForOrder(id).entries.length, 1, "duplicate webhook and browser callback settle once");
  handler = () => json({ status: true, data: { ...valid, status: "failed" } });
  assert.equal((await (await verifyPaymentReference(reference)).json()).payment.paid, true);
  assert.equal(invoiceForOrder(id).entries.length, 1);
  console.log("Payment verification: 9 malformed envelopes, 4 mismatches, 6 rejected/ignored webhook scenarios, pending-to-success, duplicate webhook/callback and late-failure settlement checks passed. Synthetic fetch only.");
} finally {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
