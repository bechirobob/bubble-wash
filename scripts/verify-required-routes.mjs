import { readFileSync } from "node:fs";

const manifestPath = ".next/server/app-paths-manifest.json";
const requiredRoutes = [
  "/admin/page",
  "/book/page",
  "/drivers/page",
  "/early-access/page",
  "/privacy/page",
  "/terms/page",
  "/refund-policy/page",
  "/services/page",
  "/track/page",
  "/manage/page",
  "/robots.txt/route",
  "/sitemap.xml/route",
  "/scan/page",
  "/api/admin/operations/route",
  "/api/customer/access/route",
  "/api/customer/order/route",
  "/api/customer/request/route",
  "/api/early-access/route",
  "/api/internal/maintenance/route",
  "/api/internal/metrics/route",
  "/api/orders/label/route",
  "/api/privacy/requests/route",
  "/api/health/route",
  "/api/ready/route",
  "/api/orders/route",
  "/api/dispatch/location/route",
];

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`Unable to read the production route manifest at ${manifestPath}. Run npm run build first.`);
  if (error instanceof Error) console.error(error.message);
  process.exit(1);
}

const missing = requiredRoutes.filter((route) => !Object.hasOwn(manifest, route));
if (missing.length) {
  console.error(`Required production routes are missing: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Required production routes verified: ${requiredRoutes.join(", ")}`);
