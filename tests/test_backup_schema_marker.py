"""Regression for the reviewed writer/attestation marker contract; no host calls."""
import contextlib
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
host=load('attestation_marker',ROOT/'ops/attest-backup-schema.py')
core=load('marker_parser',ROOT/'ops/deploy-preserving.py')

class MarkerContract(unittest.TestCase):
    def test_standard_writer_marker_is_accepted(self):
        source=(ROOT/'ops/deploy-pwa-update.py').read_text()
        self.assertIn("f'sha={args.sha}\\nrelease={candidate.name}\\npath={candidate}\\n'.encode()",source)
        current=Path('/var/lib/bubblewash-release/releases')/host.LIVE
        marker=core.parse(f'sha={host.LIVE}\nrelease={current.name}\npath={current}\n'.encode())
        host.validate_marker(marker,current)

    def test_exact_keys_sha_path_and_release_name_are_required(self):
        current=Path('/synthetic')/host.LIVE
        marker={'sha':host.LIVE,'release':current.name,'path':str(current)}
        for change in ({'sha':'a'*40},{'release':'other'},{'path':'/other'},{'extra':'unreviewed'}):
            with self.subTest(change=change),self.assertRaises(ValueError):host.validate_marker({**marker,**change},current)
        with self.assertRaises(ValueError):host.validate_marker({k:v for k,v in marker.items() if k!='release'},current)

    def test_coordinator_advances_past_valid_marker_without_configuration_or_key(self):
        class ReachedSource(Exception):pass
        with tempfile.TemporaryDirectory() as d,contextlib.ExitStack() as stack:
            root=Path(d);current=root/host.LIVE;current.mkdir();pointer=root/'current';pointer.symlink_to(current)
            @contextlib.contextmanager
            def lock(*args):yield lambda:None
            fake=types.SimpleNamespace(CURRENT=pointer,RUNTIME=root/'runtime',parse=core.parse,deployment_lock=lock,source_manifest=mock.Mock(side_effect=ReachedSource))
            guards=mock.Mock()
            marker=f'sha={host.LIVE}\nrelease={current.name}\npath={current}\n'.encode()
            guards.inspect_read.side_effect=[marker,(host.LIVE+'\n').encode()]
            replacements=[(host,'core',fake),(host,'guards',guards),(host,'pins',{'runtimeSha':host.LIVE,'candidateSource':{}}),(host.os,'geteuid',lambda:0),(host.pwd,'getpwnam',lambda _:types.SimpleNamespace(pw_uid=1000)),(host.resource,'setrlimit',lambda *x:None),(host.signal,'signal',lambda *x:None),(host.signal,'alarm',lambda *x:None),(host.signal,'pthread_sigmask',lambda *x:set())]
            for target,name,value in replacements:stack.enter_context(mock.patch.object(target,name,value))
            decrypt=stack.enter_context(mock.patch.object(host,'decrypt',side_effect=AssertionError('key use forbidden')))
            request=dict(controlSha='a'*40,runId='1',runAttempt='1',runtimeSha=host.LIVE,backupSha256='b'*64,receiptRun='2',storeSha='c'*40,storeId='1403152795')
            with self.assertRaises(ReachedSource):host.attest(request)
            self.assertEqual(guards.inspect_read.call_count,2)
            guards.environment_snapshot.assert_not_called();decrypt.assert_not_called()


