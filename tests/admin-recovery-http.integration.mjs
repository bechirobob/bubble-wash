import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { NextRequest } from "next/server";
import { createPasswordHash } from "../src/lib/passwords.ts";

const recoveryToken = "test-private-recovery-token-with-enough-entropy";
const oldPassword = "old-master-admin-password-unique";
const newPassword = "Bubbl3Wash!SecurePassphrase2026";

process.env.NODE_ENV = "production";
process.env.BUBBLEWASH_DATABASE_PATH = path.join(process.cwd(), "data", `admin-recovery-http-${randomUUID()}.sqlite`);
process.env.BUBBLEWASH_SESSION_SECRET = "admin-recovery-http-session-secret-longer-than-32-characters";
process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN = "true";
process.env.BUBBLEWASH_ADMIN_MFA_REQUIRED = "false";
process.env.NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED = "false";
process.env.BUBBLEWASH_ADMIN_EMAIL = "old-admin@bubblewash.co";
process.env.BUBBLEWASH_ADMIN_PASSWORD_HASH = createPasswordHash(oldPassword, "admin-recovery-old-salt");
process.env.BUBBLEWASH_ADMIN_RECOVERY_TOKEN_HASH = createHash("sha256").update(recoveryToken).digest("base64url");
process.env.BUBBLEWASH_ADMIN_RECOVERY_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();

const { encodeSession, decodeSession, findStaffUser } = await import("../src/lib/auth.ts");
const { POST: recover } = await import("../src/app/api/admin/recover/route.ts");
const { POST: login } = await import("../src/app/api/login/route.ts");

function requestFor(body) {
  return new NextRequest("https://bubblewash.co/api/admin/recover", {
    method: "POST",
    headers: { origin: "https://bubblewash.co", host: "bubblewash.co", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const oldAdmin = findStaffUser(process.env.BUBBLEWASH_ADMIN_EMAIL, oldPassword);
assert.equal(oldAdmin?.role, "admin");
const oldSession = encodeSession(oldAdmin);

process.env.BUBBLEWASH_ADMIN_RECOVERY_EXPIRES_AT = new Date(Date.now() - 60_000).toISOString();
const expired = await recover(requestFor({
  token: recoveryToken,
  login: "master-admin",
  password: newPassword,
  passwordConfirmation: newPassword,
}));
assert.equal(expired.status, 400);
process.env.BUBBLEWASH_ADMIN_RECOVERY_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();

const invalid = await recover(requestFor({
  token: "wrong-token",
  login: "master-admin",
  password: newPassword,
  passwordConfirmation: newPassword,
}));
assert.equal(invalid.status, 400);

const weak = await recover(requestFor({
  token: recoveryToken,
  login: "master-admin",
  password: "too-short",
  passwordConfirmation: "too-short",
}));
assert.equal(weak.status, 400);

const changed = await recover(requestFor({
  token: recoveryToken,
  login: "master-admin",
  password: newPassword,
  passwordConfirmation: newPassword,
}));
assert.equal(changed.status, 200);
assert.equal((await changed.json()).ok, true);

assert.equal(findStaffUser(process.env.BUBBLEWASH_ADMIN_EMAIL, oldPassword), null);
assert.equal(findStaffUser("master-admin", newPassword)?.role, "admin");
assert.equal(decodeSession(oldSession), null);

const reused = await recover(requestFor({
  token: recoveryToken,
  login: "another-admin",
  password: "another-new-master-password",
  passwordConfirmation: "another-new-master-password",
}));
assert.equal(reused.status, 400);

const loginResponse = await login(new NextRequest("https://bubblewash.co/api/login", {
  method: "POST",
  headers: { origin: "https://bubblewash.co", host: "bubblewash.co", "content-type": "application/json" },
  body: JSON.stringify({ email: "master-admin", password: newPassword, next: "/admin" }),
}));
assert.equal(loginResponse.status, 200);
assert.match(loginResponse.headers.get("set-cookie") ?? "", /bubblewash_staff_session=/);

console.log(JSON.stringify({ ok: true, checks: 13 }));
