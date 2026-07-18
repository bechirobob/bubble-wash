import { redirect } from "next/navigation";
import { SupportWorkspace } from "@/components/StaffWorkspaces";
import { getCurrentStaffUser } from "@/lib/auth";

type SupportView = "cases" | "orders" | "activity";

type SupportPageProps = {
  searchParams: Promise<{
    view?: string | string[];
    order?: string | string[];
    case?: string | string[];
    activity?: string | string[];
  }>;
};

const supportViews = new Set<SupportView>(["cases", "orders", "activity"]);

function firstSearchParam(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" ? candidate.trim().slice(0, 160) : "";
}

export default async function SupportPage({ searchParams }: SupportPageProps) {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/support");
  if (user.role !== "support") redirect(user.role === "admin" ? "/admin" : "/login?next=/support");

  const params = await searchParams;
  const requestedView = firstSearchParam(params.view) as SupportView;

  return (
    <SupportWorkspace
      userName={user.name}
      role={user.role}
      initialView={supportViews.has(requestedView) ? requestedView : "cases"}
      selectedOrderId={firstSearchParam(params.order)}
      selectedCaseId={firstSearchParam(params.case)}
      selectedActivityId={firstSearchParam(params.activity)}
    />
  );
}
