import { redirect } from "next/navigation";
import { getCurrentStaffUser } from "@/lib/auth";
import { StaffWorklistWorkspace } from "@/components/StaffWorklistWorkspace";

export default async function StaffWorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login");
  const params = await searchParams;
  const first = (key: string) => (Array.isArray(params[key]) ? params[key]?.[0] : params[key])?.trim().slice(0, 220) || "";
  const view = ["dispatch", "reconciliation", "notifications"].includes(first("view")) ? first("view") : "worklist";
  if (view !== "worklist" && user.role !== "admin") redirect("/staff/worklist");
  return <StaffWorklistWorkspace key={[view, first("filter"), first("offset"), first("order")].join(":")} user={user} view={view} filter={["all", "action", "mine", "unassigned", "overdue", "followups"].includes(first("filter")) ? first("filter") : "action"} offset={Math.max(0, Math.min(1_000_000, Math.floor(Number(first("offset"))) || 0))} orderId={first("order")} />;
}
