import { NextResponse } from "next/server";

import { productionReadinessErrors } from "@/lib/security";

export async function GET() {
  const readinessErrors = productionReadinessErrors();
  const ok = readinessErrors.length === 0;
  return NextResponse.json({
    ok,
    service: "Bubble Wash operations app",
    version: "next-typescript",
    time: new Date().toISOString(),
    readiness: ok ? "ready" : "blocked",
    checks: ok ? [] : readinessErrors,
  }, { status: ok ? 200 : 503 });
}
