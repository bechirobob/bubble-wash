// Read-only diagnosis on an already isolated rehearsal copy. Never authorizes
// migration or replaces the unchanged capsule's original preflight admission.
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIMIT = 10000;
const canonical = value => JSON.stringify(value);
const digest = value => createHash('sha256').update(value).digest('hex');
export async function diagnoseFeaturePreflight(root, database) {
  const counts = { objects: null, unexpectedTypes: null, unknownObjects: null, missingRequiredTables: null, mismatchedTables: null };
  const knownDiscrepancies = [];
  let stage = 'SOURCE_ROOT', error = 'SOURCE_REFUSED', db;
  const result = (ok = false) => ({ ok, stage, error, counts, knownDiscrepancies });
  try {
    if (!path.isAbsolute(root) || realpathSync(root) !== root || !path.isAbsolute(database)) return result();
    stage = 'NATIVE_MODULE'; error = 'DEPENDENCY_REFUSED';
    const Database = createRequire(path.join(root, 'package.json'))('better-sqlite3');
    const nativeProbe = new Database(':memory:'); nativeProbe.close();
    stage = 'SCHEMA_IMPORT';
    await import(pathToFileURL(path.join(root, 'src/lib/booking-reference-schema.ts')).href);
    await import(pathToFileURL(path.join(root, 'src/lib/notification-outbox-schema.ts')).href);
    stage = 'CAPSULE_IMPORT'; error = 'CAPSULE_REFUSED';
    const { featureSchemaModel, preflightFeatureSchema } = await import('./migrate-integration-features.mjs');
    stage = 'MODEL_BUILD'; error = 'MODEL_REFUSED';
    const model = await featureSchemaModel(root);
    stage = 'SOURCE_BEFORE'; error = 'SOURCE_CHANGED'; model.unchanged();
    stage = 'DATABASE_OPEN'; error = 'DATABASE_REFUSED';
    if (realpathSync(database) !== database) return result();
    db = new model.Database(database, { readonly: true, fileMustExist: true });
    db.pragma('query_only=ON'); db.pragma('busy_timeout=5000');
    stage = 'INTEGRITY'; error = 'INTEGRITY_FAILED';
    if (db.pragma('quick_check', { simple: true }) !== 'ok') return result();
    stage = 'FOREIGN_KEYS'; error = 'FOREIGN_KEY_FAILED';
    if (db.prepare('PRAGMA foreign_key_check').get()) return result();
    stage = 'OBJECT_LIMIT'; error = 'OBJECT_LIMIT_EXCEEDED';
    const objects = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT ?').all(LIMIT + 1);
    counts.objects = objects.length;
    if (objects.length > LIMIT) return result();
    const expected = model.preExpected;
    const actual = new Map(objects.filter(row => row.type === 'table').map(row => [row.name,
      canonical(objects.filter(item => item.tbl_name === row.name))]));
    counts.unexpectedTypes = objects.filter(row => !['table', 'index'].includes(row.type)).length;
    counts.unknownObjects = objects.filter(row => !expected.has(row.tbl_name)).length;
    counts.missingRequiredTables = [...model.preRequired].filter(name => !actual.has(name)).length;
    counts.mismatchedTables = [...actual].filter(([name, schema]) => !(schema === expected.get(name) ||
      name === 'operational_work_ownership' && [model.upgradedSchema, model.oldSchema].includes(schema) ||
      name === 'driver_location_stops' && [model.upgradedLocationSchema, model.oldLocationSchema].includes(schema))).length;
    for (const [name, schema] of expected) {
      const found = actual.get(name);
      const admitted = found === schema || name === 'operational_work_ownership' && [model.upgradedSchema, model.oldSchema].includes(found) ||
        name === 'driver_location_stops' && [model.upgradedLocationSchema, model.oldLocationSchema].includes(found);
      if (found === undefined ? model.preRequired.has(name) : !admitted) {
        if (knownDiscrepancies.length >= 64) { stage = 'OBJECT_LIMIT'; error = 'OBJECT_LIMIT_EXCEEDED'; return result(); }
        knownDiscrepancies.push({ objectIdSha256: digest(name), expectedSha256: digest(schema), actualSha256: found === undefined ? null : digest(found) });
      }
    }
    // Gather every metadata discrepancy in this one pass, expose only counts.
    if (counts.unexpectedTypes) { stage = 'OBJECT_TYPES'; error = 'UNEXPECTED_OBJECT_TYPE'; }
    else if (counts.unknownObjects) { stage = 'UNKNOWN_OBJECTS'; error = 'UNKNOWN_OBJECTS'; }
    else if (counts.missingRequiredTables) { stage = 'REQUIRED_TABLES'; error = 'MISSING_REQUIRED_TABLES'; }
    else if (counts.mismatchedTables) { stage = 'TABLE_SCHEMAS'; error = 'SCHEMA_MISMATCH'; }
    else { stage = 'ORIGINAL_PREFLIGHT'; error = 'ORIGINAL_PREFLIGHT_REFUSED'; }
    // Always call the actual admission when metadata is readable, even if the
    // explanatory comparison above found differences. Its refusal stays final.
    try { preflightFeatureSchema(db, model); }
    catch { return result(); }
    if (stage !== 'ORIGINAL_PREFLIGHT') return result();
    stage = 'SOURCE_AFTER'; error = 'SOURCE_CHANGED'; model.unchanged();
    stage = 'COMPLETE'; error = 'NONE'; return result(true);
  } catch { return result(); }
  finally { if (db) db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--database' || args[2] !== '--source') process.exitCode = 1;
  else console.log(JSON.stringify(await diagnoseFeaturePreflight(args[3], args[1])));
}
