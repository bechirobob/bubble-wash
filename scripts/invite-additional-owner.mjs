// Host-only enrollment. Never invoke in a public workflow with recipient or secrets.
// Run with Node --conditions=react-server --experimental-strip-types.
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { mfaEncryptionKey } from "../src/lib/mfa-encryption.ts";

function readOnlyPreflight(email, env) {
  const db = new Database(env.BUBBLEWASH_DATABASE_PATH, { readonly: true, fileMustExist: true });
  try {
    for (const table of ["staff_accounts", "staff_credential_overrides", "submissions"]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error("Existing schema is required before owner enrollment.");
    }
    const configuredCollision = ["ADMIN", "VENDOR", "DRIVER", "SUPPORT"].some((role) => env[`BUBBLEWASH_${role}_EMAIL`]?.trim().toLowerCase() === email);
    const managed = db.prepare("SELECT status FROM staff_accounts WHERE email = ? COLLATE NOCASE").get(email);
    const managedCollision = Boolean(managed);
    const masterCollision = Boolean(db.prepare("SELECT 1 FROM staff_credential_overrides WHERE login = ? COLLATE NOCASE").get(email));
    const rosterCollision = Boolean(db.prepare(`SELECT 1 FROM submissions WHERE json_extract(data, '$.submissionType') IN ('staff-onboarding', 'vendor-application', 'driver-onboarding') AND lower(trim(json_extract(data, '$.email'))) = ? LIMIT 1`).get(email));
    return { recipientCollision: configuredCollision || managedCollision || masterCollision || rosterCollision,
      collisionTypes: [configuredCollision ? "configured" : "", managedCollision ? "managed" : "", masterCollision ? "master" : "", rosterCollision ? "roster" : ""].filter(Boolean),
      managedStatus: managed ? ["invited", "active", "suspended"].includes(managed.status) ? managed.status : "unknown" : null };
  } finally { db.close(); }
}

export async function runOwnerEnrollment({ send = false, env = process.env, transport = fetch } = {}) {
  const email = env.BUBBLEWASH_OWNER_EMAIL?.trim().toLowerCase() || "";
  const name = env.BUBBLEWASH_OWNER_NAME?.trim() || "";
  const actor = env.BUBBLEWASH_OWNER_INVITED_BY?.trim() || "";
  if (env.NODE_ENV !== "production" || !isAbsolute(env.BUBBLEWASH_DATABASE_PATH || "") || env.BUBBLEWASH_STAFF_AUTH_DISABLED === "true") throw new Error("Production database and enabled staff access are required.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 160 || !name || name.length > 100 || !actor) throw new Error("Private recipient, name, and audit actor are required.");
  const sender = env.BUBBLEWASH_EMAIL_FROM?.trim() || "";
  const resendConfigured = Boolean(env.RESEND_API_KEY);
  const officialSenderDomain = /^(?:[^<>\r\n]+<[^<>@\s]+@bubblewash\.co>|[^<>@\s]+@bubblewash\.co)$/.test(sender);
  let mfaReady = true;
  if (env.BUBBLEWASH_ADMIN_MFA_REQUIRED === "true") {
    try { mfaEncryptionKey(env); } catch { mfaReady = false; }
  }
  const origin = new URL(env.BUBBLEWASH_PUBLIC_URL || "https://bubblewash.co");
  if (origin.origin !== "https://bubblewash.co" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("The verified production origin is required.");
  const collision = readOnlyPreflight(email, env);
  const ready = !collision.recipientCollision && resendConfigured && officialSenderDomain && mfaReady;
  if (!send) return { ok: ready, stage: "preflight", accountCreated: false, ...collision, resendConfigured, officialSenderDomain, mfaReady };
  if (collision.recipientCollision) throw new Error("This email already belongs to an account or roster entry. No access was changed.");
  if (!ready) throw new Error("Existing approved email and required MFA configuration must be ready before enrollment.");
  if (env.BUBBLEWASH_OWNER_INVITE_CONFIRM?.trim().toLowerCase() !== email) throw new Error("Explicit private recipient confirmation is required.");
  const { inviteOwnerAccount } = await import("../src/lib/staff-accounts.ts");
  const token = inviteOwnerAccount({ email, name }, actor);
  // No durable outbox: it must never store plaintext account-activation credentials.
  // If delivery is uncertain, stop. Never reset/reissue an existing invitation.
  let response;
  try {
    response = await transport("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.BUBBLEWASH_EMAIL_FROM, to: [email], subject: "Activate your personal Bubble Wash owner account", text: `You have been invited as an additional Bubble Wash owner. Existing staff accounts are unchanged. Choose your own password using this private, single-use link within one hour:\n\n${origin.origin}/staff/activate#${token}\n\nNever share this link or your password. If you did not expect this invitation, do not activate it.` }),
    });
  } catch { throw new Error("Invitation created; delivery outcome is uncertain. Do not retry or reset the account. Review delivery privately."); }
  if (!response.ok) throw new Error("Invitation created; email provider did not accept delivery. Do not retry or reset the account. Review delivery privately.");
  return { ok: true, stage: "invitation-created", delivery: "provider-accepted", accountActivated: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = process.argv.slice(2);
    if (flags.length > 1 || flags.some((flag) => !["--check", "--send"].includes(flag))) throw new Error("Use --check or --send; pass approved inputs only through the private environment.");
    const result = await runOwnerEnrollment({ send: flags[0] === "--send" });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    // Only our fixed diagnostics; never log provider responses, request data or tokens.
    console.error(error instanceof Error && /^(Production|Private|Existing approved|The verified|Explicit private|Invitation created|This email already|Use --check)/.test(error.message) ? error.message : "Owner enrollment failed. Inspect the private host state before retrying.");
    process.exitCode = 1;
  }
}
