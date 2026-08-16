import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { migrationTableNames } from "../src/lib/migration-schema.js";

const endpoint = process.env.BUBBLEWASH_MIGRATION_ENDPOINT;
const token = process.env.BUBBLEWASH_MIGRATION_ID_TOKEN;
const sourceDirectory = path.resolve(process.argv[2] || "migration-export");
if (!endpoint || !/^https:\/\//u.test(endpoint)) throw new Error("BUBBLEWASH_MIGRATION_ENDPOINT must be HTTPS.");
if (!token) throw new Error("BUBBLEWASH_MIGRATION_ID_TOKEN is required.");

const manifest = JSON.parse(readFileSync(path.join(sourceDirectory, "manifest.json"), "utf8"));

async function call(payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(typeof data.error === "string" ? data.error : `Migration endpoint returned HTTP ${response.status}.`);
  return data;
}

let began = false;
try {
  await call({ action: "begin", manifest });
  began = true;
  for (const table of migrationTableNames) {
    const rows = JSON.parse(readFileSync(path.join(sourceDirectory, `${table}.json`), "utf8"));
    for (let offset = 0, chunkIndex = 0; offset < rows.length; offset += 50, chunkIndex += 1) {
      await call({ action: "chunk", runId: manifest.runId, table, chunkIndex, rows: rows.slice(offset, offset + 50) });
    }
    console.log(JSON.stringify({ table, imported: rows.length }));
  }
  const completed = await call({ action: "finalize", runId: manifest.runId });
  if (process.env.BUBBLEWASH_MIGRATION_RESULT_PATH) {
    writeFileSync(process.env.BUBBLEWASH_MIGRATION_RESULT_PATH, `${JSON.stringify({
      ok: true,
      runId: completed.runId,
      state: completed.state,
      sourceSha: manifest.sourceSha,
      sourceDatabaseSha256: manifest.sourceDatabaseSha256,
      parity: completed.parity,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ ok: true, runId: completed.runId, state: completed.state, parity: completed.parity }));
} catch (error) {
  if (began) await call({ action: "abort", runId: manifest.runId }).catch(() => undefined);
  throw error;
}
