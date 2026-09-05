import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PricingCalculator } from "@/components/PricingCalculator";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";
import { plans, zones } from "@/lib/pricing";
import { bookingAvailable } from "@/lib/booking-policy";
import { formatMoney } from "@/lib/public-ui";

export const metadata: Metadata = {
  title: "Commercial laundry services and pricing | Bubble Wash",
  description: "Compare Bubble Wash commercial laundry plans, service areas, optional care services, and monthly estimates for Accra businesses.",
  alternates: { canonical: "/services" },
};

export default async function ServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const selectedPlan = plans.find(plan => plan.name === params.plan)?.name ?? "Twice weekly";
  return (
    <PublicChrome>
      <PageIntro eyebrow="Services & pricing" title="Laundry plans & pricing." summary="Find the right pickup plan for your business, see where we collect, and estimate your laundry costs." icon="services" />
      <PricingCalculator key={selectedPlan} initialPlan={selectedPlan} available={bookingAvailable()} showCatalogue />
      <section className="serviceSection pageShell" aria-labelledby="coverage-heading"><div className="sectionIntro"><p className="sectionLabel">Pickup areas</p><h2 id="coverage-heading">Where we pick up.</h2></div><div className="zoneGrid">{Object.entries(zones).map(([key, zone]) => <article key={key}><h3>{zone.label}</h3><strong>{zone.fee ? `${formatMoney(zone.fee)} / pickup` : key === "custom" ? "Confirmed first" : "Included"}</strong><p>{zone.note}</p></article>)}</div></section>
      <section className="serviceSection pageShell serviceConditions" aria-labelledby="conditions-heading"><div className="sectionIntro"><p className="sectionLabel">Service conditions</p><h2 id="conditions-heading">A few things to know before pickup.</h2></div><div className="policyGrid"><article><h3>Final weight</h3><p>Your online price is an estimate. Your final bill is based on the weight we record when your laundry arrives.</p></article><article><h3>Collection window</h3><p>Choose your preferred pickup time. We’ll confirm it with you before a rider sets off.</p></article><article><h3>Care and item issues</h3><p>Declare special-care items before collection and report missing or damaged items within 24 hours of delivery.</p></article><article><h3>Payment</h3><p>Bank transfer and approved invoicing are active during the pilot. Card and Mobile Money checkout remain unavailable.</p></article></div><Link className="inlineIconLink" href="/terms">Read the complete service terms <ArrowRight aria-hidden="true" /></Link></section>
    </PublicChrome>
  );
}
