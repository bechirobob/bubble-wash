import assert from "node:assert/strict";
import { createPasswordHash } from "../src/lib/passwords.ts";

process.env.NODE_ENV = "production";
process.env.BUBBLEWASH_SESSION_SECRET = "production-auth-test-session-secret-32-plus";
process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN = "true";
process.env.BUBBLEWASH_ADMIN_EMAIL = "admin-production-test@bubblewash.local";
process.env.BUBBLEWASH_ADMIN_PASSWORD_HASH = createPasswordHash("Admin123!", "unsafe-admin-test-salt");
process.env.BUBBLEWASH_VENDOR_EMAIL = "vendor-production-test@bubblewash.local";
process.env.BUBBLEWASH_VENDOR_PASSWORD_HASH = createPasswordHash("vendor-pilot-unique-password", "safe-vendor-test-salt");
process.env.BUBBLEWASH_VENDOR_ENTITY_ID = "vendor-production-bound-test";
process.env.BUBBLEWASH_DRIVER_EMAIL = "driver-production-test@bubblewash.local";
process.env.BUBBLEWASH_DRIVER_PASSWORD_HASH = createPasswordHash("driver-pilot-unique-password", "safe-driver-test-salt");
process.env.BUBBLEWASH_DRIVER_ENTITY_ID = "driver-production-bound-test";
process.env.BUBBLEWASH_SUPPORT_EMAIL = "support-production-test@bubblewash.local";
process.env.BUBBLEWASH_SUPPORT_PASSWORD_HASH = createPasswordHash("support-pilot-unique-password", "safe-support-test-salt");

const { findStaffUser, staffUsers } = await import("../src/lib/auth.ts");

assert.equal(staffUsers.some((user) => user.role === "admin"), false);
assert.equal(findStaffUser(process.env.BUBBLEWASH_ADMIN_EMAIL, "Admin123!"), null);

const vendor = findStaffUser(process.env.BUBBLEWASH_VENDOR_EMAIL, "vendor-pilot-unique-password");
assert.equal(vendor?.role, "vendor");
assert.equal(vendor?.entityId, "vendor-production-bound-test");
assert.equal(findStaffUser(process.env.BUBBLEWASH_VENDOR_EMAIL, "Vendor123!"), null);

console.log(JSON.stringify({ ok: true, checks: 5 }));
