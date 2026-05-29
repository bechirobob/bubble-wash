export type AssignmentRecord = {
  id: string;
  createdAt: string;
  data: Record<string, unknown>;
};

export type AssignmentOrder = {
  area: string;
  vendor: string;
  driver: string;
};

export type AssignmentPair = {
  vendorName: string;
  driverName: string;
  assignmentNote: string;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalized(value: unknown) {
  return text(value).toLowerCase();
}

function latestFirst(records: AssignmentRecord[]) {
  return [...records].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function vendorName(record: AssignmentRecord) {
  return text(record.data.company) || text(record.data.vendorName) || text(record.data.name) || "Vendor partner";
}

function driverName(record: AssignmentRecord) {
  return text(record.data.name) || text(record.data.driverName) || text(record.data.company) || "Route driver";
}

function isUnassigned(value: string) {
  const valueText = text(value);
  return !valueText || valueText.toLowerCase() === "unassigned" || valueText.toLowerCase().startsWith("next available");
}

function isVendorAvailable(record: AssignmentRecord) {
  const availability = normalized(record.data.availability);
  return text(record.data.submissionType) === "vendor-application" && !/(paused|closed|unavailable|inactive)/.test(availability);
}

function isActiveDriver(record: AssignmentRecord) {
  const status = normalized(record.data.driverStatus) || normalized(record.data.availability);
  return text(record.data.submissionType) === "driver-onboarding" && !/(inactive|suspended|offboarded|paused)/.test(status);
}

function areaMatches(record: AssignmentRecord, area: string) {
  const wanted = normalized(area);
  const served = `${normalized(record.data.area)} ${normalized(record.data.routeArea)} ${normalized(record.data.zone)}`;
  if (!wanted || !served) return false;
  return wanted.split(/[\s,/-]+/).filter(Boolean).some((token) => token.length > 2 && served.includes(token));
}

function selectVendor(records: AssignmentRecord[], area: string) {
  const available = latestFirst(records).filter(isVendorAvailable);
  return available.find((record) => areaMatches(record, area)) ?? available[0];
}

function selectDriver(records: AssignmentRecord[], area: string) {
  const active = latestFirst(records).filter(isActiveDriver);
  return active.find((record) => areaMatches(record, area)) ?? active[0];
}

export function selectAssignmentPair(records: AssignmentRecord[], order: AssignmentOrder): AssignmentPair {
  const vendorRecord = isUnassigned(order.vendor) ? selectVendor(records, order.area) : undefined;
  const driverRecord = isUnassigned(order.driver) ? selectDriver(records, order.area) : undefined;
  const vendor = isUnassigned(order.vendor) ? (vendorRecord ? vendorName(vendorRecord) : "Needs admin review") : order.vendor;
  const driver = isUnassigned(order.driver) ? (driverRecord ? driverName(driverRecord) : "Needs admin onboarding") : order.driver;

  const notes = [
    vendorRecord ? `Vendor capacity: ${vendorName(vendorRecord)} · ${text(vendorRecord.data.availability) || "Available"} · ${text(vendorRecord.data.capacity) || "capacity not stated"}` : isUnassigned(order.vendor) ? "No available vendor capacity matched this order." : `Vendor preserved: ${order.vendor}`,
    driverRecord ? `Driver roster: ${driverName(driverRecord)} · ${text(driverRecord.data.area) || "area not stated"}` : isUnassigned(order.driver) ? "No active admin-onboarded driver matched this order." : `Driver preserved: ${order.driver}`,
  ];

  return { vendorName: vendor, driverName: driver, assignmentNote: notes.join(" ") };
}
