import type { Metadata } from "next";
import { AdminRecoveryPageClient } from "@/components/AdminRecoveryPage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Recover master administrator | Bubble Wash",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
};

export default function AdminRecoveryPage() {
  return <AdminRecoveryPageClient />;
}
