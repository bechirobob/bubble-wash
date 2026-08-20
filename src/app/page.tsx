import Link from "next/link";
import { ArrowRight, CalendarCheck, PackageCheck, SearchCheck, Shirt, Sparkles, Truck } from "lucide-react";
import { PublicChrome } from "@/components/PublicChrome";

const serviceFacts = [
  ["24h", "standard turnaround target"],
  ["4", "commercial service plans"],
  ["GHS", "estimates before booking"],
  ["1", "reference from pickup to return"],
];

const serviceSteps = [
  { title: "Book the collection", copy: "Get a plan recommendation, enter the exact collection point, and select a two-hour pickup window.", icon: CalendarCheck },
  { title: "We collect and clean", copy: "The order stays on one service record while an approved partner processes it and each handoff is recorded.", icon: Shirt },
  { title: "Track the return", copy: "Use the same reference for confirmed updates until the clean order reaches the authorised recipient.", icon: PackageCheck },
];

export default function Home() {
  return (
    <PublicChrome skipTo="main-content">
      <section className="landingHero pageShell" id="main-content" aria-labelledby="home-title">
        <div className="landingHeroCopy">
          <p className="sectionLabel">Commercial laundry · Accra</p>
          <h1 id="home-title">Laundry operations your business does not have to chase.</h1>
          <p className="lead">Bubble Wash coordinates collection, professional cleaning, and return delivery on one traceable service record.</p>
          <div className="heroActions"><Link className="button primary" href="/book">Book a pickup <ArrowRight aria-hidden="true" /></Link><Link className="button secondary" href="/services">Explore services <Sparkles aria-hidden="true" /></Link></div>
        </div>
        <aside className="landingPromise" aria-label="Bubble Wash service promise">
          <SearchCheck aria-hidden="true" />
          <p className="sectionLabel">One clear trail</p>
          <h2>From the first request to the final handoff.</h2>
          <p>Customers, riders, laundry partners, and support work from the same order reference.</p>
          <Link href="/track">Track an existing order <ArrowRight aria-hidden="true" /></Link>
        </aside>
      </section>

      <section className="serviceFacts pageShell" aria-label="Service facts">{serviceFacts.map(([number, label]) => <div key={label}><strong>{number}</strong><span>{label}</span></div>)}</section>

      <section id="how-it-works" className="serviceSection pageShell landingHow" aria-labelledby="how-heading">
        <div className="sectionIntro"><p className="sectionLabel">How it works</p><h2 id="how-heading">Collection, cleaning, and return—without fragmented updates.</h2><p>The product is the operating trail: one booking becomes one record that moves through every stage.</p></div>
        <ol className="workflowCards">{serviceSteps.map(({ title, copy, icon: Icon }, index) => <li key={title}><span className="workflowIcon"><Icon aria-hidden="true" /></span><small>Step {index + 1}</small><h3>{title}</h3><p>{copy}</p></li>)}</ol>
      </section>

      <section className="serviceSection pageShell audienceSection" aria-labelledby="choose-service-heading">
        <div className="sectionIntro"><p className="sectionLabel">Choose your service</p><h2 id="choose-service-heading">Built for commercial routines, with household service opening next.</h2></div>
        <div className="audienceGrid">
          <article><Truck aria-hidden="true" /><h3>Commercial laundry</h3><p>Scheduled collections for offices, hospitality, clinics, restaurants, serviced units, and larger facilities.</p><Link href="/services">View commercial services <ArrowRight aria-hidden="true" /></Link></article>
          <article><Shirt aria-hidden="true" /><h3>Household laundry</h3><p>Doorstep collection for homes is in early access while Bubble Wash plans the first residential routes.</p><Link href="/early-access">Join household early access <ArrowRight aria-hidden="true" /></Link></article>
        </div>
      </section>

      <section className="landingCta pageShell" aria-labelledby="landing-cta-title"><div><p className="sectionLabel">Ready when you are</p><h2 id="landing-cta-title">Set up the first collection.</h2><p>The booking takes the service details once. Operations confirms the route before a rider is sent.</p></div><Link className="button primary" href="/book">Book a pickup <ArrowRight aria-hidden="true" /></Link></section>
    </PublicChrome>
  );
}
