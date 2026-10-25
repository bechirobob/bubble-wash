import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch
P=Path(__file__).resolve().parents[1]/'ops/integration-release/retained_attempt.py'
s=importlib.util.spec_from_file_location('retained_test',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class RetainedTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);root=Path(self.tmp.name)
        for key in ('STATE','RUNTIME','WORK'):
            p=root/key;p.mkdir();patch.object(m,key,p).start()
        patch.object(m.os,'geteuid',return_value=0).start();self.addCleanup(patch.stopall)
        @contextlib.contextmanager
        def lock(*a):yield lambda:None
        self.units=[]
        def state(unit):self.units.append(unit);return {'LoadState':'not-found','ActiveState':'inactive','MainPID':'0'}
        self.core=NS(deployment_lock=lock,probe_state=state)
    def test_exact_units_and_no_execution(self):
        r=m.inspect_retained(self.core);self.assertEqual(set(self.units),{'bubblewash-prepare-40144518668-1-candidate-probe.service','bubblewash-prepare-40144518668-1-fallback-probe.service'});self.assertFalse(r['releaseAcceptance']);self.assertFalse(r['databaseOpened']);self.assertFalse(r['hostStateChanged'])
    def test_no_private_database_read(self):
        p=m.STATE/'rehearsal-evidence'/m.OPERATION;p.mkdir(parents=True);(p/'preimage.sqlite').write_text('PRIVATE DATABASE')
        with patch.object(m.os,'open',side_effect=AssertionError('must not open database')):
            r=m.inspect_retained(self.core)
        self.assertTrue(r['files']['preimage']['present']);self.assertNotIn('PRIVATE DATABASE',json.dumps(r))
    def test_only_matching_temp_directory_metadata(self):
        (m.RUNTIME/'unrelated-private').mkdir();known=m.RUNTIME/('release-rehearsal-bubblewash-prepare-'+m.OPERATION+'-candidate-abcd');known.mkdir();(known/'rehearsal.sqlite').write_text('PRIVATE')
        r=m.inspect_retained(self.core);self.assertEqual(len(r['probeDirectories']['candidate']),1);self.assertNotIn('PRIVATE',json.dumps(r));self.assertNotIn('unrelated-private',json.dumps(r));self.assertNotIn(str(known),json.dumps(r))
    def test_sanitized_unit_failure(self):
        self.core.probe_state=lambda unit:(_ for _ in ()).throw(RuntimeError('SECRET PATH'));r=m.inspect_retained(self.core);self.assertEqual(r['units']['candidate'],{'status':'unavailable'});self.assertNotIn('SECRET',json.dumps(r))
    def test_symlink_report_not_read(self):
        p=m.STATE/'rehearsal-evidence'/m.OPERATION;p.mkdir(parents=True);secret=m.STATE/'secret';secret.write_text('SECRET');(p/'evidence.json').symlink_to(secret);r=m.inspect_retained(self.core);self.assertNotIn('sha256',r['files']['evidence']);self.assertNotIn('SECRET',json.dumps(r))
    def test_no_write_or_db_or_command_execution(self):
        import ast
        calls=[n.func.attr for n in ast.walk(ast.parse(P.read_text())) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)]
        self.assertFalse(set(calls)&{'mkdir','write_text','write_bytes','unlink','connect','rehearse','migrate','command','run'})
if __name__=='__main__':unittest.main()
