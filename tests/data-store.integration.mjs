import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

process.env.BUBBLEWASH_DATABASE_PATH = path.join(process.cwd(), "data", `data-store-${randomUUID()}.sqlite`);

const store = await import("../src/lib/data-store.ts");
store.resetDataStoreForTests();

assert.equal(store.consumeRateLimit("pilot:test", 2, 60_000).limited, false);
assert.equal(store.consumeRateLimit("pilot:test", 2, 60_000).limited, false);
assert.equal(store.consumeRateLimit("pilot:test", 2, 60_000).limited, true);

const claim = {
  claimKey: "BW-TEST:assign:2026-07-17T00:00:00.000Z",
  orderId: "BW-TEST",
  actionKey: "admin-assign-vendor",
  orderUpdatedAt: "2026-07-17T00:00:00.000Z",
};
assert.equal(store.claimWorkflowAction(claim), true);
assert.equal(store.claimWorkflowAction(claim), false);
store.releaseWorkflowActionClaim(claim.claimKey);
assert.equal(store.claimWorkflowAction(claim), true);

const checkout = {
  id: "BW-CHECKOUT-TEST",
  createdAt: "2026-07-17T00:00:00.000Z",
  source: "test",
  data: {
    submissionType: "checkout-request",
    paymentReference: "BW-PAY-TEST",
    paymentAmountMinor: 12500,
    amount: "GHS 125.00",
  },
};
store.appendSubmissionRecord(checkout);
assert.equal(store.findCheckoutByPaymentReference("BW-PAY-TEST")?.id, checkout.id);
assert.equal(store.findSubmissionRecordById(checkout.id)?.data.paymentReference, "BW-PAY-TEST");
assert.equal(store.findSubmissionRecordById("BW-MISSING"), null);

const verification = {
  id: "BW-VERIFY-TEST",
  createdAt: "2026-07-17T00:01:00.000Z",
  source: "test",
  data: { submissionType: "payment-update", orderId: checkout.id, paymentStatus: "success" },
};
const verificationInput = {
  record: verification,
  reference: "BW-PAY-TEST",
  status: "success",
  transactionId: "90071992547409930",
  amountMinor: 12500,
  currency: "GHS",
};
assert.equal(store.appendPaymentVerificationOnce(verificationInput), true);
assert.equal(store.appendPaymentVerificationOnce({ ...verificationInput, record: { ...verification, id: "BW-VERIFY-DUPLICATE" } }), false);
assert.equal(store.readSubmissionRecords(10).length, 2);
for (let index = 0; index < 510; index += 1) {
  store.appendSubmissionRecord({
    id: `BW-FILLER-${String(index).padStart(4, "0")}`,
    createdAt: `2026-07-18T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
    source: "test",
    data: { submissionType: "support-ticket", message: "Unrelated record" },
  });
}
assert.equal(store.readSubmissionRecords(500).some((record) => record.id === checkout.id), false);
const exactOrderRecords = store.readSubmissionRecordsForOrder(checkout.id);
assert.deepEqual(new Set(exactOrderRecords.map((record) => record.id)), new Set([checkout.id, verification.id]));
assert.equal(store.readSubmissionRecordsForOrder(checkout.id.toLowerCase()).length, 2);
assert.deepEqual(store.readSubmissionRecordsForOrder(""), []);
assert.equal(store.databaseReadiness(), true);

console.log(JSON.stringify({ ok: true, checks: 19 }));
