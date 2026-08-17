import { NextRequest, NextResponse } from "next/server";
import { encodeSession, findStaffUserFromProof, sanitizeNextPath, sessionCookieName, sessionCookieOptions } from "@/lib/auth";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { staffWriteGuard } from "@/lib/security";
import { claimMfaTimestep } from "@/lib/data-store";
import { validTotpSecret, verifyTotp } from "@/lib/totp";

const authenticationHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: authenticationHeaders });
}

export async function POST(request: NextRequest) {
  const staffGuardError = staffWriteGuard(request.headers);
  if (staffGuardError) return staffGuardError;
  if (await isRateLimited(clientKey(request.headers, "login:proof"), 10, 60_000)) {
    return response({ ok: false, error: "Too many login attempts. Try again shortly." }, 429);
  }
  try {
    const body = await request.json<Record<string, unknown>>();
    const email = typeof body.email === "string" ? body.email : "";
    const challenge = typeof body.challenge === "string" ? body.challenge : "";
    const proof = typeof body.proof === "string" ? body.proof : "";
    const totp = typeof body.totp === "string" ? body.totp.trim() : "";
    const nextPath = sanitizeNextPath(typeof body.next === "string" ? body.next : undefined);
    const user = await findStaffUserFromProof(email, challenge, proof);

    if (!user) {
      return response({ ok: false, error: "Invalid Bubble Wash staff credentials." }, 401);
    }

    if (user.role === "admin") {
      const secret = user.totpSecret ?? "";
      if (!validTotpSecret(secret)) {
        if (process.env.NODE_ENV === "production") {
          return response({ ok: false, error: "Admin sign-in is temporarily unavailable." }, 503);
        }
      } else {
        const timestep = verifyTotp(totp, secret);
        if (timestep === null || !await claimMfaTimestep(user.email.toLowerCase(), timestep)) {
          return response({ ok: false, error: "Invalid Bubble Wash staff credentials." }, 401);
        }
      }
    }

    const loginResponse = response({ ok: true, user: { name: user.name, email: user.email, role: user.role }, next: nextPath });
    loginResponse.cookies.set({
      name: sessionCookieName,
      value: encodeSession(user),
      ...sessionCookieOptions(),
    });
    return loginResponse;
  } catch {
    return response({ ok: false, error: "Unable to sign in." }, 500);
  }
}
