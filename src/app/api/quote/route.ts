import { NextRequest, NextResponse } from "next/server";
import { addons, calculateQuote, discounts, plans, zones, type AddonKey, type DiscountKey, type PlanName, type ZoneKey } from "@/lib/pricing";

const planNames = new Set(plans.map((plan) => plan.name));
const addonNames = new Set(Object.keys(addons));
const zoneNames = new Set(Object.keys(zones));
const discountNames = new Set(Object.keys(discounts));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumValue<T extends string>(value: unknown, allowed: Set<string>, fallback: T | null, label: string): T {
  if (typeof value === "string" && allowed.has(value)) return value as T;
  if (fallback) return fallback;
  throw new Error(`Select a valid ${label}.`);
}

function quoteWeight(value: unknown) {
  const kg = Number(value);
  if (!Number.isFinite(kg) || kg <= 0) throw new Error("Laundry weight must be greater than zero.");
  if (kg > 10000) throw new Error("Laundry weight is too large for an online estimate. Request an enterprise quote.");
  return kg;
}

function addonList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AddonKey => typeof item === "string" && addonNames.has(item)).slice(0, 12);
}

async function readQuotePayload(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody: unknown = await readQuotePayload(request);
    if (!isObject(rawBody)) throw new Error("Invalid quote request.");

    const plan = enumValue<PlanName>(rawBody.plan, planNames, null, "plan");
    const kg = quoteWeight(rawBody.kg);
    const selectedAddons = addonList(rawBody.addons);
    const zone = enumValue<ZoneKey>(rawBody.zone, zoneNames, "core", "pickup zone");
    const discount = enumValue<DiscountKey>(rawBody.discount, discountNames, "none", "discount");

    return NextResponse.json({ ok: true, quote: calculateQuote(plan, kg, selectedAddons, zone, discount) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to calculate quote." }, { status: 400 });
  }
}
