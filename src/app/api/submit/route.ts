import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { canAccess, getCurrentStaffUser, type StaffRole } from "@/lib/auth";
import { upsertDriverAvailability, upsertVendorAvailability } from "@/lib/availability-store";
import { appendSubmissionRecord } from "@/lib/data-store";
import { dispatchSubmissionNotifications, notificationSummary } from "@/lib/notifications";
import { clientKey, isRateLimited } from "@/lib/rate-limit";

const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const maxFieldLength = 1200;
const publicSubmissionTypes = new Set(["pickup-booking", "checkout-request", "client-onboarding"]);
const publicAllowedFields = new Set([
  "submissionType",
  "name",
  "email",
  "phone",
  "company",
  "area",
  "zone",
  "plan",
  "preferredPlan",
  "service",
  "frequency",
  "pickupDate",
  "pickupWindow",
  "kg",
  "addons",
  "paymentPreference",
  "alertPreference",
  "amount",
  "paymentMethod",
  "locations",
  "legalBusinessName",
  "registrationNumber",
  "taxId",
  "authorizedSigner",
  "multiAdmin",
  "billingCycle",
  "accountGoal",
  "message",
]);
const staffSubmissionRoles = new Map<string, StaffRole>([
  ["admin-operation", "admin"],
  ["driver-route-log", "driver"],
  ["driver-onboarding", "admin"],
  ["linen-inventory-log", "admin"],
  ["vendor-application", "vendor"],
  ["vendor-job-update", "vendor"],
  ["qr-bag-intake", "vendor"],
  ["support-ticket", "support"],
  ["support-ticket-action", "support"],
]);
const crossRoleStaffSubmissionTypes = new Set(["support-ticket"]);

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberFrom(value: unknown, fallback = 0) {
  const matched = text(value).match(/\d+/);
  return matched ? Number(matched[0]) : fallback;
}

function listFrom(value: unknown) {
  return text(value).split(/[,+/]|\band\b/i).map((item) => item.trim()).filter(Boolean);
}

function availabilityStatusFrom(value: unknown, activeWord = "available") {
  const normalized = text(value).toLowerCase();
  if (normalized.includes("pause")) return "paused";
  if (normalized.includes("inactive")) return "inactive";
  if (normalized.includes("suspend")) return "suspended";
  if (normalized.includes("limited")) return "limited";
  if (normalized.includes("training")) return "training";
  if (normalized.includes("active")) return "active";
  return activeWord;
}

function syncAvailabilityTables(body: Record<string, unknown>, submissionType: string, actorName: string) {
  if (submissionType === "vendor-application") {
    upsertVendorAvailability({
      vendorName: text(body.company) || text(body.vendorName) || text(body.name) || "Vendor partner",
      serviceZones: listFrom(body.area || body.zone || body.routeArea || body.serviceZones),
      serviceTypes: listFrom(body.services || body.service),
      capacityRemaining: numberFrom(body.capacity, 1),
      availabilityStatus: availabilityStatusFrom(body.availability),
      updatedBy: actorName,
      notes: text(body.message),
    });
  }

  if (submissionType === "driver-onboarding") {
    upsertDriverAvailability({
      driverName: text(body.name) || text(body.driverName) || "Route driver",
      serviceZones: listFrom(body.area || body.routeArea || body.zone || body.serviceZones),
      vehicle: text(body.vehicle),
      capacityRemaining: numberFrom(body.capacity || body.routeCapacity, 4),
      availabilityStatus: availabilityStatusFrom(body.driverStatus || body.availability, "active"),
      updatedBy: actorName,
      notes: text(body.message),
    });
  }
}

function cleanPayload(body: Record<string, unknown>, submissionType: string) {
  const entries = Object.entries(body).filter(([key]) => !publicSubmissionTypes.has(submissionType) || publicAllowedFields.has(key));
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      return [key, value.trim().slice(0, maxFieldLength)];
    }),
  );
}

async function authorizeSubmission(submissionType: string) {
  if (publicSubmissionTypes.has(submissionType)) return null;
  const requiredRole = staffSubmissionRoles.get(submissionType);
  if (!requiredRole) return NextResponse.json({ ok: false, error: "Unsupported submission type." }, { status: 400 });
  const user = await getCurrentStaffUser();
  if (crossRoleStaffSubmissionTypes.has(submissionType)) {
    return user ? null : NextResponse.json({ ok: false, error: "Staff authorization required for this action." }, { status: 403 });
  }
  if (!user || !canAccess(user.role, requiredRole)) {
    return NextResponse.json({ ok: false, error: "Staff authorization required for this action." }, { status: 403 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (isRateLimited(clientKey(request.headers, "submit"), 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many requests. Try again shortly." }, { status: 429 });
  }
  try {
    const rawBody = await request.json();
    const submissionType = text(rawBody.submissionType);
    const body = cleanPayload(rawBody, submissionType);
    const authError = await authorizeSubmission(submissionType);
    if (authError) return authError;

    const required = ["submissionType", "name", "email", "phone", "company"];
    for (const field of required) {
      if (!text(body[field])) {
        return NextResponse.json({ ok: false, error: `Missing required field: ${field}` }, { status: 400 });
      }
    }
    if (!emailPattern.test(text(body.email))) {
      return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
    }

    const record = {
      id: `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      source: "bubblewash-operations-web",
      data: body,
    };

    appendSubmissionRecord(record);
    syncAvailabilityTables(body, submissionType, text(body.name) || text(body.company) || "Bubble Wash team");
    const notifications = await dispatchSubmissionNotifications(record);
    return NextResponse.json({ ok: true, message: `Thanks — your request was received. ${notificationSummary(notifications)}`, id: record.id, notifications });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to save submission." }, { status: 500 });
  }
}
