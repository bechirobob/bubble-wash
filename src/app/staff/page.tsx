import Image from "next/image";
import Link from "next/link";

const staffPaths = [
  {
    role: "Admin",
    title: "Operations control",
    copy: "Order oversight, reassignment, SLA timers, payments, and vendor/driver coordination.",
    href: "/login?next=/admin",
  },
  {
    role: "Vendor",
    title: "Laundry partner queue",
    copy: "Accept jobs, manage capacity, log intake, update production status, and flag exceptions.",
    href: "/login?next=/vendors",
  },
  {
    role: "Driver",
    title: "Pickup and delivery board",
    copy: "See route handoffs, update pickup/delivery stages, ETA notes, and bag counts.",
    href: "/login?next=/drivers",
  },
  {
    role: "Support",
    title: "Customer resolution desk",
    copy: "Track customer issues, escalation notes, payment questions, and order timeline context.",
    href: "/login?next=/support",
  },
];

export default function StaffAccessPage() {
  return (
    <main className="loginPage staffAccessPage">
      <section className="loginShell staffAccessShell">
        <Link className="brand" href="/" aria-label="Bubble Wash home">
          <Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} priority />
          <span>Bubble Wash Staff</span>
        </Link>
        <div className="staffAccessHero">
          <p className="eyebrow">Staff access</p>
          <h1>Choose your workspace, then sign in.</h1>
          <p>One staff entry point keeps the public menu clean while routing every role to the correct protected login process.</p>
        </div>
        <div className="staffAccessGrid">
          {staffPaths.map((path) => (
            <Link className="staffAccessCard" href={path.href} key={path.role}>
              <span>{path.role}</span>
              <h2>{path.title}</h2>
              <p>{path.copy}</p>
              <b>Continue to login →</b>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
