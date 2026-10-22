import { NextRequest, NextResponse } from "next/server";
import { encodeSession, findStaffUser, sanitizeNextPath, sessionCookieName, sessionCookieOptions, staffAccessDisabled } from "@/lib/auth";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { adminMfaRequired, staffWriteGuard } from "@/lib/security";
import { adminMfaConfigured, adminMfaEnrollmentExists, verifyAdminMfaCredential } from "@/lib/admin-mfa";

export async function POST(request: NextRequest) {
  const staffGuardError = staffWriteGuard(request.headers);
  if (staffGuardError) return staffGuardError;
  if (staffAccessDisabled()) {
    const response = NextResponse.json({ ok: false, error: "Login cannot be reached." }, { status: 503 });
    response.cookies.set({ name: sessionCookieName, value: "", ...sessionCookieOptions(), maxAge: 0, expires: new Date(0) });
    response.cookies.delete(sessionCookieName);
    return response;
  }
  if (isRateLimited(clientKey(request.headers, "login"), 10, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many login attempts. Try again shortly." }, { status: 429 });
  }
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const totp = typeof body.totp === "string" ? body.totp.trim() : "";
    const nextPath = sanitizeNextPath(typeof body.next === "string" ? body.next : undefined);
    const user = findStaffUser(email, password);

    if (!user) {
      return NextResponse.json({ ok: false, error: "Invalid Bubble Wash staff credentials." }, { status: 401 });
    }

    const personalOwner = user.role === "admin" && user.allStaffAccess === true;
    let mfaVerified = false;
    // Reveal the next step only after validating credentials. Existing master
    // and ordinary staff behavior remains controlled by the original flags.
    if (personalOwner && !adminMfaConfigured(user.email)) {
      if (adminMfaEnrollmentExists(user.email)) return NextResponse.json({ ok: false, error: "Personal authenticator sign-in is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
      return NextResponse.json({ ok: false, mfaStep: "enroll", error: "Set up your personal authenticator before opening staff workspaces." }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if (personalOwner && !totp) {
      return NextResponse.json({ ok: false, mfaStep: "verify", error: "Enter your personal authenticator or recovery code." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    if (user.role === "admin" && (personalOwner || adminMfaRequired())) {
      if (!adminMfaConfigured(user.email)) {
        if (process.env.NODE_ENV === "production") {
          return NextResponse.json({ ok: false, error: "Admin sign-in is temporarily unavailable." }, { status: 503 });
        }
      } else if (!verifyAdminMfaCredential(user.email, totp)) {
        return NextResponse.json({ ok: false, error: "Invalid Bubble Wash staff credentials.", ...(personalOwner ? { mfaStep: "verify" } : {}) }, { status: 401, ...(personalOwner ? { headers: { "Cache-Control": "no-store" } } : {}) });
      }
      mfaVerified = true;
    }

    const response = NextResponse.json({ ok: true, user: { name: user.name, email: user.email, role: user.role }, next: user.role === "admin" ? nextPath : ({ vendor: "/vendors", driver: "/drivers", support: "/support" }[user.role]) });
    response.cookies.set({
      name: sessionCookieName,
      value: encodeSession(user, mfaVerified),
      ...sessionCookieOptions(),
    });
    return response;
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to sign in." }, { status: 500 });
  }
}
