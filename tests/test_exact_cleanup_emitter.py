import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('emitter',Path(__file__).resolve().parents[1]/'ops/emit-exact-cleanup.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class EmitterTests(unittest.TestCase):
    def fixture(self,root):
        (root/'ops').mkdir()
        runtime={'runtimeSha':'1ddf328332836aeefe41d4a4e6f05ed79d4589a3'}
        (root/'ops/pwa-update-source-pins.json').write_text(json.dumps(runtime))
        dependencies={}
        for name,path in m.PATHS.items():
            value='# fixed nonsecret source '+name+'\n'
            (root/path).write_text(value);dependencies[name]=hashlib.sha256(value.encode()).hexdigest()
        adapter="def entry(pins,sources):\n print('verified-test-entry')\n"
        (root/m.ADAPTER).write_text(adapter)
        pins={'schema':'bubblewash-exact-cleanup-host/v1','runtimeSha':runtime['runtimeSha'],'runtimePins':runtime,
              'dependencies':dependencies,'adapterSha256':hashlib.sha256(adapter.encode()).hexdigest()}
        (root/m.PINS).write_text(json.dumps(pins))
    def test_exact_payload_emits_runnable_fixed_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.fixture(root)
            source=m.emit(m.payload(root))
            result=subprocess.run([sys.executable,'-I','-B','-'],input=source,text=True,capture_output=True,check=True)
            self.assertEqual(result.stdout,'verified-test-entry\n')
            self.assertEqual(set(p.name for p in root.iterdir()),{'ops'})
    def test_emitted_real_wrapper_entry_binds_contract_with_stub_host(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.fixture(root)
            real=(Path(__file__).resolve().parents[1]/m.ADAPTER).read_text()
            # Exercise the real entry/module/pins/argparse contract; replace only
            # Host and coordinator to prove this test cannot touch a real host.
            real+="\nclass Host:\n def __init__(self,*args):pass\ndef run_cleanup(*args):return {'realEntryReached':True}\n"
            (root/m.ADAPTER).write_text(real)
            p=json.loads((root/m.PINS).read_text());p['adapterSha256']=hashlib.sha256(real.encode()).hexdigest()
            cleanup="CONFIRMATION='test-only'\n"
            (root/m.PATHS['cleanup']).write_text(cleanup);p['dependencies']['cleanup']=hashlib.sha256(cleanup.encode()).hexdigest()
            (root/m.PINS).write_text(json.dumps(p))
            result=subprocess.run([sys.executable,'-I','-B','-','--operation','preflight'],input=m.emit(m.payload(root)),text=True,capture_output=True,check=True)
            self.assertEqual(json.loads(result.stdout),{'realEntryReached':True})

    def test_all_real_frozen_modules_load_through_emitted_entry(self):
        value=m.payload(Path(__file__).resolve().parents[1])
        value['adapter']+="\nclass Host:\n def __init__(self,*args):pass\ndef run_cleanup(*args):return {'realFrozenModulesLoaded':True}\n"
        value['pins']['adapterSha256']=hashlib.sha256(value['adapter'].encode()).hexdigest()
        result=subprocess.run([sys.executable,'-I','-B','-','--operation','preflight'],input=m.emit(value),text=True,capture_output=True,check=True)
        self.assertEqual(json.loads(result.stdout),{'realFrozenModulesLoaded':True})

    def test_adapter_or_dependency_tamper_refused(self):
        for path in [m.ADAPTER,*m.PATHS.values()]:
            with tempfile.TemporaryDirectory() as folder:
                root=Path(folder);self.fixture(root)
                with (root/path).open('a') as f:f.write('# changed\n')
                with self.assertRaises(ValueError):m.payload(root)
    def test_runtime_pins_drift_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.fixture(root)
            (root/'ops/pwa-update-source-pins.json').write_text('{}')
            with self.assertRaises(ValueError):m.payload(root)
    def test_unreviewed_dependency_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.fixture(root)
            p=json.loads((root/m.PINS).read_text());p['dependencies']['extra']='x';(root/m.PINS).write_text(json.dumps(p))
            with self.assertRaises(ValueError):m.payload(root)
    def test_workflow_exact_source_first_attempt_private_backup_and_modes(self):
        s=(Path(__file__).resolve().parents[1]/'.github/workflows/exact-test-data-cleanup.yml').read_text()
        for expected in ['contents: read','persist-credentials: false','environment: backup-storage','group: bubblewash-production','cancel-in-progress: false',
          '"$SOURCE_SHA" == "$GITHUB_SHA"','"$GITHUB_RUN_ATTEMPT" == 1','default: preflight',
          '[[ "$PLAN_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]]','[[ -z "$PLAN_FINGERPRINT" ]]',
          'python3 .github/backup/check_store.py','python3 -I -B - --operation',
          'os.environ["BACKUP_STORE_SHA"] == p["storeSha"]','ops/emit-exact-cleanup.py --check']:
            self.assertIn(expected,s)
        self.assertNotIn('${{ inputs.',s[s.index('    steps:'):])

if __name__=='__main__':unittest.main()
