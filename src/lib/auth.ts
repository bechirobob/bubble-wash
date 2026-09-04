import "server-only";
import { listStaffAccounts } from "./staff-accounts.ts";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers.js";
import { readStaffCredentialOverride } from "./data-store.ts";
import { createPasswordHash, matchesKnownDemoPassword, verifyPasswordHash } from "./passwords.ts";

export { createPasswordHash } from "./passwords.ts";

export type StaffRole = "admin" | "vendor" | "driver" | "support";

export type StaffUser = {
  name: string;
  email: string;
  passwordHash: string;
  credentialVersion: string;
  role: StaffRole;
  entityId?: string;
};

export type StaffSession = Pick<StaffUser, "email" | "role" | "name" | "entityId" | "credentialVersion"> & {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export const sessionCookieName = "bubblewash_staff_session";
const sessionMaxAgeSeconds = 60 * 60 * 8;
const staffSessionVersion = "v2";
const demoPassword = "Admin123!";

export function staffAccessDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return env.BUBBLEWASH_STAFF_AUTH_DISABLED === "true";
}

function demoCredentialFallbackEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN !== "true";
}

function environmentCredentialVersion(passwordHash: string) {
  return createHash("sha256").update(passwordHash).digest("base64url");
}

function staffCredential(role: StaffRole, demoEmail: string, displayName: string): StaffUser | null {
  const prefix = `BUBBLEWASH_${role.toUpperCase()}`;
  const configuredHash = process.env[`${prefix}_PASSWORD_HASH`];
  const allowDemoFallback = demoCredentialFallbackEnabled();
  const email = process.env[`${prefix}_EMAIL`] ?? (allowDemoFallback ? demoEmail : "");
  const entityId = role === "vendor"
    ? process.env.BUBBLEWASH_VENDOR_ENTITY_ID?.trim()
    : role === "driver"
      ? process.env.BUBBLEWASH_DRIVER_ENTITY_ID?.trim()
      : undefined;
  const devPassword = process.env[`${prefix}_PASSWORD`] ?? (role === "admin" ? demoPassword : `${role[0].toUpperCase()}${role.slice(1)}123!`);

  if (!email) return null;
  if (configuredHash) {
    if (process.env.NODE_ENV === "production" && matchesKnownDemoPassword(configuredHash)) return null;
    return { name: displayName, email, passwordHash: configuredHash, credentialVersion: environmentCredentialVersion(configuredHash), role, entityId };
  }
  if (process.env.NODE_ENV === "production") return null;
  const passwordHash = createPasswordHash(devPassword);
  return { name: displayName, email, passwordHash, credentialVersion: environmentCredentialVersion(passwordHash), role, entityId };
}

export const staffUsers: StaffUser[] = [
  staffCredential("admin", "admin@bubblewash.local", "Admin Operator"),
  staffCredential("vendor", "vendor@bubblewash.local", "Vendor Partner"),
  staffCredential("driver", "driver@bubblewash.local", "Route Driver"),
  staffCredential("support", "support@bubblewash.local", "Support Agent"),
].filter((user): user is StaffUser => Boolean(user));

export function currentStaffUsers(): StaffUser[] {
  if (staffAccessDisabled()) return [];
  const override = readStaffCredentialOverride();
  const managed = listStaffAccounts();
  const merge = (users: StaffUser[]) => [...users.filter((user) => !managed.some((account) => account.email.toLowerCase() === user.email.toLowerCase())), ...managed.filter((account) => account.status === "active").map((account) => ({ ...account, entityId: account.entityId || undefined }))];
  if (!override) return merge(staffUsers);
  const admin: StaffUser = {
    name: "Master Administrator",
    email: override.login,
    passwordHash: override.passwordHash,
    credentialVersion: override.credentialVersion,
    role: "admin",
  };
  const nonAdmins = staffUsers.filter((user) => user.role !== "admin");
  return merge([admin, ...nonAdmins]);
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

export function encodeSession(user: StaffUser) {
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
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

export function decodeSession(value?: string) {
  if (staffAccessDisabled()) return null;
  if (!value) return null;
  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !safeEqual(signature, signPayload(payload))) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffSession;
    if (!session.expiresAt || session.expiresAt < Math.floor(Date.now() / 1000)) return null;
    const user = currentStaffUsers().find((item) => item.email.toLowerCase() === session.email.toLowerCase() && item.role === session.role);
    if (!user || session.entityId !== user.entityId) return null;
    if (session.credentialVersion !== user.credentialVersion) return null;
    return { email: session.email, role: session.role, name: user.name, entityId: user.entityId };
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
