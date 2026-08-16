import { NextRequest, NextResponse } from "next/server";
import { operationsDataMetrics, purgeOperationalData } from "@/lib/data-store";
import { maintenanceAuthorized } from "@/lib/maintenance-auth";
import { processNotificationOutbox } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";

export async function POST(request: NextRequest) {
  if (!maintenanceAuthorized(request.headers)) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  try {
    const delivered = await processNotificationOutbox(50);
    const purged = await purgeOperationalData();
    const metrics = await operationsDataMetrics();
    logEvent("info", "maintenance.completed", { deliveryAttempts: delivered.length, purged, metrics });
    return NextResponse.json({ ok: true, deliveryAttempts: delivered.length, purged, metrics, time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logEvent("error", "maintenance.failed", { errorType: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "Maintenance run failed." }, { status: 500 });
  }
}
