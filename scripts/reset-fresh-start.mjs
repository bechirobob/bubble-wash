import Database from "better-sqlite3";
import { createHash, createDecipheriv } from "node:crypto";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { resolveStaffUsers } from "../src/lib/staff-identity.ts";
import { mfaEncryptionKey } from "../src/lib/mfa-encryption.ts";
import { validTotpSecret } from "../src/lib/totp.ts";

export const deletedTables = ["payment_initialization_locks", "customer_recovery", "delivery_proofs", "driver_live_locations", "workflow_action_claims", "payment_verifications", "notification_outbox", "privacy_requests", "early_access_signups", "rate_limits", "submissions", "vendor_availability", "driver_availability", "vendor_declines", "assignment_capacity_reservations", "order_route_fees", "booking_requests", "order_holds", "order_invoices", "account_service_fees", "billing_entries"];
export const preservedTables = ["staff_credential_overrides", "admin_mfa_settings", "admin_mfa_recovery_codes", "admin_recovery_tokens", "mfa_replay_guard", "production_resets", "production_roster_resets"];
const confirmation = "DELETE_ALL_NONADMIN_OPERATIONAL_DATA_WITHOUT_NEW_BACKUP";
function fail(message) { throw new Error(`Fresh reset refused: ${message}`); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function rows(db, table, where = "") {
  // Table identifiers only come from the fixed allowlist.
  return db.prepare(`SELECT * FROM "${table}" ${where}`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function tableNames(db) {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  if (schema.some((entry) => entry.type === "trigger" || entry.type === "view")) fail("unreviewed trigger or view exists.");
  const names = schema.filter((entry) => entry.type === "table").map((entry) => entry.name);
  if (names.some((name) => ![...deletedTables, ...preservedTables, "staff_accounts"].includes(name))) fail("an unreviewed table exists.");
  for (const required of ["submissions", "staff_accounts", "staff_credential_overrides", "admin_mfa_settings"]) {
    if (!names.includes(required)) fail(`required table ${required} is missing.`);
  }
  return { schema, names };
}
function effectiveAdmins(db, env) {
  const override = db.prepare("SELECT login, password_hash AS passwordHash, credential_version AS credentialVersion FROM staff_credential_overrides WHERE role = 'admin'").get() ?? null;
  const managed = db.prepare("SELECT email, name, role, entity_id AS entityId, password_hash AS passwordHash, credential_version AS credentialVersion, status FROM staff_accounts").all();
  return resolveStaffUsers(env, override, managed).filter((user) => user.role === "admin");
}
function mfaUsable(db, email, env) {
  if (env.BUBBLEWASH_ADMIN_MFA_REQUIRED !== "true") return true;
  if (validTotpSecret(env.BUBBLEWASH_ADMIN_TOTP_SECRET)) return true;
  const setting = db.prepare("SELECT encrypted_secret, status FROM admin_mfa_settings WHERE admin_email = ? COLLATE NOCASE").get(email);
  if (setting?.status !== "enrolled") return false;
  try {
    const [version, nonce, tag, ciphertext, ...extra] = setting.encrypted_secret.split(".");
    if (version !== "v1" || extra.length) return false;
    const key = mfaEncryptionKey(env);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return validTotpSecret(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
  } catch { return false; }
}
function preservation(db, names) {
  return digest([...preservedTables.filter((name) => names.includes(name)).map((name) => [name, rows(db, name)]), ["staff_accounts", rows(db, "staff_accounts", "WHERE role = 'admin'")]]);
}
function checkConfiguration(env, cwd) {
  if (env.NODE_ENV !== "production" || env.BUBBLEWASH_DISABLE_DEMO_LOGIN !== "true") fail("production mode with demo login disabled is required.");
  if (env.BUBBLEWASH_ENABLE_DEMO_LOGIN === "true") fail("demo login configuration must be removed.");
  if (env.BUBBLEWASH_SESSION_SECRET?.length < 32 || !env.BUBBLEWASH_SESSION_SECRET) fail("a usable production session secret is required.");
  if (env.BUBBLEWASH_DATABASE_DRIVER !== "sqlite") fail("the configured database driver must be sqlite.");
  if (!path.isAbsolute(env.BUBBLEWASH_DATABASE_PATH ?? "")) fail("an explicit absolute database path is required.");
  if (existsSync(path.join(cwd, "data/submissions.jsonl"))) fail("legacy submissions.jsonl would repopulate operational data.");
  // Config cleanup remains an explicit prerequisite, not a silent security change.
  if (["VENDOR", "DRIVER", "SUPPORT"].some((role) => ["EMAIL", "PASSWORD", "PASSWORD_HASH", "ENTITY_ID"].some((field) => env[`BUBBLEWASH_${role}_${field}`]))) fail("remove legacy worker credentials from the service environment before resetting.");
}
export function inspectFreshReset(db, env, cwd) {
  checkConfiguration(env, cwd);
  const { schema, names } = tableNames(db);
  if (db.pragma("quick_check", { simple: true }) !== "ok" || db.pragma("foreign_key_check").length) fail("database integrity check failed.");
  const admins = effectiveAdmins(db, env);
  if (!admins.some((admin) => mfaUsable(db, admin.email, env))) fail("no effective admin with usable password and required MFA survives.");
  const counts = Object.fromEntries(names.map((name) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${name === "staff_accounts" ? " WHERE role != 'admin'" : ""}`).get().n]));
  const fingerprint = digest({ database: realpathSync(env.BUBBLEWASH_DATABASE_PATH), cwd: realpathSync(cwd), schema, contents: names.map((name) => [name, rows(db, name)]),
    // Bind the plan to authentication-relevant config without printing secrets.
    auth: Object.fromEntries(Object.entries(env).filter(([key]) => /^(NODE_ENV|BUBBLEWASH_(ADMIN|SESSION|MFA|STAFF|DISABLE_DEMO|ENABLE_DEMO|DATABASE))/.test(key)).sort()) });
  return { fingerprint, counts, preservedFingerprint: preservation(db, names), ownerAccessConfigured: true, effectiveAdminFingerprint: digest(admins), names };
}

// Inspect the actual existing systemd deployment, not a caller's assertion that
// it was stopped. Read-only checks; this script never stops/restarts any service.
export function verifyStoppedRuntime(cwd, run = execFileSync, env = process.env) {
  for (const [user, unit] of [[true, "bubblewash-local.service"], [false, "bubblewash-maintenance.service"], [false, "bubblewash-maintenance.timer"]]) {
    let values;
    try {
      const output = run("systemctl", [...(user ? ["--user"] : []), "show", unit, "--property=LoadState,ActiveState,SubState,MainPID,WorkingDirectory,EnvironmentFiles,Environment"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      values = Object.fromEntries(output.trim().split("\n").map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
    } catch { fail(`cannot verify stopped state of ${unit}.`); }
    if (values.LoadState !== "loaded" || values.ActiveState !== "inactive" || values.SubState !== "dead" || (values.MainPID && values.MainPID !== "0")) fail(`${unit} is not fully stopped.`);
    if (unit.endsWith(".service") && (!values.WorkingDirectory || realpathSync(values.WorkingDirectory) !== realpathSync(cwd))) fail(`${unit} has a different working directory.`);
    if (unit.endsWith(".service")) {
      const runtimeEnv = {};
      const inline = values.Environment ?? "";
      // Fail closed rather than guessing systemd quoting or expansion semantics.
      for (const entry of inline.split(/\s+/).filter(Boolean)) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([^"'\\]*)$/.exec(entry);
        if (!assignment) fail("inline service environment requires manual syntax review.");
        runtimeEnv[assignment[1]] = assignment[2];
      }
      const match = /^(.+) \(ignore_errors=no\)$/.exec(values.EnvironmentFiles ?? "");
      if (!match || !path.isAbsolute(match[1])) fail(`${unit} has an unreviewed environment file configuration.`);
      for (const raw of readFileSync(match[1], "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;
        const entry = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!entry || /[\\]/.test(entry[2])) fail("service environment file requires manual syntax review.");
        let value = entry[2].trim();
        if (value.startsWith('"') || value.startsWith("'")) {
          if (!value.endsWith(value[0])) fail("service environment file requires manual syntax review.");
          value = value.slice(1, -1);
        }
        runtimeEnv[entry[1]] = value;
      }
      const authKey = /^(NODE_ENV$|BUBBLEWASH_(ADMIN_|STAFF_|SESSION_SECRET$|MFA_|DATABASE_|DISABLE_DEMO_LOGIN$|ENABLE_DEMO_LOGIN$|VENDOR_|DRIVER_|SUPPORT_))/;
      const keys = unit === "bubblewash-local.service" ? new Set([...Object.keys(runtimeEnv), ...Object.keys(env)]) : Object.keys(runtimeEnv);
      for (const key of keys) {
        if (authKey.test(key) && (runtimeEnv[key] ?? "") !== (env[key] ?? "")) fail("reset and service environment do not match.");
      }
    }
  }
}

export function applyFreshReset(db, env, cwd, expectedFingerprint, verifyRuntime = () => verifyStoppedRuntime(cwd, execFileSync, env)) {
  if (env.BUBBLEWASH_CONFIRM_FRESH_RESET !== confirmation) fail("the exact permanent deletion/no-new-backup confirmation is required.");
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint ?? "")) fail("a reviewed inventory fingerprint is required.");
  verifyRuntime();
  return db.transaction(() => {
    const before = inspectFreshReset(db, env, cwd);
    if (before.fingerprint !== expectedFingerprint) fail("data, schema, path or authentication configuration changed after review.");
    for (const table of deletedTables.filter((name) => before.names.includes(name))) db.prepare(`DELETE FROM "${table}"`).run();
    db.prepare("DELETE FROM staff_accounts WHERE role != 'admin'").run();
    const after = inspectFreshReset(db, env, cwd);
    if (after.effectiveAdminFingerprint !== before.effectiveAdminFingerprint) fail("effective admin identities changed.");
    if (after.preservedFingerprint !== before.preservedFingerprint) fail("preserved admin/security state changed.");
    if ([...deletedTables, "staff_accounts"].some((name) => after.counts[name] > 0)) fail("operational records remain.");
    verifyRuntime();
    return { ok: true, before: before.counts, after: after.counts, ownerAccessConfigured: true, requiresPostRestartVerification: true };
  }).immediate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== "--apply")) fail("usage: reset-fresh-start.mjs [--apply].");
  const env = process.env;
  checkConfiguration(env, process.cwd());
  const db = new Database(env.BUBBLEWASH_DATABASE_PATH, { readonly: args[0] !== "--apply", fileMustExist: true });
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  try {
    const result = args[0] === "--apply" ? applyFreshReset(db, env, process.cwd(), env.BUBBLEWASH_FRESH_RESET_FINGERPRINT) : inspectFreshReset(db, env, process.cwd());
    const output = Object.fromEntries(Object.entries(result).filter(([key]) => !["names", "preservedFingerprint", "effectiveAdminFingerprint"].includes(key)));
    console.log(JSON.stringify(output));
  } finally { db.close(); }
}
