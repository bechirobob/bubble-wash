import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer', ROOT / 'ops/install-research-email.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
KEY = b're_' + b'SYNTHETIC_TEST_ONLY_' * 2


class Transform(unittest.TestCase):
    def test_preserves_all_original_bytes_and_disables(self):
        for raw in (b'', b'# comment\nA=one\n', b'A=one', b'A="two words"\r\n; note\r\n'):
            result = m.updated(raw, KEY)
            self.assertTrue(result.startswith(raw))
            self.assertTrue(result.endswith(b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=false\n'))
            self.assertEqual(m.updated(result, KEY), result)

    def test_refuses_existing_key_or_flag_conflicts(self):
        for raw in (b'BUBBLEWASH_RESEARCH_RESEND_KEY=old\n', b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=true\n',
                    b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=false\n',
                    b'BUBBLEWASH_RESEARCH_RESEND_KEY=' + KEY + b'\nBUBBLEWASH_RESEARCH_EMAIL_ENABLED=true\n'):
            with self.assertRaises(ValueError):
                m.updated(raw, KEY)

    def test_rejects_unsafe_format_and_boundaries(self):
        for raw in (b'export A=value', b'A=one\nA=two', b'A="one', b'A=one\\\n', b'A=\x00', b'x'*65537):
            with self.assertRaises(ValueError):
                m.updated(raw, KEY)
        for key in (b'', b're_short', KEY+b'\n', KEY+b"'", b're_'+b'x'*201):
            with self.assertRaises(ValueError):
                m.updated(b'A=one\n', key)


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.parent = self.base / '.config' / 'bubblewash'
        self.parent.mkdir(parents=True, mode=0o700)
        self.env = self.parent / 'env'
        self.env.write_bytes(b'# retained\nEXISTING=unchanged\n')
        self.env.chmod(0o600)
        self.raw = self.env.read_bytes()
        self.uid = os.getuid()
        self.runtime = self.base / 'runtime'
        self.runtime.mkdir(mode=0o700)
        (self.runtime / 'deploy.lock').touch(mode=0o600)

    def tearDown(self):
        self.tmp.cleanup()

    def test_atomic_install_preserves_mode_owner_and_idempotency(self):
        before = self.env.stat()
        with m.deployment_lock(self.runtime, self.uid) as guard:
            self.assertEqual(m.install(self.env, KEY, self.uid, guard), 'installed-disabled')
        after = self.env.stat()
        self.assertEqual((before.st_uid, before.st_gid, before.st_mode), (after.st_uid, after.st_gid, after.st_mode))
        self.assertTrue(self.env.read_bytes().startswith(self.raw))
        with m.deployment_lock(self.runtime, self.uid) as guard:
            self.assertEqual(m.install(self.env, KEY, self.uid, guard), 'already-installed-disabled')
        self.assertEqual(self.env.stat().st_ino, after.st_ino)
        self.assertEqual(list(self.parent.iterdir()), [self.env])

    def test_refuses_symlink_hardlink_and_readable_mode(self):
        real = self.parent / 'real'
        self.env.rename(real)
        self.env.symlink_to(real)
        with self.assertRaises((ValueError, OSError)):
            m.install(self.env, KEY, self.uid, lambda: None)
        self.env.unlink()
        os.link(real, self.env)
        with self.assertRaises(ValueError):
            m.install(self.env, KEY, self.uid, lambda: None)
        self.env.unlink()
        real.rename(self.env)
        self.env.chmod(0o644)
        with self.assertRaises(ValueError):
            m.install(self.env, KEY, self.uid, lambda: None)
        self.assertEqual(self.env.read_bytes(), self.raw)

    def test_lock_conflict_and_lock_replacement_fail_closed(self):
        with m.deployment_lock(self.runtime, self.uid) as guard:
            with self.assertRaises(BlockingIOError):
                with m.deployment_lock(self.runtime, self.uid):
                    pass
            (self.runtime / 'deploy.lock').unlink()
            (self.runtime / 'deploy.lock').touch(mode=0o600)
            with self.assertRaises(ValueError):
                guard()

    def test_drift_aborts_before_replace_and_removes_temporary(self):
        calls = []
        def guard():
            calls.append(1)
            if len(calls) == 2:
                self.env.write_bytes(b'NEW=external-change\n')
        with self.assertRaises(ValueError):
            m.install(self.env, KEY, self.uid, guard)
        self.assertEqual(self.env.read_bytes(), b'NEW=external-change\n')
        self.assertEqual(list(self.parent.iterdir()), [self.env])

    def test_write_failure_keeps_original(self):
        with patch.object(m.os, 'replace', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):
                m.install(self.env, KEY, self.uid, lambda: None)
        self.assertEqual(self.env.read_bytes(), self.raw)
        self.assertEqual(list(self.parent.iterdir()), [self.env])

    def test_parent_swap_aborts_and_cleans_only_bound_directory(self):
        original_parent = self.parent.with_name('original')
        calls = []
        def guard():
            calls.append(1)
            if len(calls) == 2:
                self.parent.rename(original_parent)
                self.parent.mkdir(mode=0o700)
                self.env.write_bytes(b'OTHER=untouched\n')
                self.env.chmod(0o600)
        with self.assertRaises(ValueError):
            m.install(self.env, KEY, self.uid, guard)
        self.assertEqual(self.env.read_bytes(), b'OTHER=untouched\n')
        self.assertEqual((original_parent / 'env').read_bytes(), self.raw)
        self.assertEqual([p.name for p in original_parent.iterdir()], ['env'])

    def test_short_initial_read_aborts(self):
        with patch.object(m.os, 'read', return_value=b'EXISTING=short\n'):
            with self.assertRaises(ValueError):
                m.install(self.env, KEY, self.uid, lambda: None)
        self.assertEqual(self.env.read_bytes(), self.raw)

    def test_post_commit_lock_change_does_not_claim_success(self):
        calls = []
        def guard():
            calls.append(1)
            if len(calls) == 3:
                raise ValueError('synthetic lock drift after commit')
        with self.assertRaises(ValueError):
            m.install(self.env, KEY, self.uid, guard)
        self.assertEqual(len(calls), 3)
        self.assertTrue(self.env.read_bytes().startswith(self.raw))

    def test_acl_or_xattrs_abort_without_loss(self):
        with patch.object(m.os, 'listxattr', return_value=['system.posix_acl_access']):
            with self.assertRaises(ValueError):
                m.install(self.env, KEY, self.uid, lambda: None)
        self.assertEqual(self.env.read_bytes(), self.raw)


class PrivilegeBoundary(unittest.TestCase):
    def test_drop_before_lock_service_or_file_operations(self):
        from types import SimpleNamespace
        import contextlib
        import io
        calls = []
        @contextlib.contextmanager
        def lock(*args):
            self.assertEqual(calls, ['groups', 'gid', 'uid'])
            yield lambda: None
        with patch.object(m.os, 'geteuid', side_effect=[0, 1000]), \
             patch.object(m.os, 'getuid', return_value=1000), \
             patch.object(m.os, 'uname', return_value=SimpleNamespace(nodename='hermes')), \
             patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1000, pw_gid=1000)), \
             patch.object(m.os, 'setgroups', side_effect=lambda x: calls.append('groups')), \
             patch.object(m.os, 'setgid', side_effect=lambda x: calls.append('gid')), \
             patch.object(m.os, 'setuid', side_effect=lambda x: calls.append('uid')), \
             patch.object(m, 'deployment_lock', side_effect=lock), \
             patch.object(m, 'install', return_value='installed-disabled'), \
             patch.object(m.subprocess, 'run', return_value=SimpleNamespace(stdout=b'LoadState=loaded\nEnvironmentFiles=/home/ubuntu/.config/bubblewash/env (ignore_errors=no)\n')) as run, \
             patch.object(m.sys, 'argv', ['installer']), \
             patch.object(m.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(KEY))), \
             contextlib.redirect_stdout(io.StringIO()):
            m.main()
        self.assertEqual(run.call_args.args[0][0], '/usr/bin/systemctl')
        self.assertEqual(run.call_args.kwargs['env']['PATH'], '/usr/bin:/bin')


class Transport(unittest.TestCase):
    def test_secret_only_on_stdin_and_fixed_status(self):
        spec = importlib.util.spec_from_file_location('transport', ROOT / 'ops/transport-research-email.py')
        t = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(t)
        from types import SimpleNamespace
        import contextlib
        import io
        output = io.StringIO()
        def run(argv, **kwargs):
            self.assertNotIn(KEY.decode(), repr(argv))
            self.assertNotIn('BUBBLEWASH_RESEARCH_RESEND_KEY', os.environ)
            self.assertEqual(kwargs['input'], KEY)
            return SimpleNamespace(returncode=0, stdout=b'installed-disabled\n', stderr=b'')
        with patch.dict(os.environ, {'BUBBLEWASH_RESEARCH_RESEND_KEY': KEY.decode()}, clear=True), \
             patch.object(t.subprocess, 'run', side_effect=run), \
             patch.object(t.Path, 'read_bytes', return_value=b'print("installed-disabled")'), \
             contextlib.redirect_stdout(output):
            t.main()
        self.assertNotIn(KEY.decode(), output.getvalue())


if __name__ == '__main__':
    unittest.main()
