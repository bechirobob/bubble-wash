import { readFileSync } from "node:fs";

const manifestPath = ".next/server/app-paths-manifest.json";
const requiredRoutes = [
  "/admin/page",
  "/drivers/page",
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
