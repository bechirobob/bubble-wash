import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { canAccess, getCurrentStaffUser, type StaffRole } from "@/lib/auth";
import { listVendorAvailability, upsertDriverAvailability, upsertVendorAvailability } from "@/lib/availability-store";
import { appendSubmissionRecord } from "@/lib/data-store";
import { dispatchSubmissionNotifications, notificationSummary } from "@/lib/notifications";
import { plans, zones } from "@/lib/pricing";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard, staffWriteGuard } from "@/lib/security";
import { parseServiceTypes } from "@/lib/service-capabilities";

const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const maxFieldLength = 1200;
const maxPublicPaymentAmount = 250000;
const planNames = new Set(plans.map((plan) => plan.name));
const zoneNames = new Set(Object.keys(zones));
const paymentPreferences = new Set(["MTN MoMo", "Telecel Cash", "Card", "Bank transfer", "Invoice me"]);
const paymentMethods = new Set(["MTN MoMo", "Telecel Cash", "Visa / Mastercard", "Bank transfer"]);
const alertPreferences = new Set(["Order tracking and phone follow-up", "Email + WhatsApp alerts", "WhatsApp only", "Email only", "Call me"]);
const pickupWindows = new Set(["Any available window", "Morning pickup", "Afternoon pickup", "Evening pickup"]);
const billingCycles = new Set(["Monthly", "Yearly"]);
const multiAdminModes = new Set(["Invite team leads", "Single admin only"]);
const accountGoals = new Set(["Start ordering this week", "Open account this week", "Need vendor coverage check"]);
const staffRosterRoles = new Set(["Support", "Admin", "Operations"]);
const staffRosterStatuses = new Set(["Active", "Training", "Pending checks", "Inactive"]);
const publicSubmissionTypes = new Set(["pickup-booking", "checkout-request", "client-onboarding"]);
const publicAllowedFields = new Set([
  "submissionType",
  "name",
  "email",
  "phone",
  "company",
  "area",
  "pickupAddress",
  "landmark",
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
  "requestedVendor",
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
  ["laundry-inventory-log", "admin"],
  ["vendor-application", "vendor"],
  ["vendor-job-update", "vendor"],
  ["qr-bag-intake", "vendor"],
  ["support-ticket", "support"],
  ["support-ticket-action", "support"],
  ["staff-onboarding", "admin"],
]);
const crossRoleStaffSubmissionTypes = new Set(["support-ticket"]);
const queueOnlySubmissionTypes = new Set(["admin-operation", "driver-route-log", "vendor-job-update", "qr-bag-intake"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (normalized.includes("tomorrow")) return "available-tomorrow";
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
      vendorId: text(body.vendorId) || undefined,
      vendorName: text(body.company) || text(body.vendorName) || text(body.name) || "Vendor partner",
      serviceZones: listFrom(body.area || body.zone || body.routeArea || body.serviceZones),
      serviceTypes: parseServiceTypes(body.services || body.service),
      capacityRemaining: numberFrom(body.capacity, 1),
      availabilityStatus: availabilityStatusFrom(body.availability),
      updatedBy: actorName,
      notes: text(body.message),
    });
  }

  if (submissionType === "driver-onboarding") {
    upsertDriverAvailability({
      driverId: text(body.driverId) || undefined,
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

function validateEnum(body: Record<string, unknown>, field: string, allowed: Set<string>, label: string) {
  const value = text(body[field]);
  if (value && !allowed.has(value)) return NextResponse.json({ ok: false, error: `Select a valid ${label}.` }, { status: 400 });
  return null;
}

function validatePublicPayload(body: Record<string, unknown>, submissionType: string) {
  if (!publicSubmissionTypes.has(submissionType)) return null;

  const forbiddenFields = Object.keys(body).filter((key) => !publicAllowedFields.has(key));
  if (forbiddenFields.length > 0) {
    return NextResponse.json({ ok: false, error: `Unsupported public field: ${forbiddenFields[0]}` }, { status: 400 });
  }

  const enumChecks = [
    validateEnum(body, "zone", zoneNames, "pickup zone"),
    validateEnum(body, "plan", planNames, "plan"),
    validateEnum(body, "preferredPlan", planNames, "preferred plan"),
    validateEnum(body, "paymentPreference", paymentPreferences, "payment preference"),
    validateEnum(body, "paymentMethod", paymentMethods, "payment method"),
    validateEnum(body, "alertPreference", alertPreferences, "alert preference"),
    validateEnum(body, "pickupWindow", pickupWindows, "pickup window"),
    validateEnum(body, "billingCycle", billingCycles, "billing cycle"),
    validateEnum(body, "multiAdmin", multiAdminModes, "team access mode"),
    validateEnum(body, "accountGoal", accountGoals, "account goal"),
  ];
  const enumError = enumChecks.find(Boolean);
  if (enumError) return enumError;

  if (submissionType === "pickup-booking" && process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED !== "true") {
    const paymentPreference = text(body.paymentPreference);
    if (paymentPreference && !["Bank transfer", "Invoice me"].includes(paymentPreference)) {
      return NextResponse.json({ ok: false, error: "Choose bank transfer or invoice for the pilot." }, { status: 400 });
    }
  }

  const kg = text(body.kg);
  if (kg) {
    const parsedKg = Number(kg);
    if (!Number.isFinite(parsedKg) || parsedKg <= 0 || parsedKg > 10000) {
      return NextResponse.json({ ok: false, error: "Enter a realistic laundry weight or request a custom quote." }, { status: 400 });
    }
  }

  const amountText = text(body.amount).replace(/[^\d.]/g, "");
  if (amountText) {
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0 || amount > maxPublicPaymentAmount) {
      return NextResponse.json({ ok: false, error: "Enter a valid payment amount or request invoice support." }, { status: 400 });
    }
  }

  const phone = text(body.phone).replace(/[\s()+-]/g, "");
  if (phone && (phone.length < 7 || phone.length > 16 || !/^\d+$/.test(phone))) {
    return NextResponse.json({ ok: false, error: "Enter a valid phone or WhatsApp number." }, { status: 400 });
  }

  const pickupDate = text(body.pickupDate);
  if (pickupDate && !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
    return NextResponse.json({ ok: false, error: "Enter a valid pickup date." }, { status: 400 });
  }
  if (pickupDate && pickupDate < new Date().toISOString().slice(0, 10)) {
    return NextResponse.json({ ok: false, error: "Choose today or a future pickup date." }, { status: 400 });
  }

  return null;
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
  const requestGuardError = sameOriginJsonGuard(request.headers, "submission");
  if (requestGuardError) return requestGuardError;
  if (isRateLimited(clientKey(request.headers, "submit"), 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many requests. Try again shortly." }, { status: 429 });
  }
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON submission payload." }, { status: 400 });
    }
    if (!isObject(rawBody)) {
      return NextResponse.json({ ok: false, error: "Invalid submission payload." }, { status: 400 });
    }
    const oversizedField = Object.entries(rawBody).find(([, value]) => typeof value === "string" && value.length > maxFieldLength);
    if (oversizedField) {
      return NextResponse.json({ ok: false, error: `Field too long: ${oversizedField[0]}` }, { status: 400 });
    }
    const submissionType = text(rawBody.submissionType);
    if (publicSubmissionTypes.has(submissionType)) {
      const forbiddenField = Object.keys(rawBody).find((key) => !publicAllowedFields.has(key));
      if (forbiddenField) {
        return NextResponse.json({ ok: false, error: `Unsupported public field: ${forbiddenField}` }, { status: 400 });
      }
    }
    const body = cleanPayload(rawBody, submissionType);
    if (!publicSubmissionTypes.has(submissionType)) {
      const staffGuardError = staffWriteGuard(request.headers);
      if (staffGuardError) return staffGuardError;
    }
    const authError = await authorizeSubmission(submissionType);
    if (authError) return authError;
    const staffUser = publicSubmissionTypes.has(submissionType) ? null : await getCurrentStaffUser();
    if (staffUser && queueOnlySubmissionTypes.has(submissionType)) {
      return NextResponse.json({ ok: false, error: "Use the verified action on the staff order queue for this update." }, { status: 400 });
    }
    if (staffUser) {
      if ((staffUser.role === "vendor" || staffUser.role === "driver") && process.env.NODE_ENV === "production" && !staffUser.entityId) {
        return NextResponse.json({ ok: false, error: "Staff roster binding is required." }, { status: 403 });
      }
      if (staffUser.role === "vendor" && staffUser.entityId) body.vendorId = staffUser.entityId;
      if (staffUser.role === "driver" && staffUser.entityId) body.driverId = staffUser.entityId;
      if (staffUser.role === "vendor" && submissionType === "vendor-application" && staffUser.entityId) {
        const boundVendor = listVendorAvailability().find((vendor) => vendor.vendorId === staffUser.entityId);
        if (!boundVendor) {
          return NextResponse.json({ ok: false, error: "The configured vendor roster entity was not found." }, { status: 409 });
        }
        body.vendorName = boundVendor.vendorName;
        body.company = boundVendor.vendorName;
      }
      body.submittedByName = staffUser.name;
      body.submittedByEmail = staffUser.email;
      body.submittedByRole = staffUser.role;

      const adminIsOnboarding = staffUser.role === "admin" && ["vendor-application", "driver-onboarding", "staff-onboarding"].includes(submissionType);
      if (!adminIsOnboarding) {
        body.name = staffUser.name;
        body.email = staffUser.email;
        body.company = text(body.company) || (staffUser.role === "vendor" ? "Vendor partner" : staffUser.role === "driver" ? "Bubble Wash Route Team" : staffUser.role === "support" ? "Bubble Wash Support" : "Bubble Wash Operations");
      }
    }
    const validationError = validatePublicPayload(body, submissionType);
    if (validationError) return validationError;

    if (submissionType === "vendor-application" && staffUser?.role === "admin") {
      const vendorName = text(body.company);
      const contactName = text(body.name);
      const contactEmail = text(body.email);
      const contactPhone = text(body.phone);
      const serviceArea = text(body.area);
      const services = text(body.services);
      const capacity = Number(text(body.capacity));
      if (!vendorName || !contactName || !contactEmail || !contactPhone || !serviceArea || !services || !text(body.message)) {
        return NextResponse.json({ ok: false, error: "Complete the vendor business, contact, coverage, service, capacity, and onboarding note." }, { status: 400 });
      }
      if (!emailPattern.test(contactEmail)) {
        return NextResponse.json({ ok: false, error: "Enter a valid vendor contact email." }, { status: 400 });
      }
      if (!Number.isInteger(capacity) || capacity < 0 || capacity > 10_000) {
        return NextResponse.json({ ok: false, error: "Vendor capacity must be a whole number between 0 and 10,000." }, { status: 400 });
      }
    }

    if (submissionType === "driver-onboarding") {
      const routeCapacity = Number(text(body.routeCapacity));
      if (!text(body.name) || !text(body.email) || !text(body.phone) || !text(body.area) || !text(body.vehicle) || !text(body.driverStatus) || !text(body.message)) {
        return NextResponse.json({ ok: false, error: "Complete the rider identity, contact, route coverage, vehicle, status, and onboarding note." }, { status: 400 });
      }
      if (!emailPattern.test(text(body.email))) {
        return NextResponse.json({ ok: false, error: "Enter a valid rider email." }, { status: 400 });
      }
      if (text(body.routeCapacity) && (!Number.isInteger(routeCapacity) || routeCapacity < 0 || routeCapacity > 10_000)) {
        return NextResponse.json({ ok: false, error: "Rider route capacity must be a whole number between 0 and 10,000." }, { status: 400 });
      }
    }

    if (submissionType === "staff-onboarding") {
      const staffName = text(body.staffName);
      const staffEmail = text(body.staffEmail);
      const staffPhone = text(body.staffPhone);
      const staffRole = text(body.staffRole);
      const employmentStatus = text(body.employmentStatus);
      const workArea = text(body.workArea);
      if (!staffName || !staffEmail || !staffPhone || !staffRole || !employmentStatus || !workArea) {
        return NextResponse.json({ ok: false, error: "Complete the staff member’s name, email, phone, role, status, and work area." }, { status: 400 });
      }
      if (!emailPattern.test(staffEmail)) {
        return NextResponse.json({ ok: false, error: "Enter a valid staff work email." }, { status: 400 });
      }
      if (!staffRosterRoles.has(staffRole) || !staffRosterStatuses.has(employmentStatus)) {
        return NextResponse.json({ ok: false, error: "Select a valid staff role and employment status." }, { status: 400 });
      }
    }

    const required = publicSubmissionTypes.has(submissionType) ? ["submissionType", "name", "email", "phone", "company"] : ["submissionType"];
    if (submissionType === "pickup-booking") required.push("pickupAddress");
    for (const field of required) {
      if (!text(body[field])) {
        return NextResponse.json({ ok: false, error: `Missing required field: ${field}` }, { status: 400 });
      }
    }
    if (text(body.email) && !emailPattern.test(text(body.email))) {
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
    if (publicSubmissionTypes.has(submissionType)) {
      return NextResponse.json({
        ok: true,
        message: "Thanks — your request was received. Keep this reference for tracking.",
        id: record.id,
      });
    }
    return NextResponse.json({ ok: true, message: `Thanks — your request was received. ${notificationSummary(notifications)}`, id: record.id, notifications });
  } catch (error) {
    console.error("Bubble Wash submission failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({ ok: false, error: "Unable to save submission." }, { status: 500 });
  }
}
