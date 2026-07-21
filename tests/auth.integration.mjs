import assert from "node:assert/strict";

process.env.BUBBLEWASH_SESSION_SECRET = "test-session-secret-with-more-than-32-characters";
process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN = "false";
process.env.BUBBLEWASH_VENDOR_EMAIL = "vendor-identity-test@bubblewash.local";
process.env.BUBBLEWASH_DRIVER_EMAIL = "driver-identity-test@bubblewash.local";
process.env.BUBBLEWASH_VENDOR_ENTITY_ID = "vendor-bound-test";
process.env.BUBBLEWASH_DRIVER_ENTITY_ID = "driver-bound-test";

const { decodeSession, encodeSession, staffUsers } = await import("../src/lib/auth.ts");

const vendor = staffUsers.find((user) => user.role === "vendor");
const driver = staffUsers.find((user) => user.role === "driver");
assert.equal(vendor?.entityId, "vendor-bound-test");
assert.equal(driver?.entityId, "driver-bound-test");

const vendorSession = decodeSession(encodeSession(vendor));
assert.equal(vendorSession?.role, "vendor");
assert.equal(vendorSession?.entityId, "vendor-bound-test");

const mismatchedSession = encodeSession({ ...vendor, entityId: "vendor-other" });
assert.equal(decodeSession(mismatchedSession), null);

console.log(JSON.stringify({ ok: true, checks: 6 }));
