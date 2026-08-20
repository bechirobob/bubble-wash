import "server-only";

import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto";
import QRCode from "qrcode";
import {
  acknowledgeAdminMfaRecoveryCodes,
  claimMfaTimestep,
  confirmAdminMfa,
  consumeAdminMfaRecoveryCode,
  readAdminMfaSetting,
  savePendingAdminMfa,
} from "@/lib/data-store";
import { validTotpSecret, verifyTotp } from "@/lib/totp";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pendingLifetimeMs = 10 * 60_000;

function base32(buffer: Buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let offset = 0; offset < bits.length; offset += 5) {
    output += alphabet[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

function encryptionKey() {
  const configured = process.env.BUBBLEWASH_MFA_ENCRYPTION_KEY?.trim() ?? "";
  const decoded = Buffer.from(configured, "base64");
  if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/, "") !== configured.replace(/=+$/, "")) {
    throw new Error("BUBBLEWASH_MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return decoded;
}

function encrypt(value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(value: string) {
  const [version, nonce, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext) throw new Error("Invalid encrypted MFA value.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function recoveryCode() {
  let code = "";
  for (let index = 0; index < 12; index += 1) code += recoveryAlphabet[randomInt(recoveryAlphabet.length)];
  return `BW-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function normalizeRecoveryCode(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^BW/, "");
  return compact.length === 12 ? `BW-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}` : "";
}

function recoveryCodeHash(adminEmail: string, code: string) {
  return createHmac("sha256", encryptionKey()).update(`${adminEmail.trim().toLowerCase()}:${code}`).digest("base64url");
}

function configuredEnvironmentSecret() {
  const secret = process.env.BUBBLEWASH_ADMIN_TOTP_SECRET?.trim() ?? "";
  return validTotpSecret(secret) ? secret : "";
}

export function adminMfaEnrollmentExists(adminEmail: string) {
  if (configuredEnvironmentSecret()) return true;
  return readAdminMfaSetting(adminEmail)?.status === "enrolled";
}

export function adminTotpSecret(adminEmail: string) {
  const environmentSecret = configuredEnvironmentSecret();
  if (environmentSecret) return environmentSecret;
  const setting = readAdminMfaSetting(adminEmail);
  if (!setting || setting.status !== "enrolled") return "";
  try {
    const secret = decrypt(setting.encryptedSecret);
    return validTotpSecret(secret) ? secret : "";
  } catch {
    return "";
  }
}

export function adminMfaConfigured(adminEmail: string) {
  return Boolean(adminTotpSecret(adminEmail));
}

export async function startAdminMfaEnrollment(adminEmail: string) {
  if (adminMfaEnrollmentExists(adminEmail)) throw new Error("Admin authenticator is already enrolled.");
  const secret = base32(randomBytes(20));
  const expiresAt = new Date(Date.now() + pendingLifetimeMs).toISOString();
  const saved = savePendingAdminMfa({ adminEmail, encryptedSecret: encrypt(secret), expiresAt });
  if (!saved) throw new Error("Admin authenticator is already enrolled.");

  const label = encodeURIComponent(`Bubble Wash:${adminEmail}`);
  const issuer = encodeURIComponent("Bubble Wash");
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  const qrCodeDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 320 });
  return { qrCodeDataUrl, manualKey: secret, expiresAt };
}

export function confirmAdminMfaEnrollment(adminEmail: string, code: string) {
  const setting = readAdminMfaSetting(adminEmail);
  if (!setting || setting.status !== "pending" || !setting.expiresAt || Date.parse(setting.expiresAt) <= Date.now()) {
    return { ok: false as const, error: "Authenticator setup expired. Start again." };
  }
  let secret = "";
  try {
    secret = decrypt(setting.encryptedSecret);
  } catch {
    return { ok: false as const, error: "Authenticator setup is unavailable." };
  }
  const timestep = verifyTotp(code, secret);
  if (timestep === null) return { ok: false as const, error: "That authenticator code is not valid." };

  const recoveryCodes = Array.from({ length: 8 }, recoveryCode);
  const recoveryCodeHashes = recoveryCodes.map((recovery) => recoveryCodeHash(adminEmail, recovery));
  if (!claimMfaTimestep(adminEmail.toLowerCase(), timestep)) {
    return { ok: false as const, error: "That authenticator code was already used." };
  }
  const confirmed = confirmAdminMfa({
    adminEmail,
    encryptedRecoveryBundle: encrypt(JSON.stringify(recoveryCodes)),
    recoveryCodeHashes,
  });
  if (!confirmed) {
    return { ok: false as const, error: "Authenticator setup could not be confirmed." };
  }
  return { ok: true as const, recoveryCodes };
}

export function pendingAdminRecoveryCodes(adminEmail: string) {
  const setting = readAdminMfaSetting(adminEmail);
  if (!setting || setting.status !== "enrolled" || !setting.recoveryBundleEncrypted) return [];
  try {
    const parsed = JSON.parse(decrypt(setting.recoveryBundleEncrypted));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function acknowledgeRecoveryCodes(adminEmail: string) {
  return acknowledgeAdminMfaRecoveryCodes(adminEmail);
}

export function verifyAdminMfaCredential(adminEmail: string, credential: string) {
  const secret = adminTotpSecret(adminEmail);
  if (!secret) return false;
  const trimmed = credential.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const timestep = verifyTotp(trimmed, secret);
    return timestep !== null && claimMfaTimestep(adminEmail.toLowerCase(), timestep);
  }
  const recovery = normalizeRecoveryCode(trimmed);
  return Boolean(recovery) && consumeAdminMfaRecoveryCode(adminEmail, recoveryCodeHash(adminEmail, recovery));
}
