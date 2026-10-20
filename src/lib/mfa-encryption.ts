// Shared by live MFA and offline reset preflight, with identical key parsing.
export function mfaEncryptionKey(env: Record<string, string | undefined> = process.env) {
  const configured = env.BUBBLEWASH_MFA_ENCRYPTION_KEY?.trim() ?? "";
  const decoded = Buffer.from(configured, "base64");
  if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/, "") !== configured.replace(/=+$/, "")) {
    throw new Error("BUBBLEWASH_MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return decoded;
}
