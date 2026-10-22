import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
const { encodeCustomerSession, customerSessionCookieName } = await import("../src/lib/customer-session.ts");
const { POST } = await import("../src/app/api/payments/initialize/route.ts");
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
const success = (_url, options) => json({ status: true, data: { reference: JSON.parse(options.body).reference, authorization_url: "https://checkout.paystack.com/synthetic", access_code: "synthetic" } });
function booking() {
  const id = `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
  appendSubmissionRecord({ id, createdAt: new Date().toISOString(), data: { submissionType: "pickup-booking", name: "Synthetic Customer", email: `${id}@example.invalid`, phone: "0200000000", company: "Synthetic Account", plan: "Weekly", zone: "core", addons: [] } });
  issueIntakeInvoice(id, 10);
  return id;
}
function request(id) {
  return new NextRequest("https://bubblewash.co/api/payments/initialize", { method: "POST", headers: { host: "bubblewash.co", origin: "https://bubblewash.co", "content-type": "application/json", "cf-connecting-ip": randomUUID(), cookie: `${customerSessionCookieName}=${encodeCustomerSession(id, `${id}@example.invalid`, true)}` }, body: JSON.stringify({ orderId: id }) });
}
function latest(id) { return JSON.parse(db.prepare("SELECT data FROM submissions WHERE json_extract(data, '$.submissionType') = 'checkout-request' AND json_extract(data, '$.orderId') = ? ORDER BY rowid DESC LIMIT 1").get(id).data); }
function noLock(id) { assert.equal(db.prepare("SELECT 1 FROM payment_initialization_locks WHERE order_id = ?").get(id), undefined); }
function legacy(id) {
  const reference = `BW-PAY-${randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`;
  appendSubmissionRecord({ id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), data: { submissionType: "checkout-request", orderId: id, paymentReference: reference, paymentAmountMinor: invoiceForOrder(id).balanceMinor, paymentCurrency: "GHS", paymentStatus: "Checkout preparing" } });
  return reference;
}
try {
  let id = booking();
  delete process.env.PAYSTACK_SECRET_KEY;
  assert.equal((await POST(request(id))).status, 503);
  assert.equal(calls, 0); noLock(id);
  assert.equal(latest(id).paymentStatus, "Checkout initialization failed");
  process.env.PAYSTACK_SECRET_KEY = "synthetic-not-a-credential";
  handler = success;
  assert.equal((await POST(request(id))).status, 200);
  let before = calls;
  assert.equal((await POST(request(id))).status, 200);
  assert.equal(calls, before, "successful checkout is reused"); noLock(id);

  id = booking();
  handler = () => json({ status: false, message: "Invalid billing email" }, 400);
  assert.equal((await POST(request(id))).status, 502); noLock(id);
  assert.equal(latest(id).paymentStatus, "Checkout initialization failed");
  handler = success; assert.equal((await POST(request(id))).status, 200);

  id = booking();
  handler = () => { throw new Error("Synthetic timeout"); };
  assert.equal((await POST(request(id))).status, 502); noLock(id);
  const uncertain = latest(id);
  assert.equal(uncertain.paymentStatus, "Checkout reconciliation required");
  handler = (url) => { assert.match(url, /verify\//); return json({ status: false, message: "Transaction not found" }, 404); };
  assert.equal((await POST(request(id))).status, 409);
  assert.equal(latest(id).paymentReference, uncertain.paymentReference, "unknown outcome never starts a second charge");
  handler = () => json({ status: true, data: { reference: uncertain.paymentReference, amount: uncertain.paymentAmountMinor, currency: "GHS", status: "success" } });
  assert.equal((await POST(request(id))).status, 409);
  assert.equal(invoiceForOrder(id).balanceMinor, 0, "reconciliation records settlement"); noLock(id);

  id = booking();
  let release;
  handler = (url, options) => new Promise((resolve) => { release = () => resolve(success(url, options)); });
  const pending = POST(request(id));
  await new Promise((resolve) => setImmediate(resolve));
  before = calls;
  assert.equal((await POST(request(id))).status, 409);
  assert.equal(calls, before, "concurrent request cannot initialize twice");
  release(); assert.equal((await pending).status, 200); noLock(id);

  id = booking();
  db.prepare("INSERT INTO payment_initialization_locks VALUES (?, ?)").run(id, new Date(Date.now() - 120_000).toISOString());
  handler = success;
  assert.equal((await POST(request(id))).status, 200, "orphan stale lock can be recovered"); noLock(id);

  id = booking();
  const ref = legacy(id);
  const amount = invoiceForOrder(id).balanceMinor;
  handler = (url, options) => url.includes("verify/") ? json({ status: true, data: { reference: ref, amount, currency: "GHS", status: "failed" } }) : success(url, options);
  assert.equal((await POST(request(id))).status, 200, "legacy pending request retries only after verified terminal failure");

  id = booking();
  handler = (url, options) => {
    db.prepare("UPDATE payment_initialization_locks SET created_at = ? WHERE order_id = ?").run("replacement-owner", id);
    return success(url, options);
  };
  assert.equal((await POST(request(id))).status, 502);
  assert.equal(db.prepare("SELECT created_at FROM payment_initialization_locks WHERE order_id = ?").get(id).created_at, "replacement-owner", "expired worker cannot release a new owner's lock");
  assert.equal(latest(id).authorizationUrl, undefined);

  id = booking();
  db.exec("CREATE TRIGGER reject_checkout_insert BEFORE INSERT ON submissions WHEN json_extract(NEW.data, '$.submissionType') = 'checkout-request' BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END");
  before = calls; handler = success;
  assert.equal((await POST(request(id))).status, 502); noLock(id);
  assert.equal(calls, before, "provider is never called before durable preparation");
  db.exec("DROP TRIGGER reject_checkout_insert");
  assert.equal((await POST(request(id))).status, 200);

  id = booking();
  db.exec("CREATE TRIGGER reject_checkout_update BEFORE UPDATE ON submissions WHEN json_extract(NEW.data, '$.paymentStatus') = 'Checkout initialized' BEGIN SELECT RAISE(ABORT, 'synthetic final persistence failure'); END");
  handler = success;
  assert.equal((await POST(request(id))).status, 502); noLock(id);
  const interrupted = latest(id);
  db.exec("DROP TRIGGER reject_checkout_update");
  handler = (url) => { assert.match(url, /verify\//); return json({ status: false, message: "Transaction not found" }, 404); };
  assert.equal((await POST(request(id))).status, 409);
  assert.equal(latest(id).paymentReference, interrupted.paymentReference, "post-provider storage failure must not allow another charge");

  for (const value of [null, {}, { status: "true", data: {} }, { status: true, data: { reference: "wrong", authorization_url: "https://evil.example/checkout" } }, { status: true, data: { reference: "wrong", authorization_url: "https://checkout.paystack.com/synthetic" } }]) {
    id = booking(); handler = () => json(value);
    assert.equal((await POST(request(id))).status, 502); noLock(id);
    assert.equal(latest(id).paymentStatus, "Checkout reconciliation required");
  }
  id = booking();
  legacy(id);
  appendSubmissionRecord({ id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), data: { submissionType: "checkout-request", orderId: id, paymentReference: "BW-PAY-NEWERLEGACY123", paymentAmountMinor: invoiceForOrder(id).balanceMinor, authorizationUrl: "https://checkout.paystack.com/synthetic", paymentStatus: "Checkout initialized" } });
  handler = (url) => { assert.match(url, /verify\//); return json({ status: false, message: "Transaction not found" }, 404); };
  assert.equal((await POST(request(id))).status, 409, "a newer usable URL cannot hide an older unresolved attempt");

  id = booking(); handler = () => json({ status: false, message: "Duplicate reference" }, 400);
  assert.equal((await POST(request(id))).status, 502);
  assert.equal(latest(id).paymentStatus, "Checkout reconciliation required");
  console.log("Checkout regression cases passed: provider rejection, missing config, timeout, reconciliation, concurrent retry, duplicate prevention, stale lock, legacy recovery, malformed responses and persistence failures. No external calls.");
} finally {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
