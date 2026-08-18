"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType } from "react";
import {
  BookOpenCheck,
  CalendarPlus,
  ClipboardCheck,
  FileText,
  House,
  Menu,
  Search,
  Shirt,
  UserRoundCog,
  X,
  type LucideProps,
} from "lucide-react";

type PublicChromeProps = {
  children: React.ReactNode;
  skipTo?: string;
  skipLabel?: string;
};

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<LucideProps>;
  match?: string;
};

const navigation: NavItem[] = [
  { href: "/#how-it-works", label: "How it works", icon: BookOpenCheck },
  { href: "/services", label: "Services & pricing", icon: Shirt, match: "/services" },
  { href: "/track", label: "Track", icon: Search, match: "/track" },
  { href: "/manage", label: "Manage order", icon: UserRoundCog, match: "/manage" },
  { href: "/early-access", label: "Household", icon: House, match: "/early-access" },
];

export function PublicHeader() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="siteHeader" id="top">
      <Link className="brand" href="/" aria-label="Bubble Wash home" onClick={() => setMobileOpen(false)}>
        <span className="brandCrop"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="" width={58} height={58} priority /></span>
        <span>Bubble Wash</span>
      </Link>
      <button className="menuButton" type="button" aria-controls="site-navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen((current) => !current)}>
        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        <span>{mobileOpen ? "Close" : "Menu"}</span>
      </button>
      <nav id="site-navigation" className={mobileOpen ? "navLinks open" : "navLinks"} aria-label="Main navigation">
        {navigation.map(({ href, label, icon: Icon, match }) => (
          <Link key={href} href={href} aria-current={match && pathname === match ? "page" : undefined} onClick={() => setMobileOpen(false)}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </Link>
        ))}
        <Link className="navCta" href="/book" aria-current={pathname === "/book" ? "page" : undefined} onClick={() => setMobileOpen(false)}>
          <CalendarPlus aria-hidden="true" />
          <span>Book pickup</span>
        </Link>
      </nav>
    </header>
  );
}

export function PublicFooter() {
  const whatsappNumber = process.env.NEXT_PUBLIC_BUBBLEWASH_WHATSAPP?.replace(/\D/g, "") ?? "";
  const contactEmail = process.env.NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL?.trim() ?? "";
  const whatsappUrl = whatsappNumber ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent("Hi Bubble Wash, I want to discuss a commercial laundry pickup.")}` : "";

  return (
    <footer className="footer pageShell">
      <div>
        <Link className="brand footerBrand" href="/" aria-label="Bubble Wash home"><span className="brandCrop"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="" width={58} height={58} /></span><span>Bubble Wash</span></Link>
        <p>Commercial laundry collection and delivery for businesses in Accra.</p>
      </div>
      <div>
        <h3>Service</h3>
        <Link href="/#how-it-works">How it works</Link>
        <Link href="/services">Services & pricing</Link>
        <Link href="/book">Book a pickup</Link>
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
        <p>Routes outside the core area are confirmed before dispatch.</p>
        {whatsappUrl ? <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">WhatsApp</a> : null}
        {contactEmail ? <a href={`mailto:${contactEmail}`}>{contactEmail}</a> : null}
      </div>
    </footer>
  );
}

export function PublicChrome({ children, skipTo = "main-content", skipLabel = "Skip to content" }: PublicChromeProps) {
  return (
    <main className="siteShell">
      <a className="skipLink" href={`#${skipTo}`}>{skipLabel}</a>
      <PublicHeader />
      {children}
      <PublicFooter />
    </main>
  );
}

const pageIcons = { default: ClipboardCheck, booking: CalendarPlus, services: Shirt, tracking: Search, manage: UserRoundCog, policy: FileText } as const;

export function PageIntro({ eyebrow, title, summary, icon = "default" }: { eyebrow: string; title: string; summary: string; icon?: keyof typeof pageIcons }) {
  const Icon = pageIcons[icon];
  return (
    <section className="pageIntro pageShell" id="main-content" aria-labelledby="page-title">
      <Icon className="pageIntroIcon" aria-hidden="true" />
      <div><p className="sectionLabel">{eyebrow}</p><h1 id="page-title">{title}</h1><p className="lead">{summary}</p></div>
    </section>
  );
}
