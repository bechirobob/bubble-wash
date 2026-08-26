import "server-only";

import { readFileSync } from "node:fs";

export function backupReadiness(now = Date.now()) {
  if (process.env.NODE_ENV !== "production") return [];
  const statusPath = process.env.BUBBLEWASH_BACKUP_STATUS_PATH;
  if (!statusPath) return ["Set BUBBLEWASH_BACKUP_STATUS_PATH and run an encrypted backup with restore verification."];
  try {
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
      ok?: boolean;
      createdAt?: string;
      restoreVerifiedAt?: string;
      offsiteStoredAt?: string;
    };
    const createdAt = new Date(status.createdAt ?? "").getTime();
    const verifiedAt = new Date(status.restoreVerifiedAt ?? "").getTime();
    if (!status.ok || !Number.isFinite(createdAt) || now - createdAt > 30 * 60 * 60_000) return ["The latest encrypted database backup is missing or older than 30 hours."];
    if (!Number.isFinite(verifiedAt) || verifiedAt < createdAt) return ["The latest off-site backup has no successful restore verification."];
    const offsiteStoredAt = new Date(status.offsiteStoredAt ?? "").getTime();
    if (!Number.isFinite(offsiteStoredAt) || offsiteStoredAt < verifiedAt) return ["The latest verified backup has not been confirmed in off-host storage."];
    return [];
  } catch {
    return ["The encrypted backup status file is unavailable or invalid."];
  }
}

