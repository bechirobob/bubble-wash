import test from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../next.config.mjs";
import { clientScopeKey, privateNoStoreHeaders, securityHeaders, staffWriteGuard, productionReadinessErrors, productionReadinessWarnings, publicTrackingView } from "../src/lib/security.ts";
import { createPasswordHash, knownDemoPasswords, matchesKnownDemoPassword, verifyPasswordHash } from "../src/lib/passwords.ts";

function headers(input = {}) {
  return new Headers(input);
}

test("securityHeaders includes OWASP baseline browser protections without powered-by leakage", () => {
  const map = new Map(securityHeaders().map((item) => [item.key.toLowerCase(), item.value]));
  const csp = map.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.paystack\.co(?:;|$)/);
  assert.doesNotMatch(csp, /api\.resend\.com|graph\.facebook\.com|api\.whatsapp\.com|maps\.google\.com/);
  assert.match(map.get("strict-transport-security") ?? "", /max-age=31536000/);
  assert.equal(map.get("x-content-type-options"), "nosniff");
  assert.equal(map.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(map.get("permissions-policy") ?? "", /(?:^|,\s*)geolocation=\(self\)(?:,|$)/);
  assert.doesNotMatch(map.get("permissions-policy") ?? "", /geolocation=\(\*\)/);
  assert.equal(map.has("x-powered-by"), false);
});

test("live dispatch location responses are explicitly private and non-cacheable", () => {
  const map = new Map(privateNoStoreHeaders().map((item) => [item.key.toLowerCase(), item.value]));
  const cacheControl = map.get("cache-control") ?? "";
  assert.match(cacheControl, /(?:^|,\s*)private(?:,|$)/);
  assert.match(cacheControl, /(?:^|,\s*)no-store(?:,|$)/);
  assert.match(cacheControl, /(?:^|,\s*)max-age=0(?:,|$)/);
  assert.equal(map.get("pragma"), "no-cache");
});

test("live location cache protection is scoped to the dispatch location endpoint", async () => {
  const rules = await nextConfig.headers();
  const liveLocationRule = rules.find((rule) => rule.source === "/api/dispatch/location");
  assert.ok(liveLocationRule, "dispatch location must have an explicit response-header rule");
  const map = new Map(liveLocationRule.headers.map((item) => [item.key.toLowerCase(), item.value]));
  assert.match(map.get("cache-control") ?? "", /(?:^|,\s*)private(?:,|$)/);
  assert.match(map.get("cache-control") ?? "", /(?:^|,\s*)no-store(?:,|$)/);
  assert.equal(rules.some((rule) => rule.source === "/api/:path*" && rule.headers.some((item) => item.key.toLowerCase() === "cache-control")), false);
});

test("clientKey does not trust spoofable forwarding headers unless Cloudflare/Render supplies a controlled IP header", () => {
  assert.equal(clientScopeKey(headers({ "x-forwarded-for": "1.2.3.4" }), "login"), "login:local");
  assert.equal(clientScopeKey(headers({ "x-real-ip": "5.6.7.8" }), "login"), "login:local");
  assert.equal(clientScopeKey(headers({ "cf-connecting-ip": "9.9.9.9" }), "login"), "login:local");
  process.env.BUBBLEWASH_TRUST_EDGE_HEADERS = "true";
  try {
    assert.equal(clientScopeKey(headers({ "cf-connecting-ip": "9.9.9.9" }), "login"), "login:9.9.9.9");
  } finally {
    delete process.env.BUBBLEWASH_TRUST_EDGE_HEADERS;
  }
});

test("staffWriteGuard rejects cross-origin state-changing JSON requests", () => {
  const allowed = staffWriteGuard(headers({ origin: "https://bubblewash.co", host: "bubblewash.co", "content-type": "application/json" }));
  assert.equal(allowed, null);
  const blocked = staffWriteGuard(headers({ origin: "https://evil.example", host: "bubblewash.co", "content-type": "application/json" }));
  assert.equal(blocked?.status, 403);
  const wrongType = staffWriteGuard(headers({ origin: "https://bubblewash.co", host: "bubblewash.co", "content-type": "text/plain" }));
  assert.equal(wrongType?.status, 415);
});

