import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CalendarCheck, House, PackageCheck, Search, Shirt, Sparkles, Truck } from "lucide-react";
import { PublicChrome } from "@/components/PublicChrome";
import { bookingAvailable } from "@/lib/booking-policy";

export const dynamic = "force-dynamic";

const serviceSteps = [
  { title: "Pick your pickup", copy: "Choose your plan and preferred time. We’ll confirm the details before we arrive.", icon: CalendarCheck },
  { title: "Leave the laundry to us", copy: "We collect, check and weigh your laundry, then clean and finish it with care.", icon: Shirt },
  { title: "Welcome back, fresh", copy: "Follow your order online. Share your delivery code when your clean laundry arrives.", icon: PackageCheck },
];

export default function Home() {
  const available = bookingAvailable();
  const action = { href: available ? "/book" : "/services", label: available ? "Request a pickup" : "Explore laundry plans" };
  return (
    <PublicChrome>
      <section className="freshHero pageShell" id="main-content" aria-labelledby="home-title">
        <div className="freshHeroCopy">
          <p className="sectionLabel"><span className="freshDot" /> Commercial laundry · Accra</p>
          <h1 id="home-title">Fresh laundry.<br /><span>One less thing</span><br />to manage.</h1>
          <p className="lead">Laundry pickup, cleaning and delivery for your business. We take care of the wash, so you can get on with your day.</p>
          <div className="heroActions"><Link className="button primary" href={action.href}>{action.label} <ArrowRight aria-hidden="true" /></Link><Link className="heroTrack" href="/track"><Search aria-hidden="true" /> Track an order</Link></div>
          <p className="heroAvailability">{available ? "Choose a pickup time. We’ll confirm it with you." : "New pickups are paused. Existing orders can still be tracked and managed."}</p>
        </div>
        <figure className="laundryHeroVisual">
          <Image src="/laundry-care-hero.webp" alt="Freshly folded white towels, a blue shirt and a Bubble Wash laundry bag" width={1200} height={1200} sizes="(max-width: 780px) calc(100vw - 40px), (max-width: 1100px) 45vw, 560px" priority />
          <figcaption className="careLabel"><Sparkles aria-hidden="true" /><span>Freshly cleaned.<strong>Ready for your day.</strong></span></figcaption>
          <span className="washOrbit" aria-hidden="true" />
        </figure>
      </section>

      <section className="careStrip pageShell" aria-label="Our laundry service"><div><Truck aria-hidden="true" /><span>Picked up from your business</span></div><div><Shirt aria-hidden="true" /><span>Cleaned and finished with care</span></div><div><PackageCheck aria-hidden="true" /><span>Delivered back to your door</span></div></section>

      <section id="how-it-works" className="freshHow pageShell" aria-labelledby="how-heading">
        <div className="sectionIntro"><p className="sectionLabel">A lighter laundry day</p><h2 id="how-heading">You fill the bag.<br />We’ll take it from there.</h2><p>Three simple steps, from your next pickup to fresh laundry back at your door.</p></div>
        <ol className="freshSteps">{serviceSteps.map(({ title, copy, icon: Icon }, index) => <li key={title}><div className="stepTop"><span className="careIcon"><Icon aria-hidden="true" /></span><span className="stepNumber">0{index + 1}</span></div><h3>{title}</h3><p>{copy}</p></li>)}</ol>
      </section>

      <section className="businessCare pageShell" aria-labelledby="business-heading">
        <div className="businessCareCopy"><p className="sectionLabel">Made for your working week</p><h2 id="business-heading">Fresh linen.<br />A good impression.</h2><p>From guest towels to team uniforms, make laundry one less job on the list. Choose a pickup plan that fits your business.</p><Link className="inlineIconLink" href="/services">Find your laundry plan <ArrowRight aria-hidden="true" /></Link></div>
        <div className="linenLabels" aria-label="Businesses we serve"><span><House aria-hidden="true" /> Guest stays & hospitality</span><span><Shirt aria-hidden="true" /> Offices & team uniforms</span><span><Sparkles aria-hidden="true" /> Restaurants & facilities</span><p>Pickup plans, clear estimates, and one reference to follow your laundry.</p></div>
      </section>

      <section className="homeLaundryNote pageShell" aria-labelledby="household-heading"><span className="careIcon"><House aria-hidden="true" /></span><div><p className="sectionLabel">Something fresh for home</p><h2 id="household-heading">Your laundry day is next.</h2><p>Household pickups are coming to Accra. Join early access to help shape our first routes.</p></div><Link className="button secondary" href="/early-access">Join household early access <ArrowRight aria-hidden="true" /></Link></section>

      <section className="freshCta pageShell" aria-labelledby="cta-heading"><div><p className="sectionLabel">A fresh start</p><h2 id="cta-heading">Let’s take laundry<br />off your list.</h2><p>{available ? "Find your plan and request your first pickup." : "Explore our services while new pickups are paused."}</p></div><Link className="button primary" href={action.href}>{action.label} <ArrowRight aria-hidden="true" /></Link></section>
    </PublicChrome>
  );
}
