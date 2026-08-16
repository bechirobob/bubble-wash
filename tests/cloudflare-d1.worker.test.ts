import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendPaymentVerificationOnce,
  appendSubmissionRecord,
  appendSubmissionRecordWithDeliveryProof,
  claimMfaTimestep,
  claimWorkflowAction,
  consumeRateLimit,
  databaseReadiness,
  deliveryCodeRecord,
  findCheckoutByPaymentReference,
  readSubmissionRecordsForOrder,
  resetDataStoreForTests as resetOperationalData,
  storeDeliveryCode,
} from "../src/lib/data-store.ts";
import {
  appendSubmissionRecordAndReleaseOrderCapacity,
  listDriverAvailability,
  listVendorAvailability,
  recordVendorDecline,
  releaseAssignmentCapacity,
  reserveAssignmentCapacity,
  resetDataStoreForTests as resetAvailabilityData,
  upsertDriverAvailability,
  upsertVendorAvailability,
} from "../src/lib/availability-store.ts";
import { assignOrderFromAvailability } from "../src/lib/assignment.ts";
import { createPasswordHash, decodeSession, encodeSession, findStaffUser } from "../src/lib/auth.ts";
import { beginMigration, finalizeMigration } from "../src/lib/migration.ts";
import { migrationTableNames, migrationTables } from "../src/lib/migration-schema.js";
import { POST as login } from "../src/app/api/login/route.ts";

beforeEach(async () => {
  await resetAvailabilityData();
  await resetOperationalData();
  await env.DB.prepare("DELETE FROM staff_credentials").run();
});

