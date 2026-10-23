import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { getCurrentStaffUser } from "@/lib/auth";
import { appendSubmissionRecord, getDatabase } from "@/lib/data-store";
import { listVendorAvailability, listDriverAvailability, listVendorDeclines, upsertVendorAvailability, type VendorAvailability } from "@/lib/availability-store";
import { isRateLimited } from "@/lib/rate-limit";
import { capacityFreshness, recordCapacityConfirmation } from "@/lib/automation-store";

type Actor = NonNullable<Awaited<ReturnType<typeof getCurrentStaffUser>>>;
type Body = Record<string, unknown>;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" } });
class Rejected extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const reject = (status: number, message: string): never => { throw new Rejected(status, message); };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const statuses = ["available", "available-tomorrow", "limited", "paused"];
const choice = (value: unknown, allowed: string[]): value is string => typeof value === "string" && allowed.includes(value);
function fields(body: Body, allowed: string[]) { if (Object.keys(body).some((key) => !allowed.includes(key))) reject(400, "Unsupported command field."); }
function operationalDb() {
  const db = getDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_operations_receipts (scope TEXT NOT NULL, request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,request_key));`);
  return db;
}
function once(user: Actor, path: string, target: string, body: Body, operation: () => Body) {
  const key = text(body.idempotencyKey);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) reject(400, "Start a new command before submitting.");
  const scope = hash([user.email.toLowerCase(), user.role, user.entityId || "", path, target]);
  const payload = hash(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
  const db = operationalDb();
  return db.transaction(() => {
    const prior = db.prepare("SELECT payload_hash,response FROM mobile_operations_receipts WHERE scope=? AND request_key=?").get(scope, key) as { payload_hash: string; response: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== payload) reject(409, "This command key has already been used for different details.");
      return { ...JSON.parse(prior.response), replayed: true };
    }
    const result = operation();
    // Store only the small receipt, never GPS coordinates, case notes or case timelines.
    db.prepare("INSERT INTO mobile_operations_receipts VALUES (?,?,?,?,?)").run(scope, key, payload, JSON.stringify(result), new Date().toISOString());
    return result;
  }).immediate();
}
function vendorEditable(vendor: VendorAvailability) { return [...statuses, "active"].includes(vendor.availabilityStatus.toLowerCase()); }
function vendorView(vendor: VendorAvailability, user: Actor) {
  const capacityEditable = user.role === "vendor" && vendorEditable(vendor);
  return { ...vendor, revision: hash(vendor), capacityEditable, allowedStatuses: capacityEditable ? statuses : [], capacityFreshness: capacityFreshness(vendor.vendorId) };
}
function availability(user: Actor) {
  if ((user.role === "vendor" || user.role === "driver") && !user.entityId?.trim()) reject(403, "A bound staff identity is required.");
  const owns = (id: string) => id.toLowerCase() === user.entityId?.trim().toLowerCase();
  return { ok: true,
    vendors: (user.role === "admin" ? listVendorAvailability() : user.role === "vendor" ? listVendorAvailability().filter((vendor) => owns(vendor.vendorId)) : []).map((vendor) => vendorView(vendor, user)),
    drivers: user.role === "admin" ? listDriverAvailability() : user.role === "driver" ? listDriverAvailability().filter((driver) => owns(driver.driverId)) : [],
    declines: user.role === "admin" ? listVendorDeclines().slice(0, 50) : [],
  };
}
function capacity(user: Actor, body: Body, source: string) {
  if (user.role !== "vendor" || !user.entityId?.trim()) reject(403, "Only a bound vendor can update its own capacity.");
  fields(body, ["capacityRemaining", "availabilityStatus", "note", "expectedUpdatedAt", "expectedRevision", "idempotencyKey"]);
  if (typeof body.capacityRemaining !== "number" || !Number.isInteger(body.capacityRemaining) || body.capacityRemaining < 0 || body.capacityRemaining > 999 || !choice(body.availabilityStatus, statuses)) reject(400, "Choose a valid availability status and whole capacity from 0 to 999.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 600)) reject(400, "Use a note of up to 600 characters.");
  const entity = user.entityId!.trim();
  return once(user, "capacity", entity, body, () => {
    const current = listVendorAvailability().find((vendor) => vendor.vendorId.toLowerCase() === entity.toLowerCase());
    if (!current) reject(404, "Your vendor availability record is unavailable.");
    if (!vendorEditable(current!)) reject(403, "This vendor cannot reactivate its availability. Contact an administrator.");
    if (body.expectedUpdatedAt !== current!.updatedAt || body.expectedRevision !== hash(current)) reject(409, "Availability changed. Refresh before saving.");
    const updated = upsertVendorAvailability({ ...current!, capacityRemaining: body.capacityRemaining as number, availabilityStatus: String(body.availabilityStatus), notes: body.note === undefined ? current!.notes : text(body.note), updatedBy: user.email });
    recordCapacityConfirmation(current!.vendorId, user.email, updated.updatedAt);
    const id = `BW-${randomUUID()}`;
    appendSubmissionRecord({ id, createdAt: updated.updatedAt, source, data: { submissionType: "vendor-application", vendorId: current!.vendorId, vendorName: current!.vendorName, capacityRemaining: updated.capacityRemaining, availability: updated.availabilityStatus, message: text(body.note), submittedByEmail: user.email } });
    return { ok: true, id, revision: hash(updated), updatedAt: updated.updatedAt, message: "Availability updated." };
  });
}
export function vendorCapacityCommand(request: Request, user: Actor, body: Body): NextResponse {
  try {
    if (request.method === "POST" && isRateLimited(`mobile-operations:${user.email.toLowerCase()}`, 30, 60_000)) reject(429, "Too many actions. Try again shortly.");
    return json(request.method === "GET" ? availability(user) : capacity(user, body, "browser-vendor-capacity"));
  } catch (error) {
    if (error instanceof Rejected) return json({ ok: false, error: error.message }, error.status);
    throw error;
  }
}
