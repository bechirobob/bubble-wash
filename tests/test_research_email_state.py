import contextlib
import errno
import builtins
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
i=load('installer','ops/install-research-email.py');c=load('checker','ops/check-research-email-state.py')

class ReadOnlyState(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.parent=self.root/'config';self.parent.mkdir(mode=0o700)
        self.env=self.parent/'env';self.raw=b'UNRELATED=untouched\nBUBBLEWASH_RESEARCH_RESEND_KEY=re_SYNTHETIC_ONLY_123456789\nBUBBLEWASH_RESEARCH_EMAIL_ENABLED=false\n'
        self.env.write_bytes(self.raw);self.env.chmod(0o600)
        self.bind=patch.object(i,'ENV',self.env);self.bind.start();self.addCleanup(self.bind.stop)
        self.state=c.result();self.state['appIdentityReady']=True
    def inspect(self):
        c.inspect_file(i,os.getuid(),lambda:None,self.state);return self.state
    def test_present_disabled_and_absent_preserve_bytes_mode_and_inode(self):
        before=self.env.stat();value=self.inspect()
        self.assertTrue(value['dedicatedKeyPresent']);self.assertTrue(value['emailFlagDisabled']);self.assertTrue(value['bindingStable'])
        self.assertEqual(self.env.read_bytes(),self.raw);self.assertEqual(i.identity(before),i.identity(self.env.stat()))
        self.assertNotIn('re_SYNTHETIC',json.dumps(value))
        self.env.write_bytes(b'UNRELATED=untouched\n');value=self.inspect()
        self.assertFalse(value['dedicatedKeyPresent']);self.assertFalse(value['emailFlagDisabled'])
    def test_parent_write_ineligible_is_separate_from_safe_snapshot(self):
        self.parent.chmod(0o720);value=self.inspect()
        self.assertTrue(value['parentGuardChecked']);self.assertFalse(value['parentGuardEligible'])
        self.assertTrue(value['bindingStable']);self.assertTrue(value['dedicatedKeyPresent'])
        self.assertEqual(stat.S_IMODE(self.parent.stat().st_mode),0o720)
    def test_unsafe_file_blocks_before_read(self):
        self.env.chmod(0o640)
        with patch.object(c.os,'read') as read,self.assertRaises(ValueError):self.inspect()
        read.assert_not_called();self.assertIsNone(self.state['dedicatedKeyPresent'])
    def test_links_and_attributes_rejected(self):
        link=self.parent/'link';os.link(self.env,link)
        with self.assertRaises(ValueError):self.inspect()
        link.unlink()
        with patch.object(c.os,'listxattr',return_value=['synthetic']),self.assertRaises(ValueError):self.inspect()
        real=self.parent/'real';self.env.rename(real);self.env.symlink_to(real)
        with self.assertRaises(OSError):self.inspect()
    def test_parse_failure_and_binding_drift_never_claim_state(self):
        self.env.write_bytes(b'BAD FORMAT\n')
        with self.assertRaises(ValueError):self.inspect()
        self.assertFalse(self.state['parseReady']);self.assertIsNone(self.state['dedicatedKeyPresent'])
        self.env.write_bytes(self.raw)
        def drift():self.env.write_bytes(b'CHANGED=yes\n')
        with self.assertRaises(ValueError):c.inspect_file(i,os.getuid(),drift,self.state)
        self.assertFalse(self.state['bindingStable']);self.assertIsNone(self.state['dedicatedKeyPresent'])
    def test_no_install_write_or_secret_input_calls(self):
        with patch.object(i,'install',side_effect=AssertionError('mutation')),patch.object(i,'updated',side_effect=AssertionError('mutation')),patch.object(c.sys,'stdin',None):
            self.inspect()
    def test_exact_output_schema_rejects_private_values(self):
        for edit in ({'key':'SECRET'},{'dedicatedKeyPresent':'re_SECRET'},{'parentGuardEligible':1}):
            with self.assertRaises(ValueError):c.validate({**c.result(),**edit})
    def test_readonly_parser_preserves_existing_strict_grammar(self):
        self.assertEqual(c.parse_environment(b'A="one"\nB=two\n'),{b'A':b'one',b'B':b'two'})
        for raw in (b'A=1\nA=2',b'export A=1',b'A=`secret`',b'A=\\value'):
            with self.assertRaises(ValueError):c.parse_environment(raw)
    def test_uid_drop_precedes_app_paths_and_failures_emit_only_schema(self):
        events=[]
        def run(installer,uid,state,unchanged):
            self.assertEqual(events,['lock','groups','gid','uid']);raise RuntimeError('re_SECRET /private')
        @contextlib.contextmanager
        def lock(installer,uid,state):
            self.assertEqual(events,[]);events.append('lock')
            state.update(dict.fromkeys(c.LOCK_FIELDS,True))
            def unchanged():self.assertEqual(events,['lock','groups','gid','uid'])
            yield unchanged
        output=io.StringIO()
        with patch.object(c,'observed_lock',side_effect=lock),patch.object(c.os,'geteuid',side_effect=[0,1000]),patch.object(c.os,'getuid',return_value=1000),patch.object(c.os,'uname',side_effect=AssertionError('OS hostname is not the authenticated tailnet identity')),patch.object(c.sys,'argv',['checker']),patch.object(c.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1000,pw_gid=1000)),patch.object(c.os,'setgroups',side_effect=lambda _:events.append('groups')),patch.object(c.os,'setgid',side_effect=lambda _:events.append('gid')),patch.object(c.os,'setuid',side_effect=lambda _:events.append('uid')),patch.object(c,'run',side_effect=run),contextlib.redirect_stdout(output):c.main(i)
        value=json.loads(output.getvalue());c.validate(value);self.assertTrue(value['appIdentityReady']);self.assertIsNone(value['dedicatedKeyPresent']);self.assertNotIn('SECRET',output.getvalue())
    def test_failed_uid_drop_does_not_read_env_and_releases_lock(self):
        events=[]
        @contextlib.contextmanager
        def lock(installer,uid,state):
            events.append('lock');state.update(dict.fromkeys(c.LOCK_FIELDS,True))
            try:yield lambda:None
            finally:events.append('closed')
        output=io.StringIO()
        with patch.object(c.os,'geteuid',return_value=0),patch.object(c.sys,'argv',['checker']),patch.object(c.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1000,pw_gid=1000)),patch.object(c,'observed_lock',side_effect=lock),patch.object(c.os,'setgroups'),patch.object(c.os,'setgid'),patch.object(c.os,'setuid',side_effect=PermissionError),patch.object(c,'run') as run,contextlib.redirect_stdout(output):c.main(i)
        run.assert_not_called();self.assertEqual(events,['lock','closed'])
        value=json.loads(output.getvalue());self.assertFalse(value['appIdentityReady']);self.assertIsNone(value['dedicatedKeyPresent'])

    def test_nonroot_refused_before_app_paths(self):
        output=io.StringIO()
        with patch.object(c.os,'geteuid',return_value=1000),patch.object(c,'run') as run,contextlib.redirect_stdout(output):c.main(i)
        run.assert_not_called();value=json.loads(output.getvalue())
        self.assertFalse(value['appIdentityReady']);self.assertIsNone(value['dedicatedKeyPresent'])

    def test_workflow_has_no_provider_key_and_transport_no_private_input(self):
        workflow=(ROOT/'.github/workflows/research-email-state.yml').read_text();transport=(ROOT/'ops/transport-research-email-state.py').read_text()
        self.assertNotIn('RESEND_KEY',workflow);self.assertNotIn('RESEND_KEY',transport);self.assertNotIn('install(',transport)
        self.assertIn('group: bubblewash-production',workflow);self.assertIn('limit=4096',transport);self.assertIn("'HOME':home",transport)


