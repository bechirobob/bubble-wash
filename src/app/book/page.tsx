import type { Metadata } from "next";
import { plans, addons, type AddonKey } from "@/lib/pricing";
import { BookingExperience } from "@/components/BookingExperience";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";

export const metadata: Metadata = {
  title: "Book a commercial laundry pickup | Bubble Wash",
  description: "Request a Bubble Wash commercial laundry collection in Accra.",
  alternates: { canonical: "/book" },
};

import { bookingAvailable } from "@/lib/booking-policy";
export const dynamic = "force-dynamic";

export default async function BookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const selected = plans.find((plan) => plan.name === params.plan);
  const extras = typeof params.addons === "string" ? params.addons.split(",").filter((key): key is AddonKey => Object.hasOwn(addons, key)) : [];
  const initialAddons = [...new Set(extras)].filter((key) => key !== "ironing" || !extras.includes("premium"));
  return <PublicChrome><PageIntro eyebrow={bookingAvailable() ? "Request a pickup" : "Pickup availability"} title={bookingAvailable() ? "Let’s make laundry day lighter." : "A short pause on new pickups."} summary={bookingAvailable() ? "Find your plan, tell us where to collect, and choose a pickup time. We’ll confirm the details with you." : "Existing orders are still here. Follow your laundry or manage your booking below."} icon="booking" /><BookingExperience available={bookingAvailable()} initialPlan={selected?.name} initialAddons={initialAddons} /></PublicChrome>;
}
