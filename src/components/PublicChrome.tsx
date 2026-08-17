"use client";

/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- Public shells use full document navigation and the local Apple icon so Cloudflare can serve them without invoking the Worker. */

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
      <a className="brand" href="/" aria-label="Bubble Wash home" onClick={() => setMobileOpen(false)}>
        <span className="brandCrop"><img className="brandMark" src="/apple-icon.png" alt="" width={58} height={58} /></span>
        <span>Bubble Wash</span>
      </a>
      <button className="menuButton" type="button" aria-controls="site-navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen((current) => !current)}>
        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        <span>{mobileOpen ? "Close" : "Menu"}</span>
      </button>
      <nav id="site-navigation" className={mobileOpen ? "navLinks open" : "navLinks"} aria-label="Main navigation">
        {navigation.map(({ href, label, icon: Icon, match }) => (
          <a key={href} href={href} aria-current={match && pathname === match ? "page" : undefined} onClick={() => setMobileOpen(false)}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </a>
        ))}
        <a className="navCta" href="/book" aria-current={pathname === "/book" ? "page" : undefined} onClick={() => setMobileOpen(false)}>
          <CalendarPlus aria-hidden="true" />
          <span>Book pickup</span>
        </a>
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
        <a className="brand footerBrand" href="/" aria-label="Bubble Wash home"><span className="brandCrop"><img className="brandMark" src="/apple-icon.png" alt="" width={58} height={58} /></span><span>Bubble Wash</span></a>
        <p>Commercial laundry collection and delivery for businesses in Accra.</p>
      </div>
      <div>
        <h3>Service</h3>
        <a href="/#how-it-works">How it works</a>
        <a href="/services">Services & pricing</a>
        <a href="/book">Book a pickup</a>
        <a href="/track">Track an order</a>
      </div>
      <div>
        <h3>Order and policies</h3>
        <a href="/manage">Manage an order</a>
        <a href="/early-access">Household early access</a>
        <a href="/privacy">Privacy and data rights</a>
        <a href="/terms">Service terms</a>
        <a href="/refund-policy">Cancellations and refunds</a>
        <a href="/staff">Staff access</a>
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
