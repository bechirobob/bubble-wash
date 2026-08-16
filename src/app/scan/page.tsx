import Link from "next/link";
import { getCurrentStaffUser } from "@/lib/auth";
import { verifyBagLabelToken } from "@/lib/chain-of-custody";

export const dynamic = "force-dynamic";

export default async function ScanBagPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const label = verifyBagLabelToken(token);
  const user = await getCurrentStaffUser();
  if (!label) return <main className="policyPage"><section className="policyHero"><p className="eyebrow">Bag scan</p><h1>This label is invalid or expired.</h1><p>Do not process the bag until operations reconciles its printed reference.</p><Link className="button secondary" href="/staff">Open staff access</Link></section></main>;
  if (!user) return <main className="policyPage"><section className="policyHero"><p className="eyebrow">Verified bag label</p><h1>{label.bagTag}</h1><p>Sign in with the staff role handling this handoff, then scan the label again.</p><Link className="button primary" href="/login">Staff sign in</Link></section></main>;
  const base = user.role === "vendor" ? "/vendors?view=jobs" : user.role === "driver" ? "/drivers?view=route" : user.role === "support" ? "/support?view=cases" : "/admin?view=orders";
  return <main className="policyPage"><section className="policyHero"><p className="eyebrow">Verified bag label</p><h1>{label.bagTag}</h1><p>Order {label.orderId} · signed Bubble Wash label. Open the order and record the available handoff action, count, recipient, and any exception.</p><Link className="button primary" href={`${base}&order=${encodeURIComponent(label.orderId)}`}>Open order workflow</Link></section></main>;
}