test("productionReadinessErrors fails closed when production demo credentials would be enabled", () => {
  const env = { NODE_ENV: "production", BUBBLEWASH_ENABLE_DEMO_LOGIN: "true" };
  const errors = productionReadinessErrors(env);
  assert.ok(errors.some((item) => item.includes("BUBBLEWASH_DISABLE_DEMO_LOGIN=true")));
  assert.ok(errors.some((item) => item.includes("demo login cannot be enabled")));
  assert.ok(errors.some((item) => item.includes("BUBBLEWASH_SESSION_SECRET")));
  assert.ok(errors.some((item) => item.includes("BUBBLEWASH_VENDOR_ENTITY_ID")));
  assert.ok(errors.some((item) => item.includes("BUBBLEWASH_DRIVER_ENTITY_ID")));
  assert.equal(errors.some((item) => item.includes("NEXT_PUBLIC_BUBBLEWASH_WHATSAPP")), false);
  assert.equal(errors.some((item) => item.includes("NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL")), false);
});

test("password hashes reject malformed values and detect every built-in demo credential", () => {
  assert.equal(verifyPasswordHash("anything", "not-a-scrypt-hash"), false);
  assert.equal(verifyPasswordHash("anything", "scrypt$salt$short"), false);

  for (const password of knownDemoPasswords) {
    const hash = createPasswordHash(password, `test-salt-${password}`);
    assert.equal(verifyPasswordHash(password, hash), true);
    assert.equal(matchesKnownDemoPassword(hash), true);
  }

  const uniqueHash = createPasswordHash("pilot-only-unique-credential", "unique-test-salt");
  assert.equal(matchesKnownDemoPassword(uniqueHash), false);
});

test("production readiness rejects known demo hashes for every staff role", () => {
  const env = {
    NODE_ENV: "production",
    BUBBLEWASH_DISABLE_DEMO_LOGIN: "true",
    BUBBLEWASH_SESSION_SECRET: "a-secure-session-secret-with-32-characters",
    BUBBLEWASH_DATABASE_PATH: "/var/lib/bubblewash/bubblewash.sqlite",
    BUBBLEWASH_PUBLIC_URL: "https://bubblewash.co",
    BUBBLEWASH_VENDOR_ENTITY_ID: "vendor-approved-partner",
    BUBBLEWASH_DRIVER_ENTITY_ID: "driver-approved-rider",
    BUBBLEWASH_TRUST_PROXY_HEADERS: "true",
    BUBBLEWASH_TRUST_EDGE_HEADERS: "false",
  };

  for (const [index, role] of ["ADMIN", "VENDOR", "DRIVER", "SUPPORT"].entries()) {
    env[`BUBBLEWASH_${role}_EMAIL`] = `${role.toLowerCase()}@example.com`;
    env[`BUBBLEWASH_${role}_PASSWORD_HASH`] = createPasswordHash(knownDemoPasswords[index], `readiness-${role}`);
  }

  const errors = productionReadinessErrors(env);
  for (const role of ["ADMIN", "VENDOR", "DRIVER", "SUPPORT"]) {
    assert.ok(errors.some((item) => item.includes(`BUBBLEWASH_${role}_PASSWORD_HASH`) && item.includes("known demo credentials")));
  }
});

test("production readiness requires vendor and rider entity bindings", () => {
  const base = {
    NODE_ENV: "production",
    BUBBLEWASH_DISABLE_DEMO_LOGIN: "true",
    BUBBLEWASH_SESSION_SECRET: "a-secure-session-secret-with-32-characters",
    BUBBLEWASH_DATABASE_PATH: "/var/lib/bubblewash/bubblewash.sqlite",
    BUBBLEWASH_PUBLIC_URL: "https://bubblewash.co",
    BUBBLEWASH_ADMIN_EMAIL: "admin@example.com",
    BUBBLEWASH_ADMIN_PASSWORD_HASH: "hash",
    BUBBLEWASH_VENDOR_EMAIL: "vendor@example.com",
    BUBBLEWASH_VENDOR_PASSWORD_HASH: "hash",
    BUBBLEWASH_DRIVER_EMAIL: "driver@example.com",
    BUBBLEWASH_DRIVER_PASSWORD_HASH: "hash",
    BUBBLEWASH_SUPPORT_EMAIL: "support@example.com",
    BUBBLEWASH_SUPPORT_PASSWORD_HASH: "hash",
    BUBBLEWASH_TRUST_PROXY_HEADERS: "true",
    BUBBLEWASH_TRUST_EDGE_HEADERS: "false",
  };
  const missing = productionReadinessErrors(base);
  assert.ok(missing.some((item) => item.includes("BUBBLEWASH_VENDOR_ENTITY_ID")));
  assert.ok(missing.some((item) => item.includes("BUBBLEWASH_DRIVER_ENTITY_ID")));

  const bound = productionReadinessErrors({
    ...base,
    BUBBLEWASH_VENDOR_ENTITY_ID: "vendor-approved-partner",
    BUBBLEWASH_DRIVER_ENTITY_ID: "driver-approved-rider",
  });
  assert.equal(bound.some((item) => item.includes("ENTITY_ID")), false);
});

