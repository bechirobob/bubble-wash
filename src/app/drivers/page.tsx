import { redirect } from "next/navigation";
import { DriverWorkspace } from "@/components/StaffWorkspaces";
import { getCurrentStaffUser } from "@/lib/auth";

export default async function DriversPage() {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/drivers");
  if (user.role !== "driver") redirect(user.role === "admin" ? "/admin" : "/login?next=/drivers");
  return <DriverWorkspace userName={user.name} role={user.role} />;
}
