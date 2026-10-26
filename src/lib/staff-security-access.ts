/** Operational UAT administrators must never acquire permanent security powers. */
export function canManageStaffSecurity<T extends { role: string; temporaryAccess?: boolean }>(user: T | null | undefined): user is T & { role: "admin" } {
  return user?.role === "admin" && user.temporaryAccess !== true;
}
