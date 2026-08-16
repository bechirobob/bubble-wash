import { randomUUID } from "node:crypto";
import { getDatabase } from "./data-store.ts";

export type AvailabilityStatus = "available" | "limited" | "paused" | "inactive" | "active" | "training" | "suspended";

export type VendorAvailabilityInput = {
  vendorId?: string;
  vendorName: string;
  serviceZones?: string[];
  serviceTypes?: string[];
  capacityRemaining: number;
  availabilityStatus: AvailabilityStatus | string;
  nextAvailableAt?: string;
  updatedBy: string;
  notes?: string;
};

export type DriverAvailabilityInput = {
  driverId?: string;
  driverName: string;
  serviceZones?: string[];
  vehicle?: string;
  capacityRemaining: number;
  availabilityStatus: AvailabilityStatus | string;
  updatedBy: string;
  notes?: string;
};

export type VendorAvailability = Required<Omit<VendorAvailabilityInput, "vendorId" | "serviceZones" | "serviceTypes" | "nextAvailableAt" | "notes">> & {
  vendorId: string;
  serviceZones: string[];
  serviceTypes: string[];
  nextAvailableAt?: string;
  notes?: string;
  updatedAt: string;
};

export type DriverAvailability = Required<Omit<DriverAvailabilityInput, "driverId" | "serviceZones" | "vehicle" | "notes">> & {
  driverId: string;
  serviceZones: string[];
  vehicle?: string;
  notes?: string;
  updatedAt: string;
};

export type VendorDeclineInput = { orderId: string; vendorId?: string; vendorName: string; reason: string; declinedBy: string };
export type VendorDecline = Required<Omit<VendorDeclineInput, "vendorId">> & { id: string; vendorId: string; createdAt: string };
export type CapacityReleaseResult = { vendorReleases: number; driverReleases: number };

type VendorRow = {
  vendor_id: string;
  vendor_name: string;
  service_zones: string;
  service_types: string;
  capacity_remaining: number;
  availability_status: string;
  next_available_at: string | null;
  updated_by: string;
  notes: string | null;
  updated_at: string;
};

type DriverRow = {
  driver_id: string;
  driver_name: string;
  service_zones: string;
  vehicle: string | null;
  capacity_remaining: number;
  availability_status: string;
  updated_by: string;
  notes: string | null;
  updated_at: string;
};

type DeclineRow = {
  id: string;
  order_id: string;
  vendor_id: string;
  vendor_name: string;
  reason: string;
  declined_by: string;
  created_at: string;
};

type ReservationRow = {
  reservation_id: string;
  order_id: string;
  vendor_id: string | null;
  driver_id: string | null;
  vendor_released_at: string | null;
  driver_released_at: string | null;
  release_reason: string | null;
  created_at: string;
};

function slug(value: string, fallback: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || fallback;
}

function normalizeList(values?: string[]) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function listFromJson(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clampCapacity(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(999, Math.floor(value)));
}

export function getAvailabilityDatabase() {
  return getDatabase();
}

function vendorFromRow(row: VendorRow): VendorAvailability {
  return {
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    serviceZones: listFromJson(row.service_zones),
    serviceTypes: listFromJson(row.service_types),
    capacityRemaining: row.capacity_remaining,
    availabilityStatus: row.availability_status,
    nextAvailableAt: row.next_available_at ?? undefined,
    updatedBy: row.updated_by,
    notes: row.notes ?? undefined,
    updatedAt: row.updated_at,
  };
}

function driverFromRow(row: DriverRow): DriverAvailability {
  return {
    driverId: row.driver_id,
    driverName: row.driver_name,
    serviceZones: listFromJson(row.service_zones),
    vehicle: row.vehicle ?? undefined,
    capacityRemaining: row.capacity_remaining,
    availabilityStatus: row.availability_status,
    updatedBy: row.updated_by,
    notes: row.notes ?? undefined,
    updatedAt: row.updated_at,
  };
}

