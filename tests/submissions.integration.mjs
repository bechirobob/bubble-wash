import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

process.env.BUBBLEWASH_DATABASE_PATH = path.join(process.cwd(), "data", `submissions-${randomUUID()}.sqlite`);

const { buildOrderSummaries, orderBoardRecords, orderMatchesStaffEntity, projectOrderSummaryForRole, visibleSubmissionRecords } = await import("../src/lib/submissions.ts");

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
    plan: "Twice weekly",
    pickupWindow: "8:00–10:00",
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
assert.equal(summary.plan, "Twice weekly");
assert.equal(summary.service, "Wash + fold");
assert.equal(summary.serviceType, "Wash + fold");
assert.equal(summary.payment, "success");
assert.equal(summary.routeWindow, "8:00–10:00");
assert.equal(summary.dispatch.scheduledWindow, "8:00–10:00");
assert.equal(summary.dispatch.etaSource, "area-estimate");
assert.equal(summary.dispatch.etaText, `${summary.route.estimatedDriveMinutes} min`);
assert.equal(summary.dispatch.checkpointSource, "unavailable");
assert.equal(orderBoardRecords([booking, washing, support, payment, laterSupport], "support").length, 5);

const adminView = projectOrderSummaryForRole(summary, "admin");
assert.deepEqual(adminView, summary);
assert.notEqual(adminView, summary);
assert.notEqual(adminView.timeline, summary.timeline);
assert.notEqual(adminView.route, summary.route);
assert.notEqual(adminView.route.pickup, summary.route.pickup);
assert.notEqual(adminView.dispatch, summary.dispatch);

const vendorView = projectOrderSummaryForRole(summary, "vendor");
assert.equal(vendorView.email, "");
assert.equal(vendorView.phone, "");
assert.equal(vendorView.pickupAddress, "");
assert.equal(vendorView.landmark, "");
assert.equal(vendorView.locationNote, "");
assert.equal(vendorView.payment, "");
assert.equal(vendorView.route.pickup.label, summary.area);
assert.notEqual(vendorView.route.pickup.label, summary.pickupAddress);
assert.equal(vendorView.route.googleMapsUrl, "");
assert.equal(vendorView.route.directionsUrl, "");
assert.equal(vendorView.dispatch.etaSource, "area-estimate");
assert.equal(vendorView.dispatch.etaText, `${summary.route.estimatedDriveMinutes} min`);
assert.equal(vendorView.dispatch.checkpoint, "");
assert.equal(vendorView.dispatch.checkpointUpdatedAt, "");
assert.ok(vendorView.timeline.every((event) => !event.note.includes("ama@example.com") && !event.note.includes("0550000000") && event.note !== "Production started."));
assert.ok(vendorView.timeline.every((event) => !event.type.includes("payment") && event.status !== "success"));
assert.equal(vendorView.eventCount, vendorView.timeline.length);

const assignedDriverSummary = { ...summary, driver: "Kofi Route", driverId: "driver-kofi" };
const driverView = projectOrderSummaryForRole(assignedDriverSummary, "driver");
assert.equal(driverView.email, "");
assert.equal(driverView.payment, "");
assert.equal(driverView.phone, summary.phone);
assert.equal(driverView.pickupAddress, summary.pickupAddress);
assert.equal(driverView.landmark, summary.landmark);
assert.equal(driverView.route.directionsUrl, summary.route.directionsUrl);
assert.deepEqual(driverView.dispatch, summary.dispatch);
assert.ok(driverView.timeline.every((event) => event.note !== "Production started."));
assert.ok(driverView.timeline.every((event) => !event.type.includes("payment") && event.status !== "success"));
assert.equal(driverView.eventCount, driverView.timeline.length);

