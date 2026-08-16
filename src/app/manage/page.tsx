import type { Metadata } from "next";
import { CustomerOrderManager } from "@/components/CustomerOrderManager";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";

export const metadata: Metadata = {
  title: "Manage your order | Bubble Wash",
  description: "Securely view a Bubble Wash booking and request a reschedule, cancellation or garment-care update.",
  robots: { index: false, follow: false },
};

export default function ManageOrderPage() {
  return <PublicChrome><PageIntro eyebrow="Customer order desk" title="View your booking and request changes." summary="Verify the order reference with the booking email or phone to open a private 30-minute session on this device." icon="manage" /><section className="policyContent manageOrderContent pageShell"><CustomerOrderManager /></section></PublicChrome>;
}
