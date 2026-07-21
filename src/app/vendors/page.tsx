import { redirect } from "next/navigation";
import { VendorWorkspace } from "@/components/StaffWorkspaces";
import { getCurrentStaffUser } from "@/lib/auth";

type VendorView = "jobs" | "capacity" | "activity";

type VendorsPageProps = {
  searchParams: Promise<{
    view?: string | string[];
    order?: string | string[];
    case?: string | string[];
    activity?: string | string[];
  }>;
};

const vendorViews = new Set<VendorView>(["jobs", "capacity", "activity"]);

function firstSearchParam(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" ? candidate.trim().slice(0, 160) : "";
}

export default async function VendorsPage({ searchParams }: VendorsPageProps) {
  const user = await getCurrentStaffUser();
  if (!user) redirect("/login?next=/vendors");
  if (user.role !== "vendor") redirect(user.role === "admin" ? "/admin" : "/login?next=/vendors");

  const params = await searchParams;
  const requestedView = firstSearchParam(params.view) as VendorView;

  return (
    <VendorWorkspace
      userName={user.name}
      role={user.role}
      initialView={vendorViews.has(requestedView) ? requestedView : "jobs"}
      selectedOrderId={firstSearchParam(params.order)}
      selectedCaseId={firstSearchParam(params.case)}
      selectedActivityId={firstSearchParam(params.activity)}
    />
  );
}
