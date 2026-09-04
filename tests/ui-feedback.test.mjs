import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { statusTone } from "../src/lib/public-ui.ts";

test("public status messages use semantic success, warning, info, and error tones", () => {
  assert.equal(statusTone("Booking verified."), "status success");
  assert.equal(statusTone("Payment pending approval."), "status warning");
  assert.equal(statusTone("Checking availability…"), "status info");
  assert.equal(statusTone("Unable to verify this booking."), "status error");
});

test("loading skeletons expose busy state while hiding decorative shapes", async () => {
  const source = await readFile(new URL("../src/components/LoadingSkeleton.tsx", import.meta.url), "utf8");
  const routeSource = await readFile(new URL("../src/components/RouteLoadingSkeleton.tsx", import.meta.url), "utf8");
  const routeLoading = await readFile(new URL("../src/app/loading.tsx", import.meta.url), "utf8");
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-busy="true"/);
  assert.match(source, /aria-hidden="true"/);
  assert.match(routeSource, /role="status"/);
  assert.match(routeSource, /aria-busy="true"/);
  assert.match(routeSource, /aria-hidden="true"/);
  assert.match(routeLoading, /RouteLoadingSkeleton/);
});

test("public routes warm on capable connections and page transitions respect reduced motion", async () => {
  const warmup = await readFile(new URL("../src/components/RouteWarmup.tsx", import.meta.url), "utf8");
  const template = await readFile(new URL("../src/app/template.tsx", import.meta.url), "utf8");
  const chrome = await readFile(new URL("../src/components/PublicChrome.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(warmup, /router\.prefetch/);
  assert.match(warmup, /saveData/);
  assert.match(warmup, /effectiveType/);
  assert.match(chrome, /<RouteWarmup \/>/);
  assert.match(template, /className="routeScene"/);
  assert.match(css, /--motion-route-duration/);
  assert.match(css, /@keyframes route-scene-arrival/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\.routeLoadingHero\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(css, /\.routeScene\s*\{\s*animation:\s*none/s);
});

test("semantic tokens cover status roles, reduced motion, and forced colors", async () => {
  const css = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
  for (const token of ["--status-info", "--status-success", "--status-warning", "--status-danger", "--skeleton-base"]) {
    assert.match(css, new RegExp(token));
  }
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /forced-colors:\s*active/);
  assert.match(css, /\.loadingSkeletonRow > span::after/);
});

test("brand artwork is unboxed and shared across public and staff surfaces", async () => {
  const css = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const brand = await readFile(new URL("../src/components/BrandLink.tsx", import.meta.url), "utf8");
  const artworkRule = css.match(/\.brandArtwork\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.ok(artworkRule, "brand artwork rule should exist");
  assert.doesNotMatch(artworkRule, /border|background|border-radius/);
  assert.match(brand, /className="brandArtwork"/);
});

test("staff access presents direct role choices without invented workspace descriptions", async () => {
  const source = await readFile(new URL("../src/app/staff/page.tsx", import.meta.url), "utf8");
  for (const role of ["Admin", "Vendor", "Driver", "Support"]) assert.match(source, new RegExp(`role: "${role}"`));
  assert.match(source, /<h1>Staff access<\/h1>/);
  assert.match(source, /<h2><Icon aria-hidden="true" \/>\{path\.role\}<\/h2>/);
  assert.doesNotMatch(source, /Operations queue|Laundry partner queue|Pickup and delivery board|Customer resolution desk/);
  assert.doesNotMatch(source, /Role-specific staff paths|Order review, reassignment|Accept jobs, manage capacity|See route handoffs|Track customer issues/);
});

test("login remains visible and reports the locked response as an accessible error", async () => {
  const page = await readFile(new URL("../src/app/login/page.tsx", import.meta.url), "utf8");
  const form = await readFile(new URL("../src/components/LoginPage.tsx", import.meta.url), "utf8");
  assert.match(page, /return <LoginPageClient \/>/);
  assert.doesNotMatch(page, /staffAccessDisabled/);
  assert.match(form, /Login cannot be reached\./);
  assert.match(form, /statusTone === "error" \? "alert" : "status"/);
  assert.match(form, /statusTone === "error" \? "assertive" : "polite"/);
});

test("staff workspaces keep primary actions visible and collapse secondary detail", async () => {
  const source = await readFile(new URL("../src/components/StaffWorkspaces.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(source, /className="staffPrimaryAction"/);
  assert.match(source, /<details className="staffDetailDisclosure"><summary><span><strong>Customer and collection/);
  assert.match(source, /<details className="staffDetailDisclosure"><summary><span><strong>Assignment and route/);
  assert.match(source, /<details className="staffDetailDisclosure"><summary><span><strong>Order history/);
  assert.match(source, /staffDetailDisclosure staffControlDisclosure/);
  assert.match(source, /staffRosterEditor staffStandaloneEditor/);
  assert.match(css, /\.staffDetailDisclosure > summary/);
  assert.match(css, /\.staffDetailDisclosure\[open\] > summary::after/);
  assert.match(css, /\.staffDetailDisclosure > summary\s*\{[^}]*min-height:\s*56px/s);
});

test("the mobile menu exposes state and closes with Escape", async () => {
  const source = await readFile(new URL("../src/components/PublicHeader.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-expanded=\{mobileOpen\}/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /removeEventListener\("keydown", closeOnEscape\)/);
});
