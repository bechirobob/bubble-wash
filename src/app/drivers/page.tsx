import { redirect } from "next/navigation";
import { DriverWorkspace } from "@/components/StaffWorkspaces";
import { canAccess, getCurrentStaffUser } from "@/lib/auth";

export default async function DriversPage() {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/drivers");
  if (!canAccess(user.role, "driver")) redirect("/login?next=/drivers");
  return <DriverWorkspace userName={user.name} role="driver" />;
}
