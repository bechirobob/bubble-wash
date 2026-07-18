import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

process.env.BUBBLEWASH_DATABASE_PATH = path.join(process.cwd(), "data", `submissions-${randomUUID()}.sqlite`);

const { buildOrderSummaries, orderBoardRecords } = await import("../src/lib/submissions.ts");

const booking = {
  id: "BW-PROJECTION-1",
  createdAt: "2026-07-18T08:00:00.000Z",
  data: {
    submissionType: "pickup-booking",
    name: "Ama Customer",
    company: "Ama Hotel",
    email: "ama@example.com",
    phone: "0550000000",
    area: "Osu",
    pickupAddress: "14 Oxford Street, Osu",
    landmark: "Main reception",
    pickupWindow: "Morning pickup",
    paymentPreference: "Bank transfer",
  },
};
const washing = {
  id: "BW-PROJECTION-2",
  createdAt: "2026-07-18T09:00:00.000Z",
  data: {
    submissionType: "vendor-job-update",
    orderId: booking.id,
    name: "Vendor Partner",
    email: "vendor@bubblewash.local",
    phone: "operations-line",
    jobStatus: "Washing started",
    message: "Production started.",
  },
};
const support = {
  id: "BW-PROJECTION-3",
  createdAt: "2026-07-18T09:10:00.000Z",
  data: {
    submissionType: "support-ticket-action",
    orderId: booking.id,
    name: "Support Agent",
    email: "support@bubblewash.local",
    ticketStatus: "Resolved",
    priority: "High",
  },
};
const payment = {
  id: "BW-PROJECTION-4",
  createdAt: "2026-07-18T09:20:00.000Z",
  data: {
    submissionType: "payment-update",
    orderId: booking.id,
    email: "payments@bubblewash.local",
    paymentStatus: "success",
  },
};
const laterSupport = {
  id: "BW-PROJECTION-5",
  createdAt: "2026-07-18T09:30:00.000Z",
  data: {
    submissionType: "support-ticket-action",
    orderId: booking.id,
    name: "Support Agent",
    email: "support@bubblewash.local",
    paymentPreference: "Bank transfer",
    ticketStatus: "Waiting on Customer",
  },
};

const summary = buildOrderSummaries([booking, washing, support, payment, laterSupport])[0];
assert.equal(summary.workflowStage.key, "washing");
assert.equal(summary.status, "Washing started");
assert.equal(summary.updatedAt, washing.createdAt);
assert.equal(summary.activityUpdatedAt, laterSupport.createdAt);
assert.equal(summary.email, "ama@example.com");
assert.equal(summary.phone, "0550000000");
assert.equal(summary.pickupAddress, "14 Oxford Street, Osu");
assert.equal(summary.payment, "success");
assert.equal(orderBoardRecords([booking, washing, support, payment, laterSupport], "support").length, 5);

console.log(JSON.stringify({ ok: true, checks: 10 }));
