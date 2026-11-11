import io,hashlib,tempfile,types,os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
import update_receiver_draft as r
from live_host_adapter import PIN_NAMES
from uat_update_engine import Evidence

class ReceiverIntegration(TestCase):
    def run_case(self,extra=b'',expiry=10000000,failure=None):
        calls=[];artifact=b'synthetic-artifact-only'
        original={'runtimeRevision':'f4fd4ce424c2b363fc5a2196432e0ac2ce7c05a1','runtimeFiles':{n:'a'*64 for n in PIN_NAMES},'unitSha256':'b'*64}
        candidate={**original,'runtimeRevision':'c'*40}
        request={'operationId':'synthetic-receiver-operation','candidateRevision':'c'*40,'artifactSha256':hashlib.sha256(artifact).hexdigest(),'artifactSize':len(artifact),'interruptionApproved':True,'quietWindowCoordinated':True,'adminRouteApproved':True,'expectedExpiryMs':expiry}
        class Fake:
            def __init__(self,*a,**kw):
                self.before={'synthetic':True};self.original=original
                self.c=types.SimpleNamespace(collect_restart_isolation=lambda *a,**kw:self.before)
            def now_ms(self):return 1000
            def _evidence(self,revision):return Evidence(revision,'d'*64,'e'*64,'f'*64,10000000,True,True,True,True)
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
