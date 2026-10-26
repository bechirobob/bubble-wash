import { redirect } from "next/navigation";
import { LoginPageClient } from "@/components/LoginPage";
import { getCurrentStaffUser, staffSessionDestination } from "@/lib/auth";

import { assertUatEnvironment } from "@/lib/uat-environment";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const user = await getCurrentStaffUser();
  if (user) {
    const { next } = await searchParams;
    redirect(staffSessionDestination(user, typeof next === "string" ? next : undefined));
  }
  let uat = false;
  try { assertUatEnvironment(); uat = true; } catch { /* Never advertise unvalidated UAT access. */ }
  return <LoginPageClient uat={uat} />;
}
