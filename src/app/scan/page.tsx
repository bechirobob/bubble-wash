import { bookingLabel } from "@/lib/booking-label";
import { buildOrderSummaries, orderBoardRecords, orderMatchesStaffEntity, readSubmissionsForOrder } from "@/lib/submissions";
import Link from "next/link";
import { getCurrentStaffUser } from "@/lib/auth";
import { verifyBagLabelToken } from "@/lib/chain-of-custody";

export const dynamic = "force-dynamic";

export default async function ScanBagPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const label = verifyBagLabelToken(token);
  const user = await getCurrentStaffUser();
  if (!label) return <main className="policyPage"><section className="policyHero"><p className="eyebrow">Bag scan</p><h1>This label is invalid or expired.</h1><p>Do not process the bag until operations reconciles its printed reference.</p><Link className="button secondary" href="/staff">Open staff access</Link></section></main>;
  if (!user) return <main className="policyPage"><section className="policyHero"><p className="eyebrow">Verified bag label</p><h1>Staff access required</h1><p>Sign in with the staff role handling this handoff, then scan the label again.</p><Link className="button primary" href="/login">Staff sign in</Link></section></main>;
  const records = await readSubmissionsForOrder(label.orderId);
  const order = buildOrderSummaries(orderBoardRecords(records, user.role, user.entityId)).find((item) => item.orderId === label.orderId && orderMatchesStaffEntity(item, user.role, user.entityId));
  if (!order) return <main className="policyPage"><h1>This order is not available to your role.</h1></main>;
  const base = user.role === "vendor" ? "/vendors?view=jobs" : user.role === "driver" ? "/drivers?view=route" : user.role === "support" ? "/support?view=orders" : "/admin?view=orders";
  return <main className="policyPage"><section className="policyHero"><p className="eyebrow">Verified bag label</p><h1>{bookingLabel(order)}</h1><p>Bag handoff · signed Bubble Wash label. Open the order and record the available handoff action, count, recipient, and any exception.</p><Link className="button primary" href={`${base}&order=${encodeURIComponent(label.orderId)}`}>Open order workflow</Link></section></main>;
}
