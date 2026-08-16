import test from "node:test";
import assert from "node:assert/strict";
import { totpCode, validTotpSecret, verifyTotp } from "../src/lib/totp.ts";

const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

test("TOTP accepts the current code and a one-step clock drift", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const timestep = Math.floor(now / 30_000);
  assert.equal(validTotpSecret(secret), true);
  assert.equal(verifyTotp(totpCode(secret, timestep), secret, now), timestep);
  assert.equal(verifyTotp(totpCode(secret, timestep - 1), secret, now), timestep - 1);
});

test("TOTP rejects malformed secrets and codes outside the drift window", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const timestep = Math.floor(now / 30_000);
  assert.equal(validTotpSecret("short"), false);
  assert.equal(verifyTotp("12345", secret, now), null);
  assert.equal(verifyTotp(totpCode(secret, timestep - 2), secret, now), null);
});