const deliveredDriverView = projectOrderSummaryForRole({
  ...assignedDriverSummary,
  workflowStage: { ...assignedDriverSummary.workflowStage, key: "delivered" },
}, "driver");
assert.equal(deliveredDriverView.phone, "");
assert.equal(deliveredDriverView.pickupAddress, "");
assert.equal(deliveredDriverView.landmark, "");
assert.equal(deliveredDriverView.route.pickup.label, summary.area);
assert.equal(deliveredDriverView.route.directionsUrl, "");
assert.equal(deliveredDriverView.dispatch.etaSource, "unavailable");
assert.equal(deliveredDriverView.dispatch.etaText, "");
assert.equal(deliveredDriverView.dispatch.checkpoint, "");

const supportView = projectOrderSummaryForRole(summary, "support");
assert.equal(supportView.email, summary.email);
assert.equal(supportView.phone, summary.phone);
assert.equal(supportView.pickupAddress, summary.pickupAddress);
assert.equal(supportView.payment, summary.payment);
assert.deepEqual(supportView.dispatch, summary.dispatch);
assert.ok(supportView.timeline.every((event) => event.note !== "Production started."));

assert.equal(summary.email, "ama@example.com");
assert.equal(summary.phone, "0550000000");
assert.equal(summary.pickupAddress, "14 Oxford Street, Osu");
assert.equal(summary.payment, "success");

const expressSummary = buildOrderSummaries([{
  ...booking,
  id: "BW-EXPRESS-SERVICE",
  data: { ...booking.data, addons: ["express"] },
}])[0];
assert.equal(expressSummary.service, "Wash + fold; Express capable");
assert.equal(expressSummary.serviceType, "Wash + fold; Express capable");

const dispatchAssignment = {
  id: "BW-DISPATCH-ASSIGN",
  createdAt: "2026-07-18T10:00:00.000Z",
  data: {
    submissionType: "admin-operation",
    orderId: booking.id,
    actionType: "Assign vendor",
    orderStatus: "Vendor assigned",
    vendorId: "vendor-dispatch",
    vendorName: "Dispatch Laundry",
    driverId: "driver-dispatch",
    driverName: "Dispatch Rider",
  },
};
const ordinaryRouteStart = {
  id: "BW-DISPATCH-START",
  createdAt: "2026-07-18T10:10:00.000Z",
  data: {
    submissionType: "driver-route-log",
    orderId: booking.id,
    orderStatus: "Driver en route",
    vendorId: "vendor-dispatch",
    driverId: "driver-dispatch",
    driverName: "Dispatch Rider",
    routeWindow: "8:00–10:00",
    driverEta: "8:00–10:00",
    driverEtaAt: "10:45",
    etaSource: "scheduled-window",
    locationNote: "Route started",
  },
};
const preReportDispatch = buildOrderSummaries([booking, dispatchAssignment, ordinaryRouteStart])[0];
assert.equal(preReportDispatch.routeWindow, "8:00–10:00");
assert.equal(preReportDispatch.dispatch.etaSource, "area-estimate");
assert.notEqual(preReportDispatch.dispatch.etaText, ordinaryRouteStart.data.driverEta);
assert.equal(preReportDispatch.dispatch.checkpoint, "Route started");
assert.equal(preReportDispatch.dispatch.checkpointSource, "rider-route-update");
assert.equal(preReportDispatch.dispatch.checkpointUpdatedAt, ordinaryRouteStart.createdAt);

