import { NextResponse } from "next/server";
import { getCurrentStaffUser, readStaffUsers } from "@/lib/auth";
import { readSubmissions, text } from "@/lib/submissions";

type RosterMember = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  status: string;
  workArea: string;
  access: "configured" | "roster-only";
  updatedAt: string;
};

export async function GET() {
  const user = await getCurrentStaffUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Admin authorization required." }, { status: 403 });
  }

  const records = await readSubmissions(2000);
  const rosterByEmail = new Map<string, RosterMember>();

  for (const record of [...records].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())) {
    if (text(record.data.submissionType) !== "staff-onboarding") continue;
    const email = text(record.data.staffEmail).toLowerCase();
    if (!email || rosterByEmail.has(email)) continue;
    rosterByEmail.set(email, {
      id: record.id,
      name: text(record.data.staffName) || "Staff member",
      email,
      phone: text(record.data.staffPhone),
      role: text(record.data.staffRole) || "Operations",
      status: text(record.data.employmentStatus) || "Pending checks",
      workArea: text(record.data.workArea),
      access: "roster-only",
      updatedAt: record.createdAt,
    });
  }

  for (const configured of await readStaffUsers()) {
    const email = configured.email.toLowerCase();
    const roster = rosterByEmail.get(email);
    rosterByEmail.set(email, {
      id: roster?.id ?? `configured-${configured.role}`,
      name: roster?.name ?? configured.name,
      email: configured.email,
      phone: roster?.phone ?? "",
      role: configured.role,
      status: roster?.status ?? "Active",
      workArea: roster?.workArea ?? `${configured.role} workspace`,
      access: "configured",
      updatedAt: roster?.updatedAt ?? "",
    });
  }

  return NextResponse.json({ ok: true, members: Array.from(rosterByEmail.values()).sort((left, right) => left.role.localeCompare(right.role) || left.name.localeCompare(right.name)) });
}
