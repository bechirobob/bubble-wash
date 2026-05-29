import { NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { listDriverAvailability, listVendorAvailability, listVendorDeclines } from "@/lib/availability-store";

export async function GET() {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });

  return NextResponse.json({
    ok: true,
    vendors: listVendorAvailability(),
    drivers: user.role === "admin" || user.role === "driver" ? listDriverAvailability() : [],
    declines: user.role === "admin" ? listVendorDeclines().slice(0, 50) : [],
  });
}
