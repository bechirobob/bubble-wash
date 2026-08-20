import "server-only";

import type { StaffRole } from "@/lib/auth";
import { readSubmissionRecords, readSubmissionRecordsForOrder } from "@/lib/data-store";
import { buildRoutePreview, type RoutePreview } from "@/lib/maps";
import { type ZoneKey, zones } from "@/lib/pricing";
import { stageTimerForWorkflow, workflowNextStep, workflowStageFromStatus, type WorkflowStage } from "@/lib/order-workflow";

export type SubmissionRecord = {
  id: string;
  createdAt: string;
  source?: string;
  data: Record<string, unknown>;
};

export type DispatchEtaSource = "rider-reported" | "area-estimate" | "scheduled-window" | "unavailable";
export type DispatchCheckpointSource = "rider-reported" | "rider-route-update" | "unavailable";

export type DispatchProjection = {
  scheduledWindow: string;
  estimatedDistanceKm: number;
  estimatedDriveMinutes: number;
  etaText: string;
  etaSource: DispatchEtaSource;
  etaUpdatedAt: string;
  checkpoint: string;
  checkpointSource: DispatchCheckpointSource;
  checkpointUpdatedAt: string;
};

export type OrderSummary = {
  orderId: string;
  createdAt: string;
  updatedAt: string;
  activityUpdatedAt: string;
  customer: string;
  email: string;
  phone: string;
  area: string;
  pickupAddress: string;
  landmark: string;
  plan: string;
  service: string;
  serviceType: string;
  vendor: string;
  vendorId: string;
  driver: string;
  driverId: string;
  routeWindow: string;
  locationNote: string;
  status: string;
  workflowStage: WorkflowStage;
  payment: string;
  priority: string;
  nextStep: string;
  eventCount: number;
  lastEventType: string;
  route: RoutePreview;
  dispatch: DispatchProjection;
  stageTimer: {
    label: string;
    tone: "ok" | "due" | "breached" | "paused";
    elapsedMinutes: number;
    targetMinutes: number;
  };
  timeline: Array<{
    id: string;
    createdAt: string;
    type: string;
    status: string;
    actor: string;
    note: string;
  }>;
};

function projectedTimelineNote(type: string, status: string) {
  const normalizedType = type.toLowerCase();
  const update = normalizedType === "pickup-booking" || normalizedType === "checkout-request"
    ? "Customer order received"
    : normalizedType === "admin-operation"
      ? "Operations update recorded"
      : normalizedType === "vendor-job-update"
        ? "Vendor production update recorded"
        : normalizedType === "qr-bag-intake"
          ? "Bag intake update recorded"
          : normalizedType === "driver-route-log"
            ? "Route checkpoint recorded"
            : normalizedType.includes("support")
              ? "Support follow-up recorded"
              : normalizedType.includes("payment")
                ? "Payment status update recorded"
                : "Order update recorded";
  return status ? `${update}: ${status}.` : `${update}.`;
}

function projectTimelineForRole(order: OrderSummary, role: StaffRole) {
  const hidesPayment = role === "vendor" || role === "driver";
  return order.timeline.flatMap((event) => {
    const normalizedType = event.type.toLowerCase();
    if (hidesPayment && normalizedType.includes("payment")) return [];
    if (hidesPayment && normalizedType === "checkout-request") {
      return [{ ...event, type: "order-request", status: "Received", note: "Customer order received." }];
    }
    return [{ ...event, note: projectedTimelineNote(event.type, event.status) }];
  });
}

function hasAssignedOperationalRoute(order: OrderSummary) {
  const driver = order.driver.trim();
  const assigned = Boolean(order.driverId.trim()) || Boolean(driver && !/^(unassigned|next available|needs admin)/i.test(driver));
  return assigned && !["delivered", "closed"].includes(order.workflowStage.key);
}

function unavailableDispatch(scheduledWindow = ""): DispatchProjection {
  return {
    scheduledWindow,
    estimatedDistanceKm: 0,
    estimatedDriveMinutes: 0,
    etaText: "",
    etaSource: "unavailable",
    etaUpdatedAt: "",
    checkpoint: "",
    checkpointSource: "unavailable",
    checkpointUpdatedAt: "",
  };
}

function safeAreaEstimateDispatch(dispatch: DispatchProjection): DispatchProjection {
  if (dispatch.estimatedDriveMinutes <= 0) return unavailableDispatch(dispatch.scheduledWindow);
  return {
    scheduledWindow: dispatch.scheduledWindow,
    estimatedDistanceKm: dispatch.estimatedDistanceKm,
    estimatedDriveMinutes: dispatch.estimatedDriveMinutes,
    etaText: `${dispatch.estimatedDriveMinutes} min`,
    etaSource: "area-estimate",
    etaUpdatedAt: dispatch.etaSource === "area-estimate" ? dispatch.etaUpdatedAt : "",
    checkpoint: "",
    checkpointSource: "unavailable",
    checkpointUpdatedAt: "",
  };
}

