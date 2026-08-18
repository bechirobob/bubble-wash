import { NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { listDriverAvailability, listVendorAvailability, listVendorDeclines } from "@/lib/availability-store";

export async function GET() {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });

  if ((user.role === "vendor" || user.role === "driver") && process.env.NODE_ENV === "production" && !user.entityId) {
    return NextResponse.json({ ok: false, error: "Staff roster binding is required." }, { status: 403 });
  }

  const allVendors = listVendorAvailability();
  const allDrivers = listDriverAvailability();
  if (user.role === "admin") {
    return NextResponse.json({ ok: true, vendors: allVendors, drivers: allDrivers, declines: listVendorDeclines().slice(0, 50) });
  }

  if (user.role === "support") {
    return NextResponse.json({ ok: true, vendors: [], drivers: [], declines: [] });
  }

  if (user.entityId) {
    return NextResponse.json({
      ok: true,
      vendors: user.role === "vendor" ? allVendors.filter((vendor) => vendor.vendorId === user.entityId) : [],
      drivers: user.role === "driver" ? allDrivers.filter((driver) => driver.driverId === user.entityId) : [],
      declines: [],
    });
  }

  // Local development without an entity binding preserves the original
  // single-role workspace behavior.
  return NextResponse.json({
    ok: true,
    vendors: allVendors,
    drivers: user.role === "driver" ? allDrivers : [],
    declines: [],
  });
}
