import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrationTableNames, migrationTables } from "../src/lib/migration-schema.js";

const source = process.env.BUBBLEWASH_DATABASE_PATH;
const sourceSha = process.env.BUBBLEWASH_SOURCE_SHA;
const nodeRoot = process.env.BUBBLEWASH_NODE_ROOT || process.cwd();
const output = path.resolve(process.argv[2] || "migration-export");
if (!source || !path.isAbsolute(source) || !existsSync(source)) throw new Error("BUBBLEWASH_DATABASE_PATH must point to the production SQLite file.");
if (!sourceSha || !/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error("BUBBLEWASH_SOURCE_SHA must be a full commit SHA.");
if (!path.isAbsolute(nodeRoot)) throw new Error("BUBBLEWASH_NODE_ROOT must be absolute.");
if (existsSync(output)) throw new Error(`Refusing to overwrite migration export: ${output}`);

const require = createRequire(path.join(nodeRoot, "package.json"));
const Database = require("better-sqlite3");
const work = mkdtempSync(path.join(tmpdir(), "bubblewash-cloudflare-export-"));
const snapshot = path.join(work, "snapshot.sqlite");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error(`Unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function staffCredential(role, name) {
  const prefix = `BUBBLEWASH_${role.toUpperCase()}`;
  const email = process.env[`${prefix}_EMAIL`]?.trim() ?? "";
  const passwordHash = process.env[`${prefix}_PASSWORD_HASH`]?.trim() ?? "";
  const entityId = role === "vendor" ? process.env.BUBBLEWASH_VENDOR_ENTITY_ID?.trim() ?? ""
    : role === "driver" ? process.env.BUBBLEWASH_DRIVER_ENTITY_ID?.trim() ?? "" : "";
  const totpSecret = role === "admin" ? process.env.BUBBLEWASH_ADMIN_TOTP_SECRET?.trim() ?? "" : "";
  if (!email || !/^scrypt\$[^$]+\$[^$]+$/u.test(passwordHash)) throw new Error(`Production ${role} credentials are incomplete.`);
  if ((role === "vendor" || role === "driver") && !entityId) throw new Error(`Production ${role} entity binding is incomplete.`);
  if (role === "admin" && !totpSecret) throw new Error("Production admin MFA is incomplete.");
  return {
    email,
    role,
    name,
    password_hash: passwordHash,
    entity_id: entityId || null,
    totp_secret: totpSecret || null,
    active: 1,
    updated_at: new Date().toISOString(),
  };
}

try {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await live.backup(snapshot);
  } finally {
    live.close();
  }
  const snapshotBytes = readFileSync(snapshot);
  const database = new Database(snapshot, { readonly: true, fileMustExist: true });
  const tableManifest = {};
  try {
    if (database.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Production SQLite snapshot integrity check failed.");
    const existingTables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
    for (const name of migrationTableNames) {
      const definition = migrationTables[name];
      let columns;
      let rows;
      if (name === "staff_credentials") {
        columns = [...definition.columns];
        rows = [
          staffCredential("admin", "Admin Operator"),
          staffCredential("vendor", "Vendor Partner"),
          staffCredential("driver", "Route Driver"),
          staffCredential("support", "Support Agent"),
        ].sort((left, right) => left.email.localeCompare(right.email));
      } else if (!existingTables.has(name)) {
        columns = [...definition.columns];
        rows = [];
      } else {
        const existingColumns = new Set(database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all().map((row) => row.name));
        columns = definition.columns.filter((column) => existingColumns.has(column));
        if (definition.orderBy.some((column) => !columns.includes(column))) throw new Error(`Production table ${name} is missing its migration key.`);
        rows = database.prepare(`SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(name)} ORDER BY ${definition.orderBy.map(quoteIdentifier).join(", ")}`).all();
      }
      const serialized = JSON.stringify(rows);
      writeFileSync(path.join(output, `${name}.json`), serialized, { flag: "wx", mode: 0o600 });
      tableManifest[name] = { columns, count: rows.length, sha256: sha256(serialized) };
    }
  } finally {
    database.close();
  }
  const manifest = {
    version: 1,
    runId: `bubblewash-${sourceSha.slice(0, 12)}-${Date.now()}`,
    sourceSha,
    sourceDatabaseSha256: sha256(snapshotBytes),
    createdAt: new Date().toISOString(),
    tables: tableManifest,
  };
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, runId: manifest.runId, sourceDatabaseSha256: manifest.sourceDatabaseSha256, tables: Object.fromEntries(Object.entries(tableManifest).map(([name, table]) => [name, table.count])) }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
