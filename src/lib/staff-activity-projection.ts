import { bookingLabel } from "./booking-label.ts";

export type StaffActivityRole = "admin" | "vendor" | "driver" | "support";

export type StaffActivityRecord = {
  id: string;
  createdAt: string;
  source?: string;
  data: Record<string, unknown>;
};

/** Ordinary activity headings never fall back to a private order identity. */
export function staffActivitySubject(record: StaffActivityRecord) {
  const value = (key: string) => typeof record.data[key] === "string" ? (record.data[key] as string).trim() : "";
  const name = ["company", "staffName", "driverName", "name"].map(value).find(Boolean);
  if (name) return name;
  if (value("orderId") || value("bookingReference")) return bookingLabel({ bookingReference: value("bookingReference") });
  return value("ticketId") || "Bubble Wash request";
}

const supportFields = new Set([
  "submissionType",
  "ticketId",
  "customerAction",
  "requestedDate",
  "requestedWindow",
  "decision",
  "orderId",
  "name",
  "company",
  "customer",
  "phone",
  "email",
  "issueType",
  "ticketStatus",
  "priority",
  "assignedRole",
  "escalationLevel",
  "contactChannel",
  "contactOutcome",
  "nextFollowUpAt",
  "paymentPreference",
  "paymentStatus",
  "paymentReference",
  "reason",
  "actionType",
  "operatorNote",
  "message",
]);

const vendorFields = new Set([
  "submissionType",
  "ticketId",
  "orderId",
  "name",
  "company",
  "vendorName",
  "vendorId",
  "jobStatus",
  "priority",
  "actionType",
  "area",
  "routeWindow",
  "availability",
  "capacity",
  "capacityRemaining",
  "services",
  "service",
  "serviceZones",
  "nextAvailableAt",
  "qrTag",
  "bagTag",
  "bagCount",
  "intakeBagCount",
  "readyBagCount",
  "receivedWeightKg",
  "itemCondition",
  "intakeCondition",
  "qualityCheck",
  "intakeNote",
  "dispatchNote",
  "reason",
]);

const driverFields = new Set([
  "submissionType",
  "ticketId",
  "orderId",
  "name",
  "company",
  "driverName",
  "driverId",
  "vendorName",
  "orderStatus",
  "priority",
  "actionType",
  "area",
  "routeWindow",
  "driverEta",
  "revisedEta",
  "locationNote",
  "routeCheckpoint",
  "bagCount",
  "pickupBagCount",
  "handoffBagCount",
  "recipientName",
  "vendorRecipient",
  "handoffNote",
  "proofNote",
  "delayReason",
  "reason",
]);

const forbiddenOperationalField = /(phone|email|address|landmark|payment|map|direction)/i;

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  }
  return value;
}

function collectSensitiveValues(data: Record<string, unknown>) {
  const values: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!forbiddenOperationalField.test(key)) continue;
    if (typeof value === "string" && value.trim().length >= 3) values.push(value.trim());
    if (Array.isArray(value)) {
      values.push(...value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length >= 3).map((entry) => entry.trim()));
    }
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSensitiveText(value: string, sensitiveValues: string[]) {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    redacted = redacted.replace(new RegExp(escapeRegExp(sensitiveValue), "gi"), "[redacted]");
  }
  redacted = redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]");
  redacted = redacted.replace(/\+?\d[\d\s().-]{5,}\d/g, (candidate) => candidate.replace(/\D/g, "").length >= 7 ? "[redacted phone]" : candidate);
  redacted = redacted.replace(/https?:\/\/\S+/gi, "[redacted link]");
  return redacted;
}

function sanitizeOperationalValue(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === "string") return redactSensitiveText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((entry) => sanitizeOperationalValue(entry, sensitiveValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeOperationalValue(entry, sensitiveValues)]));
  }
  return value;
}

function safeOperationalSummary(record: StaffActivityRecord, role: "vendor" | "driver") {
  const type = typeof record.data.submissionType === "string" ? record.data.submissionType.toLowerCase() : "";
  if (role === "vendor") {
    if (type === "vendor-application") return "Vendor capacity update recorded.";
    if (type === "qr-bag-intake") return "Vendor intake evidence recorded.";
    if (type === "vendor-job-update") return "Vendor production update recorded.";
    return "Vendor operational update recorded.";
  }
  if (type === "driver-route-log") return "Driver route checkpoint recorded.";
  return "Driver operational update recorded.";
}

function allowlistedData(record: StaffActivityRecord, role: "vendor" | "driver" | "support") {
  const fields = role === "vendor" ? vendorFields : role === "driver" ? driverFields : supportFields;
  const sensitiveValues = role === "support" ? [] : collectSensitiveValues(record.data);
  const data: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record.data)) {
    if (!fields.has(key)) continue;
    if (role !== "support" && forbiddenOperationalField.test(key)) continue;
    data[key] = role === "support" ? cloneValue(value) : sanitizeOperationalValue(value, sensitiveValues);
  }

  // This field comes from the authoritative read projection, not stored input.
  // Keep only canonical display labels, without phone-number text redaction.
  if (Object.hasOwn(record.data, "bookingReference")) {
    const reference = typeof record.data.bookingReference === "string" ? record.data.bookingReference : "";
    data.bookingReference = reference && bookingLabel({ bookingReference: reference }) === reference ? reference : null;
  }
  if (role === "vendor" || role === "driver") data.message = safeOperationalSummary(record, role);
  return data;
}

export function projectStaffActivityRecord(record: StaffActivityRecord, role: StaffActivityRole): StaffActivityRecord {
  if (role === "admin") return cloneValue(record) as StaffActivityRecord;
  return {
    id: record.id,
    createdAt: record.createdAt,
    ...(record.source ? { source: record.source } : {}),
    data: allowlistedData(record, role),
  };
}

