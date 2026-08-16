import "server-only";

import { env } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getDatabase } from "./data-store.ts";
import { migrationTableNames, migrationTables, migrationTriggers } from "./migration-schema.js";

type MigrationTableName = keyof typeof migrationTables;
type Scalar = string | number | null;
type MigrationRow = Record<string, Scalar>;
type TableManifest = { columns: string[]; count: number; sha256: string };
type MigrationManifest = {
  version: 1;
  runId: string;
  sourceSha: string;
  sourceDatabaseSha256: string;
  tables: Record<string, TableManifest>;
};
type MigrationRunRow = {
  run_id: string;
  source_sha: string;
  source_database_sha256: string;
  manifest: string;
  state: "importing" | "complete" | "aborted";
};

const githubJwks = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const githubIssuer = "https://token.actions.githubusercontent.com";
const githubAudience = "bubblewash-migration";
const migrationWorkflow = "bechirobob/bubble-wash/.github/workflows/cloudflare-migrate.yml@refs/heads/main";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function enabled() {
  return env.BUBBLEWASH_MIGRATION_ENABLED === "true";
}

function bearerToken(headers: Headers) {
  const authorization = headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export async function authorizeMigration(headers: Headers): Promise<JWTPayload> {
  if (!enabled()) throw new Error("Migration endpoint is disabled.");
  const token = bearerToken(headers);
  if (!token) throw new Error("Migration authorization is required.");
  const { payload } = await jwtVerify(token, githubJwks, { issuer: githubIssuer, audience: githubAudience });
  if (payload.repository !== "bechirobob/bubble-wash" || payload.ref !== "refs/heads/main" || payload.workflow_ref !== migrationWorkflow) {
    throw new Error("Migration authorization claims are not approved.");
  }
  if (typeof payload.sha !== "string" || !commitPattern.test(payload.sha)) {
    throw new Error("Migration authorization is missing a verified revision.");
  }
  return payload;
}

function tableName(value: unknown): MigrationTableName {
  if (typeof value !== "string" || !Object.hasOwn(migrationTables, value)) throw new Error("Migration table is not approved.");
  return value as MigrationTableName;
}

function validateManifest(value: unknown, authorizedSha: string): MigrationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Migration manifest is invalid.");
  const input = value as Partial<MigrationManifest>;
  if (input.version !== 1 || typeof input.runId !== "string" || !runIdPattern.test(input.runId)) throw new Error("Migration run identifier is invalid.");
  if (input.sourceSha !== authorizedSha || !commitPattern.test(input.sourceSha)) throw new Error("Migration revision does not match the authorized workflow revision.");
  if (typeof input.sourceDatabaseSha256 !== "string" || !sha256Pattern.test(input.sourceDatabaseSha256)) throw new Error("Migration database digest is invalid.");
  if (!input.tables || typeof input.tables !== "object" || Array.isArray(input.tables)) throw new Error("Migration table manifest is invalid.");
  for (const name of migrationTableNames) {
    const table = input.tables[name];
    const definition = migrationTables[name as MigrationTableName];
    if (!table || !Array.isArray(table.columns) || !Number.isSafeInteger(table.count) || table.count < 0 || !sha256Pattern.test(table.sha256)) {
      throw new Error(`Migration manifest for ${name} is invalid.`);
    }
    if (table.columns.length < 1 || table.columns.some((column) => !definition.columns.includes(column)) || new Set(table.columns).size !== table.columns.length) {
      throw new Error(`Migration columns for ${name} are invalid.`);
    }
    if (definition.orderBy.some((column) => !table.columns.includes(column))) throw new Error(`Migration keys for ${name} are incomplete.`);
  }
  if (Object.keys(input.tables).some((name) => !migrationTableNames.includes(name))) throw new Error("Migration manifest contains an unapproved table.");
  return input as MigrationManifest;
}

function validateRows(rows: unknown, columns: string[]): MigrationRow[] {
  if (!Array.isArray(rows) || rows.length > 50) throw new Error("Migration chunks must contain at most 50 rows.");
  return rows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Migration row is invalid.");
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row);
    if (keys.length !== columns.length || columns.some((column, index) => keys[index] !== column)) throw new Error("Migration row columns do not match the manifest.");
    for (const column of columns) {
      const item = row[column];
      if (item !== null && typeof item !== "string" && typeof item !== "number") throw new Error("Migration row contains a non-scalar value.");
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Migration row contains a non-finite number.");
    }
    return row as MigrationRow;
  });
}

async function activeRun(runId: string): Promise<{ row: MigrationRunRow; manifest: MigrationManifest }> {
  const row = await getDatabase().prepare("SELECT run_id, source_sha, source_database_sha256, manifest, state FROM migration_runs WHERE run_id = ? LIMIT 1")
    .bind(runId).first<MigrationRunRow>();
  if (!row || row.state !== "importing") throw new Error("Migration run is not accepting imports.");
  return { row, manifest: JSON.parse(row.manifest) as MigrationManifest };
}

async function dropMigrationSensitiveTriggers() {
  const db = getDatabase();
  await db.batch(Object.keys(migrationTriggers).map((name) => db.prepare(`DROP TRIGGER IF EXISTS ${name}`)));
}

async function restoreMigrationSensitiveTriggers() {
  const db = getDatabase();
  await db.batch(Object.values(migrationTriggers).map((statement) => db.prepare(statement)));
}

