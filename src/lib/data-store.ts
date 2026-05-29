import "server-only";

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { SubmissionRecord } from "@/lib/submissions";

const dataDir = path.join(process.cwd(), "data");
const databasePath = process.env.BUBBLEWASH_DATABASE_PATH ?? path.join(dataDir, "bubblewash.sqlite");
const legacySubmissionsPath = path.join(dataDir, "submissions.jsonl");

type StoredSubmissionRow = {
  id: string;
  created_at: string;
  source: string | null;
  data: string;
};

type RateLimitRow = {
  key: string;
  count: number;
  reset_at: number;
};

let database: Database.Database | null = null;
let migratedLegacyJsonl = false;

function getDatabase() {
  if (database) return database;
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source TEXT,
      data TEXT NOT NULL CHECK (json_valid(data))
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at DESC);

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);
  `);
  database = db;
  migrateLegacySubmissions(db);
  return db;
}

function migrateLegacySubmissions(db: Database.Database) {
  if (migratedLegacyJsonl || !existsSync(legacySubmissionsPath)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO submissions (id, created_at, source, data) VALUES (@id, @createdAt, @source, @data)");
  const migrate = db.transaction(() => {
    for (const line of readFileSync(legacySubmissionsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as SubmissionRecord;
        if (!record.id || !record.createdAt || !record.data) continue;
        insert.run({ id: record.id, createdAt: record.createdAt, source: record.source ?? null, data: JSON.stringify(record.data) });
      } catch {
        // Skip malformed legacy pilot records instead of blocking startup.
      }
    }
  });
  migrate();
  renameSync(legacySubmissionsPath, `${legacySubmissionsPath}.migrated`);
  migratedLegacyJsonl = true;
}

export function appendSubmissionRecord(record: SubmissionRecord) {
  getDatabase()
    .prepare("INSERT INTO submissions (id, created_at, source, data) VALUES (@id, @createdAt, @source, @data)")
    .run({ id: record.id, createdAt: record.createdAt, source: record.source ?? null, data: JSON.stringify(record.data) });
}

export function readSubmissionRecords(limit = 200): SubmissionRecord[] {
  const rows = getDatabase()
    .prepare("SELECT id, created_at, source, data FROM submissions ORDER BY created_at DESC LIMIT ?")
    .all(limit) as StoredSubmissionRow[];

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    source: row.source ?? undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
}

export function consumeRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const resetAt = now + windowMs;
  const db = getDatabase();
  db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(now);
  const current = db.prepare("SELECT key, count, reset_at FROM rate_limits WHERE key = ?").get(key) as RateLimitRow | undefined;

  if (!current || current.reset_at <= now) {
    db.prepare("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)").run(key, 1, resetAt);
    return { limited: false, remaining: Math.max(0, limit - 1), resetAt };
  }

  const nextCount = current.count + 1;
  db.prepare("UPDATE rate_limits SET count = ? WHERE key = ?").run(nextCount, key);
  return { limited: nextCount > limit, remaining: Math.max(0, limit - nextCount), resetAt: current.reset_at };
}

export function resetDataStoreForTests() {
  if (!database) return;
  database.prepare("DELETE FROM submissions").run();
  database.prepare("DELETE FROM rate_limits").run();
}
