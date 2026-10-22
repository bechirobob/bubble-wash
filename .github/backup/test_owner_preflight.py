import base64
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('owner_preflight', ROOT / 'scripts/release-preflight.py')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

class OwnerPreflightTests(unittest.TestCase):
    def fixture(self, root):
        db = root / 'pilot.sqlite'
        con = sqlite3.connect(db)
        con.executescript('CREATE TABLE staff_accounts(email TEXT, role TEXT, status TEXT); CREATE TABLE staff_credential_overrides(login TEXT); CREATE TABLE submissions(data TEXT);')
        con.commit()
        return db, con

    def test_private_categories_no_database_or_directory_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); db, con = self.fixture(root)
            email = 'private-fixture@example.test'
            con.execute('INSERT INTO staff_accounts VALUES (?, ?, ?)', (email.upper(), 'admin', 'invited'))
            con.execute('INSERT INTO staff_credential_overrides VALUES (?)', (email,))
            con.execute('INSERT INTO submissions VALUES (?)', (json.dumps({'submissionType': 'staff-onboarding', 'email': email}),))
            con.commit(); con.close()
            before = db.read_bytes(); files = list(root.iterdir())
            result = {'owner': preflight.owner_database_report(str(db), email, {'BUBBLEWASH_DRIVER_EMAIL':email})}
            self.assertEqual(result['owner']['duplicateTypes'], ['configured', 'master', 'managed', 'roster'])
            self.assertEqual(result['owner']['managedStatus'], 'invited')
            self.assertNotIn(email, json.dumps(result)); self.assertNotIn(email.upper(), json.dumps(result))
            self.assertEqual(db.read_bytes(), before); self.assertEqual(list(root.iterdir()), files)

    def test_unknown_values_are_not_disclosed_and_wal_is_not_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            db, con = self.fixture(Path(directory)); email = 'fixture@example.test'
            con.execute('INSERT INTO staff_accounts VALUES (?, ?, ?)', (email, 'secret-role', 'secret-status')); con.commit()
            result = {'owner': preflight.owner_database_report(str(db), email, {})}
            self.assertEqual(result['owner']['managedStatus'], 'unknown')
            self.assertNotIn('secret-', json.dumps(result))
            con.execute('PRAGMA journal_mode=WAL'); con.execute('INSERT INTO staff_credential_overrides VALUES (?)', (email,)); con.commit()
            result = preflight.database_report(str(db))
            self.assertFalse(result['inspected']); self.assertNotIn('owner', result)
            con.close()

    def test_private_mode_reads_committed_wal_without_account_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); db, writer = self.fixture(root)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('INSERT INTO staff_accounts VALUES (?, ?, ?)', ('wal@example.test', 'admin', 'invited')); writer.commit()
            before = writer.execute('SELECT email,role,status FROM staff_accounts').fetchall()
            result = preflight.owner_database_report(str(db), 'wal@example.test', {})
            self.assertTrue(result['inspected']); self.assertTrue(result['duplicatePresent'])
            self.assertTrue(result['walAwareReadTransaction']); self.assertFalse(result['accountDataWritten'])
            self.assertTrue(result['sqliteSharedMemoryBookkeepingPossible'])
            self.assertEqual(writer.execute('SELECT email,role,status FROM staff_accounts').fetchall(), before)
            self.assertNotIn('wal@example.test', json.dumps(result))
            writer.close()

    def test_private_mode_is_uri_readonly_queryonly_and_no_immutable(self):
        with tempfile.TemporaryDirectory() as directory:
            db, writer = self.fixture(Path(directory)); writer.close()
            original = sqlite3.connect; traces = []
            def observed(path, **kwargs):
                self.assertTrue(path.endswith('?mode=ro')); self.assertNotIn('immutable', path)
                self.assertTrue(kwargs.get('uri'))
                connection = original(path, **kwargs); connection.set_trace_callback(traces.append)
                return connection
            with patch.object(preflight.sqlite3, 'connect', side_effect=observed):
                self.assertTrue(preflight.owner_database_report(str(db), 'missing@example.test', {})['inspected'])
            self.assertIn('PRAGMA query_only = ON', traces); self.assertIn('BEGIN', traces)
            self.assertFalse(any(sql.startswith(('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'REPLACE')) for sql in traces))

    def test_missing_schema_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory)/'empty.sqlite'; con = sqlite3.connect(db); con.execute('CREATE TABLE staff_accounts(email TEXT, role TEXT, status TEXT)'); con.close()
            result = {'owner': preflight.owner_database_report(str(db), 'fixture@example.test', {})}
            self.assertFalse(result['owner']['inspected'])

    def test_sender_and_key_values_remain_private(self):
        key = base64.b64encode(bytes(range(32))).decode()
        result = preflight.owner_delivery_configuration({'RESEND_API_KEY':'never-log-fixture', 'BUBBLEWASH_EMAIL_FROM':'Bubble Wash <updates@bubblewash.co>', 'BUBBLEWASH_MFA_ENCRYPTION_KEY':key})
        self.assertTrue(result['resendConfigured']); self.assertTrue(result['personalMfaKeyReady'])
        self.assertEqual(result['configuredSenderCategory'], 'updates@bubblewash.co')
        self.assertNotIn(key, json.dumps(result)); self.assertNotIn('never-log', json.dumps(result))
        self.assertFalse(preflight.owner_delivery_configuration({'BUBBLEWASH_MFA_ENCRYPTION_KEY':'invalid'})['personalMfaKeyReady'])
        other = preflight.owner_delivery_configuration({'BUBBLEWASH_EMAIL_FROM':'private@bubblewash.co'})
        self.assertEqual(other['configuredSenderCategory'], 'other-official-domain'); self.assertNotIn('private@', json.dumps(other))

    def test_collect_end_to_end_matching_release_pin_and_live_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); db, writer = self.fixture(root)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('INSERT INTO staff_accounts VALUES (?, ?, ?)', ('collect@example.test', 'admin', 'invited')); writer.commit()
            release = root/'release'; release.mkdir()
            runtime = root/'bubblewash-runtime'; runtime.mkdir()
            (runtime/'current-release').write_text('sha=' + 'a'*40 + '\npath=' + str(release) + '\n')
            envfile = root/'env'
            envfile.write_text('NODE_ENV=production\nBUBBLEWASH_DATABASE_PATH=' + str(db) + '\nBUBBLEWASH_EMAIL_FROM=updates@bubblewash.co\nRESEND_API_KEY=synthetic-never-print\n')
            with patch.object(preflight, 'HOME', root), patch.object(preflight, 'CURRENT', release), patch.object(preflight, 'ENV_FILE', envfile), patch.object(preflight, 'unit_report', return_value={}), patch.object(preflight, 'release_login_inspection', return_value={}), patch.object(preflight, 'backup_report', return_value={}):
                result = preflight.collect('collect@example.test', 'a'*40)
            self.assertTrue(result['ownerInspection']['completed'])
            self.assertTrue(result['ownerInspection']['duplicatePresent'])
            self.assertTrue(result['ownerInspection']['releasePinStillMatches'])
            self.assertTrue(result['ownerInspection']['resendConfigured'])
            self.assertFalse(result['database']['inspected']) # Generic inspection still declines WAL.
            self.assertNotIn('collect@example.test', json.dumps(result)); self.assertNotIn('synthetic-never-print', json.dumps(result))
            writer.close()

    def test_wrong_release_pin_reads_no_environment(self):
        with patch.object(preflight, 'release_pin_matches', return_value=False), patch.object(preflight, 'bounded_text', side_effect=AssertionError('must not read')):
            self.assertFalse(preflight.collect('fixture@example.test', 'a'*40)['ownerInspection']['completed'])

    def test_stream_quotes_private_input_and_rejects_missing_pin(self):
        env = {**os.environ, 'OWNER_EMAIL': "odd'quote@example.test", 'EXPECTED_LIVE_SHA':'a'*40}
        run = subprocess.run(['python3','.github/backup/stream_owner_preflight.py'],cwd=ROOT,env=env,capture_output=True,text=True)
        self.assertEqual(run.returncode, 0); compile(run.stdout, '<private-stream>', 'exec')
        self.assertTrue(run.stdout.startswith("__name__ = 'private_owner_preflight'"))
        env['EXPECTED_LIVE_SHA']='not-a-sha'
        run = subprocess.run(['python3','.github/backup/stream_owner_preflight.py'],cwd=ROOT,env=env,capture_output=True,text=True)
        self.assertNotEqual(run.returncode, 0); self.assertEqual(run.stdout, '')
        self.assertNotIn(env['OWNER_EMAIL'], run.stderr)

    def test_workflow_has_no_public_recipient_or_send_input(self):
        workflow = (ROOT/'.github/workflows/release-preflight.yml').read_text()
        self.assertIn('secrets.BUBBLEWASH_OWNER_EMAIL', workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertNotIn('inputs.email', workflow); self.assertNotIn('--send', workflow)
        self.assertNotIn('upload-artifact', workflow)
