import test from "node:test";
import assert from "node:assert/strict";
import { clientScopeKey, securityHeaders, staffWriteGuard, productionReadinessErrors, productionReadinessWarnings, publicTrackingView } from "../src/lib/security.ts";

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
  assert.ok(map.has("permissions-policy"));
  assert.equal(map.has("x-powered-by"), false);
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
  assert.equal(errors.some((item) => item.includes("NEXT_PUBLIC_BUBBLEWASH_WHATSAPP")), false);
  assert.equal(errors.some((item) => item.includes("NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL")), false);
});

test("pilot operations may hide optional public contacts while readiness reports warnings", () => {
  const warnings = productionReadinessWarnings({ NODE_ENV: "production" });
  assert.ok(warnings.some((item) => item.includes("public WhatsApp contact link")));
  assert.ok(warnings.some((item) => item.includes("public email contact link")));
  assert.ok(warnings.some((item) => item.includes("bank transfer and approved invoicing")));
  assert.ok(warnings.some((item) => item.includes("follow up with customers manually")));
});

test("manual pilot mode allows missing providers but still blocks missing trusted edge configuration", () => {
  const errors = productionReadinessErrors({ NODE_ENV: "production", BUBBLEWASH_DISABLE_DEMO_LOGIN: "true" });
  assert.equal(errors.some((item) => item.includes("PAYSTACK_SECRET_KEY")), false);
  assert.equal(errors.some((item) => item.includes("RESEND_API_KEY")), false);
  assert.equal(errors.some((item) => item.includes("WHATSAPP_ACCESS_TOKEN")), false);
  assert.ok(errors.some((item) => item.includes("trusted client-IP mode")));
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
  assert.equal(view.route?.googleMapsUrl, undefined);
});