/**
 * Produces the staff-facing API view without changing the internal order
 * snapshot used for workflow validation. Blank strings preserve the current
 * client contract while ensuring hidden fields never reach the browser.
 */
export function projectOrderSummaryForRole(order: OrderSummary, role: StaffRole): OrderSummary {
  const projected: OrderSummary = {
    ...order,
    workflowStage: { ...order.workflowStage },
    route: {
      ...order.route,
      pickup: { ...order.route.pickup },
      hub: { ...order.route.hub },
    },
    dispatch: { ...order.dispatch },
    stageTimer: { ...order.stageTimer },
    timeline: order.timeline.map((event) => ({ ...event })),
  };

  if (role === "admin") return projected;

  projected.timeline = projectTimelineForRole(order, role);
  projected.eventCount = projected.timeline.length;

  if (role === "vendor") {
    projected.email = "";
    projected.phone = "";
    projected.pickupAddress = "";
    projected.landmark = "";
    projected.locationNote = "";
    projected.payment = "";
    projected.route.pickup.label = order.area || "Pickup area";
    projected.route.googleMapsUrl = "";
    projected.route.directionsUrl = "";
    projected.dispatch = safeAreaEstimateDispatch(order.dispatch);
    return projected;
  }

  if (role === "driver") {
    projected.email = "";
    projected.payment = "";
    if (!hasAssignedOperationalRoute(order)) {
      projected.phone = "";
      projected.pickupAddress = "";
      projected.landmark = "";
      projected.locationNote = "";
      projected.route.pickup.label = order.area || "Pickup area";
      projected.route.googleMapsUrl = "";
      projected.route.directionsUrl = "";
      projected.dispatch = unavailableDispatch(order.dispatch.scheduledWindow);
    }
    return projected;
  }

  // Support needs customer contact, pickup context, and the payment status for
  // manual pilot follow-up, but receives the same note-safe event projection.
  return projected;
}

const roleVisibleTypes: Record<StaffRole, Set<string> | null> = {
  admin: null,
  vendor: new Set(["vendor-application", "vendor-job-update", "qr-bag-intake"]),
  driver: new Set(["driver-route-log"]),
  support: new Set(["support-ticket", "support-ticket-action"]),
};

const workflowSeedTypes = new Set(["pickup-booking", "checkout-request"]);

function scopedEntityField(role: StaffRole) {
  return role === "vendor" ? "vendorId" : role === "driver" ? "driverId" : "";
}

function entityBindingEnabled(role: StaffRole, entityId?: string, production = process.env.NODE_ENV === "production") {
  if (role !== "vendor" && role !== "driver") return false;
  return Boolean(entityId?.trim()) || production;
}

export function orderMatchesStaffEntity(
  order: Pick<OrderSummary, "vendorId" | "driverId">,
  role: StaffRole,
  entityId?: string,
  production = process.env.NODE_ENV === "production",
) {
  if (role !== "vendor" && role !== "driver") return true;
  if (!entityBindingEnabled(role, entityId, production)) return true;
  const expected = entityId?.trim().toLowerCase();
  if (!expected) return false;
  const actual = (role === "vendor" ? order.vendorId : order.driverId).trim().toLowerCase();
  return Boolean(actual) && actual === expected;
}

function latestEntityByOrder(records: SubmissionRecord[], field: string) {
  const latest = new Map<string, string>();
  for (const record of [...records].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())) {
    const entityId = text(record.data[field]);
    if (entityId) latest.set(canonicalOrderId(record).toLowerCase(), entityId.toLowerCase());
  }
  return latest;
}

export function visibleSubmissionRecords(
  records: SubmissionRecord[],
  role: StaffRole,
  entityId?: string,
  production = process.env.NODE_ENV === "production",
) {
  const visibleTypes = roleVisibleTypes[role];
  if (!visibleTypes) return records;
  const typeVisible = records.filter((record) => visibleTypes.has(text(record.data.submissionType)));
  if (!entityBindingEnabled(role, entityId, production)) return typeVisible;
  const expected = entityId?.trim().toLowerCase();
  if (!expected) return [];
  const field = scopedEntityField(role);
  const currentEntities = latestEntityByOrder(records, field);
  return typeVisible.filter((record) => {
    const directEntity = text(record.data[field]).toLowerCase();
    if (directEntity) return directEntity === expected;
    return currentEntities.get(canonicalOrderId(record).toLowerCase()) === expected;
  });
}

