import importlib.util
import fcntl
import os
from unittest.mock import patch
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('inventory',Path(__file__).resolve().parents[1]/'ops/inspect-test-data-inventory.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class InventoryTests(unittest.TestCase):
    def db(self):
        db=sqlite3.connect(':memory:')
        db.executescript('''CREATE TABLE staff_accounts(email TEXT,role TEXT,status TEXT);
          CREATE TABLE staff_owner_capabilities(email TEXT,all_staff_access INTEGER);
          CREATE TABLE staff_credential_overrides(login TEXT);
          CREATE TABLE admin_mfa_settings(admin_email TEXT);
          CREATE TABLE submissions(data TEXT);
          CREATE TABLE research_responses(submission_key TEXT,payload TEXT);''')
        self.addCleanup(db.close)
        return db
    def test_protection_collisions_and_no_private_output(self):
        db=self.db()
        rows=[('SECRET-admin','admin','active'),('SECRET-owner','driver','active'),
              ('SECRET-mfa','support','invited'),('SECRET-override','vendor','suspended'),
              ('SECRET-env','driver','active'),('SECRET-test','driver','suspended'),
              ('SECRET-variant','super-admin','active')]
        db.executemany('INSERT INTO staff_accounts VALUES(?,?,?)',rows)
        db.execute('INSERT INTO staff_owner_capabilities VALUES(?,1)',('SECRET-owner',))
        db.execute('INSERT INTO admin_mfa_settings VALUES(?)',('SECRET-mfa',))
        db.execute('INSERT INTO staff_credential_overrides VALUES(?)',('SECRET-override',))
        env={'BUBBLEWASH_ADMIN_EMAIL':'SECRET-env','BUBBLEWASH_DRIVER_EMAIL':'SECRET-test','BUBBLEWASH_DRIVER_PASSWORD_HASH':'SECRET-hash'}
        before=db.serialize();out=m.inventory(db,env)
        self.assertEqual(before,db.serialize())
        self.assertEqual(out['managedAccounts']['protectedAdminRelatedCount'],6)
        self.assertEqual(out['managedAccounts']['nonAdminCandidateCount'],1)
        self.assertEqual(out['managedAccounts']['protectedNonAdminRoleCount'],4)
        self.assertEqual(out['managedAccounts']['unclassifiedRoleOrStatusCount'],1)
        self.assertEqual(out['legacyConfiguration']['driver']['managedCollisionCount'],1)
        self.assertNotIn('SECRET',json.dumps(out))
    def test_json_unclassified_research_and_no_arbitrary_labels(self):
        db=self.db()
        db.executemany('INSERT INTO submissions VALUES(?)',[(json.dumps({'submissionType':'checkout-request'}),),('{bad',),(json.dumps({'submissionType':'SECRET-label'}),)])
        db.executemany('INSERT INTO research_responses VALUES(?,?)',[
          ('20b2f9aa-77dd-4c7a-8efe-b23f176c77f1','{"reference":"operator-test-v1"}'),
          ('SECRET-key','{"reference":"SECRET-response"}')])
        db.execute('CREATE TABLE "SECRET-table"(value TEXT)')
        out=m.inventory(db,{})
        self.assertEqual(out['unclassifiedSubmissionCount'],2)
        self.assertEqual(out['malformedSubmissionJsonCount'],1)
        self.assertEqual(out['knownSyntheticResearchCount'],1)
        self.assertEqual(out['unclassifiedResearchCount'],1)
        self.assertEqual(out['unknownTableCount'],1)
        self.assertNotIn('SECRET',json.dumps(out))
    def test_absent_tables_are_null_not_zero(self):
        db=sqlite3.connect(':memory:');self.addCleanup(db.close)
        out=m.inventory(db,{})
        self.assertIsNone(out['tables']['staff_accounts'])
        self.assertNotIn('managedAccounts',out)
    def test_view_not_queried_as_table(self):
        db=sqlite3.connect(':memory:');self.addCleanup(db.close)
        db.execute('CREATE VIEW staff_accounts AS SELECT 1')
        self.assertIsNone(m.inventory(db,{})['tables']['staff_accounts'])
    def test_readonly_file_and_symlink_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'db';db=sqlite3.connect(p)
            db.execute('CREATE TABLE submissions(data TEXT)');db.commit();db.close()
            before=p.read_bytes()
            db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
            db.execute('PRAGMA query_only=ON')
            self.assertEqual(m.inventory(db,{})['tables']['submissions'],0)
            with self.assertRaises(sqlite3.OperationalError): db.execute('DELETE FROM submissions')
            db.close();self.assertEqual(before,p.read_bytes())
            link=Path(folder)/'link';link.symlink_to(p)
            with self.assertRaises(ValueError):m.secure_file(link)
    def test_live_wal_is_included_without_record_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'db';writer=sqlite3.connect(p)
            self.addCleanup(writer.close)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE submissions(data TEXT)')
            writer.execute('INSERT INTO submissions VALUES(?)', ('{"submissionType":"pickup-booking"}',))
            writer.commit()
            before=(p.read_bytes(),Path(str(p)+'-wal').read_bytes())
            reader=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
            try:
                reader.execute('PRAGMA query_only=ON')
                reader.execute('PRAGMA trusted_schema=OFF')
                allowed={sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION,sqlite3.SQLITE_TRANSACTION}
                reader.set_authorizer(lambda action,a,b,c,d:sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
                reader.execute('BEGIN')
                self.assertEqual(m.inventory(reader,{})['submissionCategories']['pickup-booking'],1)
                with self.assertRaises(sqlite3.DatabaseError):reader.execute('DELETE FROM submissions')
                reader.execute('ROLLBACK')
            finally:reader.close()
            self.assertEqual(before,(p.read_bytes(),Path(str(p)+'-wal').read_bytes()))
    def test_workflow_contract(self):
        s=(Path(__file__).resolve().parents[1]/'.github/workflows/inspect-test-data-inventory.yml').read_text()
        for expected in ['contents: read','cancel-in-progress: false','group: bubblewash-production',
                         'environment: backup-storage','persist-credentials: false',
                         '"$SOURCE_SHA" == "$GITHUB_SHA"','"$GITHUB_RUN_ATTEMPT" == 1',
                         "tailscale ssh root@hermes 'python3 -I -B -' < ops/inspect-test-data-inventory.py"]:
            self.assertIn(expected,s)

    def test_busy_deployment_lock_refuses_inventory(self):
        with tempfile.TemporaryDirectory() as folder:
            lock=Path(folder)/'deploy.lock';lock.touch(mode=0o600)
            fd=os.open(lock,os.O_RDONLY)
            try:
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                original_path=Path
                with patch.object(m,'Path',side_effect=lambda value: lock if str(value)=='/home/ubuntu/bubblewash-runtime/deploy.lock' else original_path(value)):
                    with self.assertRaises(BlockingIOError):
                        with m.deployment_read_lock():self.fail('busy deployment lock admitted inventory')
            finally:os.close(fd)
    def test_host_wrapper_missing_sidecar_refuses_before_sqlite_open(self):
        # No host access: mock fixed production path metadata and application
        # pointer while exercising the actual inspect() wrapper fail-closed gate.
        dbpath=Path('/home/ubuntu/test-inventory.sqlite')
        current=Path('/home/ubuntu/releases/test')
        for missing in ('-wal','-shm'):
            def secure(path,limit=None):
                if str(path)==str(dbpath)+missing:raise FileNotFoundError('test missing sidecar')
                return object()
            with patch.object(m.os,'geteuid',return_value=0), \
                 patch.object(m,'read_config',return_value={'BUBBLEWASH_DATABASE_PATH':str(dbpath)}), \
                 patch.object(m,'CURRENT') as pointer, \
                 patch.object(m,'secure_file',side_effect=secure), \
                 patch.object(m.sqlite3,'connect') as connect:
                pointer.is_symlink.return_value=True
                pointer.resolve.return_value=current
                with self.assertRaises(FileNotFoundError):m.inspect()
                connect.assert_not_called()

    def test_virtual_table_rejected(self):
        db=sqlite3.connect(':memory:');self.addCleanup(db.close)
        db.execute('CREATE VIRTUAL TABLE submissions USING fts5(data)')
        with self.assertRaises(ValueError):m.inventory(db,{})

if __name__=='__main__':unittest.main()
