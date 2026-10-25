import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'ops/integration-release'))
import host_adapter as a

class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.node=self.root/'node';self.node.write_bytes(b'node')
        self.host=a.Host.__new__(a.Host)
        self.host.plan={'node':{'path':str(self.node),'sha256':a.digest(self.node)},'candidate':str(self.root)}
        self.good={'ok':True,'stage':'COMPLETE','error':'NONE',
                   'counts':dict.fromkeys(a.PREFLIGHT_COUNTS,0),'knownDiscrepancies':[]}

    def invoke(self,child=None,side_effect=None,protection=None,regular=None):
        child=child or types.SimpleNamespace(returncode=0,stdout=json.dumps(self.good).encode(),stderr=b'')
        with patch.object(a,'protected',side_effect=protection,return_value=()), \
             patch.object(a,'regular',side_effect=regular,return_value=()), \
             patch.object(a.subprocess,'run',return_value=child,side_effect=side_effect) as run:
            result=self.host.feature_preflight_diagnostic(self.root/'copy.sqlite')
            return result,run

    def test_success_diagnostic_uses_exact_drop_and_restricted_environment(self):
        result,run=self.invoke();self.assertTrue(result['ok'])
        args=run.call_args.args[0];self.assertEqual(args[:4],['/usr/sbin/runuser','-u','ubuntu','--'])
        self.assertEqual(run.call_args.kwargs['env']['PATH'],str(self.node.parent)+':/usr/bin:/bin')
        self.assertNotIn('RESEND',repr(run.call_args));self.assertEqual(args[-4:],['--database',str(self.root/'copy.sqlite'),'--source',str(self.root)])

    def test_protection_and_regular_boundaries_distinguished(self):
        for target,stage in [('migrate-integration-features.mjs','CAPSULE_PROTECTION'),('diagnose-feature-preflight.mjs','DIAGNOSTIC_FILE'),('node','NODE_PROTECTION'),('runuser','LAUNCHER_PROTECTION')]:
            def fail(path,**kw):
                if Path(path).name==target:raise ValueError('private error not emitted')
            result,run=self.invoke(protection=fail)
            self.assertEqual(result['stage'],stage);self.assertEqual(result['error'],'BOUNDARY_REFUSED');run.assert_not_called()
        result,run=self.invoke(regular=lambda *_:(_ for _ in ()).throw(OSError('private')))
        self.assertEqual(result['stage'],'CAPSULE_FILE');run.assert_not_called()

    def test_node_hash_drift(self):
        self.host.plan['node']['sha256']='0'*64
        result,run=self.invoke();self.assertEqual(result['stage'],'NODE_HASH');run.assert_not_called()

    def test_process_failure_categories_never_leak_output(self):
        for code,stderr,expected in [(2,b'private','EXIT_NONZERO'),(-9,b'private','SIGNALLED'),(1,b"code: 'ERR_MODULE_NOT_FOUND' private",'MODULE_NOT_FOUND'),(1,b'EACCES /private','MODULE_ACCESS_DENIED'),(1,b'ERR_DLOPEN_FAILED secret','NATIVE_BINDING_FAILED')]:
            child=types.SimpleNamespace(returncode=code,stdout=b'private',stderr=stderr)
            result,_=self.invoke(child);self.assertEqual(result['error'],expected);self.assertNotIn('private',json.dumps(result));self.assertFalse(result['ok'])
        result,_=self.invoke(side_effect=FileNotFoundError('private'))
        self.assertEqual(result['error'],'SPAWN_IO')
        result,_=self.invoke(side_effect=subprocess.TimeoutExpired('private',90))
        self.assertEqual(result['error'],'TIMEOUT')

    def test_invalid_output_and_arbitrary_fields_refuse(self):
        for raw in [b'private raw output',b'{}',json.dumps({**self.good,'secret':'private'}).encode(),b' '*32769]:
            result,_=self.invoke(types.SimpleNamespace(returncode=0,stdout=raw,stderr=b''))
            self.assertEqual(result['error'],'OUTPUT_INVALID');self.assertFalse(result['ok']);self.assertNotIn('private',json.dumps(result))

    def test_schema_failure_is_structured_not_acceptance(self):
        value={**self.good,'ok':False,'stage':'TABLE_SCHEMAS','error':'SCHEMA_MISMATCH',
               'knownDiscrepancies':[{'objectIdSha256':'a'*64,'expectedSha256':'b'*64,'actualSha256':'c'*64}]}
        result,_=self.invoke(types.SimpleNamespace(returncode=0,stdout=json.dumps(value).encode(),stderr=b''))
        self.assertFalse(result['ok']);self.assertEqual(result['stage'],'TABLE_SCHEMAS')
        self.assertEqual(result['knownDiscrepancies'],value['knownDiscrepancies'])

    def test_bounded_all_mismatch_report_fits_and_overflow_refuses(self):
        value={**copy.deepcopy(self.good),'ok':False,'stage':'TABLE_SCHEMAS','error':'SCHEMA_MISMATCH'}
        value['knownDiscrepancies']=[{'objectIdSha256':format(n,'064x'),'expectedSha256':'b'*64,'actualSha256':'c'*64} for n in range(64)]
        raw=json.dumps(value).encode();self.assertGreater(len(raw),4096);self.assertLess(len(raw),32768)
        result,_=self.invoke(types.SimpleNamespace(returncode=0,stdout=raw,stderr=b''))
        self.assertEqual(result['error'],'SCHEMA_MISMATCH');self.assertEqual(len(result['knownDiscrepancies']),64)
        value['knownDiscrepancies'].append(value['knownDiscrepancies'][0])
        result,_=self.invoke(types.SimpleNamespace(returncode=0,stdout=json.dumps(value).encode(),stderr=b''))
        self.assertEqual(result['error'],'OUTPUT_INVALID')

    def test_validator_rejects_text_identifiers_and_excess_counts(self):
        value={**copy.deepcopy(self.good),'processReturnCode':0}
        value['knownDiscrepancies']=[{'objectIdSha256':'private table','expectedSha256':'b'*64,'actualSha256':None}]
        with self.assertRaises(ValueError):a.validate_preflight_diagnostic(value)
        value['knownDiscrepancies']=[];value['counts']['objects']=10002
        with self.assertRaises(ValueError):a.validate_preflight_diagnostic(value)

if __name__=='__main__':unittest.main()
