import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaffUser, type StaffRole } from "@/lib/auth";
import { staffWriteGuard } from "@/lib/security";
import { createUatTeamAccount, listUatTeam, revokeUatTeamAccount } from "@/lib/uat-accounts";
import { uatModeEnabled } from "@/lib/uat-environment";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
const headers = { "Cache-Control": "no-store" };
async function administrator() {
  if (!uatModeEnabled()) return null;
  const user = await getCurrentStaffUser();
  return user?.role === "admin" && user.temporaryAccess ? user : null;
}
export async function GET() {
  const user = await administrator();
  if (!user) return NextResponse.json({ ok: false }, { status: 403, headers });
  try { return NextResponse.json({ ok: true, ...listUatTeam(user) }, { headers }); }
  catch { return NextResponse.json({ ok: false, error: "Test user access is unavailable." }, { status: 403, headers }); }
}
export async function POST(request: NextRequest) {
  const guard = staffWriteGuard(request.headers); if (guard) return guard;
  const user = await administrator();
  if (!user) return NextResponse.json({ ok: false }, { status: 403, headers });
  if (isRateLimited(clientKey(request.headers, "uat-account-write"), 20, 60_000)) return NextResponse.json({ ok: false, error: "Too many account changes. Try again shortly." }, { status: 429, headers });
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    const username = typeof body.username === "string" ? body.username : "";
    if (body.action === "revoke") {
      revokeUatTeamAccount(username, user);
      return NextResponse.json({ ok: true, message: "Test access revoked. Existing sessions can no longer be used." }, { headers });
    }
    if (body.action !== "create" || Object.keys(body).some(key => !["action", "username", "name", "role", "entityId", "password"].includes(key))) throw new Error();
    const input = { username, name: typeof body.name === "string" ? body.name : "", role: body.role as StaffRole,
      entityId: typeof body.entityId === "string" ? body.entityId : "", password: typeof body.password === "string" ? body.password : "" };
    const account = createUatTeamAccount(input, user);
    return NextResponse.json({ ok: true, account, message: "Test user created. Share their username and password privately. Access ends with this test period." }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to update test access. Check the username, role, staff record, password and remaining account allowance." }, { status: 400, headers });
  }
}
