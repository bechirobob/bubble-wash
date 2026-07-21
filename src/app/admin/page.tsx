import { redirect } from "next/navigation";
import { AdminWorkspace } from "@/components/StaffWorkspaces";
import { canAccess, getCurrentStaffUser } from "@/lib/auth";

type AdminView = "overview" | "dispatch" | "orders" | "people" | "cases" | "activity";

type AdminPageProps = {
  searchParams: Promise<{
    view?: string | string[];
    order?: string | string[];
    case?: string | string[];
    activity?: string | string[];
  }>;
};

const adminViews = new Set<AdminView>(["overview", "dispatch", "orders", "people", "cases", "activity"]);

function firstSearchParam(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" ? candidate.trim().slice(0, 160) : "";
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/admin");
  if (!canAccess(user.role, "admin")) redirect("/login?next=/admin");

  const params = await searchParams;
  const requestedView = firstSearchParam(params.view) as AdminView;

  return (
    <AdminWorkspace
      userName={user.name}
      role={user.role}
      initialView={adminViews.has(requestedView) ? requestedView : "overview"}
      selectedOrderId={firstSearchParam(params.order)}
      selectedCaseId={firstSearchParam(params.case)}
      selectedActivityId={firstSearchParam(params.activity)}
    />
  );
}
