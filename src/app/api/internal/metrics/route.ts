import { NextRequest, NextResponse } from "next/server";
import { databaseReadiness, operationsDataMetrics } from "@/lib/data-store";
import { maintenanceAuthorized } from "@/lib/maintenance-auth";

export async function GET(request: NextRequest) {
  if (!maintenanceAuthorized(request.headers)) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  return NextResponse.json({ ok: true, database: await databaseReadiness() ? "ready" : "failed", ...await operationsDataMetrics(), time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
