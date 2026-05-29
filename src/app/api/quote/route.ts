import { NextRequest, NextResponse } from "next/server";
import { calculateQuote, type AddonKey, type DiscountKey, type PlanName, type ZoneKey } from "@/lib/pricing";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const plan = body.plan as PlanName;
    const kg = Number(body.kg);
    const addons = Array.isArray(body.addons) ? (body.addons as AddonKey[]) : [];
    const zone = (body.zone ?? "core") as ZoneKey;
    const discount = (body.discount ?? "none") as DiscountKey;
    return NextResponse.json({ ok: true, quote: calculateQuote(plan, kg, addons, zone, discount) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to calculate quote" }, { status: 400 });
  }
}
