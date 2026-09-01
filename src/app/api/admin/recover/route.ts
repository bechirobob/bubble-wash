import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { adminRecoveryConfig } from "@/lib/admin-recovery-config";
import { consumeAdminRecoveryTokenAndSetCredentials } from "@/lib/data-store";
import { createPasswordHash, matchesKnownDemoPassword } from "@/lib/passwords";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";
import { staffAccessDisabled } from "@/lib/auth";

const genericRecoveryError = "This recovery link is invalid, expired, or already used.";

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function POST(request: NextRequest) {
  const guardError = sameOriginJsonGuard(request.headers, "admin recovery request");
  if (guardError) return guardError;
  if (staffAccessDisabled()) {
    return NextResponse.json({ ok: false, error: "Login cannot be reached." }, { status: 503 });
  }
  if (isRateLimited(clientKey(request.headers, "admin-recovery"), 5, 15 * 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many recovery attempts. Try again later." }, { status: 429 });
  }

  try {
    const body = await request.json();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const login = typeof body.login === "string" ? body.login.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const passwordConfirmation = typeof body.passwordConfirmation === "string" ? body.passwordConfirmation : "";
    const config = adminRecoveryConfig();
    const tokenHash = createHash("sha256").update(token).digest("base64url");

    const expiresAt = Date.parse(config.expiresAt);
    if (!token || !config.tokenHash || !safeEqual(tokenHash, config.tokenHash) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return NextResponse.json({ ok: false, error: genericRecoveryError }, { status: 400 });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]{2,63}$/.test(login)) {
      return NextResponse.json({ ok: false, error: "Choose a username of 3–64 letters, numbers, dots, dashes, plus signs, @ signs, or underscores." }, { status: 400 });
    }
    if (password.length < 16 || password.length > 128) {
      return NextResponse.json({ ok: false, error: "Choose a password between 16 and 128 characters." }, { status: 400 });
    }
    if (password !== passwordConfirmation) {
      return NextResponse.json({ ok: false, error: "The two password entries do not match." }, { status: 400 });
    }
    const passwordHash = createPasswordHash(password);
    if (matchesKnownDemoPassword(passwordHash) || password.toLowerCase().includes(login.toLowerCase())) {
      return NextResponse.json({ ok: false, error: "Choose a password that is not a demo password and does not contain the username." }, { status: 400 });
    }

    const changed = consumeAdminRecoveryTokenAndSetCredentials({
      tokenHash,
      configuredTokenHash: config.tokenHash,
      expiresAt: config.expiresAt,
      login,
      passwordHash,
      credentialVersion: randomUUID(),
    });
    if (!changed) {
      return NextResponse.json({ ok: false, error: genericRecoveryError }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Bubble Wash admin recovery failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({ ok: false, error: "Unable to update the master administrator right now." }, { status: 500 });
  }
}
