import { redirect } from "next/navigation";
import { VendorWorkspace } from "@/components/StaffWorkspaces";
import { canAccess, getCurrentStaffUser } from "@/lib/auth";

export default async function VendorsPage() {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/vendors");
  if (!canAccess(user.role, "vendor")) redirect("/login?next=/vendors");
  return <VendorWorkspace userName={user.name} role={user.role} />;
}
