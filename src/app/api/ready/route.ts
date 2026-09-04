import { maintenanceAuthorized } from "@/lib/maintenance-auth";
import { bookingAvailable } from "@/lib/booking-policy";
import { NextRequest, NextResponse } from "next/server";

import { databaseReadiness } from "@/lib/data-store";
import { productionReadinessErrors, productionReadinessWarnings } from "@/lib/security";
import { backupReadiness } from "@/lib/backup-status";
import { adminMfaConfigured } from "@/lib/admin-mfa";
import { decodeSession, sessionCookieName, currentStaffUsers } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const blockers = productionReadinessErrors();
  blockers.push(...backupReadiness());
  try {
    if (!databaseReadiness()) blockers.push("The operations database did not pass its integrity/read check.");
  } catch (error) {
    console.error("Bubble Wash readiness database check failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    blockers.push("The operations database is unavailable.");
  }

  const ready = blockers.length === 0;
  let adminMfaReady = false;
  try {
    const admin = currentStaffUsers().find((user) => user.role === "admin");
    adminMfaReady = Boolean(admin && adminMfaConfigured(admin.email));
  } catch {
    adminMfaReady = false;
  }
  const warnings = productionReadinessWarnings().filter((warning) => {
    if (!warning.includes("MFA enrollment")) return true;
    return !adminMfaReady;
  });
  const detailed = maintenanceAuthorized(request.headers) || decodeSession(request.cookies.get(sessionCookieName)?.value)?.role === "admin";
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
