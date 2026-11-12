import sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import code_update_host as h
from uat_update_engine import Refused

class Deadlines(unittest.TestCase):
 def test_read_only_exact_grants_and_business_commitments(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'synthetic.sqlite'
   db=sqlite3.connect(path)
   db.executescript("CREATE TABLE staff_uat_accounts(username TEXT,credential_version TEXT,starts_at INTEGER,expires_at INTEGER,status TEXT); CREATE TABLE staff_uat_extensions(username TEXT,credential_version TEXT,starts_at INTEGER,original_expires_at INTEGER,expires_at INTEGER); CREATE TABLE orders(id TEXT,state TEXT); INSERT INTO orders VALUES('synthetic','pending');")
   original=1794457808095;start=original-604800000
   db.execute('INSERT INTO staff_uat_accounts VALUES(?,?,?,?,?)',('synthetic-admin','version',start,original,'active'))
   db.execute('INSERT INTO staff_uat_extensions VALUES(?,?,?,?,?)',('synthetic-admin','version',start,original,h.EXPIRY));db.commit()
   before=path.read_bytes()
   with patch.object(h,'DATABASE',path):
    baseline=h.database_commitments(path)
    self.assertEqual(baseline['expiry'],h.EXPIRY)
    self.assertEqual(path.read_bytes(),before,'inspection cannot change data')
    for field,value in [('credential_version','changed'),('expires_at',h.EXPIRY+1),('original_expires_at',original+1),('starts_at',start+1)]:
     db.execute('SAVEPOINT mutation');db.execute('UPDATE staff_uat_extensions SET '+field+'=?',(value,));db.commit()
     with self.assertRaises(Refused):h.database_commitments(path)
     db.execute('DELETE FROM staff_uat_extensions');db.execute('INSERT INTO staff_uat_extensions VALUES(?,?,?,?,?)',('synthetic-admin','version',start,original,h.EXPIRY));db.commit()
    db.execute("UPDATE orders SET state='changed'");db.commit()
    changed=h.database_commitments(path)
    self.assertNotEqual(changed['records'],baseline['records'],'business drift detected')
    db.execute('DELETE FROM staff_uat_extensions');db.commit()
    with self.assertRaises(Refused):h.database_commitments(path)
   db.close()
 def test_scope_is_separate_and_fixed(self):
  self.assertEqual(h.PREVIOUS,'8bd37b028b550967f9a3eefcd60a52cbcb4f2da9')
  self.assertEqual(h.CANDIDATE,'0bc1a37ad4a59e57a6e07bee9fa6c11c6cf6b804')
  self.assertEqual(str(h.WORK),'/opt/bubblewash-uat/code-update-20261112')
  self.assertEqual(str(h.SHARED_LOCK),'/opt/bubblewash-uat/update/host.lock')
  root=Path(__file__).resolve().parents[3]
  flow=(root/'.github/workflows/uat-code-update.yml').read_text()
  for text in ('node-version: 22','--runner-only','group: bubblewash-production','GITHUB_RUN_ATTEMPT','quiet_window_coordinated','code_update_runner.py',h.CANDIDATE,h.CANDIDATE_TREE):self.assertIn(text,flow)
  self.assertNotIn('resume_stopped_runner.py',flow)


import io,hashlib,tempfile,types,os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
import code_update_receiver as r
from code_update_host import PIN_NAMES,PREVIOUS,CANDIDATE,EXPIRY
from uat_update_engine import Evidence

class ReceiverIntegration(TestCase):
    def run_case(self,extra=b'',expiry=EXPIRY,failure=None):
        calls=[];artifact=b'synthetic-artifact-only'
        original={'runtimeRevision':PREVIOUS,'runtimeFiles':{n:'a'*64 for n in PIN_NAMES},'unitSha256':'b'*64}
        candidate={**original,'runtimeRevision':CANDIDATE}
        request={'operationId':'synthetic-receiver-operation','candidateRevision':CANDIDATE,'artifactSha256':hashlib.sha256(artifact).hexdigest(),'artifactSize':len(artifact),'interruptionApproved':True,'quietWindowCoordinated':True,'adminRouteApproved':True,'expectedExpiryMs':expiry}
        class Fake:
            def __init__(self,*a,**kw):
                self.before={'synthetic':True};self.original=original
                self.c=types.SimpleNamespace(collect_restart_isolation=lambda *a,**kw:self.before)
            def now_ms(self):return 1000
            def _evidence(self,revision):return Evidence(revision,'d'*64,'e'*64,'f'*64,EXPIRY,True,True,True,True)
            def inspect(self,c):calls.append('inspect');return self._evidence(c.previous_revision)
            def stage(self,c):calls.append('stage');return c.artifact_sha256
            def stop(self,c):calls.append('stop')
            def stopped(self,c):return self._evidence(c.previous_revision)
            def snapshot(self,c):calls.append('snapshot');return True
            def switch(self,c):
                calls.append('switch')
                if failure:raise RuntimeError('private payload must never appear')
            def start(self,c):calls.append('start')
            def postverify(self,c):return self._evidence(c.candidate_revision)
            def close(self):calls.append('close')
        with tempfile.TemporaryDirectory(prefix='bw-receiver-test-') as directory:
            parent=Path(directory);work=parent/'update'
            def trusted(path):
                self.assertEqual(path,parent)
                return os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
            with patch.object(r,'WORK',work),patch.object(r,'HostAdapter',Fake),patch.object(r.host_files,'trusted_directory',trusted),patch.object(r.os,'geteuid',return_value=0):
                result=r.receive(io.BytesIO(artifact+extra),request,None,original,candidate,600)
                retained=work.exists()
                # Fixed update path always refuses another invocation, even new operation.
                request['operationId']='synthetic-receiver-operation-new'
                repeat=r.receive(io.BytesIO(artifact),request,None,original,candidate,600)
                self.assertEqual(repeat['state'],'inspection-required')
        return result,calls,retained
    def test_success_single_preinspection_and_closed_receipt(self):
        result,calls,retained=self.run_case()
        self.assertEqual(result,{'state':'verified','stage':'postverify','automaticRetry':False})
        self.assertEqual(calls.count('inspect'),1);self.assertEqual(calls.count('stop'),1);self.assertEqual(calls.count('start'),1);self.assertTrue(retained)
    def test_expiry_mismatch_before_transaction(self):
        result,calls,_=self.run_case(expiry=11000000)
        self.assertEqual(result['state'],'inspection-required');self.assertNotIn('stop',calls)
    def test_trailing_payload_refused_before_inspection(self):
        result,calls,_=self.run_case(extra=b'X')
        self.assertEqual(result['stage'],'artifact');self.assertEqual(calls,[])
    def test_switch_failure_no_restart_or_secret_disclosure(self):
        result,calls,_=self.run_case(failure=True)
        self.assertEqual(result,{'state':'inspection-required','stage':'switch','automaticRetry':False})
        self.assertNotIn('start',calls)
        self.assertNotIn('private',str(result))


import hashlib,io,os,struct,tempfile,unittest
from pathlib import Path
from code_update_receiver import validate_request,receive_artifact
from code_update_runner import validate_context,bootstrap,write_stream,prepare_bundle
from uat_update_engine import Refused
R=dict(operationId='synthetic-update-operation-01',candidateRevision='b'*40,artifactSha256=hashlib.sha256(b'fixture').hexdigest(),artifactSize=7,interruptionApproved=True,quietWindowCoordinated=True,adminRouteApproved=True,expectedExpiryMs=10000000)
class Tests(unittest.TestCase):
 def test_request_requires_all_attestations(self):
  validate_request(R)
  for key in ('interruptionApproved','quietWindowCoordinated','adminRouteApproved'):
   with self.assertRaises(Refused):validate_request({**R,key:False})
 def test_context_first_attempt_and_no_debug(self):
  e=dict(GITHUB_REPOSITORY='bechirobob/bubble-wash',GITHUB_REF='refs/heads/main',GITHUB_SHA='a'*40,GITHUB_RUN_ATTEMPT='1',GITHUB_EVENT_NAME='workflow_dispatch');validate_context(e,'a'*40)
  for changes in ({'GITHUB_RUN_ATTEMPT':'2'},{'RUNNER_DEBUG':'1'},{'GITHUB_SHA':'b'*40}):
   with self.assertRaises(Refused):validate_context({**e,**changes},'a'*40)
 def test_missing_expiry_and_nonmain_candidate_refused(self):
  without=dict(R);without.pop('expectedExpiryMs')
  with self.assertRaises(Refused):validate_request(without)
  e=dict(GITHUB_REPOSITORY='bechirobob/bubble-wash',GITHUB_REF='refs/heads/main',GITHUB_SHA='a'*40,GITHUB_RUN_ATTEMPT='1',GITHUB_EVENT_NAME='workflow_dispatch')
  with self.assertRaises(Refused):prepare_bundle('/not-accessed','a'*40,'b'*40,e,R)
 def test_constant_small_bootstrap(self):
  code=bootstrap();compile(code,'synthetic','exec');self.assertLess(len(code),4096);self.assertIn('1048576',code)
 def test_stream_and_exclusive_receive(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'input').write_bytes(b'fixture');out=io.BytesIO();write_stream(out,b'header',p/'input',7,R['artifactSha256']);self.assertEqual(out.getvalue(),b'headerfixture')
   fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
   try:
    receive_artifact(io.BytesIO(b'fixture'),fd,7,R['artifactSha256']);self.assertEqual((p/'artifact.tar.gz').read_bytes(),b'fixture')
    with self.assertRaises(FileExistsError):receive_artifact(io.BytesIO(b'fixture'),fd,7,R['artifactSha256'])
   finally:os.close(fd)
 def test_trailing_artifact_refused(self):
  with tempfile.TemporaryDirectory() as d:
   fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY)
   try:
    with self.assertRaises(Refused):receive_artifact(io.BytesIO(b'fixtureextra'),fd,7,R['artifactSha256'])
   finally:os.close(fd)
