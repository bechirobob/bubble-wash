import { redirect } from "next/navigation";
import { SupportWorkspace } from "@/components/StaffWorkspaces";
import { canAccess, getCurrentStaffUser } from "@/lib/auth";

export default async function SupportPage() {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/support");
  if (!canAccess(user.role, "support")) redirect("/login?next=/support");
  return <SupportWorkspace userName={user.name} role="support" />;
}
