import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const databasePath = process.env.BUBBLEWASH_DATABASE_PATH ?? path.join(dataDir, "bubblewash.sqlite");

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

export type VendorDeclineInput = {
  orderId: string;
  vendorId?: string;
  vendorName: string;
  reason: string;
  declinedBy: string;
};

export type VendorDecline = Required<Omit<VendorDeclineInput, "vendorId">> & {
  id: string;
  vendorId: string;
  createdAt: string;
};

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

let database: Database.Database | null = null;

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
  if (database) return database;
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_availability (
      vendor_id TEXT PRIMARY KEY,
      vendor_name TEXT NOT NULL,
      service_zones TEXT NOT NULL CHECK (json_valid(service_zones)),
      service_types TEXT NOT NULL CHECK (json_valid(service_types)),
      capacity_remaining INTEGER NOT NULL DEFAULT 0 CHECK (capacity_remaining >= 0),
      availability_status TEXT NOT NULL,
      next_available_at TEXT,
      updated_by TEXT NOT NULL,
      notes TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vendor_availability_status_capacity ON vendor_availability(availability_status, capacity_remaining);

    CREATE TABLE IF NOT EXISTS driver_availability (
      driver_id TEXT PRIMARY KEY,
      driver_name TEXT NOT NULL,
      service_zones TEXT NOT NULL CHECK (json_valid(service_zones)),
      vehicle TEXT,
      capacity_remaining INTEGER NOT NULL DEFAULT 0 CHECK (capacity_remaining >= 0),
      availability_status TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      notes TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_driver_availability_status_capacity ON driver_availability(availability_status, capacity_remaining);

    CREATE TABLE IF NOT EXISTS vendor_declines (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      vendor_id TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      declined_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vendor_declines_order_id ON vendor_declines(order_id);
  `);
  database = db;
  return db;
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

export function upsertVendorAvailability(input: VendorAvailabilityInput): VendorAvailability {
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
  getAvailabilityDatabase()
    .prepare(`
      INSERT INTO vendor_availability (vendor_id, vendor_name, service_zones, service_types, capacity_remaining, availability_status, next_available_at, updated_by, notes, updated_at)
      VALUES (@vendorId, @vendorName, @serviceZones, @serviceTypes, @capacityRemaining, @availabilityStatus, @nextAvailableAt, @updatedBy, @notes, @updatedAt)
      ON CONFLICT(vendor_id) DO UPDATE SET
        vendor_name = excluded.vendor_name,
        service_zones = excluded.service_zones,
        service_types = excluded.service_types,
        capacity_remaining = excluded.capacity_remaining,
        availability_status = excluded.availability_status,
        next_available_at = excluded.next_available_at,
        updated_by = excluded.updated_by,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `)
    .run(record);
  return listVendorAvailability().find((vendor) => vendor.vendorId === record.vendorId)!;
}

export function upsertDriverAvailability(input: DriverAvailabilityInput): DriverAvailability {
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
  getAvailabilityDatabase()
    .prepare(`
      INSERT INTO driver_availability (driver_id, driver_name, service_zones, vehicle, capacity_remaining, availability_status, updated_by, notes, updated_at)
      VALUES (@driverId, @driverName, @serviceZones, @vehicle, @capacityRemaining, @availabilityStatus, @updatedBy, @notes, @updatedAt)
      ON CONFLICT(driver_id) DO UPDATE SET
        driver_name = excluded.driver_name,
        service_zones = excluded.service_zones,
        vehicle = excluded.vehicle,
        capacity_remaining = excluded.capacity_remaining,
        availability_status = excluded.availability_status,
        updated_by = excluded.updated_by,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `)
    .run(record);
  return listDriverAvailability().find((driver) => driver.driverId === record.driverId)!;
}

export function listVendorAvailability(): VendorAvailability[] {
  const rows = getAvailabilityDatabase()
    .prepare("SELECT * FROM vendor_availability ORDER BY capacity_remaining DESC, updated_at DESC")
    .all() as VendorRow[];
  return rows.map(vendorFromRow);
}

export function listDriverAvailability(): DriverAvailability[] {
  const rows = getAvailabilityDatabase()
    .prepare("SELECT * FROM driver_availability ORDER BY capacity_remaining DESC, updated_at DESC")
    .all() as DriverRow[];
  return rows.map(driverFromRow);
}

export function reserveVendorCapacity(vendorId: string, orderId: string): VendorAvailability {
  void orderId;
  const db = getAvailabilityDatabase();
  const reserve = db.transaction(() => {
    const row = db.prepare("SELECT * FROM vendor_availability WHERE vendor_id = ?").get(vendorId) as VendorRow | undefined;
    if (!row) throw new Error("Vendor availability row not found.");
    const nextCapacity = Math.max(0, row.capacity_remaining - 1);
    db.prepare("UPDATE vendor_availability SET capacity_remaining = ?, updated_at = ? WHERE vendor_id = ?").run(nextCapacity, nowIso(), vendorId);
    return db.prepare("SELECT * FROM vendor_availability WHERE vendor_id = ?").get(vendorId) as VendorRow;
  });
  return vendorFromRow(reserve());
}

export function reserveDriverCapacity(driverId: string, orderId: string): DriverAvailability {
  void orderId;
  const db = getAvailabilityDatabase();
  const reserve = db.transaction(() => {
    const row = db.prepare("SELECT * FROM driver_availability WHERE driver_id = ?").get(driverId) as DriverRow | undefined;
    if (!row) throw new Error("Driver availability row not found.");
    const nextCapacity = Math.max(0, row.capacity_remaining - 1);
    db.prepare("UPDATE driver_availability SET capacity_remaining = ?, updated_at = ? WHERE driver_id = ?").run(nextCapacity, nowIso(), driverId);
    return db.prepare("SELECT * FROM driver_availability WHERE driver_id = ?").get(driverId) as DriverRow;
  });
  return driverFromRow(reserve());
}

export function reserveAssignmentCapacity(vendorId?: string, driverId?: string) {
  const db = getAvailabilityDatabase();
  const reserve = db.transaction(() => {
    let vendor: VendorAvailability | undefined;
    let driver: DriverAvailability | undefined;

    if (vendorId) {
      const row = db.prepare("SELECT * FROM vendor_availability WHERE vendor_id = ?").get(vendorId) as VendorRow | undefined;
      if (!row || row.capacity_remaining <= 0 || /(paused|closed|unavailable|inactive|suspended|tomorrow)/.test(row.availability_status.toLowerCase())) {
        throw new Error("Vendor capacity is no longer available.");
      }
      const updated = db.prepare("UPDATE vendor_availability SET capacity_remaining = capacity_remaining - 1, updated_at = ? WHERE vendor_id = ? AND capacity_remaining > 0")
        .run(nowIso(), vendorId);
      if (updated.changes !== 1) throw new Error("Vendor capacity is no longer available.");
      vendor = vendorFromRow(db.prepare("SELECT * FROM vendor_availability WHERE vendor_id = ?").get(vendorId) as VendorRow);
    }

    if (driverId) {
      const row = db.prepare("SELECT * FROM driver_availability WHERE driver_id = ?").get(driverId) as DriverRow | undefined;
      if (!row || row.capacity_remaining <= 0 || /(inactive|suspended|offboarded|paused|training|tomorrow)/.test(row.availability_status.toLowerCase())) {
        throw new Error("Driver capacity is no longer available.");
      }
      const updated = db.prepare("UPDATE driver_availability SET capacity_remaining = capacity_remaining - 1, updated_at = ? WHERE driver_id = ? AND capacity_remaining > 0")
        .run(nowIso(), driverId);
      if (updated.changes !== 1) throw new Error("Driver capacity is no longer available.");
      driver = driverFromRow(db.prepare("SELECT * FROM driver_availability WHERE driver_id = ?").get(driverId) as DriverRow);
    }

    return { vendor, driver };
  });
  return reserve.immediate();
}

export function releaseAssignmentCapacity(vendorId?: string, driverId?: string) {
  const db = getAvailabilityDatabase();
  const release = db.transaction(() => {
    const updatedAt = nowIso();
    if (vendorId) {
      db.prepare("UPDATE vendor_availability SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = ? WHERE vendor_id = ?")
        .run(updatedAt, vendorId);
    }
    if (driverId) {
      db.prepare("UPDATE driver_availability SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = ? WHERE driver_id = ?")
        .run(updatedAt, driverId);
    }
  });
  release.immediate();
}

export function recordVendorDecline(input: VendorDeclineInput): VendorDecline {
  const vendorName = input.vendorName.trim() || "Vendor partner";
  const vendorId = input.vendorId?.trim() || `vendor-${slug(vendorName, "partner")}`;
  const record = {
    id: `VD-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
    orderId: input.orderId.trim(),
    vendorId,
    vendorName,
    reason: input.reason.trim() || "Vendor declined assignment.",
    declinedBy: input.declinedBy.trim() || "Vendor user",
    createdAt: nowIso(),
  };
  const db = getAvailabilityDatabase();
  const save = db.transaction(() => {
    const existing = db.prepare("SELECT * FROM vendor_declines WHERE order_id = ? AND vendor_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(record.orderId, vendorId) as DeclineRow | undefined;
    if (existing) return declineFromRow(existing);
    db.prepare("INSERT INTO vendor_declines (id, order_id, vendor_id, vendor_name, reason, declined_by, created_at) VALUES (@id, @orderId, @vendorId, @vendorName, @reason, @declinedBy, @createdAt)").run(record);
    db.prepare("UPDATE vendor_availability SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = ? WHERE vendor_id = ?").run(record.createdAt, vendorId);
    return record;
  });
  return save.immediate();
}

export function listVendorDeclines(orderId?: string): VendorDecline[] {
  const rows = orderId
    ? getAvailabilityDatabase().prepare("SELECT * FROM vendor_declines WHERE order_id = ? ORDER BY created_at DESC").all(orderId)
    : getAvailabilityDatabase().prepare("SELECT * FROM vendor_declines ORDER BY created_at DESC").all();
  return (rows as DeclineRow[]).map(declineFromRow);
}

export function resetDataStoreForTests() {
  const db = getAvailabilityDatabase();
  db.prepare("DELETE FROM vendor_declines").run();
  db.prepare("DELETE FROM vendor_availability").run();
  db.prepare("DELETE FROM driver_availability").run();
}