const explicitEtaUpdate = {
  id: "BW-DISPATCH-ETA",
  createdAt: "2026-07-18T10:20:00.000Z",
  data: {
    submissionType: "driver-route-log",
    orderId: booking.id,
    currentOrderStatus: "Driver en route",
    vendorId: "vendor-dispatch",
    driverId: "driver-dispatch",
    driverName: "Dispatch Rider",
    routeWindow: "8:00–10:00",
    driverEtaAt: "11:05",
    driverEta: "11:05",
    etaSource: "rider-reported",
    routeCheckpoint: "37 Military Hospital junction",
    locationNote: "37 Military Hospital junction",
  },
};
const explicitEtaSummary = buildOrderSummaries([booking, dispatchAssignment, ordinaryRouteStart, explicitEtaUpdate])[0];
assert.equal(explicitEtaSummary.routeWindow, "8:00–10:00");
assert.equal(explicitEtaSummary.dispatch.scheduledWindow, "8:00–10:00");
assert.equal(explicitEtaSummary.dispatch.etaText, "11:05");
assert.equal(explicitEtaSummary.dispatch.etaSource, "rider-reported");
assert.equal(explicitEtaSummary.dispatch.etaUpdatedAt, explicitEtaUpdate.createdAt);
assert.equal(explicitEtaSummary.dispatch.checkpoint, "37 Military Hospital junction");
assert.equal(explicitEtaSummary.dispatch.checkpointSource, "rider-reported");
assert.equal(explicitEtaSummary.dispatch.checkpointUpdatedAt, explicitEtaUpdate.createdAt);

const explicitDelayUpdate = {
  id: "BW-DISPATCH-DELAY",
  createdAt: "2026-07-18T10:30:00.000Z",
  data: {
    submissionType: "support-ticket",
    orderId: booking.id,
    issueType: "Pickup delay",
    routeWindow: "8:00–10:00",
    driverEta: "11:25",
    locationNote: "Airport roundabout",
    delayReason: "Heavy traffic",
  },
};
const revisedEtaSummary = buildOrderSummaries([booking, dispatchAssignment, ordinaryRouteStart, explicitEtaUpdate, explicitDelayUpdate])[0];
assert.equal(revisedEtaSummary.routeWindow, "8:00–10:00");
assert.equal(revisedEtaSummary.dispatch.etaText, "11:25");
assert.equal(revisedEtaSummary.dispatch.etaSource, "rider-reported");
assert.equal(revisedEtaSummary.dispatch.etaUpdatedAt, explicitDelayUpdate.createdAt);
assert.equal(revisedEtaSummary.dispatch.checkpoint, "Airport roundabout");
assert.equal(revisedEtaSummary.dispatch.checkpointUpdatedAt, explicitDelayUpdate.createdAt);

const dispatchAdminView = projectOrderSummaryForRole(revisedEtaSummary, "admin");
const dispatchVendorView = projectOrderSummaryForRole(revisedEtaSummary, "vendor");
const dispatchDriverView = projectOrderSummaryForRole(revisedEtaSummary, "driver");
const dispatchSupportView = projectOrderSummaryForRole(revisedEtaSummary, "support");
assert.equal(dispatchAdminView.dispatch.etaText, "11:25");
assert.equal(dispatchDriverView.dispatch.etaText, "11:25");
assert.equal(dispatchSupportView.dispatch.etaText, "11:25");
assert.equal(Object.hasOwn(dispatchSupportView.dispatch, "lat"), false);
assert.equal(dispatchVendorView.dispatch.etaSource, "area-estimate");
assert.equal(dispatchVendorView.dispatch.etaText, `${revisedEtaSummary.route.estimatedDriveMinutes} min`);
assert.equal(dispatchVendorView.dispatch.etaUpdatedAt, "");
assert.equal(dispatchVendorView.dispatch.checkpoint, "");
assert.equal(dispatchVendorView.dispatch.checkpointSource, "unavailable");
assert.equal(Object.hasOwn(dispatchVendorView.dispatch, "lng"), false);

