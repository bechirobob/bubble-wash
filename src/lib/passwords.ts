import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const knownDemoPasswords = [
  "Admin123!",
  "Vendor123!",
  "Driver123!",
  "Support123!",
] as const;

export function createPasswordHash(password: string, salt = randomBytes(16).toString("base64url")) {
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function validPasswordHash(passwordHash: string) {
  if (typeof passwordHash !== "string") return false;
  const [scheme, salt, hash, ...extra] = passwordHash.split("$");
  return scheme === "scrypt" && Boolean(salt) && /^[A-Za-z0-9_-]{86}$/.test(hash ?? "") &&
    Buffer.from(hash, "base64url").toString("base64url") === hash && extra.length === 0;
}

export function verifyPasswordHash(password: string, passwordHash: string) {
  if (!validPasswordHash(passwordHash)) return false;
  const [, salt, expectedHash] = passwordHash.split("$");

  const expected = Buffer.from(expectedHash, "base64url");
  if (expected.length !== 64) return false;

  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, expected);
}

const demoHashCache = new Map<string, boolean>();
export function matchesKnownDemoPassword(passwordHash: string) {
  const cached = demoHashCache.get(passwordHash);
  if (cached !== undefined) return cached;
  const matches = knownDemoPasswords.some((password) => verifyPasswordHash(password, passwordHash));
  if (demoHashCache.size >= 256) demoHashCache.clear();
  demoHashCache.set(passwordHash, matches);
  return matches;
}
