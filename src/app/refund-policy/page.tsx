import type { Metadata } from "next";
import { PolicyShell } from "@/components/PolicyShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Cancellations and Refunds | Bubble Wash",
  description: "Bubble Wash cancellation, route-charge, refund and service-issue rules.",
  alternates: { canonical: "/refund-policy" },
};

export default function RefundPolicyPage() {
  return <PolicyShell eyebrow="Cancellations and refunds" title="Charges follow the work that has actually started." summary="This policy separates unconfirmed requests, confirmed routes, processing work and verified service issues."><section><h2>Before route confirmation</h2><p>A customer may withdraw an unconfirmed request without a collection charge. Household early-access signups can be withdrawn at any time and never create a payment obligation.</p></section><section><h2>After route confirmation</h2><p>Request cancellation as early as possible. If the rider has not started the collection route, operations may cancel without a route charge. If dispatch has started or a failed collection is caused by unavailable access or customer absence, a reasonable route charge may apply.</p></section><section><h2>After collection or processing begins</h2><p>Work already performed, transport already completed and approved special-care materials may remain chargeable. Any unused portion should be separated during review rather than treating the full order as automatically payable.</p></section><section><h2>Quality, damage and missing-item reviews</h2><p>Report the issue within 24 hours of delivery using the order reference. Bubble Wash will compare the intake count, condition record, chain-of-custody events and delivery proof. A re-clean, service credit, partial refund or other remedy may be offered where the investigation confirms a service failure.</p></section><section><h2>Refund method and timing</h2><p>Approved refunds are returned through the original verified payment route where practical. Bank-transfer and invoice adjustments require reconciliation by operations. Processing time depends on the financial institution and the evidence required for the review.</p></section><section><h2>How to request review</h2><p>Use the customer self-service area for rescheduling or cancellation requests. Use the privacy request form only for personal-data rights; it does not replace an order support or refund review.</p></section></PolicyShell>;
}
