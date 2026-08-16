import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { listPrivacyRequests, operationsDataMetrics, updatePrivacyRequestStatus, type PrivacyRequest } from "@/lib/data-store";
import { staffWriteGuard } from "@/lib/security";

const statuses = new Set<PrivacyRequest["status"]>(["received", "identity_review", "completed", "declined"]);

async function admin() {
  const user = await getCurrentStaffUser();
  return user?.role === "admin" ? user : null;
}

export async function GET() {
  if (!await admin()) return NextResponse.json({ ok: false, error: "Admin authentication required." }, { status: 403 });
  const [metrics, privacyRequests] = await Promise.all([operationsDataMetrics(), listPrivacyRequests()]);
  return NextResponse.json({ ok: true, metrics, privacyRequests }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  if (!await admin()) return NextResponse.json({ ok: false, error: "Admin authentication required." }, { status: 403 });
  const guard = staffWriteGuard(request.headers);
  if (guard) return guard;
  try {
    const body = await request.json<Record<string, unknown>>();
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const status = typeof body.status === "string" ? body.status as PrivacyRequest["status"] : "received";
    if (!/^PR-[A-Z0-9]{8,32}$/.test(id) || !statuses.has(status)) return NextResponse.json({ ok: false, error: "Invalid privacy request update." }, { status: 400 });
    const updated = await updatePrivacyRequestStatus(id, status);
    if (!updated) return NextResponse.json({ ok: false, error: "Privacy request not found." }, { status: 404 });
    return NextResponse.json({ ok: true, request: updated });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to update the privacy request." }, { status: 500 });
  }
}
