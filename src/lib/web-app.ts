/** Presentation identity only. Authentication remains enforced by each API. */
export const STAFF_APP_HOST = "staff.bubblewash.co";
export const STAFF_APP_URL = `https://${STAFF_APP_HOST}`;

export function isStaffAppHost(host: string | null | undefined) {
  return host?.toLowerCase() === STAFF_APP_HOST;
}
