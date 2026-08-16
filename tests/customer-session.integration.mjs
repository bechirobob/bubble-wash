import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.BUBBLEWASH_SESSION_SECRET = "customer-session-integration-secret-32-plus";

const session = await import("../src/lib/customer-session.ts");
const encoded = session.encodeCustomerSession("BW-CUSTOMER1234", "Ama@example.com");
assert.equal(session.decodeCustomerSession(encoded)?.orderId, "BW-CUSTOMER1234");
assert.equal(session.decodeCustomerSession(`${encoded}tampered`), null);
assert.equal(session.customerContactMatches(" ama@EXAMPLE.com ", "ama@example.com", "0550000000"), true);
assert.equal(session.customerContactMatches("+233550000000", "ama@example.com", "0550000000"), true);
assert.equal(session.customerContactMatches("intruder@example.com", "ama@example.com", "0550000000"), false);

console.log(JSON.stringify({ ok: true, checks: 5 }));