describe("Cloudflare D1 runtime", () => {
  it("rehearses a parity-checked migration and restores the write triggers", async () => {
    const emptyDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("[]"))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const sourceSha = "a".repeat(40);
    const manifest = {
      version: 1 as const,
      runId: "bubblewash-worker-test-1",
      sourceSha,
      sourceDatabaseSha256: "b".repeat(64),
      tables: Object.fromEntries(migrationTableNames.map((name) => [name, { columns: [...migrationTables[name as keyof typeof migrationTables].columns], count: 0, sha256: emptyDigest }])),
    };
    expect(await beginMigration(manifest, sourceSha)).toMatchObject({ state: "importing" });
    expect(await finalizeMigration(manifest.runId, sourceSha)).toMatchObject({ state: "complete" });
    await upsertVendorAvailability({ vendorId: "vendor-trigger", vendorName: "Trigger Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + fold"], capacityRemaining: 1, availabilityStatus: "available", updatedBy: "Admin" });
    await upsertDriverAvailability({ driverId: "driver-trigger", driverName: "Trigger Rider", serviceZones: ["Osu"], capacityRemaining: 1, availabilityStatus: "active", updatedBy: "Admin" });
    await reserveAssignmentCapacity("BW-TRIGGER", "vendor-trigger", "driver-trigger");
    expect((await listVendorAvailability())[0].capacityRemaining).toBe(0);
    expect((await listDriverAvailability())[0].capacityRemaining).toBe(0);
  });

  it("applies the production schema and performs atomic rate and workflow claims", async () => {
    expect(await databaseReadiness()).toBe(true);
    expect((await consumeRateLimit("test:rate", 2, 60_000)).limited).toBe(false);
    expect((await consumeRateLimit("test:rate", 2, 60_000)).limited).toBe(false);
    expect((await consumeRateLimit("test:rate", 2, 60_000)).limited).toBe(true);
    const claim = { claimKey: "claim-1", orderId: "BW-1", actionKey: "assign", orderUpdatedAt: "2026-08-16T00:00:00.000Z" };
    expect(await claimWorkflowAction(claim)).toBe(true);
    expect(await claimWorkflowAction(claim)).toBe(false);
    expect(await claimMfaTimestep("admin@example.com", 10)).toBe(true);
    expect(await claimMfaTimestep("admin@example.com", 10)).toBe(false);
  });

  it("stores payment verification and its submission exactly once", async () => {
    const checkout = {
      id: "BW-CHECKOUT",
      createdAt: "2026-08-16T00:00:00.000Z",
      source: "test",
      data: { submissionType: "checkout-request", paymentReference: "PAY-1" },
    };
    await appendSubmissionRecord(checkout);
    expect((await findCheckoutByPaymentReference("PAY-1"))?.id).toBe(checkout.id);
    const input = {
      record: { id: "BW-VERIFY", createdAt: "2026-08-16T00:01:00.000Z", source: "test", data: { submissionType: "payment-update", orderId: checkout.id } },
      reference: "PAY-1",
      status: "success",
      transactionId: "12345678901234567890",
      amountMinor: 12500,
      currency: "GHS",
    };
    expect(await appendPaymentVerificationOnce(input)).toBe(true);
    expect(await appendPaymentVerificationOnce({ ...input, record: { ...input.record, id: "BW-VERIFY-DUP" } })).toBe(false);
    expect((await readSubmissionRecordsForOrder(checkout.id)).map((record) => record.id).sort()).toEqual(["BW-CHECKOUT", "BW-VERIFY"]);
  });

  it("rolls back a paired capacity reservation when one component is unavailable", async () => {
    await upsertVendorAvailability({ vendorId: "vendor-atomic", vendorName: "Atomic Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + fold"], capacityRemaining: 1, availabilityStatus: "available", updatedBy: "Admin" });
    await expect(reserveAssignmentCapacity("BW-ATOMIC", "vendor-atomic", "missing-driver")).rejects.toThrow(/Driver capacity is no longer available/u);
    expect((await listVendorAvailability())[0].capacityRemaining).toBe(1);
  });

  it("assigns matching service capacity and releases it exactly once", async () => {
    await upsertVendorAvailability({ vendorId: "vendor-osu", vendorName: "Osu Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + fold"], capacityRemaining: 2, availabilityStatus: "available", updatedBy: "Admin" });
    await upsertDriverAvailability({ driverId: "driver-osu", driverName: "Osu Rider", serviceZones: ["Osu"], capacityRemaining: 2, availabilityStatus: "active", updatedBy: "Admin" });
    const assigned = await assignOrderFromAvailability({ orderId: "BW-ASSIGN", area: "Osu", serviceType: "Wash + fold", vendor: "Unassigned", driver: "Unassigned" });
    expect(assigned).toMatchObject({ vendorId: "vendor-osu", driverId: "driver-osu", vendorCapacityRemaining: 1, driverCapacityRemaining: 1 });
    const released = await appendSubmissionRecordAndReleaseOrderCapacity({ id: "BW-CLOSE", createdAt: "2026-08-16T01:00:00.000Z", source: "test", data: { submissionType: "admin-operation", orderId: "BW-ASSIGN", orderStatus: "Closed" } }, "BW-ASSIGN");
    expect(released).toEqual({ vendorReleases: 1, driverReleases: 1 });
    expect(await releaseAssignmentCapacity(assigned.reservationId, "duplicate")).toEqual({ vendorReleases: 0, driverReleases: 0 });
    expect((await listVendorAvailability())[0].capacityRemaining).toBe(2);
    expect((await listDriverAvailability())[0].capacityRemaining).toBe(2);
  });

  it("records one vendor decline and never double-releases capacity", async () => {
    await upsertVendorAvailability({ vendorId: "vendor-decline", vendorName: "Decline Vendor", serviceZones: ["Osu"], serviceTypes: ["Wash + fold"], capacityRemaining: 2, availabilityStatus: "available", updatedBy: "Admin" });
    await upsertDriverAvailability({ driverId: "driver-decline", driverName: "Decline Rider", serviceZones: ["Osu"], capacityRemaining: 2, availabilityStatus: "active", updatedBy: "Admin" });
    await reserveAssignmentCapacity("BW-DECLINE", "vendor-decline", "driver-decline");
    const first = await recordVendorDecline({ orderId: "BW-DECLINE", vendorId: "vendor-decline", vendorName: "Decline Vendor", reason: "Machine outage", declinedBy: "Vendor" });
    const second = await recordVendorDecline({ orderId: "BW-DECLINE", vendorId: "vendor-decline", vendorName: "Decline Vendor", reason: "Duplicate", declinedBy: "Vendor" });
    expect(second.id).toBe(first.id);
    expect((await listVendorAvailability())[0].capacityRemaining).toBe(2);
    expect((await listDriverAvailability())[0].capacityRemaining).toBe(1);
  });

  it("consumes a delivery proof once and atomically appends its event", async () => {
    expect(await storeDeliveryCode("BW-DELIVERY", "proof-hash")).toBe(true);
    await appendSubmissionRecordWithDeliveryProof(
      { id: "BW-DELIVERED", createdAt: "2026-08-16T02:00:00.000Z", source: "test", data: { submissionType: "driver-route-log", orderId: "BW-DELIVERY" } },
      { orderId: "BW-DELIVERY", codeHash: "proof-hash", usedBy: "driver@example.com", recipientName: "Ama" },
    );
    expect((await deliveryCodeRecord("BW-DELIVERY"))?.usedBy).toBe("driver@example.com");
    await expect(appendSubmissionRecordWithDeliveryProof(
      { id: "BW-DELIVERED-AGAIN", createdAt: "2026-08-16T02:01:00.000Z", source: "test", data: { submissionType: "driver-route-log", orderId: "BW-DELIVERY" } },
      { orderId: "BW-DELIVERY", codeHash: "proof-hash", usedBy: "driver@example.com", recipientName: "Ama" },
    )).rejects.toThrow(/invalid or already used/u);
  });

  it("verifies inherited scrypt hashes and invalidates sessions when the D1 identity changes", async () => {
    const passwordHash = createPasswordHash("A-new-password-44!");
    await env.DB.prepare(`INSERT INTO staff_credentials (email, role, name, password_hash, entity_id, totp_secret, active, updated_at)
      VALUES (?, 'vendor', 'Vendor One', ?, 'vendor-one', NULL, 1, ?)`)
      .bind("vendor@example.com", passwordHash, new Date().toISOString()).run();
    const user = await findStaffUser("vendor@example.com", "A-new-password-44!");
    expect(user?.entityId).toBe("vendor-one");
    const session = encodeSession(user!);
    expect(await decodeSession(session)).toMatchObject({ role: "vendor", entityId: "vendor-one" });
    await env.DB.prepare("UPDATE staff_credentials SET entity_id = 'vendor-two' WHERE email = 'vendor@example.com'").run();
    expect(await decodeSession(session)).toBeNull();
  });

  it("rate-limits repeated login attempts by Cloudflare client identity", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await login(new Request("https://bubblewash.co/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://bubblewash.co",
          host: "bubblewash.co",
          "cf-connecting-ip": "203.0.113.77",
        },
        body: JSON.stringify({ email: "unknown@example.com", password: "incorrect" }),
      }) as never);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  });
});
