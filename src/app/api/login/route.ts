import { NextRequest, NextResponse } from "next/server";
import { encodeSession, findStaffUser, sanitizeNextPath, sessionCookieName, sessionCookieOptions } from "@/lib/auth";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { staffWriteGuard } from "@/lib/security";
import { claimMfaTimestep } from "@/lib/data-store";
import { validTotpSecret, verifyTotp } from "@/lib/totp";

export async function POST(request: NextRequest) {
  const staffGuardError = staffWriteGuard(request.headers);
  if (staffGuardError) return staffGuardError;
  if (await isRateLimited(clientKey(request.headers, "login"), 10, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many login attempts. Try again shortly." }, { status: 429 });
  }
  try {
    const body = await request.json<Record<string, unknown>>();
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const totp = typeof body.totp === "string" ? body.totp.trim() : "";
    const nextPath = sanitizeNextPath(typeof body.next === "string" ? body.next : undefined);
    const user = await findStaffUser(email, password);

    if (!user) {
      return NextResponse.json({ ok: false, error: "Invalid Bubble Wash staff credentials." }, { status: 401 });
    }

    if (user.role === "admin") {
      const secret = user.totpSecret ?? "";
      if (!validTotpSecret(secret)) {
        if (process.env.NODE_ENV === "production") {
          return NextResponse.json({ ok: false, error: "Admin sign-in is temporarily unavailable." }, { status: 503 });
        }
      } else {
        const timestep = verifyTotp(totp, secret);
        if (timestep === null || !await claimMfaTimestep(user.email.toLowerCase(), timestep)) {
          return NextResponse.json({ ok: false, error: "Invalid Bubble Wash staff credentials." }, { status: 401 });
        }
      }
    }

    const response = NextResponse.json({ ok: true, user: { name: user.name, email: user.email, role: user.role }, next: nextPath });
    response.cookies.set({
      name: sessionCookieName,
      value: encodeSession(user),
      ...sessionCookieOptions(),
    });
    return response;
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to sign in." }, { status: 500 });
  }
}