function workflowOrderIds(records: SubmissionRecord[]) {
  return new Set(records.filter((record) => workflowSeedTypes.has(text(record.data.submissionType))).map((record) => canonicalOrderId(record).toLowerCase()));
}

export function orderBoardRecords(
  records: SubmissionRecord[],
  role: StaffRole,
  entityId?: string,
  production = process.env.NODE_ENV === "production",
) {
  const seededOrderIds = workflowOrderIds(records);
  if (role === "admin" || role === "support") {
    return records.filter((record) => seededOrderIds.has(canonicalOrderId(record).toLowerCase()));
  }

  if (entityBindingEnabled(role, entityId, production)) {
    const expected = entityId?.trim().toLowerCase();
    if (!expected) return [];
    const field = scopedEntityField(role);
    const currentEntities = latestEntityByOrder(records, field);
    const accessibleOrderIds = new Set(
      [...currentEntities.entries()]
        .filter(([orderId, currentEntity]) => seededOrderIds.has(orderId) && currentEntity === expected)
        .map(([orderId]) => orderId),
    );
    return records.filter((record) => accessibleOrderIds.has(canonicalOrderId(record).toLowerCase()));
  }

  const accessibleOrderIds = new Set<string>();
  for (const record of records) {
    const type = text(record.data.submissionType);
    const orderId = canonicalOrderId(record).toLowerCase();
    if (!seededOrderIds.has(orderId)) continue;
    if (role === "vendor" && (type.startsWith("vendor") || type === "qr-bag-intake" || text(record.data.vendorName) || text(record.data.vendor))) {
      accessibleOrderIds.add(orderId);
    }
    if (role === "driver" && (type === "driver-route-log" || text(record.data.driverName) || text(record.data.driver))) {
      accessibleOrderIds.add(orderId);
    }
  }

  return records.filter((record) => accessibleOrderIds.has(canonicalOrderId(record).toLowerCase()));
}

export function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalOrderId(record: SubmissionRecord) {
  return text(record.data.orderId) || record.id;
}

function zoneKeyFrom(value: string): ZoneKey {
  if (value in zones) return value as ZoneKey;
  const normalized = value.toLowerCase();
  if (normalized.includes("outer") || normalized.includes("tema")) return "outer";
  if (normalized.includes("near") || normalized.includes("spintex") || normalized.includes("madina") || normalized.includes("dzorwulu")) return "near";
  if (normalized.includes("custom")) return "custom";
  return "core";
}

function recordStatus(record: SubmissionRecord) {
  const explicit = text(record.data.ticketStatus) || text(record.data.orderStatus) || text(record.data.jobStatus) || text(record.data.availability) || text(record.data.issueType);
  if (explicit) return explicit;
  const type = text(record.data.submissionType);
  if (type.includes("booking")) return "Received — dispatch confirmation pending";
  if (type.includes("checkout")) return "Checkout request received — payment confirmation pending";
  if (type.includes("payment")) return text(record.data.paymentStatus) || "Payment update received";
  if (type.includes("vendor-application")) return "Vendor capacity updated";
  if (type.includes("vendor-job")) return "Vendor update received";
  if (type.includes("qr-bag")) return "Vendor intake checked";
  if (type.includes("driver-route")) return "Driver route update received";
  if (type.includes("driver-onboarding")) return text(record.data.driverStatus) || "Driver onboarded";
  if (type.includes("laundry-inventory")) return "Laundry inventory count logged";
  if (type.includes("support")) return "Support ticket open";
  if (type.includes("admin")) return "Admin action logged";
  return "Request received";
}

function drivesFulfillmentStage(record: SubmissionRecord) {
  const type = text(record.data.submissionType);
  if (type === "pickup-booking") return true;
  if (type === "admin-operation") return Boolean(text(record.data.orderStatus));
  if (type === "vendor-job-update") return Boolean(text(record.data.jobStatus));
  if (type === "qr-bag-intake") return true;
  if (type === "driver-route-log") return Boolean(text(record.data.orderStatus));
  return false;
}

function drivesPaymentState(record: SubmissionRecord) {
  const type = text(record.data.submissionType);
  if (["pickup-booking", "checkout-request"].includes(type)) return true;
  if (/payment/i.test(type) && Boolean(text(record.data.paymentStatus) || text(record.data.paymentPreference) || text(record.data.paymentMethod))) return true;
  return type === "admin-operation" && /confirm bank transfer|approve invoice|close order/i.test(text(record.data.actionType));
}

