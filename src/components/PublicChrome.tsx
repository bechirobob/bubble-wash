import Link from "next/link";
import { connection } from "next/server";
import { CalendarPlus, ClipboardCheck, FileText, Search, Shirt, UserRoundCog } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";
import { RouteWarmup } from "@/components/RouteWarmup";
import { PublicHeader } from "@/components/PublicHeader";
import { bookingAvailable } from "@/lib/booking-policy";
type PublicChromeProps = { children: React.ReactNode; skipTo?: string; skipLabel?: string };

export function PublicFooter({ available }: { available: boolean }) {
  const whatsappNumber = process.env.NEXT_PUBLIC_BUBBLEWASH_WHATSAPP?.replace(/\D/g, "") ?? "";
  const contactEmail = process.env.NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL?.trim() ?? "";
  const whatsappUrl = whatsappNumber ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent("Hi Bubble Wash, I want to discuss a commercial laundry pickup.")}` : "";

  return (
    <footer className="footer pageShell">
      <div>
        <BrandLink className="footerBrand" />
        <p>Commercial laundry collection and delivery for businesses in Accra.</p>
      </div>
      <div>
        <h3>Service</h3>
        <Link href="/#how-it-works">How it works</Link>
        <Link href="/services">Services & pricing</Link>
        <Link href={available ? "/book" : "/services"}>{available ? "Request a pickup" : "Explore laundry plans"}</Link>
        <Link href="/track">Track an order</Link>
      </div>
      <div>
        <h3>Order and policies</h3>
        <Link href="/manage">Manage an order</Link>
        <Link href="/early-access">Household early access</Link>
        <Link href="/privacy">Privacy and data rights</Link>
        <Link href="/terms">Service terms</Link>
        <Link href="/refund-policy">Cancellations and refunds</Link>
        <Link href="/staff">Staff access</Link>
      </div>
      <div>
        <h3>Service area</h3>
        <p>Accra, Ghana</p>
        <p>Outside central Accra? We confirm coverage and any extra pickup charge before your laundry is collected.</p>
        {whatsappUrl ? <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">WhatsApp</a> : null}
        {contactEmail ? <a href={`mailto:${contactEmail}`}>{contactEmail}</a> : null}
      </div>
    </footer>
  );
}

export async function PublicChrome({ children, skipTo = "main-content", skipLabel = "Skip to content" }: PublicChromeProps) {
  await connection();
  const available = bookingAvailable();
  return (
    <main className="siteShell publicSite">
      <RouteWarmup />
      <a className="skipLink" href={`#${skipTo}`}>{skipLabel}</a>
      <PublicHeader available={available} />
      {children}
      <PublicFooter available={available} />
    </main>
  );
}

const pageIcons = { default: ClipboardCheck, booking: CalendarPlus, services: Shirt, tracking: Search, manage: UserRoundCog, policy: FileText } as const;

export function PageIntro({ eyebrow, title, summary, icon = "default" }: { eyebrow: string; title: string; summary: string; icon?: keyof typeof pageIcons }) {
  const Icon = pageIcons[icon];
  return (
    <div className="publicBand publicBandAqua"><section className="pageIntro pageShell" id="main-content" aria-labelledby="page-title">
      <Icon className="pageIntroIcon" aria-hidden="true" />
      <div><p className="sectionLabel">{eyebrow}</p><h1 id="page-title">{title}</h1><p className="lead">{summary}</p></div>
    </section></div>
  );
}
