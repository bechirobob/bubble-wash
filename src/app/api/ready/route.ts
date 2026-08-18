import { NextResponse } from "next/server";

import { databaseReadiness } from "@/lib/data-store";
import { productionReadinessErrors, productionReadinessWarnings } from "@/lib/security";
import { backupReadiness } from "@/lib/backup-status";

export async function GET() {
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
  return NextResponse.json({
    ok: ready,
    service: "Bubble Wash operations app",
    readiness: ready ? "ready" : "blocked",
    checks: ready ? [] : blockers,
    warnings: productionReadinessWarnings(),
    time: new Date().toISOString(),
  }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
