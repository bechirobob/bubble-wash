import { NextRequest, NextResponse } from "next/server";
import { encodeSession, findStaffUser, sanitizeNextPath, sessionCookieName, sessionCookieOptions } from "@/lib/auth";
import { clientKey, isRateLimited } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  if (isRateLimited(clientKey(request.headers, "login"), 10, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many login attempts. Try again shortly." }, { status: 429 });
  }
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const nextPath = sanitizeNextPath(typeof body.next === "string" ? body.next : undefined);
    const user = findStaffUser(email, password);

    if (!user) {
      return NextResponse.json({ ok: false, error: "Invalid Bubble Wash staff credentials." }, { status: 401 });
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