function explicitRiderEta(record: SubmissionRecord) {
  const driverEtaAt = text(record.data.driverEtaAt);
  if (driverEtaAt && text(record.data.etaSource).toLowerCase() === "rider-reported") return driverEtaAt;

  const revisedEta = text(record.data.revisedEta);
  if (revisedEta) return revisedEta;

  const driverEta = text(record.data.driverEta);
  const delayContext = `${text(record.data.issueType)} ${text(record.data.actionType)}`;
  if (driverEta && text(record.data.delayReason) && /delay/i.test(delayContext)) return driverEta;
  return "";
}

function routeCheckpoint(record: SubmissionRecord) {
  const type = text(record.data.submissionType);
  if (type !== "driver-route-log" && !explicitRiderEta(record)) return "";
  return text(record.data.routeCheckpoint) || text(record.data.locationNote);
}

function buildDispatchProjection(chronological: SubmissionRecord[], route: RoutePreview): DispatchProjection {
  const latestFirst = [...chronological].reverse();
  const confirmedWindowRecord = latestFirst.find((record) => (
    text(record.data.submissionType) === "admin-operation"
    && /schedule pickup/i.test(text(record.data.actionType))
    && Boolean(text(record.data.routeWindow) || text(record.data.pickupWindow))
  ));
  const requestedWindowRecord = latestFirst.find((record) => (
    workflowSeedTypes.has(text(record.data.submissionType))
    && Boolean(text(record.data.pickupWindow) || text(record.data.routeWindow))
  ));
  const scheduledWindowRecord = confirmedWindowRecord ?? requestedWindowRecord;
  const scheduledWindow = scheduledWindowRecord
    ? text(scheduledWindowRecord.data.routeWindow) || text(scheduledWindowRecord.data.pickupWindow)
    : "";

  const riderEtaRecord = latestFirst.find((record) => Boolean(explicitRiderEta(record)));
  const checkpointRecord = latestFirst.find((record) => Boolean(routeCheckpoint(record)));
  const riderEta = riderEtaRecord ? explicitRiderEta(riderEtaRecord) : "";
  const checkpoint = checkpointRecord ? routeCheckpoint(checkpointRecord) : "";

  let etaText = "";
  let etaSource: DispatchEtaSource = "unavailable";
  let etaUpdatedAt = "";
  if (riderEtaRecord && riderEta) {
    etaText = riderEta;
    etaSource = "rider-reported";
    etaUpdatedAt = riderEtaRecord.createdAt;
  } else if (route.estimatedDriveMinutes > 0) {
    etaText = `${route.estimatedDriveMinutes} min`;
    etaSource = "area-estimate";
    etaUpdatedAt = requestedWindowRecord?.createdAt ?? chronological[0]?.createdAt ?? "";
  } else if (confirmedWindowRecord && scheduledWindow) {
    etaText = scheduledWindow;
    etaSource = "scheduled-window";
    etaUpdatedAt = confirmedWindowRecord.createdAt;
  }

  return {
    scheduledWindow,
    estimatedDistanceKm: route.estimatedDistanceKm,
    estimatedDriveMinutes: route.estimatedDriveMinutes,
    etaText,
    etaSource,
    etaUpdatedAt,
    checkpoint,
    checkpointSource: checkpointRecord
      ? explicitRiderEta(checkpointRecord) ? "rider-reported" : "rider-route-update"
      : "unavailable",
    checkpointUpdatedAt: checkpointRecord?.createdAt ?? "",
  };
}

function nextStepFor(summary: Pick<OrderSummary, "status" | "lastEventType" | "vendor" | "driver" | "priority" | "stageTimer" | "customer" | "email" | "phone" | "area" | "routeWindow" | "locationNote" | "payment" | "orderId">) {
  return workflowNextStep(summary);
}

export async function readSubmissions(limit = 200) {
  return readSubmissionRecords(limit);
}

export async function readSubmissionsForOrder(orderId: string) {
  return readSubmissionRecordsForOrder(orderId);
}

