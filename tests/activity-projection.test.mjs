import test from "node:test";
import assert from "node:assert/strict";
import { projectStaffActivityRecord } from "../src/lib/staff-activity-projection.ts";

const source = {
  id: "BW-ACTIVITY-PRIVACY",
  createdAt: "2026-07-18T12:00:00.000Z",
  source: "bubblewash-workflow-automation",
  data: {
    submissionType: "vendor-job-update",
    orderId: "BW-ORDER-001",
    name: "Vendor Operator",
    company: "Clean Laundry",
    vendorName: "Clean Laundry",
    driverName: "Route Rider",
    jobStatus: "Ready for driver",
    orderStatus: "Delivered",
    area: "Osu",
    routeWindow: "14:00–16:00",
    qrTag: "BW-ORDER-001-BAG",
    bagCount: "4",
    receivedWeightKg: "12.50 kg",
    intakeCondition: "Count and condition matched",
    qualityCheck: "Count, finish, and packaging checked",
    intakeNote: "Checked with ama@example.com at 0550000000.",
    handoffNote: "Four bags handed over at 14 Oxford Street, Osu.",
    phone: "0550000000",
    email: "ama@example.com",
    pickupAddress: "14 Oxford Street, Osu",
    landmark: "Main reception",
    paymentPreference: "Bank transfer",
    paymentReference: "PAY-SECRET-001",
    paymentAmount: "GHS 250.00",
    googleMapsUrl: "https://maps.example/customer",
    directionsUrl: "https://maps.example/directions",
    message: "Customer ama@example.com on 0550000000 paid by Bank transfer at 14 Oxford Street, Osu.",
    unknownInternalField: "must not cross the API boundary",
    serviceZones: ["Osu", "Labone"],
  },
};

const forbiddenKeys = [
  "phone",
  "email",
  "pickupAddress",
  "landmark",
  "paymentPreference",
  "paymentReference",
  "paymentAmount",
  "googleMapsUrl",
  "directionsUrl",
  "unknownInternalField",
];

function assertStrictOperationalProjection(projected) {
  for (const key of forbiddenKeys) assert.equal(Object.hasOwn(projected.data, key), false, `${key} must be removed`);
  const serialized = JSON.stringify(projected);
  for (const secret of ["0550000000", "ama@example.com", "14 Oxford Street, Osu", "Main reception", "Bank transfer", "PAY-SECRET-001", "https://maps.example/customer"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not survive projection`);
  }
}

test("vendor activity uses a strict allowlist and retains safe production evidence", () => {
  const projected = projectStaffActivityRecord(source, "vendor");

  assertStrictOperationalProjection(projected);
  assert.equal(projected.data.jobStatus, "Ready for driver");
  assert.equal(projected.data.qrTag, "BW-ORDER-001-BAG");
  assert.equal(projected.data.bagCount, "4");
  assert.equal(projected.data.receivedWeightKg, "12.50 kg");
  assert.equal(projected.data.intakeCondition, "Count and condition matched");
  assert.equal(projected.data.qualityCheck, "Count, finish, and packaging checked");
  assert.equal(projected.data.message, "Vendor production update recorded.");
  assert.equal(String(projected.data.intakeNote), "Checked with [redacted] at [redacted].");
});

test("driver activity uses a strict allowlist and retains safe route evidence", () => {
  const projected = projectStaffActivityRecord({
    ...source,
    data: { ...source.data, submissionType: "driver-route-log", routeCheckpoint: "Airport junction", driverEta: "15:20", recipientName: "Ama Mensah" },
  }, "driver");

  assertStrictOperationalProjection(projected);
  assert.equal(projected.data.orderStatus, "Delivered");
  assert.equal(projected.data.routeCheckpoint, "Airport junction");
  assert.equal(projected.data.driverEta, "15:20");
  assert.equal(projected.data.recipientName, "Ama Mensah");
  assert.equal(projected.data.message, "Driver route checkpoint recorded.");
  assert.match(String(projected.data.handoffNote), /\[redacted\]/);
});

test("support retains support contact and case context but drops unrelated fields", () => {
  const projected = projectStaffActivityRecord({
    ...source,
    data: {
      ...source.data,
      submissionType: "support-ticket-action",
      ticketId: "BW-CASE-001",
      issueType: "Payment issue",
      ticketStatus: "Waiting on Customer",
      contactChannel: "Phone call",
      contactOutcome: "Message left",
      nextFollowUpAt: "2026-07-19T10:00",
    },
  }, "support");

  assert.equal(projected.data.phone, "0550000000");
  assert.equal(projected.data.email, "ama@example.com");
  assert.equal(projected.data.ticketId, "BW-CASE-001");
  assert.equal(projected.data.ticketStatus, "Waiting on Customer");
  assert.equal(projected.data.contactOutcome, "Message left");
  assert.equal(projected.data.message, source.data.message);
  assert.equal(Object.hasOwn(projected.data, "pickupAddress"), false);
  assert.equal(Object.hasOwn(projected.data, "googleMapsUrl"), false);
  assert.equal(Object.hasOwn(projected.data, "unknownInternalField"), false);
});

test("admin receives a full deep clone and projections never mutate their source", () => {
  const snapshot = structuredClone(source);
  const admin = projectStaffActivityRecord(source, "admin");
  const vendor = projectStaffActivityRecord(source, "vendor");

  assert.deepEqual(admin, source);
  assert.notEqual(admin, source);
  assert.notEqual(admin.data, source.data);
  assert.notEqual(admin.data.serviceZones, source.data.serviceZones);
  admin.data.serviceZones.push("Airport");
  vendor.data.serviceZones.push("Cantonments");
  assert.deepEqual(source, snapshot);
});