test("pilot operations may hide optional public contacts while readiness reports warnings", () => {
  const warnings = productionReadinessWarnings({ NODE_ENV: "production" });
  assert.ok(warnings.some((item) => item.includes("public WhatsApp contact link")));
  assert.ok(warnings.some((item) => item.includes("public email contact link")));
  assert.ok(warnings.some((item) => item.includes("bank transfer and approved invoicing")));
  assert.ok(warnings.some((item) => item.includes("follow up with customers manually")));
});

test("manual pilot mode keeps optional integrations fail-closed without blocking the public site", () => {
  const env = { NODE_ENV: "production", BUBBLEWASH_DISABLE_DEMO_LOGIN: "true" };
  const errors = productionReadinessErrors(env);
  const warnings = productionReadinessWarnings(env);
  assert.equal(errors.some((item) => item.includes("PAYSTACK_SECRET_KEY")), false);
  assert.equal(errors.some((item) => item.includes("RESEND_API_KEY")), false);
  assert.equal(errors.some((item) => item.includes("WHATSAPP_ACCESS_TOKEN")), false);
  assert.ok(errors.some((item) => item.includes("trusted client-IP mode")));
  assert.equal(errors.some((item) => item.includes("BUBBLEWASH_ADMIN_TOTP_SECRET")), false);
  assert.equal(errors.some((item) => item.includes("BUBBLEWASH_MAINTENANCE_TOKEN")), false);
  assert.ok(errors.some((item) => item.includes("BUBBLEWASH_BACKUP_ENCRYPTION_KEY")));
  assert.ok(errors.some((item) => item.includes("BUBBLEWASH_DATABASE_DRIVER=sqlite")));
  assert.ok(warnings.some((item) => item.includes("MFA enrollment")));
  assert.ok(warnings.some((item) => item.includes("operations token")));
  assert.ok(warnings.some((item) => item.includes("manual operations follow-up")));
  assert.ok(warnings.some((item) => item.includes("legal entity")));
  assert.ok(warnings.some((item) => item.includes("Data Protection Commission")));
});

test("enabling future integrations makes their provider credentials blocking", () => {
  const errors = productionReadinessErrors({
    NODE_ENV: "production",
    BUBBLEWASH_DISABLE_DEMO_LOGIN: "true",
    NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: "true",
    NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: "true",
  });
  assert.ok(errors.some((item) => item.includes("PAYSTACK_SECRET_KEY")));
  assert.ok(errors.some((item) => item.includes("RESEND_API_KEY")));
  assert.ok(errors.some((item) => item.includes("WHATSAPP_ACCESS_TOKEN")));
});

test("publicTrackingView redacts internal vendor, driver, payment, and contact details", () => {
  const view = publicTrackingView({
    orderId: "BW-123",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T11:00:00.000Z",
    lastEventType: "pickup-booking",
    customer: "Ama Customer",
    email: "ama@example.com",
    phone: "0550000000",
    status: "Vendor assigned",
    nextStep: "Vendor should accept",
    area: "Osu",
    payment: "MTN MoMo",
    vendor: "CleanPro",
    driver: "Kofi",
    routeWindow: "2 PM - 4 PM",
    locationNote: "Door code 1234",
    latitude: 5.55602,
    longitude: -0.18291,
    accuracyMeters: 9,
    capturedAt: "2026-07-18T12:30:00.000Z",
    receivedAt: "2026-07-18T12:30:01.000Z",
    live: true,
    eventCount: 3,
    route: { googleMapsUrl: "https://maps.example", directionsUrl: "https://maps.example/dir", zoneLabel: "Core", zoneNote: "Core route" },
  });
  assert.equal(view.customer, "Ama");
  assert.equal("email" in view, false);
  assert.equal("phone" in view, false);
  assert.equal("payment" in view, false);
  assert.equal("vendor" in view, false);
  assert.equal("driver" in view, false);
  assert.equal("locationNote" in view, false);
  assert.equal("latitude" in view, false);
  assert.equal("longitude" in view, false);
  assert.equal("accuracyMeters" in view, false);
  assert.equal("capturedAt" in view, false);
  assert.equal("receivedAt" in view, false);
  assert.equal("live" in view, false);
  assert.equal(view.route?.googleMapsUrl, undefined);
});
