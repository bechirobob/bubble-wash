import "server-only";

import { timingSafeEqual } from "node:crypto";

export function maintenanceAuthorized(headers: Headers) {
  const configured = process.env.BUBBLEWASH_MAINTENANCE_TOKEN ?? "";
  const supplied = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (configured.length < 32 || !supplied) return false;
  const left = Buffer.from(configured);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
