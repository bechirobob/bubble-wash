import { createHash } from "node:crypto";
import { createPasswordHash, matchesKnownDemoPassword, validPasswordHash } from "./passwords.ts";

export type StaffRole = "admin" | "vendor" | "driver" | "support";

export type StaffUser = {
  name: string;
  email: string;
  passwordHash: string;
  credentialVersion: string;
  role: StaffRole;
  entityId?: string;
  allStaffAccess?: boolean;
  username?: string;
  temporaryAccess?: boolean;
  accessStartsAt?: number;
  accessExpiresAt?: number;
};

type Environment = Record<string, string | undefined>;
type ManagedAccount = StaffUser & { status: string };
type AdminOverride = { login: string; passwordHash: string; credentialVersion: string };

export function environmentStaffUsers(env: Environment): StaffUser[] {
  const production = env.NODE_ENV === "production";
  const demo = !production && env.BUBBLEWASH_DISABLE_DEMO_LOGIN !== "true";
  // Preserve existing configured staff identities; managed rows still shadow them.
  const roles: StaffRole[] = ["admin", "vendor", "driver", "support"];
  return roles.flatMap((role) => {
    const prefix = `BUBBLEWASH_${role.toUpperCase()}`;
    const email = (env[`${prefix}_EMAIL`] ?? (demo ? `${role}@bubblewash.local` : "")).trim();
    const password = env[`${prefix}_PASSWORD`] ?? `${role[0].toUpperCase()}${role.slice(1)}123!`;
    const passwordHash = env[`${prefix}_PASSWORD_HASH`] || (!production && email ? createPasswordHash(password) : "");
    if (!email || !validPasswordHash(passwordHash) || (production && matchesKnownDemoPassword(passwordHash))) return [];
    return [{ name: role === "admin" ? "Admin Operator" : `${role} Operator`, email, passwordHash,
      credentialVersion: createHash("sha256").update(passwordHash).digest("base64url"), role,
      entityId: role === "vendor" || role === "driver" ? env[`${prefix}_ENTITY_ID`]?.trim() : undefined }];
  });
}

// Pure resolver shared by live authentication, readiness, and offline reset checks.
// All managed rows shadow matching fallback identities, even suspended/invited rows.
export function resolveStaffUsers(env: Environment, override: AdminOverride | null, managed: ManagedAccount[], fallback = environmentStaffUsers(env)): StaffUser[] {
  if (env.BUBBLEWASH_STAFF_AUTH_DISABLED === "true") return [];
  const base = override ? [{ name: "Master Administrator", email: override.login, passwordHash: override.passwordHash,
    credentialVersion: override.credentialVersion, role: "admin" as const }, ...fallback.filter((user) => user.role !== "admin")] : fallback;
  return [...base.filter((user) => !managed.some((account) => account.email.toLowerCase() === user.email.toLowerCase())),
    ...managed.filter((account) => account.status === "active").map((account) => ({ ...account, entityId: account.entityId || undefined }))]
    .filter((user) => Boolean(user.email.trim() && user.credentialVersion && validPasswordHash(user.passwordHash)) &&
      ["admin", "vendor", "driver", "support"].includes(user.role) &&
      (env.NODE_ENV !== "production" || (!matchesKnownDemoPassword(user.passwordHash) &&
        (user.role !== "vendor" && user.role !== "driver" || Boolean(user.entityId?.trim())))));
}
