export type PlanName = "Essentials" | "Growth" | "Scale" | "Enterprise";
export type ZoneKey = "core" | "near" | "outer" | "custom";
export type DiscountKey = "none" | "newPilot" | "prepaidQuarter" | "vendorReferral";

export type Plan = {
  name: PlanName;
  description: string;
  subscription: number;
  pickups: string;
  monthlyPickups: number;
  badge?: string;
  audience: string;
  bands: Array<{ min: number; max: number | null; rate: number }>;
  features: string[];
};

export const plans: Plan[] = [
  {
    name: "Essentials",
    description: "A steady weekly run for small teams that need clean laundry without daily follow-up.",
    subscription: 1250,
    pickups: "1 pickup / week",
    monthlyPickups: 4,
    audience: "Small restaurants, clinics, and serviced units",
    bands: [
      { min: 20, max: 39, rate: 18 },
      { min: 40, max: 59, rate: 16.5 },
      { min: 60, max: null, rate: 15.5 },
    ],
    features: ["4 scheduled pickups / month", "Basic order updates", "One invoice trail", "Support by WhatsApp", "Assigned laundry partner"],
  },
  {
    name: "Growth",
    description: "The practical operating plan for businesses with real weekly volume and repeat pickups.",
    subscription: 2250,
    pickups: "2 pickups / week",
    monthlyPickups: 8,
    badge: "Most chosen",
    audience: "Apartments, clinics, restaurants, and busy teams",
    bands: [
      { min: 30, max: 59, rate: 17 },
      { min: 60, max: 99, rate: 15.5 },
      { min: 100, max: null, rate: 14.5 },
    ],
    features: ["8 scheduled pickups / month", "Priority route planning", "Issue escalation", "Packaging notes", "Monthly service summary"],
  },
  {
    name: "Scale",
    description: "Built for larger teams with heavier laundry cycles and tighter operating windows.",
    subscription: 3250,
    pickups: "3 pickups / week",
    monthlyPickups: 12,
    audience: "Multi-unit operators and high-volume teams",
    bands: [
      { min: 50, max: 99, rate: 16 },
      { min: 100, max: 149, rate: 14.5 },
      { min: 150, max: null, rate: 13.5 },
    ],
    features: ["12 scheduled pickups / month", "Multi-order visibility", "Preferred vendor routing", "Manager support workflow", "Operational reporting"],
  },
  {
    name: "Enterprise",
    description: "Contracted laundry operations for high-volume customers, medical groups, and special requirements.",
    subscription: 4750,
    pickups: "5–6 pickups / week",
    monthlyPickups: 22,
    audience: "Medical groups, large facilities, and custom accounts",
    bands: [{ min: 1, max: null, rate: 13.5 }],
    features: ["Custom routing", "Custom SLAs", "Dedicated support", "Contracted pricing", "Account review cadence"],
  },
];

export const addons = {
  ironing: { label: "Ironing", perKg: 4 },
  premium: { label: "Premium wash + iron + fold", perKg: 5 },
  stain: { label: "Stain treatment", perKg: 2 },
  express: { label: "Express turnaround under 24h", percent: 0.25 },
  weekend: { label: "Weekend pickup / delivery", fixed: 75 },
  extraPickup: { label: "Extra unscheduled pickup", fixed: 90 },
} as const;

export const zones: Record<ZoneKey, { label: string; fee: number; note: string }> = {
  core: { label: "Core Accra route", fee: 0, note: "Osu, Labone, Cantonments, Airport, East Legon" },
  near: { label: "Near-route pickup", fee: 45, note: "Spintex, Madina, Dzorwulu, Ridge and nearby areas" },
  outer: { label: "Outer route", fee: 95, note: "Tema and longer pickup loops" },
  custom: { label: "Custom / confirm first", fee: 0, note: "Team confirms route and cost before activation" },
};

export const discounts: Record<DiscountKey, { label: string; percent: number }> = {
  none: { label: "No discount", percent: 0 },
  newPilot: { label: "New customer discount", percent: 0.1 },
  prepaidQuarter: { label: "Quarterly prepaid discount", percent: 0.15 },
  vendorReferral: { label: "Vendor referral credit", percent: 0.08 },
};

export type AddonKey = keyof typeof addons;

export function calculateQuote(
  planName: PlanName,
  kg: number,
  selectedAddons: AddonKey[] = [],
  zoneKey: ZoneKey = "core",
  discountKey: DiscountKey = "none",
) {
  const plan = plans.find((item) => item.name === planName);
  if (!plan) throw new Error("Select a valid plan.");
  if (!Number.isFinite(kg) || kg <= 0) throw new Error("Laundry weight must be greater than zero.");

  const band = plan.bands.find((item) => kg >= item.min && (item.max === null || kg <= item.max));
  if (!band) {
    const minimum = plan.bands[0]?.min ?? 1;
    throw new Error(`${plan.name} starts at ${minimum}kg per pickup. Increase the weight or choose another plan.`);
  }

  const zone = zones[zoneKey] ?? zones.core;
  const discount = discounts[discountKey] ?? discounts.none;
  const processingPerPickup = kg * band.rate;
  const addonLines = selectedAddons.map((key) => {
    const addon = addons[key];
    let amount = 0;
    if ("perKg" in addon) amount = kg * addon.perKg;
    if ("percent" in addon) amount = processingPerPickup * addon.percent;
    if ("fixed" in addon) amount = addon.fixed;
    return { key, label: addon.label, amount: Math.round(amount * 100) / 100 };
  });
  const addonsPerPickup = addonLines.reduce((sum, item) => sum + item.amount, 0);
  const rawPickupTotal = processingPerPickup + addonsPerPickup + zone.fee;
  const perPickupBeforeMinimum = rawPickupTotal;
  const perPickupTotal = Math.max(perPickupBeforeMinimum, 450);
  const grossMonthlyTotal = plan.subscription + perPickupTotal * plan.monthlyPickups;
  const discountAmount = grossMonthlyTotal * discount.percent;
  const estimatedMonthlyTotal = grossMonthlyTotal - discountAmount;

  return {
    plan: plan.name,
    pickupRhythm: plan.pickups,
    kg,
    zone: zone.label,
    zoneFee: zone.fee,
    discount: discount.label,
    discountPercent: discount.percent,
    discountAmount: Math.round(discountAmount * 100) / 100,
    ratePerKg: band.rate,
    subscription: plan.subscription,
    monthlyPickups: plan.monthlyPickups,
    processingPerPickup: Math.round(processingPerPickup * 100) / 100,
    addonsPerPickup: Math.round(addonsPerPickup * 100) / 100,
    addonLines,
    minimumApplied: perPickupBeforeMinimum < 450,
    perPickupTotal: Math.round(perPickupTotal * 100) / 100,
    grossMonthlyTotal: Math.round(grossMonthlyTotal * 100) / 100,
    estimatedMonthlyTotal: Math.round(estimatedMonthlyTotal * 100) / 100,
  };
}
