import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest
spec=importlib.util.spec_from_file_location('cleanup',Path(__file__).resolve().parents[1]/'ops/test-data-cleanup-core.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class CleanupTests(unittest.TestCase):
    def fixture(self):
        db=sqlite3.connect(':memory:');self.addCleanup(db.close)
        db.execute('PRAGMA foreign_keys=ON')
        db.executescript('''CREATE TABLE staff_accounts(email TEXT,role TEXT,status TEXT);
        CREATE TABLE staff_owner_capabilities(email TEXT,all_staff_access INTEGER);
        CREATE TABLE staff_credential_overrides(login TEXT);
        CREATE TABLE admin_mfa_settings(admin_email TEXT);
        CREATE TABLE research_responses(id TEXT PRIMARY KEY,submission_key TEXT,payload TEXT);
        CREATE TABLE research_notification_outbox(response_id TEXT REFERENCES research_responses(id),state TEXT);
        CREATE TABLE early_access_signups(id TEXT,private_payload TEXT);
        CREATE TABLE notification_outbox(id TEXT,private_payload TEXT);
        CREATE TABLE submissions(data TEXT);
        CREATE TABLE rate_limits(value TEXT);''')
        db.executemany('INSERT INTO staff_accounts VALUES(?,?,?)',[('SECRET-admin','admin','active'),('SECRET-owner','admin','invited')])
        db.executemany('INSERT INTO staff_owner_capabilities VALUES(?,1)',[('SECRET-admin',),('SECRET-owner',)])
        db.execute('INSERT INTO staff_credential_overrides VALUES(?)',('SECRET-override',))
        db.execute('INSERT INTO admin_mfa_settings VALUES(?)',('SECRET-mfa',))
        payload={'submissionKey':m.KEY,'reference':m.REFERENCE,'identity':{'name':'TEST ONLY — SYNTHETIC SURVEY RESPONSE','email':'synthetic-test@example.invalid'}}
        db.execute('INSERT INTO research_responses VALUES(?,?,?)',('SECRET-id',m.KEY,json.dumps(payload)))
        db.execute('INSERT INTO research_notification_outbox VALUES(?,?)',('SECRET-id','sent'))
        db.execute('INSERT INTO early_access_signups VALUES(?,?)',('SECRET-signup','SECRET-contact'))
        db.execute('INSERT INTO notification_outbox VALUES(?,?)',('SECRET-notice','SECRET-contact'))
        db.executemany('INSERT INTO submissions VALUES(?)',[(json.dumps({'submissionType':'staff-account-action','private':'SECRET-audit'}),)]*3)
        db.execute('INSERT INTO rate_limits VALUES(?)',('SECRET-rate',));db.commit()
        env=b'# preserve comments\nNODE_ENV=production\nBUBBLEWASH_DISABLE_DEMO_LOGIN=true\nBUBBLEWASH_ADMIN_EMAIL=SECRET-admin\nBUBBLEWASH_ADMIN_PASSWORD_HASH=SECRET-admin-hash\nOTHER_SETTING=keep\n'
        for role in m.ROLES:
            env+=('BUBBLEWASH_'+role+'_EMAIL=SECRET-'+role+'\nBUBBLEWASH_'+role+'_PASSWORD_HASH=SECRET-hash\nBUBBLEWASH_'+role+'_PASSWORD=SECRET-plain\nBUBBLEWASH_'+role+'_ENTITY_ID=SECRET-entity\n').encode()
        return db,env
    def test_exact_surgical_apply_preserves_everything_else(self):
        db,env=self.fixture();before=m.inspect(db,env)
        db.execute('BEGIN IMMEDIATE')
        replacement=m.apply_in_transaction(db,env,before['fingerprint'],m.CONFIRMATION)
        self.assertTrue(db.in_transaction)
        db.commit()
        _,contents=m.database_state(db)
        self.assertEqual(before['_preserved'],{k:v for k,v in contents.items() if k not in ('research_responses','research_notification_outbox')})
        for role in m.ROLES:self.assertNotIn(('BUBBLEWASH_'+role+'_').encode(),replacement)
        self.assertIn(b'BUBBLEWASH_ADMIN_PASSWORD_HASH=SECRET-admin-hash',replacement)
        self.assertIn(b'# preserve comments',replacement)
        self.assertIn(b'OTHER_SETTING=keep',replacement)
        self.assertEqual(db.execute('SELECT count(*) FROM research_responses').fetchone()[0],0)
    def test_plan_has_no_private_values(self):
        db,env=self.fixture();out=json.dumps(m.public_plan(m.inspect(db,env)))
        self.assertNotIn('SECRET',out);self.assertNotIn('synthetic-test',out)
    def test_all_protected_identity_sources_refuse_collision(self):
        for identity in ('SECRET-admin','SECRET-owner','SECRET-override','SECRET-mfa'):
            db,env=self.fixture()
            env=env.replace(b'BUBBLEWASH_DRIVER_EMAIL=SECRET-DRIVER',('BUBBLEWASH_DRIVER_EMAIL='+identity).encode())
            with self.assertRaises(m.Refused):m.inspect(db,env)
    def test_owner_capability_and_roster_only_collision(self):
        for sql,args in [('UPDATE staff_owner_capabilities SET email=? WHERE email=?',('SECRET-DRIVER','SECRET-owner')),
                         ('UPDATE submissions SET data=? WHERE rowid=1',(json.dumps({'submissionType':'staff-onboarding','staffEmail':'SECRET-DRIVER','staffRole':'Operations'}),))]:
            db,env=self.fixture();db.execute(sql,args)
            with self.assertRaises(m.Refused):m.inspect(db,env)
    def test_changed_plan_refuses_before_delete(self):
        db,env=self.fixture();plan=m.inspect(db,env)
        db.execute('UPDATE rate_limits SET value=?',('changed',));db.commit();db.execute('BEGIN IMMEDIATE')
        with self.assertRaises(m.Refused):m.apply_in_transaction(db,env,plan['fingerprint'],m.CONFIRMATION)
        self.assertEqual(db.execute('SELECT count(*) FROM research_responses').fetchone()[0],1)
        db.rollback()
    def test_wrong_confirmation_or_no_transaction_refuses(self):
        db,env=self.fixture();plan=m.inspect(db,env)
        with self.assertRaises(m.Refused):m.apply_in_transaction(db,env,plan['fingerprint'],m.CONFIRMATION)
        db.execute('BEGIN IMMEDIATE')
        with self.assertRaises(m.Refused):m.apply_in_transaction(db,env,plan['fingerprint'],'yes')
        db.rollback()
    def test_rollback_restores_deletions_if_wrapper_fails(self):
        db,env=self.fixture();plan=m.inspect(db,env);before=db.serialize()
        db.execute('BEGIN IMMEDIATE');m.apply_in_transaction(db,env,plan['fingerprint'],m.CONFIRMATION);db.rollback()
        self.assertEqual(before,db.serialize())
    def test_real_response_or_sending_outbox_is_never_deleted(self):
        for sql,args in [('UPDATE research_responses SET payload=?',(json.dumps({'submissionKey':m.KEY,'reference':m.REFERENCE,'identity':{'email':'real@example.invalid'}}),)),
                         ('UPDATE research_notification_outbox SET state=?',('sending',))]:
            db,env=self.fixture();db.execute(sql,args)
            with self.assertRaises(m.Refused):m.inspect(db,env)
    def test_schema_expansion_refuses(self):
        db,env=self.fixture();db.execute('CREATE TABLE unknown_data(value TEXT)')
        with self.assertRaises(m.Refused):m.inspect(db,env)
    def test_hidden_rowids_and_database_metadata_bound_to_plan(self):
        for sql in ('UPDATE rate_limits SET rowid=100','PRAGMA user_version=2','PRAGMA application_id=3'):
            db,env=self.fixture();before=m.inspect(db,env)['fingerprint'];db.execute(sql)
            self.assertNotEqual(before,m.inspect(db,env)['fingerprint'])
    def test_without_rowid_table_supported_and_preserved(self):
        db,env=self.fixture();db.execute('CREATE TABLE booking_references(id TEXT PRIMARY KEY) WITHOUT ROWID')
        before=m.inspect(db,env);db.execute('BEGIN IMMEDIATE')
        m.apply_in_transaction(db,env,before['fingerprint'],m.CONFIRMATION);db.rollback()

    def test_duplicate_environment_assignment_refuses(self):
        db,env=self.fixture()
        with self.assertRaises(m.Refused):m.inspect(db,env+b'OTHER_SETTING=second\n')
    def test_linked_outbox_must_match(self):
        db,env=self.fixture();db.execute('PRAGMA foreign_keys=OFF');db.execute('UPDATE research_notification_outbox SET response_id=?',('other',))
        with self.assertRaises(m.Refused):m.inspect(db,env)
    def test_extra_signup_or_test_row_refuses(self):
        db,env=self.fixture();db.execute('INSERT INTO early_access_signups VALUES(?,?)',('new','new'))
        with self.assertRaises(m.Refused):m.inspect(db,env)

if __name__=='__main__':unittest.main()
