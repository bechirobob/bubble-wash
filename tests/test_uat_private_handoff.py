import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import subprocess
import tempfile
import sqlite3
import io
import urllib.error
from types import SimpleNamespace
from unittest import mock
ROOT=Path(__file__).resolve().parents[1]
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=module('private','ops/uat/private-handoff.py');host=module('host','ops/uat/handoff-host.py')
class Guards(unittest.TestCase):
    def setUp(self):
        self.key=b'x'*422;self.fingerprint=hashlib.sha256(self.key).hexdigest()
        self.patch=mock.patch.object(m,'RECIPIENT',self.fingerprint);self.patch.start();self.addCleanup(self.patch.stop)
        self.env={'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','ISSUANCE_APPROVED':'true','HANDOVER_READY':'true','SOURCE_SHA':'a'*40,'GITHUB_SHA':'a'*40,'RUNTIME_SHA':'b'*40,'BACKUP_STORE_SHA':'c'*40,'BACKUP_STORE_ID':'1403152795','MODE':'issue','GITHUB_RUN_ID':'123','HANDOFF_PUBLIC_KEY':base64.b64encode(self.key).decode()}
    def test_context_and_recipient(self):
        self.assertEqual(m.context(self.env)['runtimeSha'],'b'*40)
        for key,value in [('GITHUB_REF','refs/heads/other'),('GITHUB_RUN_ATTEMPT','2'),('ISSUANCE_APPROVED','false'),('HANDOVER_READY','false'),('GITHUB_SHA','d'*40),('MODE','reset'),('BACKUP_STORE_ID','1'),('RUNNER_DEBUG','1'),('ACTIONS_STEP_DEBUG','true'),('HANDOFF_PUBLIC_KEY',base64.b64encode(b'y'*422).decode())]:
            with self.subTest(key=key),self.assertRaises(ValueError):m.context(dict(self.env,**{key:value}))
    def test_ciphertext_only_envelope(self):
        value={'schema':'bubblewash-uat-handover/v1','recipientSha256':self.fingerprint,**{k:base64.b64encode(b'x'*n).decode() for k,n in [('wrappedKey',384),('iv',12),('tag',16),('ciphertext',512)]}}
        self.assertEqual(m.envelope(json.dumps(value).encode()),value)
        for changes in [{'password':'never-allowed'},{'recipientSha256':'0'*64},{'tag':'bad'},{'schema':'other'}]:
            with self.assertRaises(ValueError):m.envelope(json.dumps(dict(value,**changes)).encode())
    def test_private_repository_checked_before_mutation(self):
        backup=mock.Mock();api=mock.Mock();backup.private_repository.side_effect=ValueError('public store')
        with self.assertRaises(ValueError):m.private_store(backup,api,self.env)
        api.api.assert_not_called()
    def test_storage_commit_exact(self):
        backup=mock.Mock();api=mock.Mock();api.api.return_value={'sha':'d'*40}
        with self.assertRaises(ValueError):m.private_store(backup,api,self.env)
        backup.private_repository.assert_called_once_with(api,'bechirobob/becore-backups',1403152795)
    def test_host_environment_fail_closed(self):
        prepare=module('prepare','ops/uat/prepare-host.py')
        # Match the installed activated allowlist without using any actual secret.
        env={'BUBBLEWASH_UAT_ENABLED':'true','BUBBLEWASH_UAT_ISOLATION_CONFIRMED':'true','BUBBLEWASH_PUBLIC_URL':'https://uat.bubblewash.co','BUBBLEWASH_UAT_DATA_ROOT':'/var/lib/bubblewash-uat','BUBBLEWASH_DATABASE_PATH':'/var/lib/bubblewash-uat/uat.sqlite','BUBBLEWASH_DATABASE_DRIVER':'sqlite','BUBBLEWASH_SESSION_SECRET':'x'*64,'BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','BUBBLEWASH_STAFF_AUTH_DISABLED':'false','BUBBLEWASH_BOOKINGS_DISABLED':'false','NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED':'false','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false','BUBBLEWASH_RESEARCH_EMAIL_ENABLED':'false','BUBBLEWASH_TRUST_PROXY_HEADERS':'false','BUBBLEWASH_TRUST_EDGE_HEADERS':'false','NEXT_TELEMETRY_DISABLED':'1'}
        raw=lambda d:'\n'.join(k+'='+v for k,v in d.items())+'\n'
        self.assertEqual(host.environment(raw(env))['NODE_ENV'],'production')
        for changes in [{'PAYSTACK_SECRET_KEY':'forbidden'},{'BUBBLEWASH_DATABASE_PATH':'/home/ubuntu/live.sqlite'},{'BUBBLEWASH_BOOKINGS_DISABLED':'true'},{'BUBBLEWASH_SESSION_SECRET':'short'},{'BUBBLEWASH_TRUST_PROXY_HEADERS':'true'}]:
            with self.assertRaises(ValueError):host.environment(raw(dict(env,**changes)))
        with self.assertRaises(ValueError):host.environment(raw(env)+'BUBBLEWASH_UAT_ENABLED=true\n')
    def test_public_handover_is_not_unconditional(self):
        source=(ROOT/'.github/workflows/uat-private-handoff.yml').read_text()
        for token in ('inputs.issuance_approved && inputs.handover_ready','ops/check-release-ci.py','secrets.BACKUP_STORE_TOKEN','GITHUB_RUN_ATTEMPT','fetch-depth: 0'):self.assertIn(token,source)
        code=(ROOT/'ops/uat/private-handoff.py').read_text()
        self.assertIn("public_readiness(request['mode'])",code)
        self.assertNotIn('print(result.stdout)',code)
    def test_exact_sandbox_and_cleared_groups(self):
        unit=(ROOT/'ops/uat/bubblewash-uat.service').read_text()
        props=host.sandbox_properties(unit)
        for expected in ['User=bubblewash-uat','Group=bubblewash-uat','SupplementaryGroups=','LimitCORE=0','SystemCallFilter=~connect','ProtectSystem=strict','ProtectHome=true','ReadWritePaths=/var/lib/bubblewash-uat','EnvironmentFile=/etc/bubblewash-uat/environment','MemoryMax=512M','IPAddressDeny=any']:
            self.assertIn(expected,props)
        self.assertFalse(any(p.startswith('ExecStart=') for p in props))
        source=(ROOT/'ops/uat/handoff-host.py').read_text()
        self.assertIn("'/usr/bin/systemd-run'",source)
        self.assertNotIn('user=account.pw_uid',source)
    def test_listener_and_dropin_refusal(self):
        valid=('ActiveState=active\nFragmentPath='+str(host.UNIT)+'\nDropInPaths=\nMainPID=123\n').encode()
        listener=b'LISTEN 0 511 127.0.0.1:3108 0.0.0.0:* users:(("node",pid=123,fd=20))\n'
        def result(value):return subprocess.CompletedProcess([],0,value,b'')
        with mock.patch.object(host.subprocess,'run',side_effect=[result(valid),result(listener)]):host.service_identity()
        for state,lines in [(valid.replace(b'DropInPaths=',b'DropInPaths=/etc/override.conf'),listener),(valid.replace(b'ActiveState=active',b'ActiveState=inactive'),listener),(valid,listener.replace(b'pid=123,',b'pid=456,')),(valid,listener.replace(b'127.0.0.1:3108',b'0.0.0.0:3108')),(valid,listener+listener)]:
            with mock.patch.object(host.subprocess,'run',side_effect=[result(state),result(lines)]),self.assertRaises(ValueError):host.service_identity()
    def publish_fixture(self, fail_upload=False):
        actual=module('backup_test','.github/backup/backup_release.py')
        backup=mock.Mock();backup.digest=actual.digest;backup.validate_release=actual.validate_release
        parent=self
        class API:
            def __init__(self):self.calls=[];self.files={};self.release=None
            def api(self,suffix='',method='GET',payload=None):
                self.calls.append((suffix,method))
                if suffix.startswith('git/commits/'):return {'sha':parent.env['BACKUP_STORE_SHA']}
                if suffix=='releases' and method=='POST':
                    self.release=dict(payload,id=42,assets=[]);return self.release
                if suffix=='releases/42' and method=='PATCH':self.release.update(payload,published_at='2026-10-26T00:00:00Z')
                if suffix=='releases/42':return self.release
                raise AssertionError('Unexpected API operation')
            def upload(self,identity,path):
                if fail_upload:raise ValueError('Synthetic upload interruption')
                data=path.read_bytes();asset_id=len(self.files)+1;self.files[asset_id]=data
                self.release['assets'].append(dict(id=asset_id,name=path.name,size=len(data),state='uploaded',content_type='application/octet-stream',digest='sha256:'+hashlib.sha256(data).hexdigest()))
            def download(self,identity,target,size):target.write_bytes(self.files[identity])
        value={'schema':'bubblewash-uat-handover/v1','recipientSha256':self.fingerprint,**{k:base64.b64encode(b'x'*n).decode() for k,n in [('wrappedKey',384),('iv',12),('tag',16),('ciphertext',512)]}}
        return backup,API(),json.dumps(value).encode()
    def test_publish_ciphertext_roundtrip(self):
        backup,api,raw=self.publish_fixture();receipt=m.publish(backup,api,self.env,raw)
        self.assertTrue(receipt['ok']);self.assertFalse(receipt['retryPermitted'])
        self.assertEqual(receipt['releaseId'],42);self.assertEqual(len(receipt['assets']),2)
        self.assertEqual(backup.private_repository.call_count,3)
        self.assertEqual(api.calls.count(('releases','POST')),1)
        self.assertEqual(api.calls.count(('releases/42','PATCH')),1)
        self.assertIn(raw,api.files.values())
        self.assertNotIn('ciphertext',json.dumps(receipt))
    def test_partial_upload_never_retries_or_publishes(self):
        backup,api,raw=self.publish_fixture(fail_upload=True)
        with self.assertRaises(ValueError):m.publish(backup,api,self.env,raw)
        self.assertEqual(api.calls.count(('releases','POST')),1)
        self.assertNotIn(('releases/42','PATCH'),api.calls)
        self.assertTrue(api.release['draft'])
    def test_honest_public_client_and_sanitized_failure(self):
        body=b'{"environment":"isolated-uat","externalProviders":"disabled","productionReady":false,"ok":false}'
        response=mock.MagicMock();response.__enter__.return_value=response;response.status=503;response.read.return_value=body
        with mock.patch.object(m.urllib.request,'urlopen',return_value=response) as get:m.public_readiness('check')
        request=get.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'),'BubbleWash-UAT-Verification/1.0')
        error=urllib.error.HTTPError(request.full_url,403,'Forbidden',{},io.BytesIO(b'SECRET HTML 1010'))
        with mock.patch.object(m.urllib.request,'urlopen',side_effect=error),self.assertRaises(ValueError):m.public_readiness('check')
        receipt=m.failure_receipt();self.assertEqual(receipt['stage'],'public-readiness');self.assertEqual(receipt['publicHttpStatus'],403);self.assertFalse(receipt['publicJson']);self.assertNotIn('SECRET',json.dumps(receipt))
    def test_check_never_publishes_or_accepts_nonzero_count(self):
        value={'ok':True,'mode':'check','hostVerified':True,'localReadinessStatus':503,'localReady':False,'uatAccountCount':0,'sealedPackageCount':0}
        with mock.patch.object(m,'publish') as publish:
            receipt=m.finish_capture({'mode':'check'},json.dumps(value).encode(),mock.Mock(),mock.Mock(),self.env)
            self.assertTrue(receipt['readOnly']);self.assertFalse(receipt['credentialsRetrieved']);publish.assert_not_called()
            with self.assertRaises(ValueError):m.finish_capture({'mode':'check'},json.dumps(dict(value,uatAccountCount=4)).encode(),mock.Mock(),mock.Mock(),self.env)
            publish.assert_not_called()
    def test_host_check_never_invokes_capsule(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);app=root/'app';config=root/'config';app.mkdir();config.mkdir();(app/'scripts').mkdir()
            (app/'SOURCE_REVISION').write_text('a'*40+'\n');capsule=app/'scripts/uat-sealed-handover.mjs';capsule.write_text('synthetic code')
            env=config/'environment';env.write_text('synthetic env');env.chmod(0o600);(config/'activation-started.json').write_text('{}')
            unit=root/'unit';unit.write_text('synthetic unit')
            request={'mode':'check','approved':True,'ready':True,'runtimeSha':'a'*40,'capsuleSha256':hashlib.sha256(capsule.read_bytes()).hexdigest(),'unitSha256':hashlib.sha256(unit.read_bytes()).hexdigest(),'publicKey':'unused'}
            with mock.patch.object(host,'APP',app),mock.patch.object(host,'CONFIG',config),mock.patch.object(host,'UNIT',unit),mock.patch.object(host,'protected'),mock.patch.object(host,'environment'),mock.patch.object(host,'service_identity'),mock.patch.object(host,'readiness',return_value=(503,False)),mock.patch.object(host,'issuance_counts',return_value=(0,0)),mock.patch.object(host.os,'geteuid',return_value=0),mock.patch.object(host.resource,'setrlimit'),mock.patch.object(host.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1001,pw_shell='/usr/sbin/nologin')),mock.patch.object(host.subprocess,'run') as run,mock.patch('sys.stdout',new_callable=io.StringIO) as output:
                host.main(request);run.assert_not_called()
                value=json.loads(output.getvalue());self.assertEqual(value['uatAccountCount'],0);self.assertEqual(value['sealedPackageCount'],0)
    def test_readonly_counts_include_committed_wal_without_private_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'uat.sqlite';database=sqlite3.connect(path);database.execute('PRAGMA journal_mode=WAL');database.executescript('CREATE TABLE staff_uat_accounts(username TEXT);CREATE TABLE uat_sealed_handover(envelope TEXT);');database.commit()
            with mock.patch.object(host,'DATABASE',path):
                self.assertEqual(host.issuance_counts(),(0,0))
                database.execute("INSERT INTO staff_uat_accounts VALUES('DO-NOT-EXPOSE')");database.execute("INSERT INTO uat_sealed_handover VALUES('CIPHERTEXT')");database.commit()
                self.assertEqual(host.issuance_counts(),(1,1))
            database.close()
if __name__=='__main__':unittest.main()
