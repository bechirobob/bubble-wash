import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('retained', Path(__file__).resolve().parents[2] / 'scripts/release-preflight.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class RetainedCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / 'bubblewash-releases' / p.FAILED_CANDIDATE
        self.root.mkdir(parents=True)
        self.put('.release-sha', p.FAILED_SHA + '\n')
        self.home_patch = patch.object(p, 'HOME', self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)

    def put(self, name, text):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
        return file

    def report(self):
        with patch.object(p.subprocess, 'run', side_effect=AssertionError('no commands')), patch.object(p.sqlite3, 'connect', side_effect=AssertionError('no database')):
            return p.retained_candidate_report()

    def test_safe_aggregate_and_no_writes(self):
        self.put('.next/BUILD_ID', 'safe-build\n')
        self.put('.next/build-manifest.json', '{}')
        self.put('.next/required-server-files.json', '{}')
        self.put('.next/diagnostics/build-diagnostics.json', '{"buildStage":"type-checking","secret":"private-value"}')
        self.put('.npm/_logs/2026-10-22T20_23_16_123Z-debug-0.log', '8 verbose cwd /private/path\n9 error code ENOSPC\n10 verbose exit 1\n11 error private-value\n')
        files = list(self.root.rglob('*'))
        before = {str(f): (f.stat(), f.read_bytes()) for f in files if f.is_file()}
        real_open = os.open
        calls = []
        def checked_open(name, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            self.assertTrue(flags & os.O_NOFOLLOW)
            if flags & os.O_PATH:
                self.assertTrue(flags & os.O_DIRECTORY)
            else:
                self.assertTrue(flags & os.O_NOATIME)
            calls.append(name)
            return real_open(name, flags, *args, **kwargs)
        with patch.object(p.os, 'open', side_effect=checked_open):
            result = self.report()
        self.assertEqual(result['buildStage'], 'type-checking')
        self.assertEqual(result['npm'], {'inspection': 'completed', 'logCount': 1, 'errorCodes': ['ENOSPC'], 'exitCodes': [1], 'commandCategories': []})
        output = json.dumps(result)
        for secret in ('private-value', '/private/path', p.FAILED_CANDIDATE, p.FAILED_SHA):
            self.assertNotIn(secret, output)
        self.assertEqual(files, list(self.root.rglob('*')))
        for name, (metadata, content) in before.items():
            after = Path(name).stat()
            self.assertEqual((metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns), (after.st_size, after.st_mtime_ns, after.st_ctime_ns))
            self.assertEqual(content, Path(name).read_bytes())
        self.assertTrue(calls)

    def test_nonowner_ancestor_traversal_uses_path_fds_but_reads_keep_noatime(self):
        # Emulate Linux EPERM for O_NOATIME on ancestors owned by another UID.
        # Local sandbox UID mapping can make even / appear owned by the runner.
        self.put('.npm/_logs/2026-10-22T20_23_16_123Z-debug-0.log', '1 verbose exit 0\n')
        wal = self.home / 'db-wal'; wal.write_bytes(b'')
        real_open = os.open
        traversal = []
        readable = []
        def nonowner_open(name, flags, *args, **kwargs):
            if flags & os.O_DIRECTORY and name != '.':
                if flags & os.O_NOATIME and not flags & os.O_PATH:
                    raise PermissionError(1, 'Operation not permitted')
                self.assertTrue(flags & os.O_PATH)
                traversal.append(name)
            else:
                self.assertTrue(flags & os.O_NOATIME)
                self.assertFalse(flags & os.O_PATH)
                readable.append(name)
            return real_open(name, flags, *args, **kwargs)
        with patch.object(p.os, 'open', side_effect=nonowner_open):
            report = self.report()
            self.assertTrue(p.regular_sidecar(self.home / 'db', '-wal'))
        self.assertEqual(report['inspection'], 'completed')
        self.assertEqual(report['npm']['inspection'], 'completed')
        self.assertIn('/', traversal)
        self.assertIn('.', readable)

    def test_directory_listing_noatime_denial_fails_closed_without_fallback(self):
        self.put('.npm/_logs/2026-10-22T20_23_16_123Z-debug-0.log', '')
        real_open = os.open
        attempts = []
        def denied_listing(name, flags, *args, **kwargs):
            if name == '.':
                attempts.append(flags)
                raise PermissionError(1, 'Operation not permitted')
            return real_open(name, flags, *args, **kwargs)
        with patch.object(p.os, 'open', side_effect=denied_listing):
            self.assertEqual(self.report()['npm']['inspection'], 'rejected')
        self.assertEqual(len(attempts), 1)
        self.assertTrue(attempts[0] & os.O_NOATIME)

    def test_pin_mismatch_missing_oversized_and_symlink_fail_closed(self):
        marker = self.root / '.release-sha'
        for value in ('b' * 40, p.FAILED_SHA + '\nsecret', 'x' * 500):
            marker.write_text(value)
            self.assertEqual(self.report()['inspection'], 'rejected')
        marker.unlink()
        self.assertEqual(self.report()['inspection'], 'missing')
        outside = self.home / 'marker'; outside.write_text(p.FAILED_SHA)
        marker.symlink_to(outside)
        self.assertEqual(self.report()['inspection'], 'rejected')

    def test_candidate_and_ancestor_symlinks_rejected(self):
        actual = self.home / 'actual'; self.root.rename(actual); self.root.symlink_to(actual)
        self.assertEqual(self.report()['inspection'], 'rejected')
        self.root.unlink(); actual.rename(self.root)
        releases = self.root.parent; relocated = self.home / 'relocated'; releases.rename(relocated); releases.symlink_to(relocated)
        self.assertEqual(self.report()['inspection'], 'rejected')

    def test_artifact_symlinks_fifo_hardlink_oversize_malformed_and_hostile_stage(self):
        name = '.next/diagnostics/build-diagnostics.json'
        f = self.put(name, '{"buildStage":"private-secret"}')
        self.assertEqual(self.report()['buildStage'], 'unknown')
        for value in ('{invalid private-secret', 'x' * 65537, '{"buildStage":[]}', '{"buildStage":"compile","buildStage":"start"}', '{"buildStage":NaN}'):
            f.write_text(value)
            self.assertIn(self.report()['buildStage'], ('rejected', 'unknown'))
        f.unlink(); os.mkfifo(f)
        self.assertEqual(self.report()['buildStage'], 'rejected')
        f.unlink(); outside = self.home / 'outside'; outside.write_text('{"buildStage":"compile"}')
        f.symlink_to(outside)
        self.assertEqual(self.report()['buildStage'], 'rejected')
        f.unlink(); os.link(outside, f)
        self.assertEqual(self.report()['buildStage'], 'rejected')
        f.unlink(); f.parent.rmdir(); f.parent.symlink_to(self.home)
        self.assertEqual(self.report()['buildStage'], 'rejected')

    def test_npm_hostile_content_and_limits(self):
        f = self.put('.npm/_logs/2026-10-22T20_23_16_123Z-debug-0.log', '1 error code SECRET123\n2 verbose exit 999\n3 error command private-secret\n')
        result = self.report()['npm']
        self.assertEqual(result['errorCodes'], ['other'])
        self.assertEqual(result['exitCodes'], [])
        self.assertNotIn('SECRET', json.dumps(result))
        f.write_text('x' * 1048577)
        self.assertEqual(self.report()['npm']['inspection'], 'rejected')
        f.unlink(); f.symlink_to(self.home / 'nonexistent')
        self.assertEqual(self.report()['npm']['inspection'], 'rejected')
        f.unlink()
        for n in range(17): self.put(f'.npm/_logs/2026-10-22T20_23_16_{n:03}Z-debug-0.log', '')
        self.assertEqual(self.report()['npm']['inspection'], 'rejected')

    def test_wal_metadata_is_boolean_only_and_never_connects(self):
        db = self.home / 'synthetic.sqlite'
        raw = bytearray(100); raw[:16] = b'SQLite format 3\x00'; raw[18:20] = b'\x02\x02'; db.write_bytes(raw)
        wal = Path(str(db) + '-wal'); wal.write_bytes(b'')
        shm = Path(str(db) + '-shm'); shm.symlink_to(wal)
        with patch.object(p.sqlite3, 'connect', side_effect=AssertionError('no connection')):
            result = p.database_report(str(db))
        self.assertTrue(result['headerUsesWal'])
        self.assertTrue(result['walSidecarRegularNoSymlink'])
        self.assertFalse(result['shmSidecarRegularNoSymlink'])
        self.assertTrue(all(isinstance(v, bool) for v in result.values()))

    def test_sidecar_ancestor_swap_cannot_follow_replacement_symlink(self):
        directory = self.home / 'database-parent'; directory.mkdir()
        outside = self.home / 'outside-parent'; outside.mkdir()
        (outside / 'db-wal').write_bytes(b'')
        saved = self.home / 'saved-parent'
        real_open = p.retained_open
        def swap_after_open(parent, name, directory_flag=False):
            fd = real_open(parent, name, directory_flag)
            if name == 'database-parent':
                directory.rename(saved)
                directory.symlink_to(outside, target_is_directory=True)
            return fd
        with patch.object(p, 'retained_open', side_effect=swap_after_open), patch.object(p.os, 'read', side_effect=AssertionError('metadata only')):
            self.assertFalse(p.regular_sidecar(directory / 'db', '-wal'))
        self.assertTrue((outside / 'db-wal').is_file())
        self.assertFalse(p.regular_sidecar(directory / 'db', '-wal'))

    def test_npm_only_exact_known_command_categories(self):
        self.put('.npm/_logs/2026-10-22T20_23_16_123Z-debug-0.log', '1 verbose title npm run build\n2 verbose title npm ci --no-audit --no-fund\n3 verbose title npm prune --omit dev --no-audit --no-fund\n4 verbose title npm private-secret\n')
        self.assertEqual(self.report()['npm']['commandCategories'], ['build', 'ci', 'prune'])

    def test_npm_underscore_codes_are_allowlisted_not_leaked(self):
        self.put('.npm/_logs/2026-10-22T20_23_16_123Z-debug-0.log', '1 error code EAI_AGAIN\n2 error code PRIVATE_SECRET\n')
        result = self.report()['npm']
        self.assertEqual(result['errorCodes'], ['EAI_AGAIN', 'other'])
        self.assertNotIn('PRIVATE_SECRET', json.dumps(result))

    def test_foreign_candidates_not_inspected(self):
        self.put('.release-sha', 'b' * 40)
        with patch.object(p, 'retained_read', wraps=p.retained_read) as read:
            self.report()
        self.assertEqual([c.args[1] for c in read.call_args_list], ['.release-sha'])


if __name__ == '__main__':
    unittest.main()
