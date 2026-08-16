import type { Metadata } from "next";
import { House } from "lucide-react";
import { EarlyAccessForm } from "@/components/EarlyAccessForm";
import { PublicChrome } from "@/components/PublicChrome";

export const metadata: Metadata = {
  title: "Household Laundry Early Access in Accra | Bubble Wash",
  description: "Join Bubble Wash household laundry collection and delivery early access in Accra.",
  alternates: { canonical: "/early-access" },
  openGraph: {
    title: "Bubble Wash household early access",
    description: "Help Bubble Wash open the right residential laundry collection routes in Accra.",
    url: "/early-access",
    type: "website",
  },
};

export default function EarlyAccessPage() {
  return (
    <PublicChrome skipTo="early-access" skipLabel="Skip to early access">
      <section className="homeHero pageShell earlyAccessHero" aria-labelledby="early-title">
        <div className="homeHeroCopy"><House className="pageIntroIcon" aria-hidden="true" /><p className="sectionLabel">Household laundry · Accra</p><h1 id="early-title">Your laundry day, picked up and returned.</h1><p className="lead">Bubble Wash is preparing dependable doorstep laundry for homes. Join early access and help determine the first residential routes.</p><dl className="recordList earlyAccessPromises"><div><dt>Pickup</dt><dd>From your home</dd></div><div><dt>Care</dt><dd>Professional cleaning</dd></div><div><dt>Updates</dt><dd>One order reference</dd></div></dl></div>
        <EarlyAccessForm />
      </section>
      <section className="serviceSection pageShell" aria-labelledby="early-faq-heading"><div className="sectionIntro"><p className="sectionLabel">Early-access questions</p><h2 id="early-faq-heading">What joining the list means.</h2></div><div className="faqList"><details><summary>Is household service live yet?</summary><p>Not yet. Demand will determine the first residential routes and collection days.</p></details><details><summary>Does joining create a booking?</summary><p>No. Joining is free and does not commit you to an order.</p></details><details><summary>What happens to my details?</summary><p>They are used only for residential launch planning and the updates you consent to receive. Review or change your choice through the privacy page.</p></details></div></section>
    </PublicChrome>
  );
}
