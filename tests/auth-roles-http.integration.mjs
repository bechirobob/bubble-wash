import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPasswordHash } from "../src/lib/passwords.ts";

const testDirectory = mkdtempSync(join(process.cwd(), ".bubblewash-auth-roles-"));

process.env.NODE_ENV = "production";
process.env.BUBBLEWASH_DATABASE_PATH = join(testDirectory, "auth.sqlite");
process.env.BUBBLEWASH_SESSION_SECRET = "production-auth-role-test-secret-32-plus";
process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN = "true";

const credentials = [
  ["ADMIN", "admin", "admin-pilot-unique-password"],
  ["VENDOR", "vendor", "vendor-pilot-unique-password"],
  ["DRIVER", "driver", "driver-pilot-unique-password"],
  ["SUPPORT", "support", "support-pilot-unique-password"],
];

for (const [role, , password] of credentials) {
  process.env[`BUBBLEWASH_${role}_EMAIL`] = `${role.toLowerCase()}-role-test@bubblewash.local`;
  process.env[`BUBBLEWASH_${role}_PASSWORD_HASH`] = createPasswordHash(password, `http-role-${role}`);
}
process.env.BUBBLEWASH_VENDOR_ENTITY_ID = "vendor-http-role-test";
process.env.BUBBLEWASH_DRIVER_ENTITY_ID = "driver-http-role-test";

const { POST } = await import("../src/app/api/login/route.ts");

for (const [role, expectedRole, password] of credentials) {
  const response = await POST(new Request("https://bubblewash.co/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "bubblewash.co",
      origin: "https://bubblewash.co",
    },
    body: JSON.stringify({
      email: process.env[`BUBBLEWASH_${role}_EMAIL`],
      password,
    }),
  }));
  assert.equal(response.status, 200, `${role} unique credential must authenticate`);
  const body = await response.json();
  assert.equal(body.user?.role, expectedRole);
}

rmSync(testDirectory, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, checks: 8 }));
