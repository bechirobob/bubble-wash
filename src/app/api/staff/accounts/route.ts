import { NextRequest, NextResponse } from "next/server";
import { currentStaffUsers, getCurrentStaffUser, type StaffRole } from "@/lib/auth";
import { inviteStaffAccount, listStaffAccounts, suspendStaffAccount } from "@/lib/staff-accounts";
import { staffWriteGuard } from "@/lib/security";
import { listDriverAvailability, listVendorAvailability } from "@/lib/availability-store";
export async function GET() {
  const user = await getCurrentStaffUser();
  if (user?.role !== "admin") return NextResponse.json({ ok: false }, { status: 403 });
  return NextResponse.json({ ok: true, accounts: listStaffAccounts().map((a) => ({ email: a.email, name: a.name, role: a.role, entityId: a.entityId, status: a.status, updatedAt: a.updatedAt })) }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: NextRequest) {
  const guard = staffWriteGuard(request.headers); if (guard) return guard;
  const user = await getCurrentStaffUser();
  if (user?.role !== "admin") return NextResponse.json({ ok: false }, { status: 403 });
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 160 || email === user.email.toLowerCase() || currentStaffUsers().some((account) => account.role === "admin" && account.email.toLowerCase() === email)) return NextResponse.json({ ok: false, error: "Use a valid individual work email other than your own account." }, { status: 400 });
    if (body.action === "suspend") { suspendStaffAccount(email, user.email); return NextResponse.json({ ok: true }); }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    const role = body.role as StaffRole;
    const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
    if (!name || !["support", "vendor", "driver"].includes(role)) return NextResponse.json({ ok: false, error: "Enter a name and select support, vendor, or driver access. Master administration uses the existing protected recovery process." }, { status: 400 });
    if (role === "vendor" && !listVendorAvailability().some((v) => v.vendorId === entityId) || role === "driver" && !listDriverAvailability().some((d) => d.driverId === entityId)) return NextResponse.json({ ok: false, error: "Select an existing roster entity for this account." }, { status: 400 });
    const token = inviteStaffAccount({ email, name, role, entityId: role === "support" ? "" : entityId }, user.email);
    return NextResponse.json({ ok: true, activationPath: `/staff/activate#${token}`, message: "Share this single-use link directly with the staff member. It expires in 24 hours." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to update access." }, { status: 400 }); }
}
