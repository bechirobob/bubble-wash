/** Independent capabilities; neither grants owner identity or substitutes for owner MFA. */
export type StaffPermissions = { role: string; allStaffAccess?: boolean; operationalWorkspaceAccess?: boolean; surveyResultsAccess?: boolean; temporaryAccess?: boolean };
export function canEnterOperationalWorkspaces(user: StaffPermissions | null | undefined) {
  return user?.role === "admin" && user.temporaryAccess !== true &&
    (user.allStaffAccess === true || user.operationalWorkspaceAccess === true);
}
export function canReadSurveyResults(user: StaffPermissions | null | undefined) {
  return user?.role === "admin" && user.temporaryAccess !== true &&
    (user.allStaffAccess === true || user.surveyResultsAccess === true);
}
