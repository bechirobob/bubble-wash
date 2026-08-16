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
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-busy="true"/);
  assert.match(source, /aria-hidden="true"/);
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
