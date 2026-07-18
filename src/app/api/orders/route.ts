import { NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { buildOrderSummaries, orderBoardRecords, readSubmissions } from "@/lib/submissions";

export async function GET() {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });

  const records = orderBoardRecords(await readSubmissions(2000), user.role);
  const orders = buildOrderSummaries(records).slice(0, 200);
  return NextResponse.json({ ok: true, role: user.role, orders });
}
