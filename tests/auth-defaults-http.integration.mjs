import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPasswordHash, knownDemoPasswords } from "../src/lib/passwords.ts";

const testDirectory = mkdtempSync(join(process.cwd(), ".bubblewash-auth-defaults-"));

process.env.NODE_ENV = "production";
process.env.BUBBLEWASH_DATABASE_PATH = join(testDirectory, "auth.sqlite");
process.env.BUBBLEWASH_SESSION_SECRET = "production-auth-default-test-secret-32-plus";
process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN = "true";

const roles = ["ADMIN", "VENDOR", "DRIVER", "SUPPORT"];
for (const [index, role] of roles.entries()) {
  process.env[`BUBBLEWASH_${role}_EMAIL`] = `${role.toLowerCase()}-default-test@bubblewash.local`;
  process.env[`BUBBLEWASH_${role}_PASSWORD_HASH`] = createPasswordHash(knownDemoPasswords[index], `http-default-${role}`);
}

const { POST } = await import("../src/app/api/login/route.ts");

for (const [index, role] of roles.entries()) {
  const response = await POST(new Request("https://bubblewash.co/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "bubblewash.co",
      origin: "https://bubblewash.co",
    },
    body: JSON.stringify({
      email: process.env[`BUBBLEWASH_${role}_EMAIL`],
      password: knownDemoPasswords[index],
    }),
  }));
  assert.equal(response.status, 401, `${role} known default must be rejected`);
}

rmSync(testDirectory, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, checks: 4 }));
