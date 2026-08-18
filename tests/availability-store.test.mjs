import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BUBBLEWASH_DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "bubblewash-availability-")), "test.sqlite");

const store = await import("../src/lib/availability-store.ts");
const assignment = await import("../src/lib/assignment.ts");
const services = await import("../src/lib/service-capabilities.ts");

test("service selections preserve combined capabilities instead of splitting on plus signs", () => {
  assert.deepEqual(services.parseServiceTypes("Wash + fold"), ["Wash + fold"]);
  assert.deepEqual(services.parseServiceTypes("Wash + iron + fold"), ["Wash + iron + fold"]);
  assert.deepEqual(services.parseServiceTypes("Wash + fold, Ironing only"), ["Wash + fold", "Ironing only"]);
});

test("a normally submitted Wash + fold capability is eligible for assignment", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({
    vendorId: "vendor-service-parser",
    vendorName: "Service Parser Vendor",
    serviceZones: ["Osu"],
    serviceTypes: services.parseServiceTypes("Wash + fold"),
    capacityRemaining: 2,
    availabilityStatus: "available",
    updatedBy: "Vendor",
  });
  store.upsertDriverAvailability({
    driverId: "driver-service-parser",
    driverName: "Service Parser Rider",
    serviceZones: ["Osu"],
    capacityRemaining: 2,
    availabilityStatus: "active",
    updatedBy: "Admin",
  });

  const result = assignment.assignOrderFromAvailability({
    orderId: "BW-SERVICE-PARSER",
    area: "Osu",
    serviceType: "Wash + fold",
    vendor: "Unassigned",
    driver: "Unassigned",
  });

  assert.equal(result.vendorId, "vendor-service-parser");
  assert.equal(result.driverId, "driver-service-parser");
  assert.equal(result.vendorCapacityRemaining, 1);
  assert.equal(result.driverCapacityRemaining, 1);
});

test("vendor availability rows are upserted into a real table and decrement on assignment", () => {
  store.resetDataStoreForTests();
  const vendor = store.upsertVendorAvailability({
    vendorId: "vendor-cleanpro-osu",
    vendorName: "CleanPro Osu",
    serviceZones: ["Osu", "Labone"],
    serviceTypes: ["wash-fold", "ironing"],
    capacityRemaining: 2,
    availabilityStatus: "available",
    nextAvailableAt: "2026-05-29T14:00:00.000Z",
    updatedBy: "Admin Operator",
    notes: "Fast lane today",
  });

  assert.equal(vendor.capacityRemaining, 2);
  assert.equal(store.listVendorAvailability()[0].vendorName, "CleanPro Osu");

  const reserved = store.reserveVendorCapacity(vendor.vendorId, "BW-ORDER-1");
  assert.equal(reserved.capacityRemaining, 1);
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 1);
});

test("assignment prefers available matching vendor and active matching driver from availability tables", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-east", vendorName: "East Vendor", serviceZones: ["East Legon"], serviceTypes: ["wash-fold"], capacityRemaining: 5, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertVendorAvailability({ vendorId: "vendor-osu", vendorName: "Osu Vendor", serviceZones: ["Osu", "Labone"], serviceTypes: ["wash-fold"], capacityRemaining: 1, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-osu", driverName: "Kofi Route", serviceZones: ["Osu"], vehicle: "Bike 7", availabilityStatus: "active", capacityRemaining: 3, updatedBy: "Admin" });

  const result = assignment.assignOrderFromAvailability({ orderId: "BW-ORDER-2", area: "Osu", serviceType: "wash-fold", vendor: "Unassigned", driver: "Unassigned" });

  assert.equal(result.vendorName, "Osu Vendor");
  assert.equal(result.driverName, "Kofi Route");
  assert.equal(result.vendorCapacityRemaining, 0);
  assert.equal(result.driverCapacityRemaining, 2);
});

test("vendor decline records reason, releases vendor capacity, and keeps order available for reassignment", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-osu", vendorName: "Osu Vendor", serviceZones: ["Osu"], serviceTypes: ["wash-fold"], capacityRemaining: 0, availabilityStatus: "available", updatedBy: "Admin" });

  const decline = store.recordVendorDecline({ orderId: "BW-ORDER-3", vendorId: "vendor-osu", vendorName: "Osu Vendor", reason: "Washer outage", declinedBy: "Vendor Partner" });
  const duplicate = store.recordVendorDecline({ orderId: "BW-ORDER-3", vendorId: "vendor-osu", vendorName: "Osu Vendor", reason: "Repeated click", declinedBy: "Vendor Partner" });

  assert.equal(decline.reason, "Washer outage");
  assert.equal(duplicate.id, decline.id);
  assert.equal(store.listVendorDeclines("BW-ORDER-3").length, 1);
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 1);
});