function declineFromRow(row: DeclineRow): VendorDecline {
  return {
    id: row.id,
    orderId: row.order_id,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    reason: row.reason,
    declinedBy: row.declined_by,
    createdAt: row.created_at,
  };
}

export async function upsertVendorAvailability(input: VendorAvailabilityInput): Promise<VendorAvailability> {
  const vendorName = input.vendorName.trim() || "Vendor partner";
  const record = {
    vendorId: input.vendorId?.trim() || `vendor-${slug(vendorName, "partner")}`,
    vendorName,
    serviceZones: JSON.stringify(normalizeList(input.serviceZones)),
    serviceTypes: JSON.stringify(normalizeList(input.serviceTypes)),
    capacityRemaining: clampCapacity(input.capacityRemaining),
    availabilityStatus: input.availabilityStatus.trim().toLowerCase() || "available",
    nextAvailableAt: input.nextAvailableAt?.trim() || null,
    updatedBy: input.updatedBy.trim() || "System",
    notes: input.notes?.trim() || null,
    updatedAt: nowIso(),
  };
  const row = await getDatabase().prepare(`
    INSERT INTO vendor_availability
      (vendor_id, vendor_name, service_zones, service_types, capacity_remaining, availability_status, next_available_at, updated_by, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vendor_id) DO UPDATE SET vendor_name = excluded.vendor_name,
      service_zones = excluded.service_zones, service_types = excluded.service_types,
      capacity_remaining = excluded.capacity_remaining, availability_status = excluded.availability_status,
      next_available_at = excluded.next_available_at, updated_by = excluded.updated_by,
      notes = excluded.notes, updated_at = excluded.updated_at RETURNING *
  `).bind(
    record.vendorId, record.vendorName, record.serviceZones, record.serviceTypes,
    record.capacityRemaining, record.availabilityStatus, record.nextAvailableAt,
    record.updatedBy, record.notes, record.updatedAt,
  ).first<VendorRow>();
  if (!row) throw new Error("Vendor availability was not stored.");
  return vendorFromRow(row);
}

export async function upsertDriverAvailability(input: DriverAvailabilityInput): Promise<DriverAvailability> {
  const driverName = input.driverName.trim() || "Route driver";
  const record = {
    driverId: input.driverId?.trim() || `driver-${slug(driverName, "route")}`,
    driverName,
    serviceZones: JSON.stringify(normalizeList(input.serviceZones)),
    vehicle: input.vehicle?.trim() || null,
    capacityRemaining: clampCapacity(input.capacityRemaining),
    availabilityStatus: input.availabilityStatus.trim().toLowerCase() || "active",
    updatedBy: input.updatedBy.trim() || "System",
    notes: input.notes?.trim() || null,
    updatedAt: nowIso(),
  };
  const row = await getDatabase().prepare(`
    INSERT INTO driver_availability
      (driver_id, driver_name, service_zones, vehicle, capacity_remaining, availability_status, updated_by, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(driver_id) DO UPDATE SET driver_name = excluded.driver_name,
      service_zones = excluded.service_zones, vehicle = excluded.vehicle,
      capacity_remaining = excluded.capacity_remaining, availability_status = excluded.availability_status,
      updated_by = excluded.updated_by, notes = excluded.notes, updated_at = excluded.updated_at RETURNING *
  `).bind(
    record.driverId, record.driverName, record.serviceZones, record.vehicle,
    record.capacityRemaining, record.availabilityStatus, record.updatedBy, record.notes, record.updatedAt,
  ).first<DriverRow>();
  if (!row) throw new Error("Driver availability was not stored.");
  return driverFromRow(row);
}

export async function listVendorAvailability(): Promise<VendorAvailability[]> {
  const result = await getDatabase().prepare(
    "SELECT * FROM vendor_availability ORDER BY capacity_remaining DESC, updated_at DESC",
  ).all<VendorRow>();
  return result.results.map(vendorFromRow);
}

export async function listDriverAvailability(): Promise<DriverAvailability[]> {
  const result = await getDatabase().prepare(
    "SELECT * FROM driver_availability ORDER BY capacity_remaining DESC, updated_at DESC",
  ).all<DriverRow>();
  return result.results.map(driverFromRow);
}

