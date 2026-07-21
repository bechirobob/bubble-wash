import { NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { buildOrderSummaries, orderBoardRecords, orderMatchesStaffEntity, projectOrderSummaryForRole, readSubmissions } from "@/lib/submissions";

export async function GET() {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });

  const records = orderBoardRecords(await readSubmissions(2000), user.role, user.entityId);
  const orders = buildOrderSummaries(records)
    .filter((order) => orderMatchesStaffEntity(order, user.role, user.entityId))
    .slice(0, 200)
    .map((order) => projectOrderSummaryForRole(order, user.role));
  return NextResponse.json({ ok: true, role: user.role, orders });
}
