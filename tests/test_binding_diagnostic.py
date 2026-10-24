import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

P=Path(__file__).resolve().parents[1]/'ops/integration-release/binding_diagnostic.py'
spec=importlib.util.spec_from_file_location('binding_diagnostic_test',P)
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)

class BindingDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name);self.state=root/'state';self.work=root/'work';self.work.mkdir()
        self.current=self.work/'live';self.current.mkdir();link=root/'current';link.symlink_to(self.current)
        self.contract=self.state/'packages'/d.PACKAGE/'source-contracts.json';self.contract.parent.mkdir(parents=True)
        self.contract.write_text(json.dumps(d.CONTRACT))
        self.raw=b'synthetic-private-config';self.values={'BUBBLEWASH_DATABASE_PATH':str(root/'db'),'BUBBLEWASH_BACKUP_OFFSITE_DIR':str(root),'BUBBLEWASH_BACKUP_STATUS_PATH':str(root/'status'),'NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false'}
        self.receipt={'sha256':d.REQUEST['backupSha256'],'filename':'archive.enc','size':1};(root/'archive.enc').write_bytes(b'x')
        @contextlib.contextmanager
        def lock(*args):yield lambda:None
        self.core=NS(CURRENT=link,RUNTIME=root/'runtime',ENV=root/'env',RECEIPT=root/'receipt',deployment_lock=lock,parse=lambda raw:self.values if raw==self.raw else {'sha':'live-sha','path':str(self.current)},verify_receipt=lambda *a:None,health=lambda *a:None)
        def read(path,*a):
            if path==self.core.RECEIPT:return json.dumps(self.receipt).encode()
            if path.name=='current-release':return b'marker'
            if path.name=='.release-sha':return b'live-sha'
            return b'{}'
        self.guards=NS(inspect_read=read,environment_snapshot=lambda *a:(self.raw,'env-identity'),database_identity=lambda *a:'db-identity',file_identity=lambda *a:True,runtime_flags=lambda *a:None)
        self.scanner=NS(source_snapshot=lambda *a:({'a':'hash'},'source-identity'),content_commitment=lambda *a:'content',pins={'runtimeContent':'content','runtimeSha':'live-sha'},open_configuration=lambda *a:None)
        self.contracts=NS(digest=lambda p:d.REQUEST['node']['sha256'])
        self.adapter=NS(protected=lambda *a,**k:'metadata',evidence_metadata=lambda p:{'present':p.exists(),'kind':'directory','uid':0,'gid':0,'mode':493,'links':1},admit_production_configuration=lambda *a:None)
        self.prep=NS(STATE=self.state,WORK=self.work,PAIR={'candidate':('candidate','tree'),'fallback':('fallback','tree')},LIVE='live-sha',LIVE_TREE='tree',source_files=lambda *a:{},git_tree=lambda *a:'tree')
        import hashlib
        self.addCleanup(patch.stopall)
        patch.object(d,'CONTRACT_SHA',hashlib.sha256(self.contract.read_bytes()).hexdigest()).start()
        patch.object(d.os,'geteuid',return_value=0).start();patch.object(d.os,'getegid',return_value=0).start()
        patch.object(d.pwd,'getpwnam',return_value=NS(pw_uid=1000)).start()
    def run_diag(self):return d.inspect_binding(self.core,self.guards,self.scanner,self.contracts,self.adapter,self.prep)
    def fail(self,*args,**kwargs):raise ValueError('PRIVATE_VALUE_MUST_NEVER_APPEAR')
    def test_all_binding_guards_pass_without_acceptance(self):
        r=self.run_diag();self.assertEqual(set(r['checks'].values()),{'pass'});self.assertFalse(r['releaseAcceptance']);self.assertFalse(r['databaseOpened']);self.assertFalse(r['hostStateChanged']);self.assertFalse(r['automaticRetry'])
    def test_independent_source_config_runtime_failures_all_reported(self):
        self.prep.git_tree=lambda *a:'wrong';self.scanner.open_configuration=self.fail;self.guards.runtime_flags=self.fail;self.core.health=self.fail
        r=self.run_diag()
        for k in ('SOURCE_TREE','SURVEY_CONFIGURATION','RUNTIME_FLAGS','RUNTIME_HEALTH'):self.assertEqual(r['checks'][k],'fail')
        self.assertEqual(r['checks']['BACKUP_VERIFICATION'],'pass');self.assertNotIn('PRIVATE',json.dumps(r))
    def test_parse_exception_is_not_mislabeled_lock(self):
        original=self.core.parse
        self.core.parse=lambda raw:self.fail() if raw==self.raw else original(raw)
        r=self.run_diag();self.assertEqual(r['checks']['ENVIRONMENT_PARSE'],'fail');self.assertEqual(r['checks']['LOCK'],'pass');self.assertEqual(r['checks']['SURVEY_CONFIGURATION'],'not-run');self.assertEqual(r['checks']['DATABASE_METADATA'],'not-run');self.assertNotIn('PRIVATE',json.dumps(r))
    def test_missing_automated_flag_explicitly_fails(self):
        del self.values['NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED'];self.assertEqual(self.run_diag()['checks']['AUTOMATED_UPDATES_DISABLED'],'fail')
    def test_receipt_failure_never_checks_archive_or_verifier(self):
        self.receipt['sha256']='wrong';self.guards.file_identity=lambda *a: self.fail();self.core.verify_receipt=lambda *a:self.fail()
        r=self.run_diag();self.assertEqual(r['checks']['BACKUP_RECEIPT'],'fail');self.assertEqual(r['checks']['ARCHIVE_BINDING'],'not-run');self.assertEqual(r['checks']['BACKUP_VERIFICATION'],'not-run');self.assertEqual(r['checks']['NODE_PIN'],'pass')
    def test_source_tree_failure_does_not_hide_commitment(self):
        self.prep.source_files=self.fail;r=self.run_diag();self.assertEqual(r['checks']['SOURCE_TREE'],'fail');self.assertEqual(r['checks']['SOURCE_COMMITMENT'],'pass')
    def test_package_failure_never_imports_or_mutates_it(self):
        self.contract.write_text('{}');before=self.contract.read_bytes();r=self.run_diag();self.assertEqual(r['checks']['PACKAGE_CONTRACT'],'fail');self.assertEqual(self.contract.read_bytes(),before)
    def test_no_write_or_database_call_exists(self):
        import ast
        tree=ast.parse(P.read_text());calls=[n.func.attr for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)]
        self.assertFalse(set(calls)&{'mkdir','write_text','write_bytes','unlink','chmod','chown','connect','prepare_pair','reserve_directories'})
    def test_same_fixed_scope_ignores_unknown_children(self):
        (self.state/'unrelated').write_text('PRIVATE');r=self.run_diag();self.assertEqual(len(r['retainedPaths']),7);self.assertNotIn('unrelated',json.dumps(r));self.assertNotIn(self.raw.decode(),json.dumps(r))

if __name__=='__main__':unittest.main()
