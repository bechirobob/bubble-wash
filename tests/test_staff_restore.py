import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('restore', Path(__file__).resolve().parents[1] / 'scripts/restore-staff-access.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
RAW = b'# preserve\nBUBBLEWASH_STAFF_AUTH_DISABLED=true\nBUBBLEWASH_BOOKINGS_DISABLED=true\nSECRET=unchanged\nMFA=true\n'

class RestoreTests(unittest.TestCase):
    def test_output_does_not_claim_unverified_account_preservation(self):
        source = Path(m.__file__).read_text()
        self.assertNotIn("'accountsChanged': False", source)
        self.assertIn("'accountMutationCommandsRun': False", source)
        self.assertIn("'accountsPreservedVerification': 'not-performed'", source)
    def test_single_flag_only(self):
        self.assertEqual(m.prepare(RAW, False), RAW.replace(b'STAFF_AUTH_DISABLED=true', b'STAFF_AUTH_DISABLED=false'))
    def test_booking_approval_required(self):
        for value in (b'false', b''):
            raw = RAW.replace(b'BOOKINGS_DISABLED=true', b'BOOKINGS_DISABLED=' + value)
            with self.assertRaises(ValueError): m.prepare(raw, False)
            self.assertEqual(m.parse(m.prepare(raw, True))[m.BOOK], 'true')
    def test_missing_booking_flag(self):
        raw = RAW.replace(b'BUBBLEWASH_BOOKINGS_DISABLED=true\n', b'')
        with self.assertRaises(ValueError): m.prepare(raw, False)
        self.assertEqual(m.parse(m.prepare(raw, True))[m.BOOK], 'true')
    def test_reject_duplicate_missing_malformed_or_unlocked(self):
        for raw in (RAW + b'BUBBLEWASH_STAFF_AUTH_DISABLED=true\n', RAW.replace(b'BUBBLEWASH_STAFF_AUTH_DISABLED=true\n', b''), RAW.replace(b'STAFF_AUTH_DISABLED=true', b'STAFF_AUTH_DISABLED=false'), RAW + b'bad shell command\n', RAW.replace(b'BOOKINGS_DISABLED=true', b'BOOKINGS_DISABLED=maybe')):
            with self.assertRaises(ValueError): m.prepare(raw, True)
    def test_quoted_flags_preserve_other_bytes(self):
        raw = RAW.replace(b'DISABLED=true', b'DISABLED="true"')
        result = m.prepare(raw, False)
        self.assertIn(b'BOOKINGS_DISABLED="true"', result)
        self.assertIn(b'SECRET=unchanged\nMFA=true\n', result)
    def test_atomic_mode_owner_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'env'
            path.write_bytes(RAW)
            path.chmod(0o600)
            old = path.stat()
            m.atomic_write(path, b'new', old)
            self.assertEqual(path.read_bytes(), b'new')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_uid, old.st_uid)
            self.assertEqual(list(Path(directory).iterdir()), [path])
    def test_success_verifies_new_runtime(self):
        replacement = m.prepare(RAW, False)
        verify = Mock()
        with patch.object(m, 'atomic_write') as write, patch.object(m, 'ctl') as ctl, patch.object(m, 'health'):
            m.apply(RAW, replacement, None, verify)
            write.assert_called_once_with(m.ENV, replacement, None)
            ctl.assert_called_once_with('restart', m.UNIT)
            verify.assert_called_once_with(m.parse(replacement))
    def test_restart_health_or_runtime_failure_rolls_back(self):
        for failing in ('ctl', 'health', 'verify'):
            verify = Mock(side_effect=[ValueError('synthetic'), None] if failing == 'verify' else None)
            with patch.object(m, 'atomic_write') as write, patch.object(m, 'ctl', side_effect=[ValueError('synthetic'), None] if failing == 'ctl' else None), patch.object(m, 'health', side_effect=[ValueError('synthetic'), None] if failing == 'health' else None):
                with self.assertRaises(ValueError): m.apply(RAW, m.prepare(RAW, False), None, verify)
                self.assertEqual(write.call_args_list[-1].args, (m.ENV, RAW, None))
                verify.assert_called_with(m.parse(RAW))
    def test_rollback_failure_propagates_not_success(self):
        with patch.object(m, 'atomic_write'), patch.object(m, 'ctl', side_effect=ValueError('restart failed')), patch.object(m, 'health'):
            with self.assertRaises(ValueError): m.apply(RAW, m.prepare(RAW, False), None, Mock())

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.target = self.root / 'release'
        self.runtime = self.root / 'runtime'
        self.proc = self.root / 'proc'
        self.runtime.mkdir()
        self.values = {m.AUTH: 'true', m.BOOK: 'true', 'NODE_ENV': 'production', 'BUBBLEWASH_DISABLE_DEMO_LOGIN': 'true'}
        self.sha = 'a' * 40
        for name in ('src/app/api/health/route.ts', 'src/lib/auth.ts', 'src/lib/booking-policy.ts', '.next/BUILD_ID'):
            path = self.target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic fixture')
        (self.runtime / 'current-release').write_text(f'sha={self.sha}\npath={self.target}\n')
        self.digest = m.source_fingerprint(self.target)
        for pid in (100, 101):
            folder = self.proc / str(pid)
            folder.mkdir(parents=True)
            (folder / 'cwd').symlink_to(self.target)
            (folder / 'exe').symlink_to(self.root / 'node')
            (folder / 'cgroup').write_bytes(b'0::/service')
            (folder / 'environ').write_bytes(b'\0'.join(f'{k}={v}'.encode() for k,v in self.values.items()))
        self.props = f'LoadState=loaded\nActiveState=active\nMainPID=100\nWorkingDirectory={self.target}\nEnvironmentFiles={m.ENV} (ignore_errors=no)'
        for name, value in [('RUNTIME', self.runtime), ('CURRENT', self.target), ('PROC', self.proc)]:
            context = patch.object(m, name, value); context.start(); self.addCleanup(context.stop)
        self.ctl = patch.object(m, 'ctl', return_value=self.props).start()
        self.command = patch.object(m, 'command', return_value='LISTEN users:(("node",pid=101,fd=22))').start()
        self.addCleanup(patch.stopall)
    def verify(self):
        m.verify_runtime(self.sha, self.digest, self.values)
    def test_verified_runtime(self): self.verify()
    def test_wrong_marker(self):
        (self.runtime / 'current-release').write_text('sha=bad\npath=/wrong\n')
        with self.assertRaises(ValueError): self.verify()
    def test_wrong_source(self):
        (self.target / 'src/lib/booking-policy.ts').write_text('changed')
        with self.assertRaises(ValueError): self.verify()
    def test_wrong_main_directory(self):
        path = self.proc / '100/cwd'; path.unlink(); path.symlink_to(self.root)
        with self.assertRaises(ValueError): self.verify()
    def test_wrong_listener_cgroup(self):
        (self.proc / '101/cgroup').write_bytes(b'0::/other')
        with self.assertRaises(ValueError): self.verify()
    def test_wrong_runtime_env(self):
        (self.proc / '101/environ').write_bytes(b'NODE_ENV=production')
        with self.assertRaises(ValueError): self.verify()
    def test_unsafe_mode_even_when_config_matches(self):
        self.values['NODE_ENV'] = 'development'
        for pid in (100, 101):
            (self.proc / str(pid) / 'environ').write_bytes(b'\0'.join(f'{k}={v}'.encode() for k,v in self.values.items()))
        with self.assertRaises(ValueError): self.verify()
    def test_ambiguous_listener(self):
        self.command.return_value = 'pid=101 pid=102'
        with self.assertRaises(ValueError): self.verify()
    def test_wrong_unit_file(self):
        self.ctl.return_value = self.props.replace(str(m.ENV), '/wrong')
        with self.assertRaises(ValueError): self.verify()

class HealthTests(unittest.TestCase):
    def test_only_pure_health_and_exact_body(self):
        with patch.object(m, 'command', return_value='{"ok":true,"service":"Bubble Wash","status":"alive"}\n200') as call:
            m.health()
            self.assertEqual(call.call_args.args[0][-1], 'http://127.0.0.1:3000/api/health')
    def test_redirect_and_wrong_json_rejected(self):
        for response in ('{}\n302', '{}\n200', 'not json\n200'):
            with patch.object(m, 'command', return_value=response), patch.object(m.time, 'sleep'):
                with self.assertRaises(ValueError): m.health()

if __name__ == '__main__': unittest.main()
