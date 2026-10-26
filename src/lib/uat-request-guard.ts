import "server-only";
import { NextResponse } from "next/server";
import { getCurrentStaffUser } from "./auth.ts";
import { uatModeEnabled } from "./uat-environment.ts";

/** Additional UAT admission only; never replaces customer ownership checks. */
export async function uatRequestGuard() {
  if (!uatModeEnabled() || (await getCurrentStaffUser())?.temporaryAccess) return null;
  return NextResponse.json({ ok: false, error: "Sign in with an active test account to use the UAT site." }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
