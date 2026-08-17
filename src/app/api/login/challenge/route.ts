import { NextRequest, NextResponse } from "next/server";
import { createStaffLoginChallenge } from "@/lib/auth";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { staffWriteGuard } from "@/lib/security";

const authenticationHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: authenticationHeaders });
}

export async function POST(request: NextRequest) {
  const staffGuardError = staffWriteGuard(request.headers);
  if (staffGuardError) return staffGuardError;
  if (await isRateLimited(clientKey(request.headers, "login:challenge"), 10, 60_000)) {
    return response({ ok: false, error: "Too many login attempts. Try again shortly." }, 429);
  }
  try {
    const body = await request.json<Record<string, unknown>>();
    const email = typeof body.email === "string" ? body.email : "";
    const result = await createStaffLoginChallenge(email);
    if (!result) return response({ ok: false, error: "Enter a valid staff email." }, 400);
    return response({ ok: true, ...result });
  } catch {
    return response({ ok: false, error: "Unable to begin sign in." }, 500);
  }
}
