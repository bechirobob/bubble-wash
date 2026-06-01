import { NextResponse } from "next/server";
import { sessionCookieName, sessionCookieOptions } from "@/lib/auth";
import { staffWriteGuard } from "@/lib/security";

function clearStaffSession(response: NextResponse) {
  response.cookies.set({
    name: sessionCookieName,
    value: "",
    ...sessionCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
  response.cookies.delete(sessionCookieName);
  return response;
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use POST to sign out." }, { status: 405, headers: { Allow: "POST" } });
}

export async function POST(request: Request) {
  const staffGuardError = staffWriteGuard(request.headers);
  if (staffGuardError) return staffGuardError;
  return clearStaffSession(NextResponse.json({ ok: true }));
}
