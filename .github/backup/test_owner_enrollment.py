import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock
ROOT = Path(__file__).resolve().parents[2]
# Execute reviewed, pure helper definitions with the same shared namespace used
# by the emitted host program. Its __main__ block must not run during import.
ns = {'__name__':'private_enrollment_test'}
exec(compile((ROOT/'scripts/release-preflight.py').read_text(), 'preflight', 'exec'),ns)
exec(compile((ROOT/'scripts/owner-enrollment-host.py').read_text(), 'host', 'exec'),ns)

SOURCE_MATCHES = ns['enrollment_source_matches']

class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); (self.root/'bubblewash-runtime').mkdir()
        (self.root/'bubblewash-runtime/deploy.lock').touch()
        self.inspection = {'ownerInspection':{'completed':True,'duplicatePresent':False,'configuredSenderCategory':'updates@bubblewash.co'},
            'configuration':{'productionMode':True,'demoDisabled':True,'staffAuthDisabled':False,'sqliteConfigured':True,'mfaRequired':True}, 'legacyImportAbsent':True,
            'backup':{k:True for k in ('statusAgeWithin30Hours','statusMetadataValid','receiptAgeWithin30Hours','receiptMetadataValid')}}
        self.envtext = 'NODE_ENV=production\nRESEND_API_KEY=private-key-fixture\nNODE_OPTIONS=untrusted-preload\n'
        self.process = Mock(returncode=0, pid=123)
        self.process.communicate.return_value = (json.dumps({'ok':True,'stage':'preflight','accountCreated':False,'resendConfigured':True,'officialSenderDomain':True,'mfaReady':True}), '')
        self.popen = Mock(return_value=self.process)
        self.patch = patch.dict(ns, {'HOME':self.root, 'CURRENT':self.root, 'release_pin_matches':lambda _:True,
             'enrollment_source_matches':lambda *_:True, 'collect':lambda *_:self.inspection,'bounded_text':lambda _:self.envtext})
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.sub = patch.object(ns['subprocess'],'Popen',self.popen); self.sub.start(); self.addCleanup(self.sub.stop)

    def run_mode(self,mode='check',approved=False):
        return ns['run_private_enrollment']('private-fixture@example.test','a'*40,'authorized-actor',mode,approved,{})

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

    def test_send_needs_known_sender_recent_backup_and_source_pin(self):
        self.inspection['ownerInspection']['configuredSenderCategory']='other-official-domain'
        self.assertEqual(self.run_mode('send',True)['state'],'approved-public-sender-required'); self.popen.assert_not_called()
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
        env={**os.environ,'OWNER_EMAIL':"quoted'fixture@example.test",'EXPECTED_LIVE_SHA':'a'*40,'GITHUB_ACTOR':'actor','ENROLLMENT_MODE':'check','DELIVERY_APPROVED':'false'}
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
        env={**os.environ,'OWNER_EMAIL':"quoted'fixture@example.test",'EXPECTED_LIVE_SHA':'a'*40,'GITHUB_ACTOR':'actor','ENROLLMENT_MODE':'check','DELIVERY_APPROVED':'false'}
        emitted=subprocess.run(['python3','.github/backup/stream_owner_enrollment.py'],cwd=ROOT,env=env,capture_output=True,text=True)
        self.assertEqual(emitted.returncode,0)
        guard="\nrelease_pin_matches = lambda _: False\ndef forbidden_spawn(*args, **kwargs):\n    raise AssertionError('Unexpected subprocess')\nsubprocess.Popen = forbidden_spawn\n"
        program=emitted.stdout.replace('\ntry:\n    _result = run_private_enrollment(',guard+'\ntry:\n    _result = run_private_enrollment(')
        run=subprocess.run(['python3','-'],input=program,capture_output=True,text=True)
        self.assertEqual(run.returncode,1)
        self.assertEqual(json.loads(run.stdout),{'ok':False,'state':'release-pin-mismatch','accountCreated':False})
        self.assertNotIn(env['OWNER_EMAIL'],run.stdout+run.stderr); self.assertEqual(run.stderr,'')

    def test_backup_ci_covers_all_enrollment_executable_inputs(self):
        source=(ROOT/'.github/workflows/backup-transport-checks.yml').read_text()
        paths=['.github/workflows/owner-enrollment.yml','scripts/owner-enrollment-host.py',
               'ops/owner-enrollment-source-pins.json','scripts/release-preflight.py','.github/workflows/release-preflight.yml','.github/backup/**']
        for path in paths:
            self.assertEqual(source.count('      - '+path+'\n'),2)

    def test_real_assembled_owner_source_and_dependency_pins_match(self):
        pins=json.loads((ROOT/'ops/owner-enrollment-source-pins.json').read_text())
        self.assertTrue(SOURCE_MATCHES(ROOT,pins))
        pins['src/lib/mfa-encryption.ts']='0'*64
        self.assertFalse(SOURCE_MATCHES(ROOT,pins))

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
        self.assertIn('secrets.BUBBLEWASH_OWNER_EMAIL',source); self.assertNotIn('inputs.email',source)
        self.assertNotIn('upload-artifact',source); self.assertIn("github.ref == 'refs/heads/main'",source)
