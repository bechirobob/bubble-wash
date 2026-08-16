import { NextResponse } from "next/server";

import { productionReadinessErrors } from "@/lib/security";

export async function GET() {
  const readinessErrors = productionReadinessErrors();
  const ok = readinessErrors.length === 0;
  return NextResponse.json({
    ok,
    service: "Bubble Wash operations app",
    version: "next-typescript",
    release: process.env.BUBBLEWASH_RELEASE_SHA ?? "local",
    deploymentPhase: process.env.BUBBLEWASH_DEPLOYMENT_PHASE ?? "local",
    time: new Date().toISOString(),
    readiness: ok ? "ready" : "blocked",
    checks: ok ? [] : readinessErrors,
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