const entityBookingA = { ...booking, id: "BW-ENTITY-A" };
const entityBookingB = { ...booking, id: "BW-ENTITY-B" };
const entityAssignmentA = {
  id: "BW-ENTITY-ASSIGN-A",
  createdAt: "2026-07-18T10:00:00.000Z",
  data: { submissionType: "admin-operation", orderId: entityBookingA.id, orderStatus: "Vendor assigned", vendorId: "vendor-a", vendorName: "Vendor A", driverId: "driver-a", driverName: "Driver A" },
};
const entityAssignmentB = {
  id: "BW-ENTITY-ASSIGN-B",
  createdAt: "2026-07-18T10:01:00.000Z",
  data: { submissionType: "admin-operation", orderId: entityBookingB.id, orderStatus: "Vendor assigned", vendorId: "vendor-b", vendorName: "Vendor B", driverId: "driver-b", driverName: "Driver B" },
};
const vendorActivityA = {
  id: "BW-ENTITY-VENDOR-A",
  createdAt: "2026-07-18T10:02:00.000Z",
  data: { submissionType: "vendor-job-update", orderId: entityBookingA.id, vendorId: "vendor-a", vendorName: "Vendor A", jobStatus: "Accepted" },
};
const vendorActivityB = {
  id: "BW-ENTITY-VENDOR-B",
  createdAt: "2026-07-18T10:03:00.000Z",
  data: { submissionType: "vendor-job-update", orderId: entityBookingB.id, vendorId: "vendor-b", vendorName: "Vendor B", jobStatus: "Accepted" },
};
const driverActivityA = {
  id: "BW-ENTITY-DRIVER-A",
  createdAt: "2026-07-18T10:04:00.000Z",
  data: { submissionType: "driver-route-log", orderId: entityBookingA.id, vendorId: "vendor-a", driverId: "driver-a", driverName: "Driver A", orderStatus: "Driver en route" },
};
const driverActivityB = {
  id: "BW-ENTITY-DRIVER-B",
  createdAt: "2026-07-18T10:05:00.000Z",
  data: { submissionType: "driver-route-log", orderId: entityBookingB.id, vendorId: "vendor-b", driverId: "driver-b", driverName: "Driver B", orderStatus: "Driver en route" },
};
const entityRecords = [entityBookingA, entityBookingB, entityAssignmentA, entityAssignmentB, vendorActivityA, vendorActivityB, driverActivityA, driverActivityB];

const vendorABoard = buildOrderSummaries(orderBoardRecords(entityRecords, "vendor", "vendor-a", true));
assert.deepEqual(vendorABoard.map((order) => order.orderId), [entityBookingA.id]);
assert.equal(orderBoardRecords(entityRecords, "vendor", "vendor-mismatch", true).length, 0);
assert.equal(orderBoardRecords(entityRecords, "vendor", undefined, true).length, 0);
assert.equal(orderBoardRecords(entityRecords, "vendor", undefined, false).length, entityRecords.length);
assert.equal(orderMatchesStaffEntity(vendorABoard[0], "vendor", "vendor-a", true), true);
assert.equal(orderMatchesStaffEntity(vendorABoard[0], "vendor", "vendor-b", true), false);

const driverABoard = buildOrderSummaries(orderBoardRecords(entityRecords, "driver", "driver-a", true));
assert.deepEqual(driverABoard.map((order) => order.orderId), [entityBookingA.id]);
assert.equal(orderBoardRecords(entityRecords, "driver", "driver-mismatch", true).length, 0);
assert.equal(orderMatchesStaffEntity(driverABoard[0], "driver", "driver-a", true), true);
assert.equal(orderMatchesStaffEntity(driverABoard[0], "driver", "driver-b", true), false);

assert.deepEqual(visibleSubmissionRecords(entityRecords, "vendor", "vendor-a", true).map((record) => record.id), [vendorActivityA.id]);
assert.deepEqual(visibleSubmissionRecords(entityRecords, "driver", "driver-a", true).map((record) => record.id), [driverActivityA.id]);
assert.equal(visibleSubmissionRecords(entityRecords, "vendor", undefined, true).length, 0);
assert.equal(visibleSubmissionRecords(entityRecords, "vendor", undefined, false).length, 2);

console.log(JSON.stringify({ ok: true, checks: 117 }));
