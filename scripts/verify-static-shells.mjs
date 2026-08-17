import { existsSync, readFileSync } from "node:fs";

const publicRoutes = [
  "/",
  "/services",
  "/book",
  "/track",
  "/manage",
  "/early-access",
  "/privacy",
  "/terms",
  "/refund-policy",
  "/staff",
  "/login",
];
const htmlPath = (route) => route === "/" ? "dist/client/index.html" : `dist/client${route}/index.html`;

for (const route of publicRoutes) {
  const path = htmlPath(route);
  if (!existsSync(path)) throw new Error(`Static public route is missing: ${route} (${path})`);
  const html = readFileSync(path, "utf8");
  if (!/^<!doctype html>/iu.test(html.trimStart()) || !html.includes("Bubble Wash")) {
    throw new Error(`Static public route is incomplete: ${route}`);
  }
  if (/Admin123!|Vendor123!|Driver123!|Support123!/u.test(html)) {
    throw new Error(`Static public route exposes demo credentials: ${route}`);
  }
}

for (const document of ["dist/client/robots.txt", "dist/client/sitemap.xml"]) {
  if (!existsSync(document) || readFileSync(document, "utf8").trim().length === 0) {
    throw new Error(`Static public document is missing: ${document}`);
  }
}

const headers = readFileSync("dist/client/_headers", "utf8");
if (!headers.includes("X-BubbleWash-Render: asset") || !headers.includes("Content-Security-Policy:")) {
  throw new Error("Static asset security headers are incomplete.");
}

const config = JSON.parse(readFileSync("dist/server/wrangler.json", "utf8"));
const workerFirst = config.assets?.run_worker_first;
for (const pattern of ["/api/*", "/admin*", "/vendors*", "/drivers*", "/support*", "/scan*"]) {
  if (!Array.isArray(workerFirst) || !workerFirst.includes(pattern)) throw new Error(`Worker-first route is missing: ${pattern}`);
}
for (const route of publicRoutes) {
  if (workerFirst.includes(route)) throw new Error(`Public route is incorrectly Worker-first: ${route}`);
}

console.log(`Static public shells verified: ${publicRoutes.join(", ")}`);
