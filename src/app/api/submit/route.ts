import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { canAccess, getCurrentStaffUser, type StaffRole } from "@/lib/auth";
import { appendSubmissionRecord } from "@/lib/data-store";
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
  ["driver-route-log", "admin"],
  ["linen-inventory-log", "admin"],
  ["vendor-application", "vendor"],
  ["vendor-job-update", "vendor"],
  ["qr-bag-intake", "vendor"],
  ["support-ticket", "support"],
]);

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
      source: "bubblewash-next-pilot",
      data: body,
    };

    appendSubmissionRecord(record);
    return NextResponse.json({ ok: true, message: "Thanks — your request was received.", id: record.id });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to save submission." }, { status: 500 });
  }
}
