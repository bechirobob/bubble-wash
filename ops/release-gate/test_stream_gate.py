"""Synthetic stream/bootstrap tests. No live systemd, SSH, credentials or database."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('stream', HERE/'stream_gate.py')
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.facts = {'schema': 'bubblewash-bounded-host-evidence/v1', 'databaseOpened': False,
                      'releaseAcceptance': False, 'privateFixture': 'DO_NOT_PRINT_FACTS'}
        self.original = dict(self.facts, original=True)
        self.expected = s.digest(canonical(self.facts)); self.original_hash = s.digest(canonical(self.original))
        self.sources = {
            'contracts': b'# synthetic contracts only\n',
            'evidence_guard': b'def parse(value): return {"parsed": True}\n',
            'host_adapter': ("from pathlib import Path\ndef inspect_host_evidence(guard):\n"
                " with guard.deployment_lock(Path('/home/ubuntu/bubblewash-runtime'),1000) as unchanged:\n"
                "  unchanged()\n  assert guard.parse('ignored') == {'parsed': True}\n  return "+repr(self.facts)+'\n').encode(),
            'app.conf': (HERE/'app.conf').read_bytes(),
            'maintenance.conf': (HERE/'maintenance.conf').read_bytes(),
        }
        fake = '''import contextlib, json
STATE = '/var/lib/bubblewash-release'
class Installer:
 def __init__(self, facts, evidence_sha256, payloads):
  self.uid=1000; self.stage='INITIALIZE'; self.recovery=None; self.held=False
  self.facts=facts; self.evidence_sha256=evidence_sha256; self.payloads=payloads
 @contextlib.contextmanager
 def lock(self):
  assert not self.held
  self.held=True
  def unchanged(): assert self.held
  try: yield unchanged
  finally: self.held=False
 def boot_id(self):
  assert self.held
  return '11111111-1111-4111-8111-111111111111'
 def preflight(self):
  assert self.held and self.facts == EXPECTED
  self.preflight_checked=True
 def parents(self, path): assert self.held
 def read(self, path, maximum=65536):
  assert self.held
  if path == '/proc/sys/kernel/random/boot_id': return b'fixture-boot'
  assert path == STATE+'/gate-installation.json'
  return RECEIPT
 def install(self, evidence_check):
  with self.lock() as unchanged:
   evidence_check(unchanged)
   assert self.facts == EXPECTED
   return {'installed':True,'restarted':False,'databaseOpened':False,'releaseAcceptance':False}
 def reverse(self, evidence_check):
  with self.lock() as unchanged:
   evidence_check(unchanged)
   assert self.facts == ORIGINAL
   return {'reversed':True,'restarted':False,'databaseOpened':False}
def diagnostic(error, stage, action, recovery):
 return {'ok':False,'stage':stage,'category':'REFUSED','automaticRollback':False}
'''
        receipt = {'schema': 'bubblewash-gate-installation/v1', 'evidenceSha256': self.original_hash,
                   'baselineEvidence': self.original}
        fake += '\nEXPECTED='+repr(self.facts)+'\nORIGINAL='+repr(self.original)+'\nRECEIPT='+repr(canonical(receipt))+'\n'
        self.sources['install_hold_gate.py'] = fake.encode()
        self.sources['stream_gate.py'] = b'# fake emitter bytes, for source loader only\n'

    def execute(self, mode='inspect', expected=None, original=None, sources=None, alter=None):
        text = s.bootstrap(sources or self.sources, mode, 'a'*64, expected or self.expected,
                           self.original_hash if original is None else original)
        if alter: text = alter(text)
        # Synthetic modules only. Pretend root; never call host commands or use a real installer.
        text = 'import os\nos.geteuid=lambda:0\nos.getegid=lambda:0\n'+text
        return subprocess.run([sys.executable, '-I', '-B', '-'], input=text, text=True, capture_output=True)

    def test_inspect_matches_host_local_evidence_without_disclosure(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertTrue(value['inspected']); self.assertFalse(value['changed'])
        self.assertTrue(value['procBootIdentityReadable']); self.assertTrue(value['preflight'])
        self.assertNotIn('DO_NOT_PRINT_FACTS', result.stdout+result.stderr)

    def test_inspect_runs_full_preflight_and_refuses_without_acceptance(self):
        sources = self.sources.copy()
        sources['install_hold_gate.py'] = sources['install_hold_gate.py'].replace(
            b'self.preflight_checked=True', b'raise ValueError("PRIVATE_PREFLIGHT_BLOCKER")')
        result = self.execute('inspect', sources=sources)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(json.loads(result.stdout)['stage'],'PREFLIGHT')
        self.assertNotIn('inspected',result.stdout)
        self.assertNotIn('PRIVATE_PREFLIGHT_BLOCKER',result.stdout+result.stderr)

    def test_install_and_reverse_check_facts_under_same_lock(self):
        for mode, field in [('install','installed'),('reverse-before-migration','reversed')]:
            result = self.execute(mode)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)[field])
            self.assertNotIn('DO_NOT_PRINT_FACTS', result.stdout+result.stderr)

    def test_current_evidence_drift_refuses_before_mutation(self):
        result = self.execute('install', expected='f'*64)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['stage'], 'EVIDENCE_RECHECK')
        self.assertNotIn('installed', result.stdout)
        self.assertNotIn('DO_NOT_PRINT_FACTS', result.stdout+result.stderr)

    def test_original_evidence_drift_refuses_reversal(self):
        result = self.execute('reverse-before-migration', original='e'*64)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('reversed', result.stdout)
        self.assertNotIn('DO_NOT_PRINT_FACTS', result.stdout+result.stderr)

    def test_different_lock_target_refused(self):
        sources = self.sources.copy()
        sources['host_adapter'] = sources['host_adapter'].replace(b'/home/ubuntu/bubblewash-runtime', b'/other/runtime')
        result = self.execute('install', sources=sources)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('installed', result.stdout)

    def test_embedded_byte_tamper_refused_before_import(self):
        result = self.execute(alter=lambda text:text.replace('synthetic contracts only', 'tampered contracts only', 1))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['stage'], 'BOOTSTRAP')
        self.assertEqual(result.stderr, '')

    def test_confirmation_binds_exact_mode_and_both_hashes(self):
        p='a'*64; e='b'*64; o='c'*64
        s.validate_inputs('inspect',p,e,'','')
        s.validate_inputs('install',p,e,'','install:'+p+':'+e)
        s.validate_inputs('reverse-before-migration',p,e,o,'reverse-before-migration:'+p+':'+e+':'+o)
        for args in [('inspect',p,e,'','yes'),('install',p,e,'','yes'),
                     ('install',p,e,'','install:'+p+':'+'d'*64),
                     ('reverse-before-migration',p,e,o,'reverse-before-migration:'+p+':'+e),
                     ('execute',p,e,'','')]:
            with self.assertRaises(ValueError): s.validate_inputs(*args)

    def test_manifest_and_each_public_source_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); gate=root/'gate'; gate.mkdir()
            for name in s.GATE_FILES: (gate/name).write_bytes(self.sources[name])
            for module,name in s.EVIDENCE_FILES.items():
                path=root/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(self.sources[module])
            manifest={'schema':'bubblewash-gate-transport/v1',
                'gateFiles':{name:s.digest(self.sources[name]) for name in s.GATE_FILES},
                'evidenceFiles':{name:s.digest(self.sources[module]) for module,name in s.EVIDENCE_FILES.items()}}
            raw=canonical(manifest); (gate/'transport-manifest.json').write_bytes(raw)
            loaded=s.load_reviewed(root,s.digest(raw),gate)
            self.assertEqual(loaded,self.sources)
            (gate/'install_hold_gate.py').write_text('raise RuntimeError("never import")')
            with self.assertRaises(ValueError): s.load_reviewed(root,s.digest(raw),gate)

    def test_manifest_hash_or_symlink_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); path=root/'manifest'; path.write_text('{}')
            (root/'transport-manifest.json').symlink_to(path)
            with self.assertRaises(ValueError): s.load_reviewed(root,'a'*64,root)
            with self.assertRaises(ValueError): s.bounded_read(root/'transport-manifest.json')

    def test_source_read_short_reads_loop_but_truncation_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'source'; path.write_bytes(b'complete reviewed source')
            original=os.read
            with patch.object(os,'read',side_effect=lambda fd,n:original(fd,min(n,2))):
                self.assertEqual(s.bounded_read(path),path.read_bytes())
            calls=[]
            def premature(fd,n):
                calls.append(True)
                return original(fd,2) if len(calls)==1 else b''
            with patch.object(os,'read',side_effect=premature):
                with self.assertRaises(ValueError): s.bounded_read(path)

    def test_packaged_public_modules_initialize_without_host_access(self):
        sources = {name:(HERE/name).read_bytes() for name in s.GATE_FILES}
        for module, name in s.EVIDENCE_FILES.items():
            sources[module] = (HERE.parents[1]/name).read_bytes()
        program = s.bootstrap(sources, 'inspect', 'a'*64, 'b'*64, '')
        initialize = program.split(" gate = sys.modules['gate_installer']", 1)[0]
        initialize += " print('initialized reviewed public modules')\nexcept BaseException:\n raise\n"
        protect = ("import os, subprocess, sqlite3\nfrom pathlib import Path\n"
                   "os.geteuid=lambda:0\nos.getegid=lambda:0\n"
                   "def forbidden(*args,**kwargs): raise AssertionError('host action during initialization')\n"
                   "subprocess.run=forbidden\nsqlite3.connect=forbidden\nPath.open=forbidden\n")
        result = subprocess.run([sys.executable,'-I','-B','-'], input=protect+initialize,
                                text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'initialized reviewed public modules')

    def test_workflow_is_separate_main_only_serial_no_new_secret(self):
        workflow=(HERE.parents[1]/'.github/workflows/release-gate-operation.yml').read_text()
        self.assertIn('github.ref == \'refs/heads/main\'',workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'",workflow)
        self.assertIn('group: bubblewash-production',workflow)
        self.assertIn('environment: backup-storage',workflow)
        self.assertIn('options: [inspect, install, reverse-before-migration]',workflow)
        self.assertIn("tailscale ssh root@hermes 'python3 -I -B -'",workflow)
        self.assertNotIn('set -x',workflow); self.assertNotIn('tee ',workflow)
        self.assertNotIn('upload-artifact',workflow)
        self.assertEqual(workflow.count('secrets.'),2)
        self.assertNotIn('BACKUP_STORE_TOKEN',workflow)
        self.assertNotIn('complete-labels-only',workflow)


if __name__=='__main__': unittest.main(verbosity=2)
