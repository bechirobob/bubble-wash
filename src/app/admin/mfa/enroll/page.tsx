import type { Metadata } from "next";
import { AdminMfaEnrollment } from "@/components/AdminMfaEnrollment";
import { redirect } from "next/navigation";
import { staffAccessDisabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin authenticator setup | Bubble Wash",
  robots: { index: false, follow: false },
};

export default function AdminMfaEnrollmentPage() {
  if (staffAccessDisabled()) redirect("/login");
  return <AdminMfaEnrollment />;
}
