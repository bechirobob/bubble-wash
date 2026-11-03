import { addons, plans, zones, type AddonKey, type PlanName, type ZoneKey } from './pricing.ts';

export type PricingDraft = { plan: PlanName; zone: ZoneKey; kg: string; addons: AddonKey[] };
const key = 'bubblewashPricingDraft';

export function readPricingHistory(state: unknown, href: string): PricingDraft | null {
  if (!state || typeof state !== 'object') return null;
  const entry = (state as Record<string, unknown>)[key];
  if (!entry || typeof entry !== 'object') return null;
  const value = entry as Record<string, unknown>;
  if (value.version !== 1 || value.href !== href ||
      typeof value.plan !== 'string' || !plans.some(plan => plan.name === value.plan) ||
      typeof value.zone !== 'string' || !Object.hasOwn(zones, value.zone) ||
      typeof value.kg !== 'string' || value.kg.length > 20 || !value.kg.trim() ||
      !Number.isFinite(Number(value.kg)) || Number(value.kg) <= 0 || Number(value.kg) > 10000 ||
      !Array.isArray(value.addons) || value.addons.length > Object.keys(addons).length ||
      !value.addons.every(addon => typeof addon === 'string' && Object.hasOwn(addons, addon)) ||
      new Set(value.addons).size !== value.addons.length ||
      (value.addons.includes('premium') && value.addons.includes('ironing'))) return null;
  return { plan: value.plan as PlanName, zone: value.zone as ZoneKey, kg: value.kg, addons: [...value.addons] as AddonKey[] };
}

export function withPricingHistory(state: unknown, href: string, draft: PricingDraft) {
  return { ...(state && typeof state === 'object' ? state : {}), [key]: { version: 1, href, ...draft, addons: [...draft.addons] } };
}
