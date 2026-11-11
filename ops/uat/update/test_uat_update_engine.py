import tempfile
import unittest
from pathlib import Path
from dataclasses import replace
from uat_update_engine import Contract,Evidence,FileJournal,Refused,execute

C=Contract('synthetic-uat-operation-0001','a'*40,'b'*40,'c'*64,'d'*64,'e'*64,'f'*64,10000000)
STAGES=('inspect','stage','stop','stopped','snapshot','switch','start','postverify')
class Fake:
    def __init__(self,fail=None,after=False):
        self.calls=[];self.fail=fail;self.after=after;self.current=C.previous_revision
        self.running=True;self.snapshot_ok=False;self.now=1;self.mismatch=None
    def now_ms(self):return self.now
    def evidence(self,c):
        e=Evidence(self.current,c.configuration_sha256,c.accounts_sha256,c.schema_sha256,c.expiry_ms,True,True,True,True)
        return replace(e,**self.mismatch) if self.mismatch else e
    def __getattr__(self,name):
        if name not in STAGES:raise AttributeError(name)
        def call(c):
            self.calls.append(name)
            if self.fail==name and not self.after:raise RuntimeError('PRIVATE secret must not escape')
            result=None
            if name in ('inspect','stopped','postverify'):result=self.evidence(c)
            if name=='stopped' and self.running:raise RuntimeError('not stopped')
            if name=='stage':result=c.artifact_sha256
            if name=='stop':self.running=False
            if name=='snapshot':self.snapshot_ok=True;result=True
            if name=='switch':
                assert self.snapshot_ok and not self.running
                self.current=c.candidate_revision
            if name=='start':self.running=True
            if self.fail==name and self.after:raise RuntimeError('PRIVATE secret must not escape')
            return result
        return call

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.root.chmod(0o700)
    def tearDown(self):self.tmp.cleanup()
    def journal(self, subdir=None):
        if subdir:
            path=self.root/subdir;path.mkdir(mode=0o700);return FileJournal(path)
        return FileJournal(self.root)
    def test_success(self):
        f=Fake();r=execute(C,f,self.journal());self.assertEqual(r.state,'verified');self.assertEqual(f.calls,list(STAGES))
        self.assertIn('"event": "verified"',(self.root/(C.operation_id+'.jsonl')).read_text())
    def test_each_boundary_failure_before_and_after_no_retry(self):
        for index,stage in enumerate(STAGES):
            for after in (False,True):
                with self.subTest(stage=stage,after=after):
                    c=replace(C,operation_id=f'synthetic-{stage}-{str(after).lower()}-0001');f=Fake(stage,after)
                    r=execute(c,f,self.journal(c.operation_id));self.assertEqual(r.state,'inspection-required');self.assertEqual(f.calls,list(STAGES[:index+1]))
                    self.assertNotIn('PRIVATE',repr(r));self.assertNotIn('PRIVATE',(self.root/c.operation_id/(c.operation_id+'.jsonl')).read_text())
    def test_replay_refused(self):
        execute(C,Fake(),self.journal());f=Fake()
        with self.assertRaises(FileExistsError):execute(C,f,self.journal())
        self.assertEqual(f.calls,[])
    def test_empty_interrupted_journal_refuses(self):
        (self.root/(C.operation_id+'.jsonl')).touch();f=Fake()
        with self.assertRaises(FileExistsError):execute(C,f,self.journal())
        self.assertEqual(f.calls,[])
    def test_every_protected_invariant_rejected(self):
        for key,value in dict(configuration_sha256='1'*64,accounts_sha256='2'*64,schema_sha256='3'*64,expiry_ms=99999,isolated=False,production_untouched=False,exclusive=False,capacity_ok=False,revision='0'*40).items():
            f=Fake();f.mismatch={key:value};c=replace(C,operation_id='synthetic-invariant-'+key.lower().replace('_','-'))
            r=execute(c,f,self.journal(c.operation_id));self.assertEqual(r.state,'inspection-required');self.assertEqual(f.calls,['inspect'])
    def test_expiry_not_extended(self):
        f=Fake();f.now=C.expiry_ms;r=execute(C,f,self.journal());self.assertEqual(f.calls,[]);self.assertEqual(r.stage,'inspect')
    def test_bad_contract_no_adapter(self):
        f=Fake()
        with self.assertRaises(Refused):execute(replace(C,candidate_revision='oops'),f,self.journal())
        self.assertEqual(f.calls,[])
    def test_journal_failure_blocks_next_action(self):
        class Broken(FileJournal):
            def record(self,event,commitment=''):
                if event=='done:stop':raise OSError('disk failure')
                super().record(event,commitment)
        f=Fake();r=execute(C,f,Broken(self.root));self.assertEqual(r.state,'inspection-required');self.assertEqual(f.calls,['inspect','stage','stop']);self.assertFalse(f.running)
    def test_candidate_revision_checked_after_start(self):
        class WrongRuntime(Fake):
            def postverify(self,c):return replace(self.evidence(c),revision=c.previous_revision)
        f=WrongRuntime();r=execute(C,f,self.journal());self.assertEqual(r.state,'inspection-required');self.assertEqual(r.stage,'postverify')
    def test_changed_account_at_postcheck_refused(self):
        class Changed(Fake):
            def postverify(self,c):return replace(self.evidence(c),accounts_sha256='0'*64)
        r=execute(C,Changed(),self.journal());self.assertEqual(r.state,'inspection-required');self.assertEqual(r.stage,'postverify')
    def test_bad_artifact_prevents_stop(self):
        class WrongArtifact(Fake):
            def stage(self,c):return '0'*64
        f=WrongArtifact();r=execute(C,f,self.journal());self.assertEqual(r.stage,'stage');self.assertTrue(f.running)
    def test_unverified_snapshot_prevents_switch(self):
        class BadSnapshot(Fake):
            def snapshot(self,c):return False
        f=BadSnapshot();r=execute(C,f,self.journal());self.assertEqual(r.stage,'snapshot');self.assertEqual(f.current,C.previous_revision)
    def test_different_id_blocked_after_success(self):
        execute(C,Fake(),self.journal());f=Fake()
        with self.assertRaises(FileExistsError):execute(replace(C,operation_id='synthetic-different-operation-0002'),f,self.journal())
        self.assertEqual(f.calls,[])
    def test_different_id_blocked_after_uncertainty(self):
        execute(C,Fake('switch',True),self.journal());f=Fake()
        with self.assertRaises(FileExistsError):execute(replace(C,operation_id='synthetic-different-operation-0002'),f,self.journal())
        self.assertEqual(f.calls,[])
    def test_empty_active_marker_blocks_any_id(self):
        (self.root/'active-operation').touch();f=Fake()
        with self.assertRaises(FileExistsError):execute(C,f,self.journal())
        self.assertEqual(f.calls,[])
    def test_prestop_budget_exhaustion_never_stops(self):
        class SlowStage(Fake):
            def stage(self,c):self.now=c.expiry_ms-899999;return c.artifact_sha256
        f=SlowStage();r=execute(C,f,self.journal());self.assertEqual(r.stage,'stop');self.assertTrue(f.running)
    def test_expiry_after_stop_does_not_prevent_start(self):
        class DeadlineDuringSnapshot(Fake):
            def snapshot(self,c):self.now=c.expiry_ms+100;self.snapshot_ok=True;return True
        f=DeadlineDuringSnapshot();r=execute(C,f,self.journal());self.assertEqual(r.state,'verified');self.assertTrue(f.running)
        self.assertEqual(f.evidence(C).expiry_ms,C.expiry_ms)
    def test_private_journal_required(self):
        self.root.chmod(0o755)
        with self.assertRaises(Refused):execute(C,Fake(),self.journal())

if __name__=='__main__':unittest.main()