class LockDiagnostics(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.runtime=Path(self.tmp.name);self.runtime.chmod(0o700)
        self.lock=self.runtime/'deploy.lock';self.lock.write_bytes(b'');self.lock.chmod(0o600)
        self.binding=patch.object(i,'RUNTIME',self.runtime);self.binding.start();self.addCleanup(self.binding.stop)
        self.state=c.result()
    def observe(self):
        with c.observed_lock(i,os.getuid(),self.state) as unchanged:unchanged()
    def test_success_matches_original_and_changes_no_metadata(self):
        before=(i.identity(self.runtime.stat()),i.identity(self.lock.stat()))
        with i.deployment_lock(self.runtime,os.getuid()) as unchanged:unchanged()
        self.observe();self.assertTrue(all(self.state[k] is True for k in c.LOCK_FIELDS))
        self.assertEqual(before,(i.identity(self.runtime.stat()),i.identity(self.lock.stat())))
    def test_open_failure_is_precise_and_remaining_unknown(self):
        real=os.open
        def guarded(path,*a,**kw):
            if path=='deploy.lock':raise PermissionError(errno.EACCES,'PRIVATE /secret username')
            return real(path,*a,**kw)
        with patch.object(c.os,'open',side_effect=guarded),self.assertRaises(PermissionError):self.observe()
        self.assertEqual(self.state['lockFailure'],'permission-denied');self.assertFalse(self.state['lockFileOpened']);self.assertTrue(self.state['lockDirectoryModeSafe'])
        self.assertIsNone(self.state['lockFileOwnerSafe']);self.assertIsNone(self.state['lockAcquired'])
        self.assertNotIn('PRIVATE',json.dumps(c.validate(self.state)))
    def test_directory_mode_guard_still_rejects(self):
        self.runtime.chmod(0o720)
        for check in (lambda:i.deployment_lock(self.runtime,os.getuid()),lambda:c.observed_lock(i,os.getuid(),self.state)):
            with self.assertRaises(ValueError):
                with check():pass
        self.assertFalse(self.state['lockDirectoryModeSafe']);self.assertIsNone(self.state['lockFileOpened'])
    def test_file_mode_single_link_and_symlink_guards(self):
        self.lock.chmod(0o620)
        with self.assertRaises(ValueError):self.observe()
        self.assertFalse(self.state['lockFileModeSafe']);self.assertIsNone(self.state['lockAcquired'])
        self.lock.chmod(0o600);os.link(self.lock,self.runtime/'other');self.state=c.result()
        with self.assertRaises(ValueError):self.observe()
        self.assertFalse(self.state['lockFileSingleLink'])
        (self.runtime/'other').unlink();self.lock.unlink();self.lock.symlink_to('/dev/null');self.state=c.result()
        with self.assertRaises(OSError):self.observe()
        self.assertFalse(self.state['lockFileOpened'])
    def test_contention_and_binding_drift_not_conflated(self):
        with patch.object(i.fcntl,'flock',side_effect=BlockingIOError(errno.EAGAIN,'PRIVATE')),self.assertRaises(BlockingIOError):self.observe()
        self.assertFalse(self.state['lockAcquired']);self.assertIsNone(self.state['lockBindingStable'])
        self.state=c.result()
        with c.observed_lock(i,os.getuid(),self.state) as unchanged:
            self.lock.rename(self.runtime/'old');self.lock.write_bytes(b'')
            with self.assertRaises(ValueError):unchanged()
        self.assertTrue(self.state['lockAcquired']);self.assertFalse(self.state['lockBindingStable'])
    def test_foreign_owner_and_nonregular_refused(self):
        real=os.fstat
        def foreign(fd):
            v=real(fd);return types.SimpleNamespace(st_uid=999999,st_mode=v.st_mode)
        with patch.object(c.os,'fstat',side_effect=foreign),self.assertRaises(ValueError):self.observe()
        self.assertFalse(self.state['lockDirectoryOwnerSafe'])
        self.lock.unlink();self.lock.mkdir();self.state=c.result()
        with self.assertRaises(ValueError):self.observe()
        self.assertFalse(self.state['lockFileRegular'])
    def test_lock_descriptors_readonly_cloexec_and_no_content_reads(self):
        real=os.open;fds=[]
        def opening(path,flags,*args,**kwargs):
            self.assertFalse(flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC))
            self.assertTrue(flags & os.O_CLOEXEC)
            fd=real(path,flags,*args,**kwargs);fds.append(fd)
            self.assertFalse(os.get_inheritable(fd));return fd
        with patch.object(c.os,'open',side_effect=opening),patch.object(c.os,'read',side_effect=AssertionError('lock content read')):
            self.observe()
            with i.deployment_lock(self.runtime,os.getuid()) as unchanged:unchanged()
        self.assertEqual(len(fds),4)
        for fd in fds:
            with self.assertRaises(OSError):os.fstat(fd)

    def test_fixed_failure_allowlist_and_consistency(self):
        for error,expected in ((PermissionError(errno.EPERM,'SECRET'),'permission-denied'),(FileNotFoundError(errno.ENOENT,'SECRET'),'missing'),(OSError(errno.ELOOP,'SECRET'),'symlink'),(BlockingIOError(errno.EAGAIN,'SECRET'),'busy'),(ValueError('SECRET'),'metadata-guard'),(RuntimeError('SECRET'),'other')):
            state=c.result();c.lock_failure(state,error);self.assertEqual(state['lockFailure'],expected)
            c.validate(state);self.assertNotIn('SECRET',json.dumps(state))
        for edit in ({'lockFailure':'PRIVATE'},{'deploymentLockReady':True},{'bindingStable':True}):
            with self.assertRaises(ValueError):c.validate({**c.result(),**edit})
        self.lock.unlink()
        with self.assertRaises(FileNotFoundError):self.observe()
        self.assertEqual(self.state['lockFailure'],'missing')

    def test_private_types_rejected_and_unknown_not_false(self):
        self.assertTrue(all(c.result()[k] is None for k in c.LOCK_FIELDS))
        for value in ('/private',1000,{'mode':384}):
            with self.assertRaises(ValueError):c.validate({**c.result(),'lockFileOwnerSafe':value})


