import Link from "next/link";
import { ArrowRight, Bike, Headphones, ShieldCheck, WashingMachine } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";

export const dynamic = "force-dynamic";

const staffPaths = [
  {
    role: "Admin",
    title: "Operations queue",
    copy: "Order review, reassignment, timers, payments, and vendor or rider coordination.",
    href: "/login?next=/admin",
    icon: ShieldCheck,
  },
  {
    role: "Vendor",
    title: "Laundry partner queue",
    copy: "Accept jobs, manage capacity, log intake, update production status, and flag exceptions.",
    href: "/login?next=/vendors",
    icon: WashingMachine,
  },
  {
    role: "Driver",
    title: "Pickup and delivery board",
    copy: "See route handoffs, update pickup/delivery stages, ETA notes, and bag counts.",
    href: "/login?next=/drivers",
    icon: Bike,
  },
  {
    role: "Support",
    title: "Customer resolution desk",
    copy: "Track customer issues, escalation notes, payment questions, and order timeline context.",
    href: "/login?next=/support",
    icon: Headphones,
  },
];

export default function StaffAccessPage() {
  return (
    <main className="loginPage staffAccessPage">
      <section className="loginShell staffAccessShell">
        <BrandLink label="Bubble Wash Staff" priority />
        <div className="staffAccessHero">
          <p className="eyebrow">Staff access</p>
          <h1>Choose your workspace.</h1>
          <p>Role-specific staff paths for orders, washing, routes, and support follow-up.</p>
        </div>
        <div className="staffAccessGrid">
          {staffPaths.map((path) => {
            const Icon = path.icon;
            return (
            <Link className="staffAccessCard" href={path.href} key={path.role}>
              <span><Icon aria-hidden="true" />{path.role}</span>
              <h2>{path.title}</h2>
              <p>{path.copy}</p>
              <b>Continue to login <ArrowRight aria-hidden="true" /></b>
            </Link>
          )})}
        </div>
      </section>
    </main>
  );
}
