import type { Metadata } from "next";
import { CustomerOrderManager } from "@/components/CustomerOrderManager";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";

export const metadata: Metadata = {
  title: "Manage your order | Bubble Wash",
  description: "Securely view a Bubble Wash booking and request a reschedule, cancellation or garment-care update.",
  robots: { index: false, follow: false },
};

export default function ManageOrderPage() {
  return <PublicChrome><PageIntro eyebrow="Your laundry" title="Your order, all in one place." summary="Check your pickup, view your bill, or request a change. Use your booking reference and the contact details you booked with." icon="manage" /><section className="policyContent manageOrderContent pageShell"><CustomerOrderManager /></section></PublicChrome>;
}