export function buildOrderSummaries(records: SubmissionRecord[]) {
  const grouped = new Map<string, SubmissionRecord[]>();
  for (const record of records) {
    const key = canonicalOrderId(record);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }

  return Array.from(grouped.entries()).map(([orderId, group]) => {
    const chronological = [...group].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const latest = chronological[chronological.length - 1];
    const first = chronological[0];
    const findLatest = (...fields: string[]) => {
      for (const record of [...chronological].reverse()) {
        for (const field of fields) {
          const value = text(record.data[field]);
          if (value) return value;
        }
      }
      return "";
    };
    const findCustomer = () => {
      const customerEvent = chronological.find((record) => {
        const type = text(record.data.submissionType);
        return type.includes("booking") || type.includes("onboarding") || type.includes("checkout") || type.includes("support");
      });
      return text(customerEvent?.data.company) || text(customerEvent?.data.name) || findLatest("customer", "clientName") || "Bubble Wash customer";
    };
    const findLatestFromTypes = (types: string[], ...fields: string[]) => {
      for (const record of [...chronological].reverse()) {
        if (!types.includes(text(record.data.submissionType))) continue;
        for (const field of fields) {
          const value = text(record.data[field]);
          if (value) return value;
        }
      }
      return "";
    };
    const fulfillmentRecord = [...chronological].reverse().find(drivesFulfillmentStage) ?? first;
    const paymentRecord = [...chronological].reverse().find(drivesPaymentState);
    const lastEventType = text(fulfillmentRecord.data.submissionType) || "request";
    const status = recordStatus(fulfillmentRecord);
    const workflowStage = workflowStageFromStatus(status, lastEventType);
    const customerEmail = findLatestFromTypes(["pickup-booking", "checkout-request"], "email");
    const customerPhone = findLatestFromTypes(["pickup-booking", "checkout-request"], "phone");
    const bookingRecord = [...chronological].reverse().find((record) => text(record.data.submissionType) === "pickup-booking")
      ?? [...chronological].reverse().find((record) => text(record.data.submissionType) === "checkout-request");
    const explicitService = text(bookingRecord?.data.service);
    const bookingAddons = Array.isArray(bookingRecord?.data.addons)
      ? bookingRecord.data.addons.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
      : [];
    const service = explicitService
      || (bookingAddons.includes("express")
        ? "Express capable"
        : bookingAddons.includes("premium") || bookingAddons.includes("ironing")
          ? "Wash + iron + fold"
          : "Wash + fold");
    const vendor = findLatest("vendorName", "vendor");
    const driver = findLatest("driverName") || findLatestFromTypes(["driver-route-log"], "name") || "Unassigned";
    const area = findLatest("area", "zone", "routeArea") || "Route pending";
    const pickupAddress = findLatestFromTypes(["pickup-booking", "checkout-request"], "pickupAddress");
    const landmark = findLatestFromTypes(["pickup-booking", "checkout-request"], "landmark");
    const plan = findLatestFromTypes(["pickup-booking", "checkout-request"], "plan", "preferredPlan");
    const route = buildRoutePreview(zoneKeyFrom(findLatest("zone", "routeArea", "area")), pickupAddress || area);
    const dispatch = buildDispatchProjection(chronological, route);
    const routeWindow = dispatch.scheduledWindow || "ETA pending";
    const locationNote = dispatch.checkpoint || "No driver checkpoint yet";
    const summary: OrderSummary = {
      orderId,
      createdAt: first.createdAt,
      updatedAt: fulfillmentRecord.createdAt,
      activityUpdatedAt: latest.createdAt,
      customer: findCustomer(),
      email: customerEmail,
      phone: customerPhone,
      area,
      pickupAddress,
      landmark,
      plan,
      service,
      serviceType: service,
      vendor: vendor || "Unassigned",
      vendorId: findLatest("vendorId"),
      driver,
      driverId: findLatest("driverId"),
      routeWindow,
      locationNote,
      status,
      workflowStage,
      payment: paymentRecord ? text(paymentRecord.data.paymentStatus) || text(paymentRecord.data.paymentPreference) || text(paymentRecord.data.paymentMethod) || "Payment not confirmed" : "Payment not confirmed",
      priority: findLatest("priority") || "Normal",
      nextStep: "",
      eventCount: chronological.length,
      lastEventType,
      route,
      dispatch,
      stageTimer: stageTimerForWorkflow(status, fulfillmentRecord.createdAt, lastEventType),
      timeline: chronological.map((record) => ({
        id: record.id,
        createdAt: record.createdAt,
        type: text(record.data.submissionType) || "request",
        status: recordStatus(record),
        actor: text(record.data.name) || text(record.data.company) || "Bubble Wash team",
        note: text(record.data.message) || text(record.data.actionType) || text(record.data.itemCondition) || "No note supplied",
      })).reverse(),
    };
    summary.nextStep = nextStepFor(summary);
    return summary;
  }).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function findOrderById(records: SubmissionRecord[], id: string) {
  const normalized = id.trim().toLowerCase();
  return buildOrderSummaries(records).find((order) => order.orderId.toLowerCase() === normalized || order.timeline.some((event) => event.id.toLowerCase() === normalized));
}
