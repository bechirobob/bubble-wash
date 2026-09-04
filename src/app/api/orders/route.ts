import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { buildOrderSummaries, orderBoardRecords, orderMatchesStaffEntity, projectOrderSummaryForRole } from "@/lib/submissions";

import { readOrderPage } from "@/lib/operational-store";

export async function GET(request: NextRequest) {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });

  const offset = Math.max(0, Math.min(1000000, Number(request?.nextUrl.searchParams.get("offset")) || 0));
  const page = readOrderPage(offset, 100, request?.nextUrl.searchParams.get("q")?.trim().slice(0, 100) || "");
  const records = orderBoardRecords(page.records, user.role, user.entityId);
  const orders = buildOrderSummaries(records)
    .filter((order) => orderMatchesStaffEntity(order, user.role, user.entityId))
    .slice(0, 200)
    .map((order) => projectOrderSummaryForRole(order, user.role));
  return NextResponse.json({ ok: true, role: user.role, orders, nextOffset: page.nextOffset });
}
