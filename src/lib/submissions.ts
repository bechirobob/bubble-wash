import "server-only";

import type { StaffRole } from "@/lib/auth";
import { readSubmissionRecords } from "@/lib/data-store";
import { buildRoutePreview, type RoutePreview } from "@/lib/maps";
import { type ZoneKey, zones } from "@/lib/pricing";

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
  if (role !== "driver") return visibleSubmissionRecords(records, role);

  const driverOrderIds = new Set(
    records
      .filter((record) => text(record.data.submissionType) === "driver-route-log" || text(record.data.driverName) || text(record.data.driverPhone) || text(record.data.routeWindow))
      .map((record) => canonicalOrderId(record)),
  );
  return records.filter((record) => driverOrderIds.has(canonicalOrderId(record)));
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
  if (type.includes("linen-inventory")) return "Inventory count logged";
  if (type.includes("support")) return "Support ticket open";
  if (type.includes("admin")) return "Admin action logged";
  return "Request received";
}

const stageTargets = [
  { match: ["received", "booking", "intake"], minutes: 20 },
  { match: ["pickup scheduled", "vendor assigned", "assigned"], minutes: 60 },
  { match: ["driver en route", "out for delivery"], minutes: 75 },
  { match: ["picked up", "dropped at vendor", "vendor received"], minutes: 45 },
  { match: ["washing", "ironing", "finishing"], minutes: 360 },
  { match: ["ready"], minutes: 120 },
  { match: ["delayed", "waiting"], minutes: 0, paused: true },
  { match: ["delivered", "completed", "resolved", "closed"], minutes: 0, paused: true },
];

function minutesSince(value: string) {
  const started = new Date(value).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 60_000));
}

function stageTimerFor(status: string, updatedAt: string) {
  const normalized = status.toLowerCase();
  const rule = stageTargets.find((item) => item.match.some((word) => normalized.includes(word))) ?? { minutes: 180 };
  const elapsedMinutes = minutesSince(updatedAt);
  if ("paused" in rule && rule.paused) {
    return { label: normalized.includes("delivered") || normalized.includes("completed") || normalized.includes("resolved") || normalized.includes("closed") ? "Timer complete" : "Timer paused", tone: "paused" as const, elapsedMinutes, targetMinutes: 0 };
  }
  const targetMinutes = rule.minutes;
  const remaining = targetMinutes - elapsedMinutes;
  if (remaining < 0) return { label: `Overdue by ${Math.abs(remaining)} min`, tone: "breached" as const, elapsedMinutes, targetMinutes };
  if (remaining <= 20) return { label: `Due in ${remaining} min`, tone: "due" as const, elapsedMinutes, targetMinutes };
  return { label: `Elapsed ${elapsedMinutes} min · SLA ${targetMinutes} min`, tone: "ok" as const, elapsedMinutes, targetMinutes };
}

function nextStepFor(summary: Pick<OrderSummary, "status" | "lastEventType" | "vendor">) {
  const status = summary.status.toLowerCase();
  const type = summary.lastEventType.toLowerCase();
  if (status.includes("received") || type.includes("booking")) return "Admin confirms route window, assigns vendor, and sends pickup confirmation.";
  if (status.includes("vendor assigned")) return "Vendor accepts the job, confirms capacity, and logs QR/bag intake when received.";
  if (status.includes("accepted")) return "Driver/vendor updates pickup handoff, bag count, and ETA before washing starts.";
  if (status.includes("washing") || status.includes("ironing")) return "Vendor keeps status current and flags missing/stain/quality issues before ready-for-driver.";
  if (status.includes("driver en route")) return "Driver shares ETA, pickup/delivery checkpoint, and customer handoff note.";
  if (status.includes("picked up")) return "Driver drops the bags at the assigned vendor and logs bag count / handoff note.";
  if (status.includes("delayed")) return "Support contacts the customer with the latest route note and revised ETA.";
  if (status.includes("ready")) return "Dispatch schedules return delivery and support watches for customer alerts.";
  if (status.includes("delivered")) return "Admin closes the order, confirms payment/invoice, and records any quality follow-up.";
  if (type.includes("support")) return "Support checks the shared timeline before contacting customer, vendor, or driver.";
  if (!summary.vendor || summary.vendor === "Unassigned") return "Admin should assign a vendor so the vendor dashboard and public tracking stay aligned.";
  return "Next team updates the same order ID so admin, vendor, support, and tracking stay consistent.";
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
      payment: findLatest("paymentPreference", "paymentMethod") || "Payment not confirmed",
      priority: findLatest("priority") || "Normal",
      nextStep: "",
      eventCount: chronological.length,
      lastEventType,
      route,
      stageTimer: stageTimerFor(status, latest.createdAt),
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
