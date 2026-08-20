import { plans, type PlanName } from "./pricing.ts";

export const businessTypes = [
  "Hospitality or serviced apartments",
  "Restaurant or catering",
  "Clinic or medical",
  "Office or small team",
  "Large facility or multi-site",
] as const;

export const laundryRhythms = [
  "About once a week",
  "Every 3–4 days",
  "Every 2 days",
  "Daily or almost daily",
] as const;

export const locationCounts = ["1 location", "2–3 locations", "4+ locations"] as const;

export const servicePriorities = [
  "Standard scheduled service",
  "Priority route planning",
  "Dedicated support and service levels",
] as const;

export type BusinessType = (typeof businessTypes)[number];
export type LaundryRhythm = (typeof laundryRhythms)[number];
export type LocationCount = (typeof locationCounts)[number];
export type ServicePriority = (typeof servicePriorities)[number];

export type PlanSurvey = {
  businessType: BusinessType;
  laundryRhythm: LaundryRhythm;
  locationCount: LocationCount;
  servicePriority: ServicePriority;
};

const planOrder: PlanName[] = ["Weekly", "Twice weekly", "Three times weekly", "Contract"];

function planForSurvey(survey: PlanSurvey): PlanName {
  if (
    survey.laundryRhythm === "Daily or almost daily"
    || survey.locationCount === "4+ locations"
    || survey.servicePriority === "Dedicated support and service levels"
  ) return "Contract";
  if (
    survey.laundryRhythm === "Every 2 days"
    || survey.businessType === "Large facility or multi-site"
    || (survey.locationCount === "2–3 locations" && survey.servicePriority === "Priority route planning")
  ) return "Three times weekly";
  if (
    survey.laundryRhythm === "Every 3–4 days"
    || survey.locationCount === "2–3 locations"
    || survey.servicePriority === "Priority route planning"
    || survey.businessType === "Clinic or medical"
  ) return "Twice weekly";
  return "Weekly";
}

export function recommendPlan(survey: PlanSurvey) {
  const name = planForSurvey(survey);
  const plan = plans.find((item) => item.name === name) ?? plans[0];
  const reasons = [
    survey.laundryRhythm === "About once a week"
      ? "A weekly collection matches how quickly your supplied laundry bag fills."
      : survey.laundryRhythm === "Every 3–4 days"
        ? "Two collections a week keep laundry from building beyond the supplied bag."
        : survey.laundryRhythm === "Every 2 days"
          ? "Three weekly collections match your faster laundry cycle."
          : "Near-daily collection needs a contracted route and agreed service levels.",
    survey.locationCount === "1 location"
      ? "One location keeps collection scheduling straightforward."
      : `${survey.locationCount} need a plan with stronger route coordination.`,
    survey.servicePriority === "Standard scheduled service"
      ? "Standard operational support is enough for the service level selected."
      : survey.servicePriority === "Priority route planning"
        ? "Priority route planning is built into the recommended service level."
        : "Dedicated support and service levels are best handled under contract.",
  ];

  return {
    name,
    plan,
    reasons,
    alternatives: planOrder.filter((candidate) => candidate !== name),
  };
}

export function isCompletePlanSurvey(value: Partial<PlanSurvey>): value is PlanSurvey {
  return businessTypes.includes(value.businessType as BusinessType)
    && laundryRhythms.includes(value.laundryRhythm as LaundryRhythm)
    && locationCounts.includes(value.locationCount as LocationCount)
    && servicePriorities.includes(value.servicePriority as ServicePriority);
}
