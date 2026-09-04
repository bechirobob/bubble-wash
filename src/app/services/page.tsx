import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BadgeCheck } from "lucide-react";
import { PricingCalculator } from "@/components/PricingCalculator";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";
import { plans, zones } from "@/lib/pricing";
import { formatMoney } from "@/lib/public-ui";

export const metadata: Metadata = {
  title: "Commercial laundry services and pricing | Bubble Wash",
  description: "Compare Bubble Wash commercial laundry plans, service areas, optional care services, and monthly estimates for Accra businesses.",
  alternates: { canonical: "/services" },
};

export default function ServicesPage() {
  return (
    <PublicChrome>
      <PageIntro eyebrow="Services & pricing" title="A collection rhythm that fits the laundry volume." summary="Compare commercial plans, route coverage, and optional care before requesting the first collection." icon="services" />
      <section className="serviceSection pageShell" aria-labelledby="plans-heading"><div className="sectionIntro"><p className="sectionLabel">Commercial plans</p><h2 id="plans-heading">A collection plan for every workload.</h2></div><div className="planGrid">{plans.map((plan) => <article key={plan.name}><div className="planTitle"><h3>{plan.name}</h3><strong>{formatMoney(plan.subscription)}<small>service fee / month</small></strong></div><p>{plan.description}</p><dl className="miniFacts"><div><dt>Schedule</dt><dd>{plan.pickups}</dd></div><div><dt>Best fit</dt><dd>{plan.audience}</dd></div></dl><ul>{plan.features.map((feature) => <li key={feature}><BadgeCheck aria-hidden="true" />{feature}</li>)}</ul></article>)}</div></section>
      <section className="serviceSection pageShell" aria-labelledby="coverage-heading"><div className="sectionIntro"><p className="sectionLabel">Route coverage</p><h2 id="coverage-heading">Accra routes priced by collection loop.</h2></div><div className="zoneGrid">{Object.entries(zones).map(([key, zone]) => <article key={key}><h3>{zone.label}</h3><strong>{zone.fee ? `${formatMoney(zone.fee)} / pickup` : key === "custom" ? "Confirmed first" : "Included"}</strong><p>{zone.note}</p></article>)}</div></section>
      <section className="serviceSection pageShell" aria-labelledby="estimate-heading"><div className="sectionIntro"><p className="sectionLabel">Estimate</p><h2 id="estimate-heading">Build a monthly service estimate.</h2><p>The calculator combines the monthly service fee, expected intake weight, route, and selected extras. Final billing uses the verified intake weight.</p></div><PricingCalculator /></section>
      <section className="serviceSection pageShell serviceConditions" aria-labelledby="conditions-heading"><div className="sectionIntro"><p className="sectionLabel">Service conditions</p><h2 id="conditions-heading">What is confirmed before collection.</h2></div><div className="policyGrid"><article><h3>Final weight</h3><p>Online prices are estimates. The confirmed bill uses the intake weight recorded by the laundry partner.</p></article><article><h3>Collection window</h3><p>A requested time becomes final after operations confirms the route and available rider.</p></article><article><h3>Care and item issues</h3><p>Declare special-care items before collection and report missing or damaged items within 24 hours of delivery.</p></article><article><h3>Payment</h3><p>Bank transfer and approved invoicing are active during the pilot. Card and Mobile Money checkout remain unavailable.</p></article></div><Link className="inlineIconLink" href="/terms">Read the complete service terms <ArrowRight aria-hidden="true" /></Link></section>
    </PublicChrome>
  );
}
