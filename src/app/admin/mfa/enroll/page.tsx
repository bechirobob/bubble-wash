import type { Metadata } from "next";
import { AdminMfaEnrollment } from "@/components/AdminMfaEnrollment";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin authenticator setup | Bubble Wash",
  robots: { index: false, follow: false },
};

export default function AdminMfaEnrollmentPage() {
  return <AdminMfaEnrollment />;
}
