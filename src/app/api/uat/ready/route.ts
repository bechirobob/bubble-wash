import { NextResponse } from "next/server";
import { assertUatEnvironment, uatModeEnabled } from "@/lib/uat-environment";
import { databaseReadiness, openReadOnlyDatabase } from "@/lib/data-store";
import { initializeUatAccountsSchema } from "@/lib/uat-accounts";
import { currentStaffUsers } from "@/lib/auth";

/** UAT-only admission check. It never substitutes for production /api/ready. */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  if (!uatModeEnabled()) return NextResponse.json({ ok: false }, { status: 404, headers });
  let database: ReturnType<typeof openReadOnlyDatabase> | undefined;
  let ready = false;
  try {
    assertUatEnvironment();
    if ((process.env.BUBBLEWASH_SESSION_SECRET || "").length < 32 ||
        process.env.BUBBLEWASH_DATABASE_DRIVER !== "sqlite" ||
        process.env.BUBBLEWASH_STAFF_AUTH_DISABLED === "true") throw new Error("UAT admission blocked");
    database = openReadOnlyDatabase();
    const users = currentStaffUsers(database);
    ready = databaseReadiness(database, [initializeUatAccountsSchema]) &&
      ["admin", "vendor", "driver", "support"].every((role) => users.some((user) => user.role === role && user.temporaryAccess));
  } catch {
    ready = false;
  } finally {
    database?.close();
  }
  return NextResponse.json({
    ok: ready, environment: "isolated-uat", readiness: ready ? "ready-for-uat" : "blocked",
    externalProviders: "disabled", productionReady: false,
  }, { status: ready ? 200 : 503, headers });
}
