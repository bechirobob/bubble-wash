import { existsSync, readFileSync } from "node:fs";

const workerBundlePath = "dist/server/index.js";
const workerConfigPath = "dist/server/wrangler.json";
const requiredRoutes = [
  ["/", "src/app/page.tsx"],
  ["/admin", "src/app/admin/page.tsx"],
  ["/book", "src/app/book/page.tsx"],
  ["/drivers", "src/app/drivers/page.tsx"],
  ["/early-access", "src/app/early-access/page.tsx"],
  ["/login", "src/app/login/page.tsx"],
  ["/manage", "src/app/manage/page.tsx"],
  ["/privacy", "src/app/privacy/page.tsx"],
  ["/refund-policy", "src/app/refund-policy/page.tsx"],
  ["/scan", "src/app/scan/page.tsx"],
  ["/services", "src/app/services/page.tsx"],
  ["/staff", "src/app/staff/page.tsx"],
  ["/support", "src/app/support/page.tsx"],
  ["/terms", "src/app/terms/page.tsx"],
  ["/track", "src/app/track/page.tsx"],
  ["/vendors", "src/app/vendors/page.tsx"],
  ["/robots.txt", "src/app/robots.ts"],
  ["/sitemap.xml", "src/app/sitemap.ts"],
  ["/api/admin/operations", "src/app/api/admin/operations/route.ts"],
  ["/api/availability", "src/app/api/availability/route.ts"],
  ["/api/customer/access", "src/app/api/customer/access/route.ts"],
  ["/api/customer/logout", "src/app/api/customer/logout/route.ts"],
  ["/api/customer/order", "src/app/api/customer/order/route.ts"],
  ["/api/customer/request", "src/app/api/customer/request/route.ts"],
  ["/api/dispatch/location", "src/app/api/dispatch/location/route.ts"],
  ["/api/early-access", "src/app/api/early-access/route.ts"],
  ["/api/health", "src/app/api/health/route.ts"],
  ["/api/internal/maintenance", "src/app/api/internal/maintenance/route.ts"],
  ["/api/internal/metrics", "src/app/api/internal/metrics/route.ts"],
  ["/api/internal/migration", "src/app/api/internal/migration/route.ts"],
  ["/api/login/challenge", "src/app/api/login/challenge/route.ts"],
  ["/api/login", "src/app/api/login/route.ts"],
  ["/api/logout", "src/app/api/logout/route.ts"],
  ["/api/orders", "src/app/api/orders/route.ts"],
  ["/api/orders/advance", "src/app/api/orders/advance/route.ts"],
  ["/api/orders/label", "src/app/api/orders/label/route.ts"],
  ["/api/payments/initialize", "src/app/api/payments/initialize/route.ts"],
  ["/api/payments/verify", "src/app/api/payments/verify/route.ts"],
  ["/api/privacy/requests", "src/app/api/privacy/requests/route.ts"],
  ["/api/quote", "src/app/api/quote/route.ts"],
  ["/api/ready", "src/app/api/ready/route.ts"],
  ["/api/route-preview", "src/app/api/route-preview/route.ts"],
  ["/api/staff/roster", "src/app/api/staff/roster/route.ts"],
  ["/api/submissions", "src/app/api/submissions/route.ts"],
  ["/api/submit", "src/app/api/submit/route.ts"],
  ["/api/track", "src/app/api/track/route.ts"],
];

const missingSources = requiredRoutes.filter(([, source]) => !existsSync(source));
if (missingSources.length) {
  console.error(`Required route sources are missing: ${missingSources.map(([route]) => route).join(", ")}`);
  process.exit(1);
}

if (!existsSync(workerConfigPath)) {
  console.error(`Unable to find ${workerConfigPath}. Run npm run build first.`);
  process.exit(1);
}

let workerBundle;
try {
  workerBundle = readFileSync(workerBundlePath, "utf8");
} catch (error) {
  console.error(`Unable to read the production Worker bundle at ${workerBundlePath}. Run npm run build first.`);
  if (error instanceof Error) console.error(error.message);
  process.exit(1);
}

// The root route is represented by the router itself; every non-root route is
// emitted as a literal URL in Vinext's production Worker route table.
const missingBuiltRoutes = requiredRoutes
  .filter(([route]) => route !== "/" && !workerBundle.includes(route))
  .map(([route]) => route);
if (missingBuiltRoutes.length) {
  console.error(`Required production routes are missing from the Worker bundle: ${missingBuiltRoutes.join(", ")}`);
  process.exit(1);
}

console.log(`Required production routes verified in the Worker bundle: ${requiredRoutes.map(([route]) => route).join(", ")}`);
