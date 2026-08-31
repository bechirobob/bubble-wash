import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { NextRequest } from "next/server";
import { createPasswordHash } from "../src/lib/passwords.ts";

process.env.NODE_ENV = "production";
process.env.BUBBLEWASH_DATABASE_PATH = path.join(process.cwd(), "data", `auth-disabled-${randomUUID()}.sqlite`);
process.env.BUBBLEWASH_SESSION_SECRET = "disabled-auth-test-session-secret-longer-than-32-characters";
process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN = "true";
process.env.BUBBLEWASH_STAFF_AUTH_DISABLED = "true";
process.env.BUBBLEWASH_ADMIN_EMAIL = "admin-disabled-test@bubblewash.co";
process.env.BUBBLEWASH_ADMIN_PASSWORD_HASH = createPasswordHash("disabled-production-admin-password", "disabled-admin-salt");
process.env.BUBBLEWASH_ADMIN_RECOVERY_TOKEN_HASH = createHash("sha256").update("disabled-recovery-token").digest("base64url");
process.env.BUBBLEWASH_ADMIN_RECOVERY_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();

const { decodeSession, encodeSession, staffUsers } = await import("../src/lib/auth.ts");
const { POST: login } = await import("../src/app/api/login/route.ts");
const { POST: recover } = await import("../src/app/api/admin/recover/route.ts");
const { POST: enrollMfa } = await import("../src/app/api/admin/mfa/enroll/route.ts");

const configuredAdmin = staffUsers.find((user) => user.role === "admin");
assert.ok(configuredAdmin);
assert.equal(decodeSession(encodeSession(configuredAdmin)), null, "existing staff sessions must be rejected while access is disabled");

function request(url, body) {
  return new NextRequest(url, {
    method: "POST",
    headers: { origin: "https://bubblewash.co", host: "bubblewash.co", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const loginResponse = await login(request("https://bubblewash.co/api/login", {
  email: process.env.BUBBLEWASH_ADMIN_EMAIL,
  password: "disabled-production-admin-password",
  next: "/admin",
}));
assert.equal(loginResponse.status, 503);
assert.match(loginResponse.headers.get("set-cookie") ?? "", /bubblewash_staff_session=/);

const recoveryResponse = await recover(request("https://bubblewash.co/api/admin/recover", {
  token: "disabled-recovery-token",
  login: "replacement-admin",
  password: "replacement-admin-password-long",
  passwordConfirmation: "replacement-admin-password-long",
}));
assert.equal(recoveryResponse.status, 503);

const mfaResponse = await enrollMfa(request("https://bubblewash.co/api/admin/mfa/enroll", {
  action: "start",
  email: process.env.BUBBLEWASH_ADMIN_EMAIL,
  password: "disabled-production-admin-password",
}));
assert.equal(mfaResponse.status, 503);

console.log(JSON.stringify({ ok: true, checks: 6 }));
