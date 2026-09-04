import type { Metadata } from "next";
import { CustomerOrderManager } from "@/components/CustomerOrderManager";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";

export const metadata: Metadata = {
  title: "Manage your order | Bubble Wash",
  description: "Securely view a Bubble Wash booking and request a reschedule, cancellation or garment-care update.",
  robots: { index: false, follow: false },
};

export default function ManageOrderPage() {
  return <PublicChrome><PageIntro eyebrow="Customer order desk" title="View your booking and request changes." summary="Check your collection, view your invoice, or ask for a change using your booking reference and contact details." icon="manage" /><section className="policyContent manageOrderContent pageShell"><CustomerOrderManager /></section></PublicChrome>;
}
