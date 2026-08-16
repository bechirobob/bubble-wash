import "server-only";

import { env } from "cloudflare:workers";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers.js";
import { getDatabase } from "./data-store.ts";
import { matchesKnownDemoPassword, verifyPasswordHash } from "./passwords.ts";
import { validTotpSecret } from "./totp.ts";

export { createPasswordHash } from "./passwords.ts";

export type StaffRole = "admin" | "vendor" | "driver" | "support";

export type StaffUser = {
  name: string;
  email: string;
  passwordHash: string;
  role: StaffRole;
  entityId?: string;
  totpSecret?: string;
};

export type StaffSession = Pick<StaffUser, "email" | "role" | "name" | "entityId"> & {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

type StaffCredentialRow = {
  email: string;
  role: StaffRole;
  name: string;
  password_hash: string;
  entity_id: string | null;
  totp_secret: string | null;
};

export const sessionCookieName = "bubblewash_staff_session";
const sessionMaxAgeSeconds = 60 * 60 * 8;
const allowedNextPaths = new Set(["/admin", "/vendors", "/drivers", "/support"]);

function sessionSecret() {
  const secret = env.BUBBLEWASH_SESSION_SECRET || process.env.BUBBLEWASH_SESSION_SECRET;
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

function userFromRow(row: StaffCredentialRow): StaffUser {
  return {
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    entityId: row.entity_id ?? undefined,
    totpSecret: row.totp_secret ?? undefined,
  };
}

export function sanitizeNextPath(value?: string) {
  if (!value || value.startsWith("//")) return "/admin";
  return allowedNextPaths.has(value) ? value : "/admin";
}

export async function readStaffUsers(): Promise<StaffUser[]> {
  const result = await getDatabase().prepare(`
    SELECT email, role, name, password_hash, entity_id, totp_secret
    FROM staff_credentials WHERE active = 1 ORDER BY role, email
  `).all<StaffCredentialRow>();
  return result.results.map(userFromRow);
}

export async function staffCredentialReadiness() {
  const users = await readStaffUsers();
  const errors: string[] = [];
  for (const role of ["admin", "vendor", "driver", "support"] satisfies StaffRole[]) {
    const user = users.find((candidate) => candidate.role === role);
    if (!user) errors.push(`Configure one active ${role} credential in D1.`);
    if (user && matchesKnownDemoPassword(user.passwordHash)) errors.push(`Rotate the ${role} password; known demo credentials are prohibited.`);
    if (user && (role === "vendor" || role === "driver") && !user.entityId) errors.push(`Bind the ${role} credential to its approved roster entity.`);
    if (user && role === "admin" && !validTotpSecret(user.totpSecret)) errors.push("Configure the admin MFA secret in D1.");
  }
  return errors;
}

export async function findStaffUser(email: string, password: string) {
  const row = await getDatabase().prepare(`
    SELECT email, role, name, password_hash, entity_id, totp_secret
    FROM staff_credentials WHERE email = ? COLLATE NOCASE AND active = 1 LIMIT 1
  `).bind(email.trim()).first<StaffCredentialRow>();
  if (!row || matchesKnownDemoPassword(row.password_hash) || !verifyPasswordHash(password, row.password_hash)) return null;
  return userFromRow(row);
}

export function encodeSession(user: StaffUser) {
  const now = Math.floor(Date.now() / 1000);
  const session: StaffSession = {
    email: user.email,
    role: user.role,
    name: user.name,
    entityId: user.entityId,
    issuedAt: now,
    expiresAt: now + sessionMaxAgeSeconds,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

export async function decodeSession(value?: string) {
  if (!value) return null;
  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !safeEqual(signature, signPayload(payload))) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffSession;
    if (!session.expiresAt || session.expiresAt < Math.floor(Date.now() / 1000)) return null;
    const row = await getDatabase().prepare(`
      SELECT email, role, name, password_hash, entity_id, totp_secret
      FROM staff_credentials WHERE email = ? COLLATE NOCASE AND role = ? AND active = 1 LIMIT 1
    `).bind(session.email, session.role).first<StaffCredentialRow>();
    if (!row || session.entityId !== (row.entity_id ?? undefined)) return null;
    return { email: row.email, role: row.role, name: row.name, entityId: row.entity_id ?? undefined };
  } catch {
    return null;
  }
}

export async function getCurrentStaffUser() {
  const store = await cookies();
  return await decodeSession(store.get(sessionCookieName)?.value);
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
