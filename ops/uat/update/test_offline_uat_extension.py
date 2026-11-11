import copy
import sqlite3
import unittest
import offline_uat_extension as e

class ExtensionTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.executescript("""
        CREATE TABLE staff_uat_accounts (username TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','vendor','driver','support')), entity_id TEXT NOT NULL, password_hash TEXT NOT NULL, credential_version TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at - starts_at = 604800000), status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')), created_at INTEGER NOT NULL);
        CREATE TABLE staff_uat_audit (id TEXT PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, occurred_at INTEGER NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE business(id TEXT PRIMARY KEY, data TEXT);
        INSERT INTO business VALUES('one','preserved');
        """)
        for name,role,status in [('test-admin','admin','active'),('test-support','support','active'),('test-revoked','support','revoked'),('test-expired','support','expired')]:
            self.db.execute('INSERT INTO staff_uat_accounts VALUES(?,?,?,?,?,?,?,?,?,?)',(name,name,role,'','synthetic-hash' if status=='active' else '',name+'-version',e.START,e.OLD,status,e.START))
        self.db.execute('INSERT INTO staff_uat_audit VALUES(?,?,?,?,?,?,?)',('prior','test-admin','created','test',e.START,e.START,e.OLD))
        self.db.commit()
        self.expected={**e.fingerprint(self.db),'usernames':['test-support','test-admin'],'operationId':'synthetic-operation','actor':'approved-uat-extension'}
    def tearDown(self): self.db.close()
    def run_extension(self, request=None, clock=None):
        return e.extend(self.db, request or self.expected, clock or (lambda:e.OLD-1000))
    def assert_refused_unchanged(self,request=None,clock=None):
        before=e.state(self.db)
        with self.assertRaises((e.Refused, sqlite3.IntegrityError)): self.run_extension(request,clock)
        self.assertEqual(before,e.state(self.db))
        self.assertFalse(self.db.in_transaction)
    def test_success_and_replay_refused(self):
        before=e.state(self.db)[1]
        result=self.run_extension()
        self.assertEqual(result['extended'],2);self.assertEqual(result['expiresAt'],e.NEW)
        after=e.state(self.db)[1]
        self.assertEqual(before['staff_uat_accounts'],after['staff_uat_accounts'])
        self.assertEqual(before['business'],after['business'])
        self.assertEqual(len(after['staff_uat_audit']),3)
        self.assertEqual(len(after['staff_uat_extensions']),2)
        self.assert_refused_unchanged()
    def test_fingerprint_changes(self):
        for key in ['schema','accounts']:
            bad=copy.deepcopy(self.expected);bad[key]='0'*64;self.assert_refused_unchanged(bad)
    def test_missing_extra_revoked_duplicate_names(self):
        for names in [['test-admin'],['test-admin','test-support','test-revoked'],['test-admin','test-admin']]:
            bad=copy.deepcopy(self.expected);bad['usernames']=names;self.assert_refused_unchanged(bad)
    def test_wrong_window(self):
        self.db.execute("UPDATE staff_uat_accounts SET starts_at=starts_at+1,expires_at=expires_at+1 WHERE username='test-support'");self.db.commit()
        self.expected.update(e.fingerprint(self.db));self.assert_refused_unchanged()
    def test_expiry_before_or_during(self):
        for now in [e.OLD,e.START-1]:self.assert_refused_unchanged(clock=lambda:now)
        ticks=iter([e.OLD-1,e.OLD]);self.assert_refused_unchanged(clock=lambda:next(ticks))
    def test_partial_audit_failure_rolls_back_grants_and_schema(self):
        self.db.execute("CREATE TRIGGER reject_audit BEFORE INSERT ON staff_uat_audit WHEN NEW.username='test-support' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        self.db.commit();self.expected.update(e.fingerprint(self.db));self.assert_refused_unchanged()
    def test_unrelated_trigger_mutation_detected_and_rolled_back(self):
        self.db.execute("CREATE TRIGGER mutate_business AFTER INSERT ON staff_uat_audit BEGIN UPDATE business SET data='changed'; END")
        self.db.commit();self.expected.update(e.fingerprint(self.db));self.assert_refused_unchanged()
    def test_empty_hash_refused(self):
        self.db.execute("UPDATE staff_uat_accounts SET password_hash='' WHERE username='test-admin'");self.db.commit()
        self.expected.update(e.fingerprint(self.db));self.assert_refused_unchanged()
    def test_app_schema_parity(self):
        import pathlib
        source=(pathlib.Path(__file__).resolve().parents[3] / 'src/lib/uat-accounts.ts').read_text()
        self.assertIn(e.SCHEMA.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS '),source)

if __name__=='__main__':unittest.main()
