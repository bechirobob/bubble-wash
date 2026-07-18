import test from "node:test";
import assert from "node:assert/strict";
import { automationActionsForOrder, isValidDriverEtaAt, paymentReadyForCloseout, workflowNextStep, workflowStageFromStatus } from "../src/lib/order-workflow.ts";

const baseOrder = {
  orderId: "BW-TEST-001",
  updatedAt: "2026-05-29T12:00:00.000Z",
  customer: "Ama Customer",
  email: "ama@example.com",
  phone: "0550000000",
  area: "Osu",
  vendor: "CleanPro Osu",
  driver: "Kofi Route 1",
  routeWindow: "2 PM - 4 PM",
  locationNote: "Near Oxford Street",
  status: "Vendor assigned",
  workflowStage: workflowStageFromStatus("Vendor assigned", "admin-operation"),
  payment: "MTN MoMo",
  priority: "Normal",
  nextStep: "Vendor should accept.",
  eventCount: 2,
  lastEventType: "admin-operation",
  route: { googleMapsUrl: "https://maps.google.com", directionsUrl: "https://maps.google.com", zoneLabel: "Osu", zoneNote: "" },
  stageTimer: { label: "Due in 120 min", tone: "ok", elapsedMinutes: 0, targetMinutes: 180 },
  timeline: [],
};

test("vendor assigned orders expose accept and decline actions", () => {
  const actions = automationActionsForOrder(baseOrder, "vendor", "Vendor Partner");
  assert.ok(actions.some((action) => action.key === "vendor-accept-job"));
  const decline = actions.find((action) => action.key === "vendor-decline-job");
  assert.ok(decline, "decline action should be present");
  assert.equal(decline.nextStatus, "Needs attention");
  assert.equal(decline.payload.jobStatus, "Declined");
});

test("admin can reassign orders in Needs Attention after a vendor decline", () => {
  const exceptionOrder = {
    ...baseOrder,
    status: "Declined",
    workflowStage: workflowStageFromStatus("Declined", "vendor-job-update"),
    lastEventType: "vendor-job-update",
  };
  const actions = automationActionsForOrder(exceptionOrder, "admin", "Admin Operator");
  assert.ok(actions.some((action) => action.key === "admin-assign-vendor"));
});

test("admin schedules a new pickup before assigning and does not rewind unrelated exceptions", () => {
  const received = { ...baseOrder, status: "Received", lastEventType: "pickup-booking" };
  const receivedActions = automationActionsForOrder(received, "admin", "Admin Operator");
  assert.ok(receivedActions.some((action) => action.key === "admin-schedule-pickup"));
  assert.equal(receivedActions.some((action) => action.key === "admin-assign-vendor"), false);

  const delayed = { ...baseOrder, status: "Delayed", lastEventType: "driver-route-log" };
  assert.equal(automationActionsForOrder(delayed, "admin", "Admin Operator").some((action) => action.key === "admin-assign-vendor"), false);
});

test("admin cannot close a delivered order until pilot billing is confirmed", () => {
  const delivered = {
    ...baseOrder,
    status: "Delivered",
    workflowStage: workflowStageFromStatus("Delivered", "driver-route-log"),
    lastEventType: "driver-route-log",
    payment: "Bank transfer",
  };
  const pendingActions = automationActionsForOrder(delivered, "admin", "Admin Operator");
  assert.ok(pendingActions.some((action) => action.key === "admin-confirm-bank-transfer"));
  assert.equal(pendingActions.some((action) => action.key === "admin-close-order"), false);
  assert.match(workflowNextStep(delivered), /confirm the bank transfer/i);

  const settledActions = automationActionsForOrder({ ...delivered, payment: "Bank transfer confirmed" }, "admin", "Admin Operator");
  assert.ok(settledActions.some((action) => action.key === "admin-close-order"));
  assert.equal(paymentReadyForCloseout("Invoice approved"), true);
  assert.equal(paymentReadyForCloseout("Invoice pending approval"), false);
});

test("workflow actions enforce vendor acceptance, route, handoff, and intake order", () => {
  const assigned = { ...baseOrder, status: "Vendor assigned", lastEventType: "admin-operation" };
  assert.equal(automationActionsForOrder(assigned, "driver", "Route Driver").some((action) => action.key === "driver-start-route"), false);
  assert.ok(automationActionsForOrder(assigned, "vendor", "Vendor Partner").some((action) => action.key === "vendor-accept-job"));

  const accepted = { ...baseOrder, status: "Accepted", lastEventType: "vendor-job-update" };
  assert.ok(automationActionsForOrder(accepted, "driver", "Route Driver").some((action) => action.key === "driver-start-route"));
  const delay = automationActionsForOrder(accepted, "driver", "Route Driver").find((action) => action.key === "driver-report-delay");
  assert.equal(delay?.submissionType, "support-ticket");
  assert.equal(delay?.payload.ticketStatus, "Open");

  const atVendor = { ...baseOrder, status: "Dropped at vendor", lastEventType: "driver-route-log" };
  const beforeIntake = automationActionsForOrder(atVendor, "vendor", "Vendor Partner");
  assert.ok(beforeIntake.some((action) => action.key === "vendor-log-intake"));
  assert.equal(beforeIntake.some((action) => action.key === "vendor-start-washing"), false);

  const intake = { ...baseOrder, status: "At vendor", lastEventType: "qr-bag-intake" };
  assert.ok(automationActionsForOrder(intake, "vendor", "Vendor Partner").some((action) => action.key === "vendor-start-washing"));
});

test("driver ETA updates are limited to moving legs and preserve the current route context", () => {
  for (const status of ["Driver en route", "Picked up", "Out for delivery"]) {
    const movingOrder = { ...baseOrder, status, lastEventType: "driver-route-log" };
    const update = automationActionsForOrder(movingOrder, "driver", "Route Driver").find((action) => action.key === "driver-update-eta");
    assert.ok(update, `${status} should expose an ETA update`);
    assert.equal(update.submissionType, "driver-route-log");
    assert.equal(update.nextStatus, status);
    assert.equal(update.payload.currentOrderStatus, status);
    assert.equal(Object.hasOwn(update.payload, "orderStatus"), false, "ETA checkpoints must not reset the fulfillment-stage timer");
    assert.equal(update.payload.vendorName, baseOrder.vendor);
    assert.equal(update.payload.driverName, baseOrder.driver);
  }

  for (const status of ["Accepted", "Ready", "Dropped at vendor", "Delivered", "Closed"]) {
    const stationaryOrder = { ...baseOrder, status, lastEventType: "driver-route-log" };
    assert.equal(automationActionsForOrder(stationaryOrder, "driver", "Route Driver").some((action) => action.key === "driver-update-eta"), false);
  }

  const repeatedUpdate = { ...baseOrder, status: "Driver en route", lastEventType: "driver-route-log", locationNote: "37 Military Hospital" };
  assert.ok(automationActionsForOrder(repeatedUpdate, "driver", "Route Driver").some((action) => action.key === "driver-update-eta"));
});

test("rider-reported ETA uses a strict 24-hour clock value", () => {
  for (const value of ["00:00", "09:05", "15:20", "23:59"]) assert.equal(isValidDriverEtaAt(value), true);
  for (const value of ["", "9:05", "24:00", "15:60", "3 PM", "15:20 tomorrow"]) assert.equal(isValidDriverEtaAt(value), false);
});
