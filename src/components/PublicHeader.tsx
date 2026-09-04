"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";
type NavItem = { href: string; label: string; match?: string };

const navigation: NavItem[] = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/services", label: "Services & pricing", match: "/services" },
  { href: "/track", label: "Track order", match: "/track" },
  { href: "/manage", label: "Manage order", match: "/manage" },
  { href: "/early-access", label: "For home", match: "/early-access" },
];

export function PublicHeader({ available }: { available: boolean }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return (
    <header className="siteHeader" id="top">
      <BrandLink priority onClick={() => setMobileOpen(false)} />
      <button className="menuButton" type="button" aria-controls="site-navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen((current) => !current)}>
        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        <span>{mobileOpen ? "Close" : "Menu"}</span>
      </button>
      <nav id="site-navigation" className={mobileOpen ? "navLinks open" : "navLinks"} aria-label="Main navigation">
        {navigation.map(({ href, label, match }) => (
          <Link key={href} href={href} aria-current={match && pathname === match ? "page" : undefined} onClick={() => setMobileOpen(false)}>
            <span>{label}</span>
          </Link>
        ))}
        <Link className="navCta" href={available ? "/book" : "/services"} aria-current={pathname === (available ? "/book" : "/services") ? "page" : undefined} onClick={() => setMobileOpen(false)}>
          <ArrowRight aria-hidden="true" />
          <span>{available ? "Request pickup" : "View services"}</span>
        </Link>
      </nav>
    </header>
  );
}

