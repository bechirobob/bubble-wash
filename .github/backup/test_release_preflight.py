import base64
import datetime
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).resolve().parents[2] / 'scripts/release-preflight.py')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

class PreflightTests(unittest.TestCase):
    def test_environment_is_parsed_never_executed_and_hashes_remain_private(self):
        secret = 'scrypt$synthetic-secret$not-a-real-hash'
        env = preflight.parse_env('BUBBLEWASH_ADMIN_PASSWORD_HASH=' + secret + '\nNODE_ENV=production')
        output = json.dumps(preflight.configuration(env))
        self.assertNotIn(secret, output)
        self.assertNotIn('scrypt', output)
        self.assertTrue(json.loads(output)['productionMode'])
        for text in ['export KEY=value', 'KEY="unterminated', 'KEY=x\nKEY=y', 'KEY=`shell-command`']:
            with self.assertRaises(ValueError):
                preflight.parse_env(text)

    def test_configuration_is_boolean_only_and_key_validation_strict(self):
        env = {'BUBBLEWASH_BACKUP_ENCRYPTION_KEY': base64.b64encode(b'x' * 32).decode(), 'BUBBLEWASH_MFA_ENCRYPTION_KEY': 'invalid', 'BUBBLEWASH_VENDOR_EMAIL': 'private-person@example.test'}
        report = preflight.configuration(env)
        self.assertTrue(report['backupKeyFormatValid'])
        self.assertFalse(report['mfaKeyFormatValid'])
        self.assertFalse(report['legacyWorkerCredentialsAbsent'])
        self.assertTrue(all(isinstance(value, bool) for value in report.values()))

    def test_backup_paths_reject_normalized_aliases_and_missing_paths(self):
        for primary, offsite in [
            ('/synthetic/backups', '/synthetic/backups'),
            ('/synthetic/backups', '/synthetic/backups/.'),
            ('/synthetic/backups/', '/synthetic//backups'),
            ('/synthetic/backups', '/synthetic/other/../backups'),
            ('/synthetic/backups', '//synthetic/backups'),
            ('', '/synthetic/backups'), ('/synthetic/backups', ''),
            ('relative/primary', '/synthetic/backups'),
            ('/synthetic/backups', 'relative/offsite'),
        ]:
            with self.subTest(primary=primary, offsite=offsite):
                report = preflight.configuration({'BUBBLEWASH_BACKUP_PRIMARY_DIR': primary, 'BUBBLEWASH_BACKUP_OFFSITE_DIR': offsite})
                self.assertIs(report['distinctBackupPaths'], False)
                self.assertNotIn('synthetic', json.dumps(report))

    def test_backup_paths_accept_distinct_normalized_absolute_paths(self):
        report = preflight.configuration({'BUBBLEWASH_BACKUP_PRIMARY_DIR': '/synthetic/primary/.', 'BUBBLEWASH_BACKUP_OFFSITE_DIR': '/synthetic/other/../offsite/'})
        self.assertIs(report['distinctBackupPaths'], True)

    def test_status_metadata_rejects_invalid_or_unordered_timestamps(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        created = (now - datetime.timedelta(hours=2)).isoformat()
        restored = (now - datetime.timedelta(hours=1)).isoformat()
        stored = now.isoformat()
        valid = {'ok': True, 'createdAt': created, 'restoreVerifiedAt': restored, 'offsiteStoredAt': stored}
        for field in ('createdAt', 'restoreVerifiedAt', 'offsiteStoredAt'):
            for invalid in ('private-invalid-timestamp', '', None, 123, True, [], {}, '2026-02-30T00:00:00Z', '2026-10-20T00:00:00', '20261020T00:00:00Z', '2026-W43-2T00:00:00Z', '2026-10-20T00:00:00+00:60', '2026-10-20T00:00:00+24:00'):
                with self.subTest(field=field, invalid=invalid):
                    self.assertIs(preflight.status_metadata_valid({**valid, field: invalid}), False)
            missing = valid.copy(); del missing[field]
            self.assertIs(preflight.status_metadata_valid(missing), False)
        for changes in ({'restoreVerifiedAt': '2000-01-01T00:00:00Z'}, {'offsiteStoredAt': created}, {'restoreVerifiedAt': 'private-invalid-timestamp'}, {'offsiteStoredAt': 'private-invalid-timestamp'}):
            with self.subTest(changes=changes), patch.object(preflight, 'bounded_text', return_value=json.dumps({**valid, **changes})):
                report = preflight.backup_report('/synthetic/status')
                self.assertIs(report['statusAgeWithin30Hours'], True)
                self.assertIs(report['statusMetadataValid'], False)
                self.assertNotIn('private-invalid-timestamp', json.dumps(report))
                self.assertTrue(all(isinstance(value, bool) for value in report.values()))

    def test_status_metadata_accepts_ordered_equal_and_offset_timestamps(self):
        for stamps in [
            ('2026-10-20T00:00:00Z', '2026-10-20T00:01:00Z', '2026-10-20T00:02:00Z'),
            ('2026-10-20T00:00:00Z',) * 3,
            ('2026-10-20T03:00:00+03:00', '2026-10-20T00:01:00Z', '2026-10-19T19:02:00-05:00'),
        ]:
            status = dict(zip(('createdAt', 'restoreVerifiedAt', 'offsiteStoredAt'), stamps), ok=True)
            with self.subTest(stamps=stamps):
                self.assertIs(preflight.status_metadata_valid(status), True)
                for invalid_ok in ('true', 'false', 1, False, None):
                    self.assertIs(preflight.status_metadata_valid({**status, 'ok': invalid_ok}), False)

    def test_preflight_push_paths_cover_executed_backup_dependencies(self):
        workflow = Path(__file__).resolve().parents[1] / 'workflows/release-preflight.yml'
        push_paths = workflow.read_text().split('    paths:\n', 1)[1].split('  workflow_dispatch:', 1)[0]
        paths = {line.strip().removeprefix('- ') for line in push_paths.splitlines() if line.strip()}
        self.assertEqual(paths, {'.github/workflows/release-preflight.yml', 'scripts/release-preflight.py', '.github/backup/check_store.py', '.github/backup/backup_release.py'})

    def test_database_aggregates_never_expose_rows_and_preserve_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'fixture.sqlite'
            db = sqlite3.connect(source)
            db.execute('CREATE TABLE staff_accounts(role TEXT, secret TEXT)')
            db.execute("INSERT INTO staff_accounts VALUES ('admin','private-person@example.test')")
            db.commit(); db.close()
            before = source.read_bytes()
            before_names = sorted(Path(root).iterdir())
            report = preflight.database_report(str(source))
            self.assertEqual(report['adminCount'], 1)
            self.assertTrue(report['integrityOk'])
            self.assertNotIn('private-person', json.dumps(report))
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(sorted(Path(root).iterdir()), before_names)

    def test_unknown_schema_identifiers_are_not_printed_or_counted(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'fixture.sqlite'
            db = sqlite3.connect(source)
            db.execute('CREATE TABLE "sensitive_customer_name"(value TEXT)'); db.close()
            report = preflight.database_report(str(source))
            self.assertTrue(report['inventoryBlockedBySchema'])
            self.assertNotIn('sensitive_customer_name', json.dumps(report))
            self.assertNotIn('knownTableCounts', report)

    def test_wal_database_is_skipped_without_creating_sidecars(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'fixture.sqlite'
            db = sqlite3.connect(source)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE submissions(value TEXT)'); db.commit(); db.close()
            before = {f.name: f.read_bytes() for f in Path(root).iterdir()}
            report = preflight.database_report(str(source))
            self.assertFalse(report['inspected'])
            self.assertTrue(report['journalModeRequiresSeparateSafeInspection'])
            self.assertEqual({f.name: f.read_bytes() for f in Path(root).iterdir()}, before)

    def test_unsupported_environment_aborts_remaining_inspection(self):
        with patch.object(preflight, 'bounded_text', side_effect=ValueError('private-secret')), patch.object(preflight, 'unit_report') as unit:
            report = preflight.collect()
            self.assertFalse(report['environmentInspectionSupported'])
            self.assertNotIn('private-secret', json.dumps(report))
            unit.assert_not_called()

    def test_unit_output_is_only_allowlisted_flags(self):
        raw = 'LoadState=loaded\nActiveState=active\nMainPID=9876\nWorkingDirectory=/private/location\nEnvironmentFiles=/private/env\n'
        with patch.object(preflight, 'command', return_value=raw):
            report = preflight.unit_report('bubblewash-maintenance.service')
            self.assertTrue(report['active'])
            self.assertNotIn('private', json.dumps(report))
            self.assertTrue(all(isinstance(value, bool) for value in report.values()))

    def test_only_in_memory_sqlite_is_connected(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'fixture.sqlite'
            db = sqlite3.connect(source); db.execute('CREATE TABLE submissions(value TEXT)'); db.close()
            original = sqlite3.connect
            calls = []
            def connect(target, *args, **kwargs):
                calls.append(target)
                return original(target, *args, **kwargs)
            with patch.object(preflight.sqlite3, 'connect', side_effect=connect):
                self.assertTrue(preflight.database_report(str(source))['inspected'])
            self.assertEqual(calls, [':memory:'])

    def test_preflight_has_no_network_or_mutating_app_probe(self):
        source = Path(preflight.__file__).read_text()
        self.assertNotIn('urlopen', source)
        self.assertNotIn('/api/ready', source)

    def test_journal_presence_skips_source_connection(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'fixture.sqlite'
            db = sqlite3.connect(source); db.execute('CREATE TABLE submissions(value TEXT)'); db.close()
            Path(str(source) + '-journal').write_bytes(b'synthetic-journal')
            with patch.object(preflight.sqlite3, 'connect') as connect:
                self.assertFalse(preflight.database_report(str(source))['inspected'])
                connect.assert_not_called()

    def test_journal_appearing_during_read_causes_safe_skip(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'fixture.sqlite'
            db = sqlite3.connect(source); db.execute('CREATE TABLE submissions(value TEXT)'); db.close()
            original = Path.open
            reads = 0
            def changing_open(target, *args, **kwargs):
                nonlocal reads
                if target == source:
                    reads += 1
                    if reads == 3:
                        with original(Path(str(source) + '-journal'), 'wb') as handle:
                            handle.write(b'synthetic-journal')
                return original(target, *args, **kwargs)
            with patch.object(Path, 'open', changing_open), patch.object(preflight.sqlite3, 'connect') as connect:
                report = preflight.database_report(str(source))
                self.assertFalse(report['inspected'])
                self.assertTrue(report['databaseChangedDuringInspection'])
                connect.assert_not_called()

if __name__ == '__main__':
    unittest.main()
