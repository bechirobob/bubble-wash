import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1]/'ops/integration-release/repair_backup_mode.py'
spec = importlib.util.spec_from_file_location('repair_backup_mode', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root/'backups'
        self.target.mkdir(mode=0o775)
        self.target.chmod(0o775)
        self.file = self.target/'archive'
        self.file.write_bytes(b'unchanged')
        self.file.chmod(0o600)
        self.expected = m.identity(self.target.stat())
        self.uid = os.getuid()

    def run_repair(self, unchanged=lambda: None):
        return m._repair(self.target, self.uid, self.expected, unchanged)

    def test_only_target_mode_changes_and_second_attempt_refuses(self):
        file_before = self.file.stat()
        self.assertTrue(self.run_repair()['ok'])
        self.assertEqual(m.identity(self.target.stat()), self.expected[:-1]+(0o755,))
        self.assertEqual(self.file.read_bytes(), b'unchanged')
        self.assertEqual(self.file.stat(), file_before)
        with self.assertRaises(RuntimeError): self.run_repair()

    def test_wrong_mode_owner_inode_or_device_refused_without_chmod(self):
        for index in range(5):
            with self.subTest(index=index):
                wrong = list(self.expected); wrong[index] += 1
                with patch.object(m.os, 'fchmod') as chmod:
                    with self.assertRaises(RuntimeError):
                        m._repair(self.target, self.uid, tuple(wrong), lambda: None)
                    chmod.assert_not_called()

    def test_symlink_refused(self):
        alias = self.root/'alias'; alias.symlink_to(self.target)
        with self.assertRaises(OSError): m._repair(alias, self.uid, self.expected, lambda: None)

    def test_unprotected_parent_refused(self):
        self.root.chmod(0o775)
        with self.assertRaises(RuntimeError): self.run_repair()

    def test_replaced_target_after_open_refused(self):
        def replace():
            self.target.rename(self.root/'old')
            self.target.mkdir(mode=0o775)
        with patch.object(m.os, 'fchmod') as chmod:
            with self.assertRaises(RuntimeError): self.run_repair(replace)
            chmod.assert_not_called()

    def test_lost_lock_refuses_before_mutation(self):
        with patch.object(m.os, 'fchmod') as chmod:
            with self.assertRaises(RuntimeError):
                self.run_repair(lambda: (_ for _ in ()).throw(RuntimeError('lock changed')))
            chmod.assert_not_called()

    def test_post_chmod_recheck_reports_uncertain_race_without_reverting(self):
        calls = []
        def check():
            calls.append(1)
            if len(calls) == 2: raise RuntimeError('lock changed')
        with self.assertRaises(RuntimeError): self.run_repair(check)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o755)

    def test_production_entry_uses_existing_lock_and_exact_target(self):
        class Guard:
            from contextlib import contextmanager
            @contextmanager
            def deployment_lock(inner, runtime, uid):
                self.assertEqual(runtime, m.RUNTIME); self.assertEqual(uid, 1000)
                yield 'recheck'
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.pwd, 'getpwnam') as user, patch.object(m, '_repair', return_value={'ok': True}) as repair:
            user.return_value.pw_uid = 1000
            m.repair_backup_mode(Guard())
            repair.assert_called_once_with(m.TARGET, 1000, (2049,254581,1000,1000,0o775), 'recheck')

if __name__ == '__main__': unittest.main()