export async function beginMigration(value: unknown, authorizedSha: string) {
  const manifest = validateManifest(value, authorizedSha);
  const db = getDatabase();
  await dropMigrationSensitiveTriggers();
  await db.batch(migrationTableNames.map((name) => db.prepare(`DELETE FROM ${name}`)));
  await db.batch([
    db.prepare("DELETE FROM migration_imports WHERE source_database_sha256 = ?").bind(manifest.sourceDatabaseSha256),
    db.prepare(`INSERT INTO migration_runs (run_id, source_sha, source_database_sha256, manifest, state, started_at, completed_at)
      VALUES (?, ?, ?, ?, 'importing', ?, NULL)
      ON CONFLICT(run_id) DO UPDATE SET source_sha = excluded.source_sha,
        source_database_sha256 = excluded.source_database_sha256, manifest = excluded.manifest,
        state = 'importing', started_at = excluded.started_at, completed_at = NULL`)
      .bind(manifest.runId, manifest.sourceSha, manifest.sourceDatabaseSha256, JSON.stringify(manifest), new Date().toISOString()),
  ]);
  return { ok: true, runId: manifest.runId, state: "importing" as const };
}

export async function importMigrationChunk(input: { runId?: unknown; table?: unknown; chunkIndex?: unknown; rows?: unknown }, authorizedSha: string) {
  if (typeof input.runId !== "string" || !runIdPattern.test(input.runId)) throw new Error("Migration run identifier is invalid.");
  if (!Number.isSafeInteger(input.chunkIndex) || Number(input.chunkIndex) < 0) throw new Error("Migration chunk index is invalid.");
  const name = tableName(input.table);
  const { row: run, manifest } = await activeRun(input.runId);
  if (run.source_sha !== authorizedSha) throw new Error("Migration revision no longer matches its authorization.");
  const columns = manifest.tables[name].columns;
  const rows = validateRows(input.rows, columns);
  const chunkIndex = Number(input.chunkIndex);
  const importId = `${input.runId}:${name}:${chunkIndex}`;
  const existing = await getDatabase().prepare("SELECT row_count AS rowCount FROM migration_imports WHERE import_id = ? LIMIT 1")
    .bind(importId).first<{ rowCount: number }>();
  if (existing) {
    if (existing.rowCount !== rows.length) throw new Error("Migration chunk was replayed with a different row count.");
    return { ok: true, runId: input.runId, table: name, chunkIndex, rows: existing.rowCount, replayed: true };
  }
  const placeholders = columns.map(() => "?").join(", ");
  const statements = rows.map((item) => getDatabase().prepare(`INSERT INTO ${name} (${columns.join(", ")}) VALUES (${placeholders})`)
    .bind(...columns.map((column) => item[column])));
  statements.push(getDatabase().prepare(`INSERT INTO migration_imports
    (import_id, source_sha, source_database_sha256, table_name, chunk_index, row_count, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(importId, run.source_sha, run.source_database_sha256, name, chunkIndex, rows.length, new Date().toISOString()));
  await getDatabase().batch(statements);
  return { ok: true, runId: input.runId, table: name, chunkIndex, rows: rows.length, replayed: false };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tableParity(name: MigrationTableName, expected: TableManifest) {
  const definition = migrationTables[name];
  const count = await getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${name}`).first<{ count: number }>();
  const rows: MigrationRow[] = [];
  for (let offset = 0; offset < expected.count; offset += 200) {
    const result = await getDatabase().prepare(`SELECT ${expected.columns.join(", ")} FROM ${name}
      ORDER BY ${definition.orderBy.join(", ")} LIMIT 200 OFFSET ?`).bind(offset).all<MigrationRow>();
    rows.push(...result.results);
  }
  return { count: count?.count ?? 0, sha256: await sha256(JSON.stringify(rows)) };
}

export async function finalizeMigration(runId: unknown, authorizedSha: string) {
  if (typeof runId !== "string" || !runIdPattern.test(runId)) throw new Error("Migration run identifier is invalid.");
  const { row: run, manifest } = await activeRun(runId);
  if (run.source_sha !== authorizedSha) throw new Error("Migration revision no longer matches its authorization.");
  const parity: Record<string, { count: number; sha256: string }> = {};
  for (const rawName of migrationTableNames) {
    const name = rawName as MigrationTableName;
    parity[name] = await tableParity(name, manifest.tables[name]);
    if (parity[name].count !== manifest.tables[name].count || parity[name].sha256 !== manifest.tables[name].sha256) {
      throw new Error(`Migration parity failed for ${name}.`);
    }
  }
  await restoreMigrationSensitiveTriggers();
  await getDatabase().prepare("UPDATE migration_runs SET state = 'complete', completed_at = ? WHERE run_id = ? AND state = 'importing'")
    .bind(new Date().toISOString(), runId).run();
  return { ok: true, runId, state: "complete" as const, parity };
}

export async function abortMigration(runId: unknown, authorizedSha: string) {
  if (typeof runId !== "string" || !runIdPattern.test(runId)) throw new Error("Migration run identifier is invalid.");
  const { row } = await activeRun(runId);
  if (row.source_sha !== authorizedSha) throw new Error("Migration revision no longer matches its authorization.");
  await restoreMigrationSensitiveTriggers();
  await getDatabase().prepare("UPDATE migration_runs SET state = 'aborted', completed_at = ? WHERE run_id = ? AND state = 'importing'")
    .bind(new Date().toISOString(), runId).run();
  return { ok: true, runId, state: "aborted" as const };
}
