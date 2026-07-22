import { listDriverAvailability, listVendorAvailability, listVendorDeclines, reserveAssignmentCapacity, type DriverAvailability, type VendorAvailability } from "./availability-store.ts";
import { serviceCapability } from "./service-capabilities.ts";

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
  vendorId?: string;
  driverId?: string;
  vendorCapacityRemaining?: number;
  driverCapacityRemaining?: number;
  reservationId?: string;
};

export type AvailabilityAssignmentOrder = AssignmentOrder & {
  orderId: string;
  serviceType?: string;
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
  return text(record.data.submissionType) === "vendor-application" && !/(paused|closed|unavailable|inactive|tomorrow)/.test(availability);
}

function isActiveDriver(record: AssignmentRecord) {
  const status = normalized(record.data.driverStatus) || normalized(record.data.availability);
  return text(record.data.submissionType) === "driver-onboarding" && !/(inactive|suspended|offboarded|paused|training|tomorrow)/.test(status);
}

function areaMatches(record: AssignmentRecord, area: string) {
  const wanted = normalized(area);
  const served = `${normalized(record.data.area)} ${normalized(record.data.routeArea)} ${normalized(record.data.zone)}`;
  if (!wanted || !served) return false;
  return wanted.split(/[\s,/-]+/).filter(Boolean).some((token) => token.length > 2 && served.includes(token));
}

function listMatches(values: string[], wanted: string) {
  const wantedText = wanted.toLowerCase();
  if (!wantedText) return true;
  if (values.length === 0) return false;
  return wantedText.split(/[\s,/-]+/).filter(Boolean).some((token) => token.length > 2 && values.some((value) => value.toLowerCase().includes(token)));
}

function statusAllowsVendor(vendor: VendorAvailability) {
  return vendor.capacityRemaining > 0 && !/(paused|closed|unavailable|inactive|suspended|tomorrow)/.test(vendor.availabilityStatus.toLowerCase());
}

function statusAllowsDriver(driver: DriverAvailability) {
  return driver.capacityRemaining > 0 && !/(inactive|suspended|offboarded|paused|training|tomorrow)/.test(driver.availabilityStatus.toLowerCase());
}

function serviceMatches(vendor: VendorAvailability, serviceType?: string) {
  const wanted = serviceCapability(serviceType ?? "");
  if (!wanted) return true;
  if (vendor.serviceTypes.length === 0) return false;
  return vendor.serviceTypes.some((service) => {
    const offered = serviceCapability(service);
    if (wanted === "wash-fold") return offered === "wash-fold" || offered === "wash-iron-fold";
    return offered === wanted;
  });
}

function selectAvailabilityVendor(area: string, serviceType: string | undefined, orderId: string) {
  const declinedVendorIds = new Set(listVendorDeclines(orderId).map((decline) => decline.vendorId));
  const available = listVendorAvailability().filter((vendor) => statusAllowsVendor(vendor) && serviceMatches(vendor, serviceType) && !declinedVendorIds.has(vendor.vendorId));
  return available.find((vendor) => listMatches(vendor.serviceZones, area));
}

function selectAvailabilityDriver(area: string) {
  const active = listDriverAvailability().filter(statusAllowsDriver);
  return active.find((driver) => listMatches(driver.serviceZones, area));
}

function selectVendor(records: AssignmentRecord[], area: string) {
  const available = latestFirst(records).filter(isVendorAvailable);
  return available.find((record) => areaMatches(record, area));
}

function selectDriver(records: AssignmentRecord[], area: string) {
  const active = latestFirst(records).filter(isActiveDriver);
  return active.find((record) => areaMatches(record, area));
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

export function assignOrderFromAvailability(order: AvailabilityAssignmentOrder): AssignmentPair {
  const vendorRow = isUnassigned(order.vendor) ? selectAvailabilityVendor(order.area, order.serviceType, order.orderId) : undefined;
  const driverRow = isUnassigned(order.driver) ? selectAvailabilityDriver(order.area) : undefined;
  const missing = [
    isUnassigned(order.vendor) && !vendorRow ? "vendor" : "",
    isUnassigned(order.driver) && !driverRow ? "driver" : "",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`No eligible ${missing.join(" or ")} matches ${order.area || "this order's route"}. Update approved coverage or capacity before assigning.`);
  }
  const { vendor: reservedVendor, driver: reservedDriver, reservationId } = reserveAssignmentCapacity(order.orderId, vendorRow?.vendorId, driverRow?.driverId);
  const vendorNameValue = isUnassigned(order.vendor) ? (reservedVendor?.vendorName ?? "Needs admin review") : order.vendor;
  const driverNameValue = isUnassigned(order.driver) ? (reservedDriver?.driverName ?? "Needs admin onboarding") : order.driver;

  const notes = [
    reservedVendor ? `Vendor table: ${reservedVendor.vendorName} · ${reservedVendor.availabilityStatus} · ${reservedVendor.capacityRemaining} capacity left.` : isUnassigned(order.vendor) ? "No available vendor table match." : `Vendor preserved: ${order.vendor}.`,
    reservedDriver ? `Driver table: ${reservedDriver.driverName} · ${reservedDriver.availabilityStatus} · ${reservedDriver.capacityRemaining} route slots left.` : isUnassigned(order.driver) ? "No active admin-onboarded driver table match." : `Driver preserved: ${order.driver}.`,
  ];

  return {
    vendorName: vendorNameValue,
    driverName: driverNameValue,
    assignmentNote: notes.join(" "),
    vendorId: reservedVendor?.vendorId,
    driverId: reservedDriver?.driverId,
    vendorCapacityRemaining: reservedVendor?.capacityRemaining,
    driverCapacityRemaining: reservedDriver?.capacityRemaining,
    reservationId,
  };
}
