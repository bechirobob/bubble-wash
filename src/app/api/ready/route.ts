import { canManageStaffSecurity } from "@/lib/staff-security-access";
import { maintenanceAuthorized } from "@/lib/maintenance-auth";
import { bookingAvailable } from "@/lib/booking-policy";
import { NextRequest, NextResponse } from "next/server";

import { databaseReadiness, openReadOnlyDatabase } from "@/lib/data-store";
import { productionReadinessErrors, productionReadinessWarnings } from "@/lib/security";
import { backupReadiness } from "@/lib/backup-status";
import { adminMfaConfigured } from "@/lib/admin-mfa";
import { decodeSession, sessionCookieName, currentStaffUsers } from "@/lib/auth";

import { initializeStaffAccountsSchema } from "@/lib/staff-accounts";

export async function GET(request: NextRequest) {
  let database: ReturnType<typeof openReadOnlyDatabase>;
  try {
    database = openReadOnlyDatabase();
  } catch {
    return NextResponse.json({
      ok: false,
      service: "Bubble Wash operations app",
      readiness: "blocked",
      bookings: bookingAvailable() ? "accepting requests" : "paused",
      time: new Date().toISOString(),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return readinessResponse(request, database);
  } finally {
    database.close();
  }
}

function readinessResponse(request: NextRequest, database: ReturnType<typeof openReadOnlyDatabase>) {
  let staff: ReturnType<typeof currentStaffUsers> = [];
  let staffReadFailed = false;
  try { staff = currentStaffUsers(database); } catch { staffReadFailed = true; }
  const blockers = productionReadinessErrors(process.env, staff);
  if (staffReadFailed) blockers.push("The managed staff account store is unavailable.");
  blockers.push(...backupReadiness());
  try {
    if (!databaseReadiness(database, [initializeStaffAccountsSchema])) blockers.push("The operations database did not pass its integrity/read check.");
  } catch {
    console.error("Bubble Wash readiness database check failed");
    blockers.push("The operations database is unavailable.");
  }

  const ready = blockers.length === 0;
  let adminMfaReady = false;
  try {
    const admin = staff.find((user) => user.role === "admin");
    adminMfaReady = Boolean(admin && adminMfaConfigured(admin.email, database));
  } catch {
    adminMfaReady = false;
  }
  const warnings = productionReadinessWarnings().filter((warning) => {
    if (!warning.includes("MFA enrollment")) return true;
    return !adminMfaReady;
  });
  const detailed = maintenanceAuthorized(request.headers) || canManageStaffSecurity(decodeSession(request.cookies.get(sessionCookieName)?.value, staff, database));
  return NextResponse.json({
    ok: ready,
    service: "Bubble Wash operations app",
    readiness: ready ? "ready" : "blocked",
    bookings: bookingAvailable() ? "accepting requests" : "paused",
    ...(detailed ? { checks: ready ? [] : blockers, warnings } : {}),
    time: new Date().toISOString(),
  }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
