import { redirect } from "next/navigation";
import { SupportWorkspace } from "@/components/StaffWorkspaces";
import { getCurrentStaffUser } from "@/lib/auth";

export default async function SupportPage() {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/support");
  if (user.role !== "support") redirect(user.role === "admin" ? "/admin" : "/login?next=/support");
  return <SupportWorkspace userName={user.name} role={user.role} />;
}
