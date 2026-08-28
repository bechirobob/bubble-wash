import test from "node:test";
import assert from "node:assert/strict";
import {
  isMaintenanceBypassPath,
  maintenanceApiBody,
  maintenanceHeaders,
  maintenanceHtml,
} from "../src/lib/maintenance-gate.ts";

test("maintenance gate leaves only operational routes and required assets available", () => {
  for (const path of [
    "/api/health",
    "/api/ready",
    "/api/internal/maintenance",
    "/api/internal/metrics",
    "/_next/static/chunks/app.js",
    "/maintenance.css",
    "/bubble-wash-icon.jpg",
  ]) {
    assert.equal(isMaintenanceBypassPath(path), true, `${path} should bypass maintenance`);
  }

  for (const path of [
    "/",
    "/services",
    "/book",
    "/track",
    "/manage",
    "/admin",
    "/admin/recover",
    "/api/orders",
    "/api/customer/order",
    "/robots.txt",
    "/sitemap.xml",
  ]) {
    assert.equal(isMaintenanceBypassPath(path), false, `${path} should be in maintenance`);
  }
});

test("maintenance page is branded, user-friendly, and contains the release marker", () => {
  assert.match(maintenanceHtml, /data-bubblewash-maintenance/);
  assert.match(maintenanceHtml, /Bubble Wash/);
  assert.match(maintenanceHtml, /quick wash cycle/i);
  assert.match(maintenanceHtml, /temporarily unavailable/i);
  assert.match(maintenanceHtml, /maintenance\.css/);
  assert.doesNotMatch(maintenanceHtml, /owner|payment|invoice|dispute/i);
});

test("maintenance responses are temporary, non-cacheable, and excluded from indexing", () => {
  const headers = maintenanceHeaders("text/html; charset=utf-8");
  assert.match(headers["Cache-Control"], /no-store/);
  assert.equal(headers["CDN-Cache-Control"], "no-store");
  assert.equal(headers["Cloudflare-CDN-Cache-Control"], "no-store");
  assert.equal(headers["Retry-After"], "3600");
  assert.match(headers["X-Robots-Tag"], /noindex/);
  assert.match(headers["Content-Security-Policy"], /default-src 'none'/);
  assert.match(maintenanceApiBody, /service_unavailable/);
});
