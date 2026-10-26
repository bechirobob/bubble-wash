/** Research access never follows the broad admin override used by staff workspaces. */
export function canViewResearchResults(user: { role: string; allStaffAccess?: boolean; temporaryAccess?: boolean } | null | undefined) {
  return user?.role === 'admin' && user.allStaffAccess === true && user.temporaryAccess !== true;
}
