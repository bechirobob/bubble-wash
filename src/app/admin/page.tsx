import { redirect } from "next/navigation";
import { AdminWorkspace } from "@/components/StaffWorkspaces";
import { canAccess, getCurrentStaffUser } from "@/lib/auth";

export default async function AdminPage() {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/admin");
  if (!canAccess(user.role, "admin")) redirect("/login?next=/admin");
  return <AdminWorkspace userName={user.name} role={user.role} />;
}
