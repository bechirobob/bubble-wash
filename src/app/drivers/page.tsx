import { redirect } from "next/navigation";
import { DriverWorkspace } from "@/components/StaffWorkspaces";
import { getCurrentStaffUser } from "@/lib/auth";

type DriverView = "route" | "activity";

type DriversPageProps = {
  searchParams: Promise<{
    view?: string | string[];
    order?: string | string[];
    case?: string | string[];
    activity?: string | string[];
  }>;
};

const driverViews = new Set<DriverView>(["route", "activity"]);

function firstSearchParam(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" ? candidate.trim().slice(0, 160) : "";
}

export default async function DriversPage({ searchParams }: DriversPageProps) {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/drivers");
  if (user.role !== "driver") redirect(user.role === "admin" ? "/admin" : "/login?next=/drivers");

  const params = await searchParams;
  const requestedView = firstSearchParam(params.view) as DriverView;

  return (
    <DriverWorkspace
      userName={user.name}
      role={user.role}
      initialView={driverViews.has(requestedView) ? requestedView : "route"}
      selectedOrderId={firstSearchParam(params.order)}
      selectedCaseId={firstSearchParam(params.case)}
      selectedActivityId={firstSearchParam(params.activity)}
    />
  );
}
