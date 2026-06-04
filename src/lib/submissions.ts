import "server-only";

import type { StaffRole } from "@/lib/auth";
import { readSubmissionRecords } from "@/lib/data-store";
import { buildRoutePreview, type RoutePreview } from "@/lib/maps";
import { type ZoneKey, zones } from "@/lib/pricing";
import { stageTimerForWorkflow, workflowNextStep, workflowStageFromStatus, type WorkflowStage } from "@/lib/order-workflow";

export type SubmissionRecord = {
  id: string;
  createdAt: string;
  source?: string;
  data: Record<string, unknown>;
};

export type OrderSummary = {
  orderId: string;
  createdAt: string;
  updatedAt: string;
  customer: string;
  email: string;
  phone: string;
  area: string;
  vendor: string;
  driver: string;
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

const roleVisibleTypes: Record<StaffRole, Set<string> | null> = {
  admin: null,
  vendor: new Set(["vendor-application", "vendor-job-update", "qr-bag-intake"]),
  driver: new Set(["driver-route-log"]),
  support: new Set(["support-ticket", "support-ticket-action"]),
};

export function visibleSubmissionRecords(records: SubmissionRecord[], role: StaffRole) {
  const visibleTypes = roleVisibleTypes[role];
  if (!visibleTypes) return records;
  return records.filter((record) => visibleTypes.has(text(record.data.submissionType)));
}

export function orderBoardRecords(records: SubmissionRecord[], role: StaffRole) {
  if (role === "admin") return records;

  const accessibleOrderIds = new Set<string>();
  for (const record of records) {
    const type = text(record.data.submissionType);
    const orderId = canonicalOrderId(record);
    if (role === "vendor" && (type.startsWith("vendor") || type === "qr-bag-intake" || text(record.data.vendorName) || text(record.data.vendor))) {
      accessibleOrderIds.add(orderId);
    }
    if (role === "driver" && (type === "driver-route-log" || text(record.data.driverName) || text(record.data.driver))) {
      accessibleOrderIds.add(orderId);
    }
    if (role === "support" && (type.startsWith("support") || text(record.data.ticketStatus) || text(record.data.issueType) || isSupportRiskRecord(record))) {
      accessibleOrderIds.add(orderId);
    }
  }

  return records.filter((record) => accessibleOrderIds.has(canonicalOrderId(record)));
}

function isSupportRiskRecord(record: SubmissionRecord) {
  const riskText = [
    record.data.priority,
    record.data.ticketStatus,
    record.data.orderStatus,
    record.data.jobStatus,
    record.data.issueType,
    record.data.message,
  ].map(text).join(" ");
  return /urgent|high|delayed|declined|issue|missing|quality|escalated|needs attention|waiting/i.test(riskText);
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
  if (type.includes("vendor-application")) return "Vendor capacity updated";
  if (type.includes("vendor-job")) return "Vendor update received";
  if (type.includes("qr-bag")) return "Vendor intake checked";
  if (type.includes("driver-route")) return "Driver route update received";
  if (type.includes("driver-onboarding")) return text(record.data.driverStatus) || "Driver onboarded";
  if (type.includes("linen-inventory")) return "Inventory count logged";
  if (type.includes("support")) return "Support ticket open";
  if (type.includes("admin")) return "Admin action logged";
  return "Request received";
}

function nextStepFor(summary: Pick<OrderSummary, "status" | "lastEventType" | "vendor" | "driver" | "priority" | "stageTimer" | "customer" | "email" | "phone" | "area" | "routeWindow" | "locationNote" | "payment" | "orderId">) {
  return workflowNextStep(summary);
}

export async function readSubmissions(limit = 200) {
  return readSubmissionRecords(limit);
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
    const lastEventType = text(latest.data.submissionType) || "request";
    const status = recordStatus(latest);
    const workflowStage = workflowStageFromStatus(status, lastEventType);
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
    const vendor = findLatest("vendorName", "vendor");
    const driver = findLatest("driverName") || findLatestFromTypes(["driver-route-log"], "name") || "Unassigned";
    const routeWindow = findLatest("routeWindow", "pickupWindow", "driverEta", "eta") || "ETA pending";
    const locationNote = findLatest("locationNote", "routeCheckpoint") || findLatestFromTypes(["driver-route-log"], "message") || "No driver checkpoint yet";
    const area = findLatest("area", "zone", "routeArea") || "Route pending";
    const route = buildRoutePreview(zoneKeyFrom(findLatest("zone", "routeArea", "area")), area);
    const summary: OrderSummary = {
      orderId,
      createdAt: first.createdAt,
      updatedAt: latest.createdAt,
      customer: findCustomer(),
      email: findLatest("email") || "",
      phone: findLatest("phone") || "",
      area,
      vendor: vendor || "Unassigned",
      driver,
      routeWindow,
      locationNote,
      status,
      workflowStage,
      payment: findLatest("paymentPreference", "paymentMethod") || "Payment not confirmed",
      priority: findLatest("priority") || "Normal",
      nextStep: "",
      eventCount: chronological.length,
      lastEventType,
      route,
      stageTimer: stageTimerForWorkflow(status, latest.createdAt, lastEventType),
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