test("paired capacity reservation rolls back the vendor decrement when the driver is unavailable", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-atomic", vendorName: "Atomic Vendor", serviceZones: ["Osu"], serviceTypes: ["wash-fold"], capacityRemaining: 1, availabilityStatus: "available", updatedBy: "Admin" });

  assert.throws(
    () => store.reserveAssignmentCapacity("BW-ATOMIC-1", "vendor-atomic", "missing-driver"),
    /Driver capacity is no longer available/,
  );
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 1);
});

test("reassignment excludes a vendor that already declined the order", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-declined", vendorName: "Declined Vendor", serviceZones: ["Osu"], serviceTypes: ["wash-fold"], capacityRemaining: 2, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertVendorAvailability({ vendorId: "vendor-backup", vendorName: "Backup Vendor", serviceZones: ["Osu"], serviceTypes: ["wash-fold"], capacityRemaining: 1, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-osu", driverName: "Osu Rider", serviceZones: ["Osu"], capacityRemaining: 2, availabilityStatus: "active", updatedBy: "Admin" });
  store.recordVendorDecline({ orderId: "BW-REASSIGN-1", vendorId: "vendor-declined", vendorName: "Declined Vendor", reason: "No capacity", declinedBy: "Vendor" });

  const result = assignment.assignOrderFromAvailability({ orderId: "BW-REASSIGN-1", area: "Osu", serviceType: "wash-fold", vendor: "Unassigned", driver: "Unassigned" });
  assert.equal(result.vendorName, "Backup Vendor");
  assert.equal(result.vendorId, "vendor-backup");
});

test("paused vendors and inactive drivers are excluded from assignment", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-paused", vendorName: "Paused Vendor", serviceZones: ["Osu"], serviceTypes: ["wash-fold"], capacityRemaining: 5, availabilityStatus: "paused", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-inactive", driverName: "Inactive Driver", serviceZones: ["Osu"], availabilityStatus: "inactive", capacityRemaining: 5, updatedBy: "Admin" });

  assert.throws(
    () => assignment.assignOrderFromAvailability({ orderId: "BW-ORDER-4", area: "Osu", serviceType: "wash-fold", vendor: "Unassigned", driver: "Unassigned" }),
    /No eligible vendor or driver matches Osu/,
  );
});

test("assignment fails closed for out-of-zone, tomorrow-only, and training capacity", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-tema", vendorName: "Tema Vendor", serviceZones: ["Tema"], serviceTypes: ["wash-fold"], capacityRemaining: 3, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertVendorAvailability({ vendorId: "vendor-tomorrow", vendorName: "Tomorrow Vendor", serviceZones: ["Osu"], serviceTypes: ["wash-fold"], capacityRemaining: 3, availabilityStatus: "available-tomorrow", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-training", driverName: "Training Rider", serviceZones: ["Osu"], capacityRemaining: 3, availabilityStatus: "training", updatedBy: "Admin" });

  assert.throws(
    () => assignment.assignOrderFromAvailability({ orderId: "BW-ORDER-5", area: "Osu", serviceType: "wash-fold", vendor: "Unassigned", driver: "Unassigned" }),
    /No eligible vendor or driver matches Osu/,
  );
  assert.equal(store.listVendorAvailability().find((vendor) => vendor.vendorId === "vendor-tomorrow").capacityRemaining, 3);
  assert.equal(store.listDriverAvailability()[0].capacityRemaining, 3);
});

test("assignment enforces the projected order service capability", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-fold", vendorName: "Fold Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + fold"], capacityRemaining: 4, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertVendorAvailability({ vendorId: "vendor-premium", vendorName: "Premium Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + iron + fold"], capacityRemaining: 2, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-service", driverName: "Service Rider", serviceZones: ["Osu"], capacityRemaining: 2, availabilityStatus: "active", updatedBy: "Admin" });

  const result = assignment.assignOrderFromAvailability({ orderId: "BW-SERVICE-1", area: "Osu", serviceType: "Wash + iron + fold", vendor: "Unassigned", driver: "Unassigned" });
  assert.equal(result.vendorId, "vendor-premium");
  assert.equal(store.listVendorAvailability().find((vendor) => vendor.vendorId === "vendor-fold").capacityRemaining, 4);
});

test("assignment fails closed when a vendor has no declared service capability", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-unspecified", vendorName: "Unspecified Vendor", serviceZones: ["Osu"], serviceTypes: [], capacityRemaining: 3, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-unspecified", driverName: "Available Rider", serviceZones: ["Osu"], capacityRemaining: 3, availabilityStatus: "active", updatedBy: "Admin" });

  assert.throws(
    () => assignment.assignOrderFromAvailability({ orderId: "BW-SERVICE-2", area: "Osu", serviceType: "Wash + fold", vendor: "Unassigned", driver: "Unassigned" }),
    /No eligible vendor matches Osu/,
  );
});

