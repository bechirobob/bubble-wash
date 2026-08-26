import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextRequest } from "next/server";
import { createPasswordHash } from "../src/lib/passwords.ts";
import { totpCode } from "../src/lib/totp.ts";

process.env.NODE_ENV = "production";
process.env.BUBBLEWASH_DATABASE_PATH = path.join(process.cwd(), "data", `admin-mfa-http-${randomUUID()}.sqlite`);
process.env.BUBBLEWASH_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.BUBBLEWASH_SESSION_SECRET = "admin-mfa-http-session-secret-longer-than-32-characters";
process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN = "true";
process.env.BUBBLEWASH_ADMIN_MFA_REQUIRED = "true";
process.env.NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED = "true";
process.env.BUBBLEWASH_ADMIN_EMAIL = "admin@bubblewash.co";
process.env.BUBBLEWASH_ADMIN_PASSWORD_HASH = createPasswordHash("unique-production-admin-password", "admin-mfa-http-salt");

const { POST } = await import("../src/app/api/admin/mfa/enroll/route.ts");
const { POST: login } = await import("../src/app/api/login/route.ts");

function enrollmentRequest(body, cookie = "") {
  return new NextRequest("https://bubblewash.co/api/admin/mfa/enroll", {
    method: "POST",
    headers: { origin: "https://bubblewash.co", host: "bubblewash.co", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

const denied = await POST(enrollmentRequest({ action: "start", email: process.env.BUBBLEWASH_ADMIN_EMAIL, password: "wrong" }));
assert.equal(denied.status, 401);

const started = await POST(enrollmentRequest({ action: "start", email: process.env.BUBBLEWASH_ADMIN_EMAIL, password: "unique-production-admin-password" }));
assert.equal(started.status, 200);
const startBody = await started.json();
assert.match(startBody.enrollment.qrCodeDataUrl, /^data:image\/png;base64,/);

const currentStep = Math.floor(Date.now() / 30_000);
const confirmed = await POST(enrollmentRequest({
  action: "confirm",
  email: process.env.BUBBLEWASH_ADMIN_EMAIL,
  password: "unique-production-admin-password",
  code: totpCode(startBody.enrollment.manualKey, currentStep),
}));
assert.equal(confirmed.status, 200);
const enrollmentCookie = (confirmed.headers.get("set-cookie") ?? "").split(";", 1)[0];
assert.match(enrollmentCookie, /bubblewash_staff_session=/);
const confirmBody = await confirmed.json();
assert.equal(confirmBody.recoveryCodes.length, 8);

const resumed = await POST(enrollmentRequest({ action: "resume" }, enrollmentCookie));
assert.equal(resumed.status, 200);
assert.deepEqual((await resumed.json()).recoveryCodes, confirmBody.recoveryCodes);

const anonymousResume = await POST(enrollmentRequest({ action: "resume" }));
assert.equal(anonymousResume.status, 401);

const loginResponse = await login(new NextRequest("https://bubblewash.co/api/login", {
  method: "POST",
  headers: { origin: "https://bubblewash.co", host: "bubblewash.co", "content-type": "application/json" },
  body: JSON.stringify({
    email: process.env.BUBBLEWASH_ADMIN_EMAIL,
    password: "unique-production-admin-password",
    totp: totpCode(startBody.enrollment.manualKey, currentStep + 1),
    next: "/admin",
  }),
}));
assert.equal(loginResponse.status, 200);

const recoveryLogin = await login(new NextRequest("https://bubblewash.co/api/login", {
  method: "POST",
  headers: { origin: "https://bubblewash.co", host: "bubblewash.co", "content-type": "application/json" },
  body: JSON.stringify({
    email: process.env.BUBBLEWASH_ADMIN_EMAIL,
    password: "unique-production-admin-password",
    totp: confirmBody.recoveryCodes[0],
    next: "/admin",
  }),
}));
assert.equal(recoveryLogin.status, 200);

console.log(JSON.stringify({ ok: true, checks: 11 }));