class FixedDiagnostics(unittest.TestCase):
    def test_invalid_request_has_fixed_pre_access_status(self):
        import io,json
        output=io.StringIO()
        with contextlib.redirect_stdout(output),self.assertRaises(SystemExit):host.main({'private':'do-not-emit'})
        result=json.loads(output.getvalue())
        self.assertEqual(result['diagnostics'],host.diagnostics())
        self.assertNotIn('do-not-emit',output.getvalue())

    def test_configuration_failure_and_cleanup_failure_are_distinguished(self):
        import io,json
        for configuration_returns,cleanup_fails in ((False,False),(True,False),(True,True)):
            with self.subTest(configuration_returns=configuration_returns,cleanup_fails=cleanup_fails),tempfile.TemporaryDirectory() as d,contextlib.ExitStack() as stack:
                root=Path(d);current=root/host.LIVE;current.mkdir();pointer=root/'current';pointer.symlink_to(current)
                @contextlib.contextmanager
                def lock(*args):yield lambda:None
                fake=types.SimpleNamespace(CURRENT=pointer,RUNTIME=root/'runtime',ENV=root/'env',parse=core.parse,deployment_lock=lock,source_manifest=lambda _: {},check_runtime=mock.Mock(side_effect=ValueError('private-runtime')))
                guards=mock.Mock();guards.inspect_read.side_effect=[f'sha={host.LIVE}\nrelease={current.name}\npath={current}\n'.encode(),(host.LIVE+'\n').encode()]
                guards.environment_snapshot.side_effect=None if configuration_returns else ValueError('private-config')
                guards.environment_snapshot.return_value=(b'NODE_ENV=production\n',())
                scanner=mock.Mock();scanner.source_snapshot.return_value=({},());scanner.content_commitment.return_value={}
                replacements=[(host,'core',fake),(host,'guards',guards),(host,'scanner',scanner),(host,'pins',{'runtimeSha':host.LIVE,'candidateSource':{},'runtimeContent':{}}),(host.os,'geteuid',lambda:0),(host.pwd,'getpwnam',lambda _:types.SimpleNamespace(pw_uid=1000)),(host.resource,'setrlimit',lambda *x:None),(host.signal,'signal',lambda *x:None),(host.signal,'alarm',lambda *x:None),(host.signal,'pthread_sigmask',lambda *x:set())]
                for target,name,value in replacements:stack.enter_context(mock.patch.object(target,name,value))
                if cleanup_fails:stack.enter_context(mock.patch.object(host,'clean_scratch',side_effect=ValueError('private-cleanup')))
                decrypt=stack.enter_context(mock.patch.object(host,'decrypt',side_effect=AssertionError('must not decrypt')))
                request=dict(controlSha='a'*40,runId='1',runAttempt='1',runtimeSha=host.LIVE,backupSha256='b'*64,receiptRun='2',storeSha='c'*40,storeId='1403152795')
                output=io.StringIO()
                with contextlib.redirect_stdout(output),self.assertRaises(SystemExit):host.main(request)
                status=json.loads(output.getvalue())['diagnostics']
                self.assertEqual(status['phase'],'cleanup' if cleanup_fails else 'runtime-process' if configuration_returns else 'configuration')
                self.assertEqual(status['configurationRead'],'completed' if configuration_returns else 'started')
                self.assertEqual(status['decryption'],'not-started');self.assertEqual(status['scratchCreation'],'not-started');self.assertEqual(status['cleanup'],'not-applicable')
                self.assertNotIn('private-',output.getvalue());decrypt.assert_not_called()

    def test_post_creation_failures_and_verified_cleanup(self):
        import datetime,hashlib,io,json
        for failure in ('decryption','snapshot-schema','cleanup',None):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as d,contextlib.ExitStack() as stack:
                root=Path(d);current=root/host.LIVE;current.mkdir();pointer=root/'current';pointer.symlink_to(current)
                run=root/'run';run.mkdir();node=mock.Mock();node.resolve.return_value=node;node.stat.return_value=types.SimpleNamespace(st_uid=0,st_mode=0o755)
                path=lambda value:run if value=='/run' else node if value=='/usr/bin/node' else Path(value)
                @contextlib.contextmanager
                def lock(*args):yield lambda:None
                receipt_path=root/'receipt';status_path=root/'status';archive_path=root/'archive'/'cipher'
                archive=b'x'*40;sha=hashlib.sha256(archive).hexdigest();receipt=json.dumps({'filename':'cipher','sha256':sha,'size':40}).encode();status=b'{"createdAt":"synthetic"}'
                raw=f'BUBBLEWASH_BACKUP_STATUS_PATH={status_path}\nBUBBLEWASH_BACKUP_OFFSITE_DIR={archive_path.parent}\nBUBBLEWASH_BACKUP_ENCRYPTION_KEY=synthetic\n'.encode()
                fake=types.SimpleNamespace(CURRENT=pointer,RUNTIME=root/'runtime',ENV=root/'env',RECEIPT=receipt_path,parse=core.parse,deployment_lock=lock,source_manifest=lambda _: {},check_runtime=mock.Mock(),verify_receipt=mock.Mock(),digest=lambda _:host.NODE_SHA,dt=datetime)
                guards=mock.Mock();marker=f'sha={host.LIVE}\nrelease={current.name}\npath={current}\n'.encode()
                guards.inspect_read.side_effect=lambda p,*args:marker if p.name=='current-release' else (host.LIVE+'\n').encode()
                guards.environment_snapshot.return_value=(raw,())
                scanner=mock.Mock();scanner.source_snapshot.return_value=({},());scanner.content_commitment.return_value={'sha256':'a'*64}
                replacements=[(host,'Path',path),(host,'core',fake),(host,'guards',guards),(host,'scanner',scanner),(host,'pins',{'runtimeSha':host.LIVE,'candidateSource':{},'runtimeContent':{'sha256':'a'*64}}),(host.os,'geteuid',lambda:0),(host.pwd,'getpwnam',lambda _:types.SimpleNamespace(pw_uid=1000)),(host.pwd,'getpwuid',lambda _:types.SimpleNamespace(pw_uid=0)),(host.resource,'setrlimit',lambda *x:None),(host.signal,'signal',lambda *x:None),(host.signal,'alarm',lambda *x:None),(host.signal,'pthread_sigmask',lambda *x:set()),(host,'protected_backup_path',lambda *x:None),(host,'read_backup',lambda p,*x:receipt if p==receipt_path else status if p==status_path else archive)]
                for target,name,value in replacements:stack.enter_context(mock.patch.object(target,name,value))
                stack.enter_context(mock.patch.object(host,'decrypt',side_effect=ValueError('private-decrypt') if failure=='decryption' else None,return_value=b'synthetic-plaintext'))
                stack.enter_context(mock.patch.object(host,'snapshot_hashes',side_effect=ValueError('private-schema') if failure=='snapshot-schema' else None,return_value=('b'*64,'c'*64)))
                if failure=='cleanup':stack.enter_context(mock.patch.object(host.shutil,'rmtree',side_effect=ValueError('private-cleanup')))
                request=dict(controlSha='a'*40,runId='1',runAttempt='1',runtimeSha=host.LIVE,backupSha256=sha,receiptRun='2',storeSha='c'*40,storeId='1403152795')
                output=io.StringIO()
                with contextlib.redirect_stdout(output):
                    if failure:
                        with self.assertRaises(SystemExit):host.main(request)
                    else:host.main(request)
                result=json.loads(output.getvalue());self.assertNotIn('private-',output.getvalue());self.assertNotIn('synthetic-plaintext',output.getvalue())
                if failure:
                    progress=result['diagnostics'];self.assertEqual(progress['phase'],failure);self.assertEqual(progress['scratchCreation'],'completed');self.assertEqual(progress['decryption'],'started' if failure=='decryption' else 'completed');self.assertEqual(progress['cleanup'],'started' if failure=='cleanup' else 'removed-verified')
                else:self.assertTrue(result['scratchRemoved'])
                self.assertEqual((run/'bubblewash-schema-attestation-1').exists(),failure=='cleanup')

if __name__=='__main__':unittest.main()
