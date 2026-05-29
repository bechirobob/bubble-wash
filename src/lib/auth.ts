import "server-only";

import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export type StaffRole = "admin" | "vendor" | "driver" | "support";

export type StaffUser = {
  name: string;
  email: string;
  passwordHash: string;
  role: StaffRole;
};

export type StaffSession = Pick<StaffUser, "email" | "role" | "name"> & {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export const sessionCookieName = "bubblewash_staff_session";
const sessionMaxAgeSeconds = 60 * 60 * 8;
const demoPassword = "Admin123!";

export function createPasswordHash(password: string, salt = randomBytes(16).toString("base64url")) {
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, passwordHash: string) {
  const [scheme, salt, expectedHash] = passwordHash.split("$");
  if (scheme !== "scrypt" || !salt || !expectedHash) return false;
  const actualHash = scryptSync(password, salt, 64).toString("base64url");
  const actual = Buffer.from(actualHash);
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function staffCredential(role: StaffRole, demoEmail: string, displayName: string): StaffUser | null {
  const prefix = `BUBBLEWASH_${role.toUpperCase()}`;
  const email = process.env[`${prefix}_EMAIL`] ?? (process.env.NODE_ENV === "production" ? "" : demoEmail);
  const configuredHash = process.env[`${prefix}_PASSWORD_HASH`];
  const devPassword = process.env[`${prefix}_PASSWORD`] ?? (role === "admin" ? demoPassword : `${role[0].toUpperCase()}${role.slice(1)}123!`);

  if (!email) return null;
  if (configuredHash) return { name: displayName, email, passwordHash: configuredHash, role };
  if (process.env.NODE_ENV === "production") return null;
  return { name: displayName, email, passwordHash: createPasswordHash(devPassword), role };
}

export const staffUsers: StaffUser[] = [
  staffCredential("admin", "admin@bubblewash.local", "Admin Operator"),
  staffCredential("vendor", "vendor@bubblewash.local", "Vendor Partner"),
  staffCredential("driver", "driver@bubblewash.local", "Route Driver"),
  staffCredential("support", "support@bubblewash.local", "Support Agent"),
].filter((user): user is StaffUser => Boolean(user));

const allowedNextPaths = new Set(["/admin", "/vendors", "/drivers", "/support"]);

function sessionSecret() {
  const secret = process.env.BUBBLEWASH_SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("BUBBLEWASH_SESSION_SECRET is required in production.");
  return "bubblewash-local-dev-session-secret-change-before-production";
}

function signPayload(payload: string) {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
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

export function findStaffUser(email: string, password: string) {
  return staffUsers.find((user) => user.email.toLowerCase() === email.trim().toLowerCase() && verifyPassword(password, user.passwordHash)) ?? null;
}

export function encodeSession(user: StaffUser) {
  const now = Math.floor(Date.now() / 1000);
  const session: StaffSession = {
    email: user.email,
    role: user.role,
    name: user.name,
    issuedAt: now,
    expiresAt: now + sessionMaxAgeSeconds,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

export function decodeSession(value?: string) {
  if (!value) return null;
  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !safeEqual(signature, signPayload(payload))) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffSession;
    if (!session.expiresAt || session.expiresAt < Math.floor(Date.now() / 1000)) return null;
    const user = staffUsers.find((item) => item.email === session.email && item.role === session.role);
    return user ? { email: session.email, role: session.role, name: user.name } : null;
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
