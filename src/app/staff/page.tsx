import Link from "next/link";
import { ArrowRight, Bike, Headphones, ShieldCheck, WashingMachine } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";

export const dynamic = "force-dynamic";

const staffPaths = [
  {
    role: "Admin",
    href: "/login?next=/admin",
    icon: ShieldCheck,
  },
  {
    role: "Vendor",
    href: "/login?next=/vendors",
    icon: WashingMachine,
  },
  {
    role: "Driver",
    href: "/login?next=/drivers",
    icon: Bike,
  },
  {
    role: "Support",
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
          <h1>Staff access</h1>
        </div>
        <div className="staffAccessGrid">
          {staffPaths.map((path) => {
            const Icon = path.icon;
            return (
            <Link className="staffAccessCard" href={path.href} key={path.role}>
              <h2><Icon aria-hidden="true" />{path.role}</h2>
              <span>Sign in <ArrowRight aria-hidden="true" /></span>
            </Link>
          )})}
        </div>
      </section>
    </main>
  );
}
