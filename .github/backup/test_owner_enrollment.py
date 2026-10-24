import importlib.util
import ast
import sys
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock
ROOT = Path(__file__).resolve().parents[2]
# Execute reviewed, pure helper definitions with the same shared namespace used
# by the emitted host program. Its __main__ block must not run during import.
ns = {'__name__':'private_enrollment_test'}
exec(compile((ROOT/'scripts/release-preflight.py').read_text(), 'preflight', 'exec'),ns)
exec(compile((ROOT/'scripts/owner-enrollment-source-contract.py').read_text(), 'source-contract', 'exec'),ns)
exec(compile((ROOT/'scripts/owner-enrollment-host.py').read_text(), 'host', 'exec'),ns)

SOURCE_MATCHES = ns['enrollment_source_matches']

class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); (self.root/'bubblewash-runtime').mkdir()
        (self.root/'bubblewash-runtime/deploy.lock').touch()
        self.inspection = {'ownerInspection':{'completed':True,'duplicatePresent':False,'configuredSenderCategory':'updates@bubblewash.co','personalMfaKeyReady':True},
            'configuration':{'productionMode':True,'demoDisabled':True,'staffAuthDisabled':False,'sqliteConfigured':True,'mfaRequired':False}, 'legacyImportAbsent':True,
            'backup':{k:True for k in ('statusAgeWithin30Hours','statusMetadataValid','receiptAgeWithin30Hours','receiptMetadataValid')}}
        self.envtext = 'NODE_ENV=production\nRESEND_API_KEY=private-key-fixture\nNODE_OPTIONS=untrusted-preload\n'
        self.process = Mock(returncode=0, pid=123)
        self.process.communicate.return_value = (json.dumps({'ok':True,'stage':'preflight','accountCreated':False,'resendConfigured':True,'officialSenderDomain':True,'mfaReady':True}), '')
        self.popen = Mock(return_value=self.process)
        self.patch = patch.dict(ns, {'pwd':SimpleNamespace(getpwnam=lambda _:SimpleNamespace(pw_uid=os.getuid())), 'HOME':self.root, 'CURRENT':self.root, 'release_pin_matches':lambda _:True,
             'enrollment_source_matches':lambda *_:True, 'collect':lambda *_:self.inspection,'bounded_text':lambda _:self.envtext})
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.sub = patch.object(ns['subprocess'],'Popen',self.popen); self.sub.start(); self.addCleanup(self.sub.stop)

    def run_mode(self,mode='check',approved=False):
        return ns['run_private_enrollment']('private-fixture@example.test','a'*40,'authorized-actor',mode,approved,{},'synthetic-owner-key')

    def test_check_invalid_child_output_is_fixed_and_non_mutating(self):
        for raw in ('', 'secret-token-fixture', '[]', 'null', 'true', '{"unexpected":"secret-token-fixture"}'):
            with self.subTest(raw=raw):
                self.process.communicate.return_value=(raw, 'secret-provider-body-fixture')
                self.assertEqual(self.run_mode(), {'ok':False, 'state':'check-child-invalid-output', 'accountCreated':False, 'retryPermitted':False})

    def test_timeout_check_and_send_keep_separate_fixed_states(self):
        for mode, expected in (('check','check-child-timeout'), ('send','outcome-uncertain-stop-inspect-privately')):
            with self.subTest(mode=mode):
                self.process.communicate.side_effect=[subprocess.TimeoutExpired('secret-command-fixture',45), ('','')]
                with patch.object(ns['os'], 'killpg') as kill:
                    result=self.run_mode(mode, mode=='send')
                self.assertEqual(result['state'],expected); self.assertFalse(result['retryPermitted'])
                if mode=='check': self.assertFalse(result['accountCreated'])
                kill.assert_called_once_with(123, ns['signal'].SIGTERM)
                self.assertNotIn('secret-',json.dumps(result))

    def test_launch_failure_and_post_child_lock_failure_track_boundary(self):
        diagnostic={}
        self.popen.side_effect=FileNotFoundError('secret-launch-detail')
        with self.assertRaises(FileNotFoundError):
            ns['run_private_enrollment']('fixture@example.test','a'*40,'actor','check',False,{},'synthetic-key',diagnostic=diagnostic)
        self.assertEqual(diagnostic,{'stage':'before-node'})
        self.popen.side_effect=None
        lock=self.root/'bubblewash-runtime/deploy.lock'
        def replace_lock(**_):
            lock.unlink(); lock.touch()
            return (json.dumps({'ok':True,'stage':'preflight'}),'')
        self.process.communicate.side_effect=replace_lock
        with self.assertRaises(ValueError):
            ns['run_private_enrollment']('fixture@example.test','a'*40,'actor','check',False,{},'synthetic-key',diagnostic=diagnostic)
        self.assertEqual(diagnostic,{'stage':'child-started'})

    def test_absolute_runuser_executes_with_restricted_path(self):
        # Exercise real executable lookup, not mocked Popen. Never switch users.
        self.run_mode()
        executable=self.popen.call_args.args[0][0]
        child_path=self.popen.call_args.kwargs['env']['PATH']
        self.assertEqual(executable,'/usr/sbin/runuser')
        self.assertEqual(child_path,'/usr/local/bin:/usr/bin:/bin')
        if not Path(executable).is_file():
            self.skipTest('The supported host executable /usr/sbin/runuser is absent on this test platform.')
        self.sub.stop()
        result=subprocess.run([executable,'--version'],env={'PATH':child_path},capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0)
        self.assertIn('runuser',result.stdout)

    def test_emitted_stream_runs_fixed_exception_branches_without_leaks(self):
        self.sub.stop()
        for mode in ('check','send'):
            env={**os.environ,'BUBBLEWASH_OWNER_RESEND_KEY':'synthetic-owner-key','OWNER_EMAIL':'private-fixture@example.test','EXPECTED_LIVE_SHA':'a'*40,'GITHUB_ACTOR':'actor','ENROLLMENT_MODE':mode,'DELIVERY_APPROVED':'true'}
            emitted=subprocess.run([sys.executable,'.github/backup/stream_owner_enrollment.py'],cwd=ROOT,env=env,capture_output=True,text=True,check=True)
            for stage in ('before-node','child-started'):
                with self.subTest(mode=mode,stage=stage):
                    # Execute the real generated exception handler, injecting only
                    # a deterministic boundary fault instead of host operations.
                    guard='\ndef run_private_enrollment(*args, diagnostic=None):\n    diagnostic["stage"] = ' + repr(stage) + '\n    raise RuntimeError("secret-token-fixture")\n'
                    marker='\n_diagnostic = {"stage":"before-node"}\n'
                    self.assertEqual(emitted.stdout.count(marker),1)
                    program=emitted.stdout.replace(marker,guard+marker)
                    result=subprocess.run([sys.executable,'-I','-B','-'],input=program,capture_output=True,text=True,cwd=self.root,env=env)
                    self.assertEqual(result.returncode,1); self.assertEqual(result.stderr,'')
                    value=json.loads(result.stdout)
                    if mode=='check':
                        expected='check-host-pre-node-failed' if stage=='before-node' else 'check-host-post-node-failed'
                        self.assertEqual(value,{'ok':False,'state':expected,'accountCreated':False,'retryPermitted':False})
                    else:
                        self.assertEqual(value,{'ok':False,'state':'outcome-uncertain-stop-inspect-privately','retryPermitted':False})
                    for secret in ('secret-token-fixture',env['OWNER_EMAIL'],env['BUBBLEWASH_OWNER_RESEND_KEY']):
                        self.assertNotIn(secret,result.stdout+result.stderr)

    def test_private_key_excludes_shared_transport(self):
        self.envtext += 'BUBBLEWASH_EMAIL_FROM=unapproved@example.test\nBUBBLEWASH_OWNER_RESEND_KEY=host-key-must-not-win\n'
        result=self.run_mode(); self.assertTrue(result['ok'])
        env=self.popen.call_args.kwargs['env']
        self.assertEqual(env['BUBBLEWASH_OWNER_RESEND_KEY'],'synthetic-owner-key')
        self.assertNotIn('RESEND_API_KEY',env); self.assertNotIn('BUBBLEWASH_EMAIL_FROM',env)
        self.assertEqual(result['transportScope'],'private-owner-only')
        self.popen.reset_mock()
        result=ns['run_private_enrollment']('private-fixture@example.test','a'*40,'actor','check',False,{})
        self.assertEqual(result['state'],'dedicated-owner-transport-required'); self.popen.assert_not_called()

    def test_absent_node_env_requires_exact_effective_production_proof(self):
        flags={k:'absent' for k in ns['LOGIN_FLAGS']}
        runtime={k:True for k in ('serviceActive','workingDirectoryMatchesCurrent','environmentFileMatchesExpected',
            'mainProcessDirectoryMatchesCurrent','uniqueListener','listenerDirectoryMatchesCurrent','listenerIsNode',
            'listenerSameServiceCgroup','listenerStableDuringRead','mainStableDuringRead')}
        runtime.update(mainProcessFlags={**flags,'productionModePresent':False,'productionMode':False},
                       listenerFlags={**flags,'productionModePresent':True,'productionMode':True})
        proof={'staffRestorationInspection':{'currentTargetStableDuringRead':True,'runtime':runtime}}
        check=ns['owner_production_proven']
        self.assertTrue(check({},proof)); self.assertFalse(check({'NODE_ENV':'development'},proof))
        self.assertFalse(check({'NODE_ENV':''},proof)); self.assertFalse(check({},{}))
        for key in list(runtime):
            saved=runtime[key]; runtime[key]=False if isinstance(saved,bool) else {}
            self.assertFalse(check({},proof),key); runtime[key]=saved
        runtime['mainProcessFlags'].update(productionModePresent=True,productionMode=False)
        self.assertFalse(check({},proof))
        runtime['mainProcessFlags'].update(productionModePresent=False,productionMode=False)
        runtime['listenerFlags']['productionMode']=False
        self.assertFalse(check({},proof)); runtime['listenerFlags']['productionMode']=True
        runtime['mainProcessFlags']['BUBBLEWASH_STAFF_AUTH_DISABLED']='other'
        runtime['listenerFlags']['BUBBLEWASH_STAFF_AUTH_DISABLED']='other'
        self.assertFalse(check({'BUBBLEWASH_STAFF_AUTH_DISABLED':'malformed'},proof))
        runtime['mainProcessFlags']['BUBBLEWASH_STAFF_AUTH_DISABLED']='absent'
        runtime['listenerFlags']['BUBBLEWASH_STAFF_AUTH_DISABLED']='true'
        self.assertFalse(check({},proof)); runtime['listenerFlags']['BUBBLEWASH_STAFF_AUTH_DISABLED']='absent'
        self.envtext='RESEND_API_KEY=shared-key-not-used\n'
        self.inspection.update(proof); self.inspection['configuration']['productionMode']=False
        self.assertTrue(self.run_mode()['ok'])
        self.assertEqual(self.popen.call_args.kwargs['env']['NODE_ENV'],'production')

    def test_default_check_never_confirms_recipient_for_send(self):
        result=self.run_mode(); self.assertTrue(result['ok']); self.assertFalse(result['accountCreated'])
        args,kwargs=self.popen.call_args
        self.assertEqual(args[0][-1],'--check'); self.assertNotIn('private-fixture',str(args))
        self.assertNotIn('NODE_OPTIONS',kwargs['env']); self.assertNotIn('BUBBLEWASH_OWNER_INVITE_CONFIRM',kwargs['env'])
        self.assertEqual(kwargs['env']['BUBBLEWASH_OWNER_INVITED_BY'],'github-actions:authorized-actor')
        self.assertNotIn('private-key',json.dumps(result))

    def test_unapproved_send_and_collision_do_not_spawn(self):
        self.assertEqual(self.run_mode('send')['state'],'delivery-approval-required'); self.popen.assert_not_called()
        self.inspection['ownerInspection']['duplicatePresent']=True
        self.assertEqual(self.run_mode('send',True)['state'],'private-preflight-blocked'); self.popen.assert_not_called()

    def test_existing_lock_is_noncreating_and_rejects_unsafe_objects(self):
        lock = self.root/'bubblewash-runtime/deploy.lock'
        lock.unlink()
        with self.assertRaises(OSError): self.run_mode()
        self.assertFalse(lock.exists()); self.popen.assert_not_called()
        target=self.root/'protected'; target.write_text('unchanged')
        for kind in ('symlink','fifo','hardlink','groupwrite'):
            if kind=='symlink': lock.symlink_to(target)
            elif kind=='fifo': os.mkfifo(lock)
            elif kind=='hardlink': os.link(target,lock)
            else: lock.touch(); lock.chmod(0o660)
            with self.assertRaises((OSError,ValueError)): self.run_mode()
            self.assertEqual(target.read_text(),'unchanged'); self.popen.assert_not_called()
            lock.unlink()

    def test_lock_replacement_during_preflight_blocks_child(self):
        lock=self.root/'bubblewash-runtime/deploy.lock'
        def replace_lock(*_):
            lock.unlink(); lock.touch()
            return self.inspection
        with patch.dict(ns,{'collect':replace_lock}):
            with self.assertRaises(ValueError): self.run_mode('send',True)
        self.popen.assert_not_called()

    def test_lock_identity_checked_after_child_before_success(self):
        lock=self.root/'bubblewash-runtime/deploy.lock'
        def replace_lock(**_):
            lock.unlink(); lock.touch()
            return (json.dumps({'ok':True,'stage':'invitation-created','delivery':'provider-accepted','accountActivated':False}),'')
        self.process.communicate.side_effect=replace_lock
        with self.assertRaises(ValueError): self.run_mode('send',True)
        self.assertEqual(self.popen.call_count,1)

    def test_personal_key_required_without_changing_global_mfa(self):
        self.envtext += 'BUBBLEWASH_ADMIN_MFA_REQUIRED=false\n'
        self.assertTrue(self.run_mode()['ok'])
        self.assertEqual(self.popen.call_args.kwargs['env']['BUBBLEWASH_ADMIN_MFA_REQUIRED'],'false')
        self.popen.reset_mock()
        self.inspection['ownerInspection']['personalMfaKeyReady'] = False
        self.assertEqual(self.run_mode()['state'],'private-preflight-blocked')
        self.popen.assert_not_called()

    def test_send_needs_known_sender_recent_backup_and_source_pin(self):
        self.inspection['ownerInspection']['configuredSenderCategory']='other-official-domain'
        self.inspection['ownerInspection']['configuredSenderCategory']='updates@bubblewash.co'
        self.inspection['backup']['receiptAgeWithin30Hours']=False
        self.assertEqual(self.run_mode('send',True)['state'],'verified-recent-backup-required'); self.popen.assert_not_called()
        with patch.dict(ns,{'enrollment_source_matches':lambda *_:False}):
            self.assertEqual(self.run_mode()['state'],'owner-source-pin-mismatch'); self.popen.assert_not_called()

    def test_send_records_only_fixed_provider_acceptance(self):
        self.process.communicate.return_value=(json.dumps({'ok':True,'stage':'invitation-created','delivery':'provider-accepted','accountActivated':False}), '')
        result=self.run_mode('send',True)
        self.assertTrue(result['ok']); self.assertFalse(result['accountActivated']); self.assertFalse(result['retryPermitted'])
        self.assertEqual(self.popen.call_args.kwargs['env']['BUBBLEWASH_OWNER_INVITE_CONFIRM'],'private-fixture@example.test')
        self.assertNotIn('private-fixture',json.dumps(result))

    def test_unexpected_output_never_forwarded_or_retried(self):
        self.process.communicate.return_value=('secret-token-fixture','secret-provider-body-fixture')
        result=self.run_mode('send',True)
        self.assertEqual(result['state'],'outcome-uncertain-stop-inspect-privately'); self.assertFalse(result['retryPermitted'])
        self.assertNotIn('secret-',json.dumps(result)); self.assertEqual(self.popen.call_count,1)

    def test_stream_quotes_recipient_and_declines_unapproved_send(self):
        # Temporarily use the real Popen for runner-only stream generation.
        self.sub.stop()
        env={**os.environ,'BUBBLEWASH_OWNER_RESEND_KEY':"synthetic'owner\\key",'OWNER_EMAIL':"quoted'fixture@example.test",'EXPECTED_LIVE_SHA':'a'*40,'GITHUB_ACTOR':'actor','ENROLLMENT_MODE':'check','DELIVERY_APPROVED':'false'}
        run=subprocess.run(['python3','.github/backup/stream_owner_enrollment.py'],cwd=ROOT,env=env,capture_output=True,text=True)
        self.assertEqual(run.returncode,0); compile(run.stdout,'<stream>','exec')
        env['ENROLLMENT_MODE']='send'
        run=subprocess.run(['python3','.github/backup/stream_owner_enrollment.py'],cwd=ROOT,env=env,capture_output=True,text=True)
        self.assertNotEqual(run.returncode,0); self.assertEqual(run.stdout,''); self.assertNotIn(env['OWNER_EMAIL'],run.stderr)

    def test_environment_drift_before_and_after_preflight_blocks_spawn(self):
        for values in ([self.envtext,'changed-sender'], [self.envtext,self.envtext,'changed-security-flag']):
            with patch.dict(ns,{'bounded_text':Mock(side_effect=values)}):
                result=self.run_mode('send',True)
            self.assertEqual(result['state'],'environment-drift'); self.popen.assert_not_called()

    def test_emitted_program_executes_entrypoint_without_spawning_on_failed_pin(self):
        self.sub.stop()
        env={**os.environ,'BUBBLEWASH_OWNER_RESEND_KEY':"synthetic'owner\\key",'OWNER_EMAIL':"quoted'fixture@example.test",'EXPECTED_LIVE_SHA':'a'*40,'GITHUB_ACTOR':'actor','ENROLLMENT_MODE':'check','DELIVERY_APPROVED':'false'}
        emitted=subprocess.run(['python3','.github/backup/stream_owner_enrollment.py'],cwd=ROOT,env=env,capture_output=True,text=True)
        self.assertEqual(emitted.returncode,0)
        guard="\nrelease_pin_matches = lambda _: False\ndef forbidden_spawn(*args, **kwargs):\n    raise AssertionError('Unexpected subprocess')\nsubprocess.Popen = forbidden_spawn\n"
        program=emitted.stdout.replace('\ntry:\n    _result = run_private_enrollment(',guard+'\ntry:\n    _result = run_private_enrollment(')
        # The exact emitted payload and positional arguments survive isolated stdin.
        # Fail before host inspection/spawn; exercise stdlib imports under a hostile cwd.
        (self.root/'base64.py').write_text("raise RuntimeError('UNTRUSTED IMPORT EXECUTED')")
        isolated_env={**os.environ,'PYTHONPATH':str(self.root)}
        run=subprocess.run([sys.executable,'-I','-B','-'],input=program,capture_output=True,text=True,
                           cwd=self.root,env=isolated_env)
        self.assertEqual(run.returncode,1)
        self.assertEqual(json.loads(run.stdout),{'ok':False,'state':'release-pin-mismatch','accountCreated':False})
        self.assertNotIn(env['OWNER_EMAIL'],run.stdout+run.stderr)
        self.assertNotIn(env['BUBBLEWASH_OWNER_RESEND_KEY'],run.stdout+run.stderr); self.assertEqual(run.stderr,'')
        unsafe=subprocess.run([sys.executable,'-B','-'],input=program,capture_output=True,text=True,
                              cwd=self.root,env=isolated_env)
        self.assertIn('UNTRUSTED IMPORT EXECUTED',unsafe.stderr)

    def test_host_stream_uses_stdlib_without_file_or_python_environment_dependencies(self):
        for relative in ('scripts/release-preflight.py','scripts/owner-enrollment-source-contract.py','scripts/owner-enrollment-host.py'):
            source=(ROOT/relative).read_text()
            self.assertNotIn('__file__',source)
            self.assertNotIn('os.environ',source)
            self.assertNotIn('sys.path',source)
            for node in ast.walk(ast.parse(source)):
                modules = [alias.name for alias in node.names] if isinstance(node,ast.Import) else [node.module] if isinstance(node,ast.ImportFrom) else []
                for name in modules:
                    self.assertIsNotNone(name)
                    self.assertIn(name.split('.')[0],sys.stdlib_module_names)

    def test_backup_ci_covers_all_enrollment_executable_inputs(self):
        source=(ROOT/'.github/workflows/backup-transport-checks.yml').read_text()
        paths=['.github/workflows/owner-enrollment.yml','scripts/owner-enrollment-host.py',
               'ops/owner-enrollment-source-pins.json','scripts/release-preflight.py','.github/workflows/release-preflight.yml','.github/backup/**']
        for path in paths:
            self.assertEqual(source.count('      - '+path+'\n'),2)

    def test_real_assembled_owner_source_and_dependency_pins_match(self):
        pins=json.loads((ROOT/'ops/owner-enrollment-source-pins.json').read_text())
        spec=importlib.util.spec_from_file_location('enrollment_source_check',ROOT/'ops/check-owner-enrollment-source.py')
        checker=importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)
        selected=checker.verify_runner_source(ROOT)
        self.assertEqual(SOURCE_MATCHES(ROOT,pins),selected=='historical-owner-v1')
        if selected=='reviewed-runner-only-v1':
            # Runner acceptance must not make the same app eligible for any
            # historical host enrollment selector or a new invented selector.
            for profile_name in ['historical-owner-v1', *ns['INTEGRATION_ENROLLMENT_PROFILE_SHA256'], selected]:
                with self.assertRaises((ValueError, KeyError)):
                    checker.check_source(ROOT, profile_name)
        elif selected!='historical-owner-v1':
            contract=json.loads((ROOT/'ops/owner-enrollment-integration-pins.json').read_text())
            profile=ns['load_integration_enrollment_profile'](contract,selected)
            self.assertTrue(ns['integration_enrollment_source_matches'](ROOT,profile,selected))
        pins['src/lib/mfa-encryption.ts']='0'*64
        self.assertFalse(SOURCE_MATCHES(ROOT,pins))

    def test_runner_only_candidate_rejects_changed_and_extra_source(self):
        spec=importlib.util.spec_from_file_location('runner_only_check',ROOT/'ops/check-owner-enrollment-source.py')
        checker=importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)
        if checker.verify_runner_source(ROOT) != 'reviewed-runner-only-v1':
            return  # Historical snapshots retain their independently tested path.
        copy=self.root/'runner-copy'
        shutil.copytree(ROOT,copy,ignore=shutil.ignore_patterns('.git','node_modules','.next','__pycache__'))
        self.assertEqual(checker.verify_runner_source(copy),'reviewed-runner-only-v1')
        target=copy/'src/lib/data-store.ts'; original=target.read_bytes()
        target.write_bytes(original+b'\n// changed\n')
        with self.assertRaises(ValueError): checker.verify_runner_source(copy)
        target.write_bytes(original)
        extra=copy/'src/unreviewed.ts'; extra.write_text('export {}')
        with self.assertRaises(ValueError): checker.verify_runner_source(copy)
        extra.unlink()
        target.unlink()
        with self.assertRaises((ValueError,FileNotFoundError)): checker.verify_runner_source(copy)

    def test_timeout_terminates_group_and_never_retries(self):
        self.process.communicate.side_effect=[subprocess.TimeoutExpired('private-operation',45), ('','')]
        with patch.object(ns['os'],'killpg') as kill:
            result=self.run_mode('send',True)
        kill.assert_called_once_with(123,ns['signal'].SIGTERM)
        self.assertEqual(self.popen.call_count,1); self.assertFalse(result['retryPermitted'])

    def test_release_drift_before_spawn_is_blocked(self):
        with patch.dict(ns,{'release_pin_matches':Mock(side_effect=[True,False])}):
            result=self.run_mode('send',True)
        self.assertEqual(result['state'],'release-or-source-drift'); self.popen.assert_not_called()

    def test_workflow_has_no_public_recipient_or_secret_outputs(self):
        source=(ROOT/'.github/workflows/owner-enrollment.yml').read_text()
        self.assertIn('default: check',source); self.assertIn('default: false',source)
        self.assertIn("tailscale ssh root@hermes 'python3 -I -B -'",source)
        self.assertNotIn("'python3 -B -'",source)
        self.assertIn('secrets.BUBBLEWASH_OWNER_EMAIL',source); self.assertNotIn('inputs.email',source)
        self.assertNotIn('upload-artifact',source); self.assertIn("github.ref == 'refs/heads/main'",source)
