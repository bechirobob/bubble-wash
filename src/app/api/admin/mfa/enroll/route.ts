import { NextRequest, NextResponse } from "next/server";
import {
  acknowledgeRecoveryCodes,
  confirmAdminMfaEnrollment,
  pendingAdminRecoveryCodes,
  startAdminMfaEnrollment,
} from "@/lib/admin-mfa";
import {
  decodeSession,
  encodeSession,
  findStaffUser,
  sessionCookieName,
  sessionCookieOptions,
  staffAccessDisabled,
} from "@/lib/auth";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { staffWriteGuard } from "@/lib/security";

function text(value: unknown, max = 320) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: NextRequest) {
  const guardError = staffWriteGuard(request.headers);
  if (guardError) return guardError;
  if (staffAccessDisabled()) {
    const response = NextResponse.json({ ok: false, error: "Bubble Wash staff access is disabled." }, { status: 503 });
    response.cookies.set({ name: sessionCookieName, value: "", ...sessionCookieOptions(), maxAge: 0, expires: new Date(0) });
    response.cookies.delete(sessionCookieName);
    return response;
  }

  try {
    const body = await request.json();
    const action = text(body.action, 40);

    if (action === "resume" || action === "acknowledge") {
      const current = decodeSession(request.cookies.get(sessionCookieName)?.value);
      if (!current || current.role !== "admin") {
        return NextResponse.json({ ok: false, error: "Admin authentication required." }, { status: 401 });
      }
      if (action === "resume") {
        return NextResponse.json({ ok: true, recoveryCodes: pendingAdminRecoveryCodes(current.email) }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      acknowledgeRecoveryCodes(current.email);
      return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (isRateLimited(clientKey(request.headers, "admin-mfa-enrollment"), 6, 10 * 60_000)) {
      return NextResponse.json({ ok: false, error: "Too many enrollment attempts. Try again later." }, { status: 429 });
    }

    const email = text(body.email).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const user = findStaffUser(email, password);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ ok: false, error: "Invalid Bubble Wash admin credentials." }, { status: 401 });
    }

    if (action === "start") {
      const enrollment = await startAdminMfaEnrollment(user.email);
      return NextResponse.json({ ok: true, enrollment }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "confirm") {
      const code = text(body.code, 6);
      const confirmation = confirmAdminMfaEnrollment(user.email, code);
      if (!confirmation.ok) {
        return NextResponse.json({ ok: false, error: confirmation.error }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      const response = NextResponse.json({ ok: true, recoveryCodes: confirmation.recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
      response.cookies.set({
        name: sessionCookieName,
        value: encodeSession(user),
        ...sessionCookieOptions(),
      });
      return response;
    }

    return NextResponse.json({ ok: false, error: "Invalid enrollment action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to enroll authenticator.";
    const status = message.includes("already enrolled") ? 409 : message.includes("MFA_ENCRYPTION_KEY") ? 503 : 500;
    if (status === 500) console.error("Bubble Wash admin MFA enrollment failed", { message });
    const publicMessage = status === 409
      ? "Admin authenticator is already enrolled."
      : status === 503
        ? "Authenticator enrollment is temporarily unavailable."
        : "Unable to enroll authenticator.";
    return NextResponse.json({ ok: false, error: publicMessage }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
