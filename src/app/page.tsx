import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PublicChrome } from "@/components/PublicChrome";
import { PickupCoverage } from "@/components/PickupCoverage";
import { LaundrySteps } from "@/components/LaundrySteps";
import { bookingAvailable } from "@/lib/booking-policy";

export const dynamic = "force-dynamic";

export default function Home() {
  const available = bookingAvailable();
  return (
    <PublicChrome>
      <section className="laundryIntro pageShell" id="main-content" aria-labelledby="home-title">
        <div className="laundryIntroCopy">
          <p className="sectionLabel">Commercial laundry · Accra</p>
          <h1 id="home-title">Laundry pickup<br /><span>for your business.</span></h1>
          <p className="lead">We collect, clean and return your laundry. Choose a pickup plan that works for your week.</p>
          <div className="heroActions"><Link className="button primary" href={available ? "/book" : "/services"}>{available ? "Request a pickup" : "View plans & pricing"}<ArrowRight aria-hidden="true" /></Link><Link className="textAction" href="/track">Track an order <ArrowRight aria-hidden="true" /></Link></div>
          {!available && <p className="availabilityNote">New pickups are paused. You can still <Link href="/manage">manage an existing order</Link>.</p>}
        </div>
        <figure className="laundryPhoto"><Image src="/laundry-care-hero-blended.webp" alt="Folded towels and a shirt beside a bag with the original Bubble Wash icon" width={1200} height={960} sizes="(max-width: 600px) 340px, (max-width: 980px) 42vw, 540px" priority /></figure>
      </section>
      <section className="publicBand publicBandBlue" aria-labelledby="pickup-heading"><div className="pickupSection pageShell"><div><p className="sectionLabel">Pickup coverage</p><h2 id="pickup-heading">Around Accra.<br /> Back to your door.</h2><p>Check your area and any pickup charge before choosing a plan.</p></div><PickupCoverage available={available} /></div></section>
      <section className="laundryProcess pageShell" id="how-it-works" aria-labelledby="process-heading"><div className="processHeading"><p className="sectionLabel">How it works</p><h2 id="process-heading">From pickup to return.</h2></div><LaundrySteps /></section>
      <section className="publicBand publicBandSage" aria-labelledby="service-heading"><div className="laundryServices pageShell"><div><p className="sectionLabel">Choose your service</p><h2 id="service-heading">For work. Soon, for home.</h2></div><div className="serviceRows"><article><div><h3>Business laundry</h3><p>Regular pickups for restaurants, offices, guest stays and facilities.</p></div><Link className="textAction" href="/services">Compare plans <ArrowRight aria-hidden="true" /></Link></article><article><div><h3>Household laundry</h3><p>Home pickups are coming to Accra. Join the early-access list.</p></div><Link className="textAction" href="/early-access">Join early access <ArrowRight aria-hidden="true" /></Link></article></div></div></section>
    </PublicChrome>
  );
}
