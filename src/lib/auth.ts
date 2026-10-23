import "server-only";
import { environmentStaffUsers, resolveStaffUsers, type StaffRole, type StaffUser } from "./staff-identity.ts";
import { listStaffAccounts } from "./staff-accounts.ts";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers.js";
import { readAdminMfaSetting, readStaffCredentialOverride } from "./data-store.ts";
import { verifyPasswordHash } from "./passwords.ts";

export { createPasswordHash } from "./passwords.ts";

export type { StaffRole, StaffUser } from "./staff-identity.ts";
export type StaffSession = Pick<StaffUser, "email" | "role" | "name" | "entityId" | "credentialVersion"> & {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  ownerMfaProof?: string;
};

export const sessionCookieName = "bubblewash_staff_session";
const sessionMaxAgeSeconds = 60 * 60 * 8;
const staffSessionVersion = "v2";

export function staffAccessDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return env.BUBBLEWASH_STAFF_AUTH_DISABLED === "true";
}

// Preserve configured legacy staff alongside managed accounts. Resolve managed
// status on each request so invited/suspended rows shadow fallback and revoke sessions.
export const staffUsers = environmentStaffUsers(process.env);

export function currentStaffUsers(database?: Parameters<typeof readStaffCredentialOverride>[1]): StaffUser[] {
  if (staffAccessDisabled()) return [];
  return resolveStaffUsers(process.env, readStaffCredentialOverride("admin", database), listStaffAccounts(database), staffUsers);
}

const allowedNextPaths = new Set(["/admin", "/vendors", "/drivers", "/support"]);

function sessionSecret() {
  const secret = process.env.BUBBLEWASH_SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("BUBBLEWASH_SESSION_SECRET is required in production.");
  return "bubblewash-local-dev-session-secret-change-before-production";
}

function signPayload(payload: string) {
  return createHmac("sha256", sessionSecret()).update(`${staffSessionVersion}:${payload}`).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function sanitizeNextPath(value?: string) {
  if (!value || value.startsWith("//")) return "/admin";
  return allowedNextPaths.has(value) ? value : "/admin";
}

export function findStaffUser(identifier: string, password: string) {
  return currentStaffUsers().find((user) => user.email.toLowerCase() === identifier.trim().toLowerCase() && verifyPasswordHash(password, user.passwordHash)) ?? null;
}

function ownerMfaProof(user: StaffUser, database?: Parameters<typeof readAdminMfaSetting>[1]) {
  const setting = readAdminMfaSetting(user.email, database);
  return setting?.status === "enrolled" ? createHash("sha256").update(setting.encryptedSecret).digest("base64url") : "";
}

export function encodeSession(user: StaffUser, mfaVerified = false) {
  const personalOwner = user.role === "admin" && user.allStaffAccess === true;
  const proof = personalOwner ? ownerMfaProof(user) : undefined;
  if (personalOwner && (!mfaVerified || !proof)) throw new Error("Personal owner MFA verification is required.");
  const now = Math.floor(Date.now() / 1000);
  const session: StaffSession = {
    email: user.email,
    role: user.role,
    name: user.name,
    entityId: user.entityId,
    credentialVersion: user.credentialVersion,
    issuedAt: now,
    expiresAt: now + sessionMaxAgeSeconds,
    nonce: randomUUID(),
    ...(personalOwner ? { ownerMfaProof: proof } : {}),
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

export function decodeSession(value?: string, users?: StaffUser[], database?: Parameters<typeof readAdminMfaSetting>[1]) {
  if (staffAccessDisabled()) return null;
  if (!value) return null;
  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !safeEqual(signature, signPayload(payload))) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffSession;
    if (!session.expiresAt || session.expiresAt < Math.floor(Date.now() / 1000)) return null;
    const user = (users ?? currentStaffUsers(database)).find((item) => item.email.toLowerCase() === session.email.toLowerCase() && item.role === session.role);
    if (!user || session.entityId !== user.entityId) return null;
    if (session.credentialVersion !== user.credentialVersion) return null;
    if (user.role === "admin" && user.allStaffAccess === true) {
      const proof = ownerMfaProof(user, database);
      if (!proof || !session.ownerMfaProof || !safeEqual(session.ownerMfaProof, proof)) return null;
    }
    return { email: session.email, role: session.role, name: user.name, entityId: user.entityId, allStaffAccess: user.role === "admin" && user.allStaffAccess === true };
  } catch {
    return null;
  }
}

export async function getCurrentStaffUser() {
  const store = await cookies();
  return decodeSession(store.get(sessionCookieName)?.value);
}

export function canAccess(userRole: StaffRole, pageRole: StaffRole) {
  return userRole === "admin" || userRole === pageRole;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionMaxAgeSeconds,
  };
}
