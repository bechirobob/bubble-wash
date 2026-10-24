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



class ConfigModeRepair(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.config=self.root/'config';self.config.mkdir(mode=0o775);self.config.chmod(0o775)
        self.child=self.config/'bubblewash';self.child.mkdir(mode=0o700)
        self.env=self.child/'env';self.env.write_bytes(b'UNCHANGED=synthetic');self.env.chmod(0o600)
        for name,value in (('ENV',self.env),('CONFIG_PARENT',self.config)):
            p=patch.object(m,name,value);p.start();self.addCleanup(p.stop)
    def repair(self,unchanged=lambda:None):m.repair_config_directory(os.getuid(),unchanged)
    def test_changes_only_mode_preserves_owner_group_inode_and_descendants(self):
        before=self.config.stat();child=m.identity(self.child.stat());env=m.identity(self.env.stat())
        with patch.object(m.os,'read',side_effect=AssertionError('no content read')):self.repair()
        after=self.config.stat();self.assertEqual(after.st_mode&0o7777,0o755)
        for field in ('st_uid','st_gid','st_ino','st_dev','st_nlink'):self.assertEqual(getattr(before,field),getattr(after,field))
        self.assertEqual(child,m.identity(self.child.stat()));self.assertEqual(env,m.identity(self.env.stat()))
        self.assertEqual(self.env.read_bytes(),b'UNCHANGED=synthetic')
    def test_wrong_prestate_symlink_attributes_owner_and_uid_fail_before_chmod(self):
        self.config.chmod(0o755)
        with patch.object(m.os,'fchmod') as change,self.assertRaises(ValueError):self.repair()
        change.assert_not_called();self.config.chmod(0o775)
        with patch.object(m.os,'listxattr',return_value=['system.posix_acl_access']),patch.object(m.os,'fchmod') as change,self.assertRaises(ValueError):self.repair()
        change.assert_not_called()
        with patch.object(m.os,'geteuid',return_value=os.getuid()+1),patch.object(m.os,'fchmod') as change,self.assertRaises(ValueError):self.repair()
        change.assert_not_called()
        real=self.root/'real';self.config.rename(real);self.config.symlink_to(real,target_is_directory=True)
        with patch.object(m.os,'fchmod') as change,self.assertRaises(ValueError):self.repair()
        change.assert_not_called()
    def test_before_change_drift_never_chmods_replacement(self):
        old=self.root/'old'
        def drift():self.config.rename(old);self.config.mkdir(mode=0o775)
        with patch.object(m.os,'fchmod') as change,self.assertRaises(ValueError):self.repair(drift)
        change.assert_not_called();self.assertEqual(old.stat().st_mode&0o7777,0o775)
    def test_post_change_binding_drift_is_uncertain_not_success_or_rollback(self):
        real=os.fchmod;old=self.root/'old'
        def change(fd,mode):
            real(fd,mode);self.config.rename(old);self.config.mkdir(mode=0o775)
        with patch.object(m.os,'fchmod',side_effect=change),self.assertRaises(ValueError):self.repair()
        self.assertEqual(old.stat().st_mode&0o7777,0o755)
    def test_existing_group_preserved_not_reassigned(self):
        source=(ROOT/'ops/install-research-email.py').read_text()
        helper=source[source.index('def repair_config_directory'):source.index('def main(')]
        self.assertNotIn('chown',helper);self.assertNotIn('app_gid',helper)
        self.assertIn('before.st_gid',helper)


class PrivilegeBoundary(unittest.TestCase):
    def test_root_lock_then_drop_before_secret_service_or_file_operations(self):
        from types import SimpleNamespace
        import contextlib
        import io
        calls = []
        @contextlib.contextmanager
        def lock(*args):
            self.assertEqual(calls, [])
            calls.append('lock')
            def unchanged():self.assertEqual(calls[:4], ['lock','groups','gid','uid'])
            yield unchanged
        class Input:
            def read(inner, size):
                self.assertEqual(calls,['lock','groups','gid','uid','repair']);return KEY
        with patch.object(m.os, 'geteuid', side_effect=[0, 1000]), \
             patch.object(m.os, 'getuid', return_value=1000), \
             patch.object(m.os, 'uname', side_effect=AssertionError('OS hostname is not the authenticated tailnet identity')), \
             patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1000, pw_gid=1000)), \
             patch.object(m.os, 'setgroups', side_effect=lambda x: calls.append('groups')), \
             patch.object(m.os, 'setgid', side_effect=lambda x: calls.append('gid')), \
             patch.object(m.os, 'setuid', side_effect=lambda x: calls.append('uid')), \
             patch.object(m, 'deployment_lock', side_effect=lock), \
             patch.object(m, 'repair_config_directory', side_effect=lambda *args: calls.append('repair')), \
             patch.object(m, 'install', return_value='installed-disabled'), \
             patch.object(m.subprocess, 'run', return_value=SimpleNamespace(stdout=b'LoadState=loaded\nEnvironmentFiles=/home/ubuntu/.config/bubblewash/env (ignore_errors=no)\n')) as run, \
             patch.object(m.sys, 'argv', ['installer']), \
             patch.object(m.sys, 'stdin', SimpleNamespace(buffer=Input())), \
             contextlib.redirect_stdout(io.StringIO()):
            m.main(repair_config_parent=True)
        self.assertEqual(run.call_args.args[0][0], '/usr/bin/systemctl')
        self.assertEqual(run.call_args.kwargs['env']['PATH'], '/usr/bin:/bin')

    def test_drop_failure_closes_lock_without_secret_or_app_access(self):
        import contextlib
        from types import SimpleNamespace
        events=[]
        @contextlib.contextmanager
        def lock(*args):
            events.append('lock')
            try:yield lambda:None
            finally:events.append('closed')
        with patch.object(m.os,'geteuid',return_value=0),patch.object(m.sys,'argv',['installer']),patch.object(m.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1000,pw_gid=1000)),patch.object(m,'deployment_lock',side_effect=lock),patch.object(m.os,'setgroups'),patch.object(m.os,'setgid'),patch.object(m.os,'setuid',side_effect=PermissionError),patch.object(m.sys,'stdin',None),patch.object(m,'install') as install,patch.object(m.subprocess,'run') as run:
            with self.assertRaises(PermissionError):m.main()
        install.assert_not_called();run.assert_not_called();self.assertEqual(events,['lock','closed'])

    def test_nonroot_refused_before_secret_read_or_app_access(self):
        with patch.object(m.os, 'geteuid', return_value=1000), patch.object(m.sys, 'stdin', None), patch.object(m, 'deployment_lock') as lock:
            with self.assertRaises(ValueError): m.main()
        lock.assert_not_called()


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
            self.assertEqual(argv[:3], ['tailscale', 'ssh', 'root@hermes'])
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

    def test_explicit_repair_boolean_in_actual_emitted_program_and_invalid_refusal(self):
        import contextlib,io,shlex
        from types import SimpleNamespace
        spec=importlib.util.spec_from_file_location('repair_transport',ROOT/'ops/transport-research-email.py');t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
        for flag in (None,'false','true'):
            expected=flag=='true'
            source=('def main(repair_config_parent=False):\n assert repair_config_parent is '+repr(expected)+'\n print("installed-disabled")\n').encode()
            def run(argv,**kwargs):
                self.assertNotIn(KEY.decode(),repr(argv));self.assertEqual(kwargs['input'],KEY)
                self.assertNotIn('REPAIR_CONFIG_PARENT',os.environ)
                command=shlex.split(argv[3]);self.assertEqual(command[:4],['/usr/bin/python3','-I','-B','-c'])
                output=io.StringIO()
                with contextlib.redirect_stdout(output):exec(command[4],{})
                return SimpleNamespace(returncode=0,stdout=output.getvalue().encode(),stderr=b'')
            env={'BUBBLEWASH_RESEARCH_RESEND_KEY':KEY.decode()}
            if flag is not None:env['REPAIR_CONFIG_PARENT']=flag
            with patch.dict(os.environ,env,clear=True),patch.object(t.Path,'read_bytes',return_value=source),patch.object(t.subprocess,'run',side_effect=run),contextlib.redirect_stdout(io.StringIO()):t.main()
        with patch.dict(os.environ,{'BUBBLEWASH_RESEARCH_RESEND_KEY':KEY.decode(),'REPAIR_CONFIG_PARENT':'yes'},clear=True),patch.object(t.subprocess,'run') as run:
            with self.assertRaises(ValueError):t.main()
        run.assert_not_called()
        workflow=(ROOT/'.github/workflows/install-research-email.yml').read_text()
        self.assertIn('default: false',workflow);self.assertIn('REPAIR_CONFIG_PARENT: ${{ inputs.repair_config_parent }}',workflow)



if __name__ == '__main__':
    unittest.main()
