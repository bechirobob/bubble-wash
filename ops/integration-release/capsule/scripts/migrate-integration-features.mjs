// Control-only offline capsule. Caller must hold every writer, pin this script
// and --source before/after execution, and retain the verified fresh backup.
// Never calls application initialization, cleanup, account or notification code.
import { realpathSync, lstatSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIVE = ['driver_location_stops', 'operational_work_ownership', 'operational_command_receipts', 'vendor_capacity_confirmations', 'mobile_operations_receipts'];
const OPTIONAL = 'mobile_customer_requests';
const requireThat = value => { if (!value) throw new Error('feature-schema-refused'); };
const canonical = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? { integer: item.toString() } : typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0)) ? { real: String(item), negativeZero: Object.is(item, -0) } : item);
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function sourceReader(root) {
  requireThat(path.isAbsolute(root) && realpathSync(root) === root);
  const pins = new Map(), fields = ['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'];
  function stable(relative) {
    const file = path.join(root, relative), info = lstatSync(file);
    requireThat(realpathSync(file) === file && info.isFile() && info.nlink === 1 && info.size < 500000);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      requireThat(fields.every(key=>fstatSync(fd)[key] === info[key]));
      const buffer=Buffer.alloc(info.size+1); let length=0, count;
      while (length<buffer.length && (count=readSync(fd,buffer,length,buffer.length-length,null))>0) length+=count;
      const raw=buffer.subarray(0,length); const after=fstatSync(fd), current=lstatSync(file);
      requireThat(raw.length === info.size && fields.every(key=>after[key]===info[key] && current[key]===info[key]));
      return { raw, identity: fields.map(key=>info[key]) };
    } finally { closeSync(fd); }
  }
  function read(relative) { const {raw,identity}=stable(relative); pins.set(relative,{hash:digest(raw),identity}); return raw.toString('utf8'); }
  return { read, unchanged: () => { for (const [name, pin] of pins) { const {raw,identity}=stable(name); requireThat(digest(raw)===pin.hash && canonical(identity)===canonical(pin.identity)); } } };
}
function template(source, marker) {
  const offset = source.indexOf(marker); requireThat(offset >= 0 && source.indexOf(marker, offset + 1) < 0);
  const match = source.slice(offset).match(/(?:db|database)\.exec\(`([^`]+)`\)/);
  requireThat(match && !match[1].includes('${')); return match[1];
}
function literal(source, name) {
  const matches = [...source.matchAll(new RegExp('(?:db|database)\\.exec\\("(CREATE TABLE IF NOT EXISTS ' + name + ' [^"\\n]+)"\\)', 'g'))];
  requireThat(matches.length === 1); return matches[0][1];
}
function snapshot(db, table) {
  return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name=? ORDER BY type,name').all(table);
}
function groupSchemas(db) {
  return new Map(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => [name, canonical(snapshot(db, name))]));
}
export async function featureSchemaModel(root) {
  const source = sourceReader(root);
  const Database = createRequire(path.join(root, 'package.json'))('better-sqlite3');
  // Imports are pure schema helpers; the full reviewed source/dependency binding
  // remains the caller's responsibility. Their bytes are rechecked here too.
  for (const relative of ['src/lib/booking-reference-schema.ts','src/lib/booking-references.ts','src/lib/vendor-codes.ts','src/lib/notification-outbox-schema.ts','src/lib/notification-policy.ts']) source.read(relative);
  const labels = await import(pathToFileURL(path.join(root,'src/lib/booking-reference-schema.ts')).href);
  const outbox = await import(pathToFileURL(path.join(root,'src/lib/notification-outbox-schema.ts')).href);
  const model = new Database(':memory:');
  try {
    const store = source.read('src/lib/data-store.ts');
    model.exec(template(store, 'function initializeDatabaseSchema('));
    const staff = source.read('src/lib/staff-accounts.ts');
    model.exec(template(staff, 'export function initializeStaffAccountsSchema('));
    const owner = staff.match(/const ownerCapabilityDdl = `([^`]+)`/); requireThat(owner && !owner[1].includes('${')); model.exec(owner[1]);
    model.exec(source.read('db/proposed/research-v1.sql'));
    const preRequired = new Set(groupSchemas(model).keys()), legacyOutbox = canonical(snapshot(model, 'notification_outbox'));
    labels.createBookingReferenceSchema(model); outbox.addNotificationOutboxColumns(model); model.exec(outbox.NOTIFICATION_OUTBOX_LEASE_INDEX_SQL);
    const required = new Set(groupSchemas(model).keys());
    // These inherited lazy tables may be absent, but if present every object,
    // constraint and index must match the exact reviewed definition.
    model.exec(template(source.read('src/lib/availability-store.ts'), 'export function getAvailabilityDatabase('));
    model.exec(template(source.read('src/lib/operational-store.ts'), 'export function operationalDatabase('));
    model.exec(literal(source.read('src/app/api/customer/recover/route.ts'), 'customer_recovery'));
    model.exec(literal(source.read('src/app/api/payments/initialize/route.ts'), 'payment_initialization_locks'));
    const featureDdl = [literal(store, 'driver_location_stops'), template(source.read('src/lib/automation-store.ts'), 'export function automationDatabase('), template(source.read('src/lib/vendor-capacity-command.ts'), 'function operationalDb(')];
    for (const ddl of featureDdl) model.exec(ddl);
    const optionalDdl = template(source.read('src/lib/customer-requests.ts'), 'export function createCustomerRequest('); model.exec(optionalDdl);
    const expected = groupSchemas(model), preExpected = new Map(expected);
    for (const name of ['booking_references','vendor_codes','sqlite_sequence']) preExpected.delete(name);
    preExpected.set('notification_outbox', legacyOutbox);
    const names = model.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
    requireThat(names.length === 40 && FIVE.every(n=>expected.has(n)) && expected.has(OPTIONAL));
    const ownershipSql = model.prepare("SELECT sql FROM sqlite_schema WHERE name='operational_work_ownership'").get().sql;
    // Exactly the historical six-column form from this definition, not any
    // arbitrary table missing order_id. ALTER preserves all old rowids/values.
    const oldOwnership = ownershipSql.replace(/,\s*order_id TEXT NOT NULL DEFAULT ''\s*\)/, '\n    )');
    requireThat(oldOwnership !== ownershipSql);
    const legacy = new Database(':memory:');
    let oldSchema, upgradedSchema;
    try { legacy.exec(oldOwnership); oldSchema = canonical(snapshot(legacy, 'operational_work_ownership')); legacy.exec("ALTER TABLE operational_work_ownership ADD COLUMN order_id TEXT NOT NULL DEFAULT ''"); upgradedSchema = canonical(snapshot(legacy, 'operational_work_ownership')); } finally { legacy.close(); }
    const oldLocationDdl = literal(store, 'driver_location_stops').replace(", generation TEXT NOT NULL DEFAULT '', order_id TEXT NOT NULL DEFAULT ''", '');
    requireThat(oldLocationDdl !== literal(store, 'driver_location_stops'));
    const location = new Database(':memory:');
    let oldLocationSchema, upgradedLocationSchema;
    try {
      location.exec(oldLocationDdl); oldLocationSchema = canonical(snapshot(location, 'driver_location_stops'));
      location.exec("ALTER TABLE driver_location_stops ADD COLUMN generation TEXT NOT NULL DEFAULT ''");
      location.exec("ALTER TABLE driver_location_stops ADD COLUMN order_id TEXT NOT NULL DEFAULT ''");
      upgradedLocationSchema = canonical(snapshot(location, 'driver_location_stops'));
    } finally { location.close(); }
    return { Database, expected, required, preExpected, preRequired, featureDdl, oldSchema, upgradedSchema,
      oldLocationSchema, upgradedLocationSchema, unchanged: source.unchanged };
  } finally { model.close(); }
}
export function inspectFeatureSchema(db, model, complete = false) {
  requireThat(db.pragma('quick_check', { simple: true }) === 'ok');
  requireThat(db.pragma('foreign_key_check').length === 0);
  const objects = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  requireThat(objects.every(row => ['table','index'].includes(row.type) && model.expected.has(row.tbl_name)));
  const actual = groupSchemas(db);
  requireThat([...model.required].every(name => actual.has(name)));
  for (const [name, schema] of actual) requireThat(schema === model.expected.get(name) || name === 'operational_work_ownership' && (schema === model.upgradedSchema || !complete && schema === model.oldSchema) || name === 'driver_location_stops' && (schema === model.upgradedLocationSchema || !complete && schema === model.oldLocationSchema));
  if (complete) requireThat(FIVE.every(name=>actual.has(name)));
  return actual;
}
export function preflightFeatureSchema(db, model) {
  return db.transaction(() => {
    model.unchanged();
    inspectFeatureSchema(db, { ...model, expected: model.preExpected, required: model.preRequired });
    model.unchanged();
    return { ok: true, status: 'exact-pre-migration-ready', databaseChanged: false };
  })();
}
export function verifyFeatureSchema(db, model) {
  return db.transaction(() => {
    model.unchanged(); inspectFeatureSchema(db, model, true); model.unchanged();
    return { ok: true, status: 'exact-post-feature-ready', databaseChanged: false };
  })();
}
function protectedFingerprint(db, original) {
  const hash = createHash('sha256');
  hash.update(canonical(['user_version','application_id','encoding'].map(name=>[name,db.pragma(name,{simple:true})])));
  for (const [name, columns] of original) {
    hash.update(canonical([name,columns]));
    // All admitted tables have ordinary unshadowed rowids. Safe integers and
    // raw arrays retain integer precision, null/blob types and column order.
    const statement = db.prepare('SELECT rowid,' + columns.map(quote).join(',') + ' FROM '+quote(name)+' ORDER BY rowid').safeIntegers(true).raw(true);
    for (const row of statement.iterate()) hash.update(canonical(row)+'\n');
  }
  return hash.digest('hex');
}
export function migrateFeatureSchema(db, model) {
  return db.transaction(() => {
    model.unchanged();
    const before = inspectFeatureSchema(db, model);
    const original = [...before.keys()].sort().map(name=>[name,db.pragma('table_info('+quote(name)+')').map(column=>column.name)]);
    const fingerprint = protectedFingerprint(db, original);
    const changed = FIVE.filter(name=>!before.has(name));
    const upgrade = before.get('operational_work_ownership') === model.oldSchema;
    const locationUpgrade = before.get('driver_location_stops') === model.oldLocationSchema;
    for (const ddl of model.featureDdl) db.exec(ddl);
    if (upgrade) db.exec("ALTER TABLE operational_work_ownership ADD COLUMN order_id TEXT NOT NULL DEFAULT ''");
    if (locationUpgrade) {
      db.exec("ALTER TABLE driver_location_stops ADD COLUMN generation TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE driver_location_stops ADD COLUMN order_id TEXT NOT NULL DEFAULT ''");
    }
    const after = inspectFeatureSchema(db, model, true);
    for (const [name, schema] of before) requireThat(name === 'operational_work_ownership' && upgrade ? after.get(name) === model.upgradedSchema : name === 'driver_location_stops' && locationUpgrade ? after.get(name) === model.upgradedLocationSchema : after.get(name) === schema);
    requireThat(protectedFingerprint(db, original) === fingerprint);
    model.unchanged();
    return { createdTables: changed.length, ownershipColumnAdded: upgrade, locationColumnsAdded: locationUpgrade, optionalCustomerTableCreated: false };
  }).immediate();
}
async function main() {
  const args=process.argv.slice(2), mode=['--preflight','--verify'].includes(args[0]) ? args.shift() : 'migrate';
  requireThat(args.length===4 && args[0]==='--database' && args[2]==='--source' && path.isAbsolute(args[1]) && path.isAbsolute(args[3]));
  const model=await featureSchemaModel(args[3]);
  const db=new model.Database(args[1],{fileMustExist:true,readonly:mode!=='migrate'});
  try {
    db.pragma('foreign_keys=ON'); db.pragma('busy_timeout=5000');
    if (mode!=='migrate') { db.pragma('query_only=ON'); console.log(JSON.stringify(mode==='--preflight' ? preflightFeatureSchema(db,model) : verifyFeatureSchema(db,model))); }
    else { const result=migrateFeatureSchema(db,model); console.log(JSON.stringify({ok:true,status:'exact-post-feature-ready',migration:'exact-integration-features-v1',...result})); }
  } finally { db.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { await main(); } catch { console.error(JSON.stringify({ok:false,status:'feature-schema-refused',automaticRetry:false}));process.exitCode=1; }
}