export async function reserveVendorCapacity(vendorId: string, orderId: string): Promise<VendorAvailability> {
  void orderId;
  const row = await getDatabase().prepare(`
    UPDATE vendor_availability SET capacity_remaining = capacity_remaining - 1, updated_at = ?
    WHERE vendor_id = ? AND capacity_remaining > 0 RETURNING *
  `).bind(nowIso(), vendorId).first<VendorRow>();
  if (!row) throw new Error("Vendor availability row not found or has no capacity.");
  return vendorFromRow(row);
}

export async function reserveDriverCapacity(driverId: string, orderId: string): Promise<DriverAvailability> {
  void orderId;
  const row = await getDatabase().prepare(`
    UPDATE driver_availability SET capacity_remaining = capacity_remaining - 1, updated_at = ?
    WHERE driver_id = ? AND capacity_remaining > 0 RETURNING *
  `).bind(nowIso(), driverId).first<DriverRow>();
  if (!row) throw new Error("Driver availability row not found or has no capacity.");
  return driverFromRow(row);
}

export async function reserveAssignmentCapacity(orderId: string, vendorId?: string, driverId?: string) {
  const normalizedOrderId = orderId.trim();
  if ((vendorId || driverId) && !normalizedOrderId) throw new Error("Order ID is required for a capacity reservation.");
  if (!vendorId && !driverId) return { vendor: undefined, driver: undefined, reservationId: undefined };
  const reservationId = `AR-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
  const createdAt = nowIso();
  await getDatabase().prepare(`
    INSERT INTO assignment_capacity_reservations
      (reservation_id, order_id, vendor_id, driver_id, vendor_released_at, driver_released_at, release_reason, created_at)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
  `).bind(reservationId, normalizedOrderId, vendorId ?? null, driverId ?? null, createdAt).run();
  const [vendorRow, driverRow] = await Promise.all([
    vendorId ? getDatabase().prepare("SELECT * FROM vendor_availability WHERE vendor_id = ?").bind(vendorId).first<VendorRow>() : undefined,
    driverId ? getDatabase().prepare("SELECT * FROM driver_availability WHERE driver_id = ?").bind(driverId).first<DriverRow>() : undefined,
  ]);
  return {
    vendor: vendorRow ? vendorFromRow(vendorRow) : undefined,
    driver: driverRow ? driverFromRow(driverRow) : undefined,
    reservationId,
  };
}

export async function releaseAssignmentCapacity(reservationId?: string, reason = "workflow-rollback"): Promise<CapacityReleaseResult> {
  if (!reservationId) return { vendorReleases: 0, driverReleases: 0 };
  const db = getDatabase();
  const row = await db.prepare("SELECT * FROM assignment_capacity_reservations WHERE reservation_id = ? LIMIT 1")
    .bind(reservationId).first<ReservationRow>();
  if (!row) return { vendorReleases: 0, driverReleases: 0 };
  const releasedAt = nowIso();
  await db.prepare(`
    UPDATE assignment_capacity_reservations
    SET vendor_released_at = CASE WHEN vendor_released_at IS NULL AND vendor_id IS NOT NULL THEN ? ELSE vendor_released_at END,
        driver_released_at = CASE WHEN driver_released_at IS NULL AND driver_id IS NOT NULL THEN ? ELSE driver_released_at END,
        release_reason = ?
    WHERE reservation_id = ?
  `).bind(releasedAt, releasedAt, reason, reservationId).run();
  return {
    vendorReleases: row.vendor_id && !row.vendor_released_at ? 1 : 0,
    driverReleases: row.driver_id && !row.driver_released_at ? 1 : 0,
  };
}

export async function appendSubmissionRecordAndReleaseOrderCapacity(
  record: { id: string; createdAt: string; source?: string; data: Record<string, unknown> },
  orderId: string,
  vendorId?: string,
  driverId?: string,
): Promise<CapacityReleaseResult> {
  void vendorId;
  void driverId;
  const db = getDatabase();
  const normalizedOrderId = orderId.trim();
  const counts = await db.prepare(`
    SELECT SUM(CASE WHEN vendor_id IS NOT NULL AND vendor_released_at IS NULL THEN 1 ELSE 0 END) AS vendorReleases,
           SUM(CASE WHEN driver_id IS NOT NULL AND driver_released_at IS NULL THEN 1 ELSE 0 END) AS driverReleases
    FROM assignment_capacity_reservations WHERE order_id = ? COLLATE NOCASE
  `).bind(normalizedOrderId).first<{ vendorReleases: number | null; driverReleases: number | null }>();
  await db.batch([
    db.prepare("INSERT INTO submissions (id, created_at, source, data) VALUES (?, ?, ?, ?)")
      .bind(record.id, record.createdAt, record.source ?? null, JSON.stringify(record.data)),
    db.prepare(`
      UPDATE assignment_capacity_reservations
      SET vendor_released_at = CASE WHEN vendor_released_at IS NULL AND vendor_id IS NOT NULL THEN ? ELSE vendor_released_at END,
          driver_released_at = CASE WHEN driver_released_at IS NULL AND driver_id IS NOT NULL THEN ? ELSE driver_released_at END,
          release_reason = 'order-closed'
      WHERE order_id = ? COLLATE NOCASE
    `).bind(record.createdAt, record.createdAt, normalizedOrderId),
  ]);
  return { vendorReleases: counts?.vendorReleases ?? 0, driverReleases: counts?.driverReleases ?? 0 };
}

export async function recordVendorDecline(input: VendorDeclineInput): Promise<VendorDecline> {
  const vendorName = input.vendorName.trim() || "Vendor partner";
  const vendorId = input.vendorId?.trim() || `vendor-${slug(vendorName, "partner")}`;
  const existing = await getDatabase().prepare(
    "SELECT * FROM vendor_declines WHERE order_id = ? COLLATE NOCASE AND vendor_id = ? LIMIT 1",
  ).bind(input.orderId.trim(), vendorId).first<DeclineRow>();
  if (existing) return declineFromRow(existing);
  const record = {
    id: `VD-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
    orderId: input.orderId.trim(),
    vendorId,
    vendorName,
    reason: input.reason.trim() || "Vendor declined assignment.",
    declinedBy: input.declinedBy.trim() || "Vendor user",
    createdAt: nowIso(),
  };
  const db = getDatabase();
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO vendor_declines (id, order_id, vendor_id, vendor_name, reason, declined_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(record.id, record.orderId, record.vendorId, record.vendorName, record.reason, record.declinedBy, record.createdAt),
    db.prepare(`
      UPDATE assignment_capacity_reservations
      SET vendor_released_at = ?, release_reason = 'vendor-decline'
      WHERE order_id = ? COLLATE NOCASE AND vendor_id = ? AND vendor_released_at IS NULL
    `).bind(record.createdAt, record.orderId, record.vendorId),
  ]);
  const saved = await db.prepare(
    "SELECT * FROM vendor_declines WHERE order_id = ? COLLATE NOCASE AND vendor_id = ? LIMIT 1",
  ).bind(record.orderId, record.vendorId).first<DeclineRow>();
  if (!saved) throw new Error("Vendor decline was not stored.");
  return declineFromRow(saved);
}

export async function listVendorDeclines(orderId?: string): Promise<VendorDecline[]> {
  const statement = orderId
    ? getDatabase().prepare("SELECT * FROM vendor_declines WHERE order_id = ? COLLATE NOCASE ORDER BY created_at DESC").bind(orderId)
    : getDatabase().prepare("SELECT * FROM vendor_declines ORDER BY created_at DESC");
  const result = await statement.all<DeclineRow>();
  return result.results.map(declineFromRow);
}

export async function resetDataStoreForTests() {
  const db = getDatabase();
  await db.batch([
    "assignment_capacity_reservations", "vendor_declines", "vendor_availability", "driver_availability",
  ].map((table) => db.prepare(`DELETE FROM ${table}`)));
}
