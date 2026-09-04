import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { staffWriteGuard } from "@/lib/security";
import { decideCustomerRequest } from "@/lib/customer-decisions";
export async function POST(request: NextRequest) {
  const guard = staffWriteGuard(request.headers); if (guard) return guard;
  const user = await getCurrentStaffUser();
  if (!user || !["admin", "support"].includes(user.role)) return NextResponse.json({ ok: false }, { status: 403 });
  try {
    const body = await request.json();
    if (!["approve", "decline"].includes(body.decision) || typeof body.note !== "string" || !body.note.trim() || body.note.length > 600 || typeof body.ticketId !== "string") throw new Error("Select a decision and explain it.");
    const id = decideCustomerRequest(body.ticketId, body.decision, body.note.trim(), user.email);
    return NextResponse.json({ ok: true, id, message: "Decision applied and recorded." });
  } catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to apply decision." }, { status: 409 }); }
}
