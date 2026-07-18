import { NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { projectStaffActivityRecord } from "@/lib/staff-activity-projection";
import { readSubmissions, visibleSubmissionRecords } from "@/lib/submissions";

export async function GET() {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });

  const records = visibleSubmissionRecords(await readSubmissions(500), user.role, user.entityId)
    .slice(0, 300)
    .map((record) => projectStaffActivityRecord(record, user.role));
  return NextResponse.json({ ok: true, role: user.role, records });
}
