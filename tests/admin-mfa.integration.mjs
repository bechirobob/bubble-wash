import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

process.env.BUBBLEWASH_DATABASE_PATH = path.join(process.cwd(), "data", `admin-mfa-${randomUUID()}.sqlite`);
process.env.BUBBLEWASH_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const store = await import("../src/lib/data-store.ts");
const mfa = await import("../src/lib/admin-mfa.ts");
const { totpCode } = await import("../src/lib/totp.ts");
store.resetDataStoreForTests();

const email = "admin@bubblewash.co";
assert.equal(mfa.adminMfaConfigured(email), false);

const enrollment = await mfa.startAdminMfaEnrollment(email);
assert.match(enrollment.qrCodeDataUrl, /^data:image\/png;base64,/);
assert.equal(enrollment.manualKey.length, 32);
assert.equal(mfa.confirmAdminMfaEnrollment(email, "000000").ok, false);

const currentStep = Math.floor(Date.now() / 30_000);
const confirmation = mfa.confirmAdminMfaEnrollment(email, totpCode(enrollment.manualKey, currentStep));
assert.equal(confirmation.ok, true);
assert.equal(confirmation.recoveryCodes.length, 8);
assert.equal(new Set(confirmation.recoveryCodes).size, 8);
assert.equal(mfa.adminMfaConfigured(email), true);

assert.equal(mfa.verifyAdminMfaCredential(email, totpCode(enrollment.manualKey, currentStep)), false, "confirmed TOTP step cannot be replayed");
assert.equal(mfa.verifyAdminMfaCredential(email, totpCode(enrollment.manualKey, currentStep + 1)), true);

const recoveryCode = confirmation.recoveryCodes[0];
assert.equal(mfa.verifyAdminMfaCredential(email, recoveryCode), true);
assert.equal(mfa.verifyAdminMfaCredential(email, recoveryCode), false, "recovery code is single-use");
assert.deepEqual(mfa.pendingAdminRecoveryCodes(email), confirmation.recoveryCodes);
assert.equal(mfa.acknowledgeRecoveryCodes(email), true);
assert.deepEqual(mfa.pendingAdminRecoveryCodes(email), []);

await assert.rejects(() => mfa.startAdminMfaEnrollment(email), /already enrolled/);

console.log(JSON.stringify({ ok: true, checks: 16 }));
