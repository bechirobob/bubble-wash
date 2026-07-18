import { redirect } from "next/navigation";
import { VendorWorkspace } from "@/components/StaffWorkspaces";
import { getCurrentStaffUser } from "@/lib/auth";

export default async function VendorsPage() {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/vendors");
  if (user.role !== "vendor") redirect(user.role === "admin" ? "/admin" : "/login?next=/vendors");
  return <VendorWorkspace userName={user.name} role={user.role} />;
}
