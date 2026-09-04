import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyPickupLocation } from "../src/lib/pickup-location.ts";
import { recommendPlan } from "../src/lib/plan-recommendation.ts";

test("plan recommendation scales with laundry rhythm, locations, and support needs", () => {
  const weekly = recommendPlan({
    businessType: "Office or small team",
    laundryRhythm: "About once a week",
    locationCount: "1 location",
    servicePriority: "Standard scheduled service",
  });
  assert.equal(weekly.name, "Weekly");
  assert.match(weekly.reasons[0], /supplied .*bag/i);

  const regular = recommendPlan({
    businessType: "Restaurant or catering",
    laundryRhythm: "Every 3–4 days",
    locationCount: "1 location",
    servicePriority: "Priority route planning",
  });
  assert.equal(regular.name, "Twice weekly");

  const frequent = recommendPlan({
    businessType: "Hospitality or serviced apartments",
    laundryRhythm: "Every 2 days",
    locationCount: "1 location",
    servicePriority: "Standard scheduled service",
  });
  assert.equal(frequent.name, "Three times weekly");

  const dedicated = recommendPlan({
    businessType: "Office or small team",
    laundryRhythm: "About once a week",
    locationCount: "1 location",
    servicePriority: "Dedicated support and service levels",
  });
  assert.equal(dedicated.name, "Contract");

  const contract = recommendPlan({
    businessType: "Large facility or multi-site",
    laundryRhythm: "Daily or almost daily",
    locationCount: "4+ locations",
    servicePriority: "Dedicated support and service levels",
  });
  assert.equal(contract.name, "Contract");
});

test("exact addresses produce private locality analytics fields without asking for an area", () => {
  assert.deepEqual(classifyPickupLocation("14 Oxford Street, Osu, Accra"), {
    locality: "Osu",
    clusterKey: "accra-osu",
    zone: "core",
    confidence: "address-match",
  });
  assert.equal(classifyPickupLocation("Community 12, Tema").clusterKey, "greater-accra-tema");
  assert.equal(classifyPickupLocation("A precise but currently unknown locality").confidence, "unmapped");
});

test("booking UI removes customer weight and area questions and uses exact pickup windows", async () => {
  const source = await readFile(new URL("../src/components/BookingExperience.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /name="area"/);
  assert.doesNotMatch(source, /name="kg"/);
  assert.doesNotMatch(source, /Preferred date|Any available window|Morning pickup|Afternoon pickup|Evening pickup/);
  assert.match(source, /Select your laundry pickup/);
  assert.match(source, /Exact pickup location/);
  assert.match(source, /8:00–10:00/);
  assert.match(source, /Recommended for your business/);
});