test("final close releases a paired reservation exactly once", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-close", vendorName: "Close Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + fold"], capacityRemaining: 2, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-close", driverName: "Close Rider", serviceZones: ["Osu"], capacityRemaining: 2, availabilityStatus: "active", updatedBy: "Admin" });
  const assigned = assignment.assignOrderFromAvailability({ orderId: "BW-CLOSE-1", area: "Osu", serviceType: "Wash + fold", vendor: "Unassigned", driver: "Unassigned" });
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 1);
  assert.equal(store.listDriverAvailability()[0].capacityRemaining, 1);

  const released = store.appendSubmissionRecordAndReleaseOrderCapacity({
    id: "BW-CLOSE-EVENT-1",
    createdAt: "2026-07-18T12:00:00.000Z",
    source: "test",
    data: { submissionType: "admin-operation", orderId: "BW-CLOSE-1", orderStatus: "Closed" },
  }, "BW-CLOSE-1", assigned.vendorId, assigned.driverId);
  assert.deepEqual(released, { vendorReleases: 1, driverReleases: 1 });
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 2);
  assert.equal(store.listDriverAvailability()[0].capacityRemaining, 2);
  assert.deepEqual(store.releaseAssignmentCapacity(assigned.reservationId, "duplicate-release"), { vendorReleases: 0, driverReleases: 0 });
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 2);
  assert.equal(store.listDriverAvailability()[0].capacityRemaining, 2);
});

test("vendor decline releases only its component and close cannot release it twice", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-decline-ledger", vendorName: "Decline Ledger Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + fold"], capacityRemaining: 2, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-decline-ledger", driverName: "Decline Ledger Rider", serviceZones: ["Osu"], capacityRemaining: 2, availabilityStatus: "active", updatedBy: "Admin" });
  const assigned = assignment.assignOrderFromAvailability({ orderId: "BW-DECLINE-LEDGER", area: "Osu", serviceType: "Wash + fold", vendor: "Unassigned", driver: "Unassigned" });

  store.recordVendorDecline({ orderId: "BW-DECLINE-LEDGER", vendorId: assigned.vendorId, vendorName: assigned.vendorName, reason: "Capacity changed", declinedBy: "Vendor" });
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 2);
  assert.equal(store.listDriverAvailability()[0].capacityRemaining, 1);

  const released = store.appendSubmissionRecordAndReleaseOrderCapacity({
    id: "BW-CLOSE-EVENT-DECLINE",
    createdAt: "2026-07-18T12:05:00.000Z",
    source: "test",
    data: { submissionType: "admin-operation", orderId: "BW-DECLINE-LEDGER", orderStatus: "Closed" },
  }, "BW-DECLINE-LEDGER", assigned.vendorId, assigned.driverId);
  assert.deepEqual(released, { vendorReleases: 0, driverReleases: 1 });
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 2);
  assert.equal(store.listDriverAvailability()[0].capacityRemaining, 2);
});

test("failed close append rolls back its capacity release transaction", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-atomic-close", vendorName: "Atomic Close Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + fold"], capacityRemaining: 1, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-atomic-close", driverName: "Atomic Close Rider", serviceZones: ["Osu"], capacityRemaining: 1, availabilityStatus: "active", updatedBy: "Admin" });
  const assigned = assignment.assignOrderFromAvailability({ orderId: "BW-ATOMIC-CLOSE", area: "Osu", serviceType: "Wash + fold", vendor: "Unassigned", driver: "Unassigned" });
  store.getAvailabilityDatabase().prepare("INSERT INTO submissions (id, created_at, source, data) VALUES (?, ?, ?, ?)")
    .run("BW-DUPLICATE-CLOSE", "2026-07-18T12:10:00.000Z", "test", JSON.stringify({ submissionType: "support-ticket" }));

  assert.throws(() => store.appendSubmissionRecordAndReleaseOrderCapacity({
    id: "BW-DUPLICATE-CLOSE",
    createdAt: "2026-07-18T12:11:00.000Z",
    source: "test",
    data: { submissionType: "admin-operation", orderId: "BW-ATOMIC-CLOSE", orderStatus: "Closed" },
  }, "BW-ATOMIC-CLOSE", assigned.vendorId, assigned.driverId), /UNIQUE constraint failed/);
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 0);
  assert.equal(store.listDriverAvailability()[0].capacityRemaining, 0);
  assert.deepEqual(store.releaseAssignmentCapacity(assigned.reservationId), { vendorReleases: 1, driverReleases: 1 });
});
