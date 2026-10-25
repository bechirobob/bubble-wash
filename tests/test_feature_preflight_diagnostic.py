"""Synthetic isolated-copy diagnostics, never a production database."""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT/'ops/integration-release/capsule/scripts/diagnose-feature-preflight.mjs'

class FeatureDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = Path(os.environ['BW_TEST_CANDIDATE']).resolve(strict=True)
        cls.node = str(Path(os.environ['BW_TEST_NODE']).resolve(strict=True))
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='feature-diagnostic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root/'private.sqlite'
        code = """
import {readFileSync} from 'node:fs'; import {createRequire} from 'node:module';
const Database=createRequire(process.cwd()+'/package.json')('better-sqlite3');
const db=new Database(process.argv[1]);
for(const [file,marker] of [['src/lib/data-store.ts','function initializeDatabaseSchema('],['src/lib/staff-accounts.ts','export function initializeStaffAccountsSchema(']]) {
const text=readFileSync(file,'utf8');db.exec(text.slice(text.indexOf(marker)).match(/(?:db|database)\\.exec\\(`([^`]+)`\\)/)[1]);}
const staff=readFileSync('src/lib/staff-accounts.ts','utf8');db.exec(staff.match(/const ownerCapabilityDdl = `([^`]+)`/)[1]);
db.exec(readFileSync('db/proposed/research-v1.sql','utf8'));db.close();
"""
        subprocess.run([self.node,'--input-type=module','-e',code,str(self.db)],cwd=self.source,check=True,capture_output=True)
        self.db.chmod(0o600)
    def diagnose(self, source=None, script=SCRIPT):
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        result = subprocess.run([self.node,'--conditions=react-server','--experimental-strip-types',str(script),'--database',str(self.db),'--source',str(source or self.source)],capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0)
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(),before)
        self.assertLess(len(result.stdout),32768)
        report=json.loads(result.stdout)
        self.assertEqual(set(report),{'ok','stage','error','counts','knownDiscrepancies'})
        self.assertEqual(set(report['counts']),{'objects','unexpectedTypes','unknownObjects','missingRequiredTables','mismatchedTables'})
        self.assertTrue(all(n is None or type(n) is int and 0 <= n <= 10001 for n in report['counts'].values()))
        self.assertLessEqual(len(report['knownDiscrepancies']),64)
        for row in report['knownDiscrepancies']:
            self.assertEqual(set(row),{'objectIdSha256','expectedSha256','actualSha256'})
            for key,value in row.items():
                if key=='actualSha256' and value is None:continue
                self.assertRegex(value,r'^[a-f0-9]{64}$')
        self.assertNotIn(str(self.root),result.stdout)
        self.assertNotIn('CREATE',result.stdout)
        return report
    def test_exact_schema_and_relocated_readonly_capsule_pass(self):
        package=self.root/'protected/package/capsule/scripts';package.mkdir(parents=True)
        for name in ('diagnose-feature-preflight.mjs','migrate-integration-features.mjs'):
            shutil.copyfile(SCRIPT.parent/name,package/name);(package/name).chmod(0o444)
        report=self.diagnose(script=package/SCRIPT.name)
        self.assertEqual((report['ok'],report['stage'],report['error']),(True,'COMPLETE','NONE'))
    def test_all_schema_discrepancies_counted_together_without_names(self):
        with sqlite3.connect(self.db) as db:
            db.executescript('DROP TABLE early_access_signups; CREATE TABLE secret_customer_name(id TEXT); CREATE VIEW secret_view AS SELECT id FROM secret_customer_name; CREATE INDEX changed_schema ON submissions(created_at);')
        report=self.diagnose()
        self.assertFalse(report['ok']); self.assertEqual(report['stage'],'OBJECT_TYPES')
        self.assertEqual(report['counts']['unexpectedTypes'],1)
        self.assertEqual(report['counts']['unknownObjects'],2)
        self.assertEqual(report['counts']['missingRequiredTables'],1)
        self.assertEqual(report['counts']['mismatchedTables'],2)
        self.assertNotIn('secret_',json.dumps(report))
        self.assertEqual({row['objectIdSha256'] for row in report['knownDiscrepancies']}, {hashlib.sha256(name.encode()).hexdigest() for name in ('early_access_signups','submissions')})
        self.assertEqual(sum(row['actualSha256'] is None for row in report['knownDiscrepancies']),1)
    def test_missing_required_is_distinct(self):
        with sqlite3.connect(self.db) as db:db.execute('DROP TABLE early_access_signups')
        self.assertEqual(self.diagnose()['stage'],'REQUIRED_TABLES')
    def test_schema_text_mismatch_is_distinct(self):
        with sqlite3.connect(self.db) as db:db.execute('CREATE INDEX changed_schema ON submissions(created_at)')
        self.assertEqual(self.diagnose()['stage'],'TABLE_SCHEMAS')
    def test_native_dependency_is_distinct(self):
        source=self.root/'no-dependency';source.mkdir()
        self.assertEqual(self.diagnose(source)['stage'],'NATIVE_MODULE')
    def test_schema_import_is_distinct(self):
        source=self.root/'no-import';source.mkdir();(source/'node_modules').symlink_to(self.source/'node_modules',target_is_directory=True)
        self.assertEqual(self.diagnose(source)['stage'],'SCHEMA_IMPORT')
    def test_model_source_is_distinct(self):
        source=self.root/'missing-model';(source/'src/lib').mkdir(parents=True)
        (source/'node_modules').symlink_to(self.source/'node_modules',target_is_directory=True)
        for name in ('booking-reference-schema.ts','notification-outbox-schema.ts'):(source/'src/lib'/name).write_text('export {};')
        self.assertEqual(self.diagnose(source)['stage'],'MODEL_BUILD')
    def roster_ddl(self):
        text=(self.source/'scripts/reset-production-roster.mjs').read_text()
        return re.search(r'CREATE TABLE IF NOT EXISTS production_roster_resets \([\s\S]*?\);',text)[0]
    def test_exact_historical_roster_schema_is_admitted_without_changes(self):
        with sqlite3.connect(self.db) as db:
            db.executescript(self.roster_ddl())
            db.execute("INSERT INTO production_roster_resets VALUES ('synthetic-reset','time','backup','hash','{}','{}','{}')")
            db.row_factory=sqlite3.Row
            rows=[dict(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name='production_roster_resets' ORDER BY type,name")]
            self.assertEqual(hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest(),'7b9dec121f2e38b692feca0f247ebde6e50904225a945902d0513fdfb53d1f54')
        report=self.diagnose()
        self.assertTrue(report['ok']);self.assertEqual(report['stage'],'COMPLETE')
        self.assertEqual(report['knownDiscrepancies'],[])
        with sqlite3.connect(self.db) as db:self.assertEqual(db.execute('SELECT * FROM production_roster_resets').fetchall(),[('synthetic-reset','time','backup','hash','{}','{}','{}')])
    def test_reset_source_remains_pinned_after_model_creation(self):
        source=self.root/'source-copy'
        shutil.copytree(self.source,source,ignore=shutil.ignore_patterns('node_modules','.git','.next','__pycache__'))
        (source/'node_modules').symlink_to(self.source/'node_modules',target_is_directory=True)
        code=r"""
import {appendFileSync} from 'node:fs';
const {featureSchemaModel}=await import(process.argv[1]);
const model=await featureSchemaModel(process.argv[2]);model.unchanged();
appendFileSync(process.argv[2]+'/scripts/reset-production-roster.mjs','\n// synthetic drift\n');
try {model.unchanged();process.exitCode=1;}catch {console.log('source-drift-refused');}
"""
        result=subprocess.run([self.node,'--conditions=react-server','--experimental-strip-types','--input-type=module','-e',code,(SCRIPT.parent/'migrate-integration-features.mjs').as_uri(),str(source)],capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'source-drift-refused')
    def test_roster_constraint_and_other_sql_drift_remain_refused(self):
        original=self.roster_ddl()
        variants=[original.replace(' CHECK (json_valid(before_counts))',''),
            original.replace('CHECK (json_valid(after_counts))','CHECK (json_valid(after_counts) OR 1)'),
            original.replace('backup_sha256 TEXT NOT NULL','backup_sha256 TEXT'),
            original.replace('reset_id TEXT PRIMARY KEY','reset_id TEXT'),
            original.replace('    reset_id','   reset_id')]
        for ddl in variants:
            with self.subTest(ddl=ddl),sqlite3.connect(self.db) as db:
                db.execute('DROP TABLE IF EXISTS production_roster_resets');db.executescript(ddl)
            report=self.diagnose()
            self.assertFalse(report['ok']);self.assertEqual(report['stage'],'TABLE_SCHEMAS')
    def test_unknown_table_is_distinct_and_not_identified(self):
        with sqlite3.connect(self.db) as db:db.execute('CREATE TABLE secret_unknown(id TEXT)')
        report=self.diagnose()
        self.assertEqual(report['stage'],'UNKNOWN_OBJECTS')
        self.assertEqual(report['knownDiscrepancies'],[])
    def test_foreign_key_failure_is_distinct(self):
        with sqlite3.connect(self.db) as db:db.execute("INSERT INTO staff_owner_capabilities VALUES ('not-real@example.invalid',1)")
        self.assertEqual(self.diagnose()['stage'],'FOREIGN_KEYS')
    def test_missing_capsule_is_bounded(self):
        package=self.root/'missing-capsule';package.mkdir()
        shutil.copyfile(SCRIPT,package/SCRIPT.name)
        self.assertEqual(self.diagnose(script=package/SCRIPT.name)['stage'],'CAPSULE_IMPORT')
    def test_original_preflight_is_authoritative(self):
        package=self.root/'synthetic-capsule';package.mkdir()
        shutil.copyfile(SCRIPT,package/SCRIPT.name)
        original=(SCRIPT.parent/'migrate-integration-features.mjs').as_uri()
        (package/'migrate-integration-features.mjs').write_text('export {featureSchemaModel} from '+json.dumps(original)+'; export function preflightFeatureSchema(){throw Error("never expose synthetic private data");}')
        report=self.diagnose(script=package/SCRIPT.name)
        self.assertFalse(report['ok']);self.assertEqual(report['stage'],'ORIGINAL_PREFLIGHT')
        self.assertEqual(report['error'],'ORIGINAL_PREFLIGHT_REFUSED')
        self.assertNotIn('synthetic private',json.dumps(report))
    def test_invalid_database_never_outputs_its_bytes(self):
        self.db.write_bytes(b'PRIVATE-SYNTHETIC-NOT-A-DATABASE')
        report=self.diagnose()
        self.assertFalse(report['ok']);self.assertIn(report['stage'],('DATABASE_OPEN','INTEGRITY'))
        self.assertNotIn('PRIVATE-SYNTHETIC',json.dumps(report))

if __name__=='__main__':unittest.main()