class Transport(unittest.TestCase):
    def test_actual_transport_bounded_public_program_clean_environment_and_fixed_output(self):
        t=load('state_transport','ops/transport-research-email-state.py');calls=[];real_exec=builtins.exec
        expected=c.result();expected['appIdentityReady']=True
        def bounded(args,data,**kw):
            calls.append((args,data,kw));compile(data,'<emitted-checker>','exec')
            self.assertEqual(args,['/usr/local/bin/tailscale','ssh','root@hermes','/usr/bin/python3 -I -B -'])
            self.assertEqual(kw['limit'],4096);self.assertEqual(kw['timeout'],60)
            self.assertEqual(set(kw['env']),{'PATH','LC_ALL','HOME'})
            self.assertNotIn(b're_SYNTHETIC',data);self.assertNotIn('SECRET',repr(kw))
            return json.dumps(expected).encode()
        def execute(code,scope):
            if scope.get('__name__')=='facts':scope.update(bounded=bounded,strict_json=json.loads)
            else:real_exec(code,scope)
        env={'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_SHA':'a'*40,'REVIEWED_SHA':'a'*40,'HOME':'/synthetic/runner','BUBBLEWASH_RESEARCH_RESEND_KEY':'re_SYNTHETIC_SECRET','GH_TOKEN':'SECRET'}
        output=io.StringIO()
        with patch.dict(os.environ,env,clear=True),patch.object(builtins,'exec',side_effect=execute),contextlib.redirect_stdout(output):t.main()
        self.assertEqual(len(calls),1);self.assertEqual(json.loads(output.getvalue()),expected)
        self.assertNotIn('SECRET',output.getvalue())

if __name__=='__main__':unittest.main()
