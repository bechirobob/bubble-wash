import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
P=ROOT/'ops/integration-release/stream_backup_mode.py'
spec=importlib.util.spec_from_file_location('mode_transport_test',P);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ModeTransportTests(unittest.TestCase):
    def build(self):
        with patch.dict(os.environ,{'GITHUB_SHA':'a'*40}):return m.build('a'*40,m.CONFIRMATION)
    def test_valid_stream_compiles(self):compile(self.build(),'stream','exec')
    def test_wrong_sha_rejected(self):
        with patch.dict(os.environ,{'GITHUB_SHA':'a'*40}),self.assertRaises(ValueError):m.build('b'*40,m.CONFIRMATION)
    def test_missing_sha_rejected(self):
        with patch.dict(os.environ,{},clear=True),self.assertRaises(ValueError):m.build('a'*40,m.CONFIRMATION)
    def test_wrong_confirmation_rejected(self):
        with patch.dict(os.environ,{'GITHUB_SHA':'a'*40}),self.assertRaises(ValueError):m.build('a'*40,'yes')
    def test_repair_source_tampering_rejected(self):
        with patch.object(m,'REPAIR_SHA256','0'*64),self.assertRaises(ValueError):self.build()
    def test_guard_source_tampering_rejected(self):
        with patch.object(m,'GUARD_SHA256','0'*64),self.assertRaises(ValueError):self.build()
    def run_injected(self,expression):
        source=self.build();prefix,tail=source.rsplit(" result=sys.modules['repair_backup_mode'].repair_backup_mode",1)
        source=prefix+" sys.modules['repair_backup_mode'].repair_backup_mode=lambda guard: "+expression+"\n result=sys.modules['repair_backup_mode'].repair_backup_mode"+tail
        with tempfile.TemporaryDirectory() as directory:return subprocess.run([sys.executable,'-I','-B','-'],input=source,capture_output=True,text=True,cwd=directory)
    def test_no_host_imports_and_exact_success(self):
        result=self.run_injected("{'ok':True,'status':'backup-directory-group-write-removed'}")
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout),{'ok':True,'status':'backup-directory-group-write-removed'})
    def test_errors_sanitized_and_require_inspection(self):
        result=self.run_injected("(_ for _ in ()).throw(ValueError('SECRET /private/path'))")
        self.assertEqual(result.returncode,1);self.assertEqual(result.stdout,'')
        self.assertEqual(json.loads(result.stderr),{'ok':False,'status':'backup-directory-repair-unconfirmed','inspectBeforeRetry':True,'automaticRetry':False})
        self.assertNotIn('SECRET',result.stderr);self.assertNotIn('/private/path',result.stderr)
    def test_workflow_identity_and_no_interpolated_remote_command(self):
        s=(ROOT/'.github/workflows/repair-backup-directory-mode.yml').read_text()
        for text in ('github.ref == \'refs/heads/main\'','"$SOURCE_SHA" == "$GITHUB_SHA"','environment: backup-storage','group: bubblewash-production','cancel-in-progress: false','persist-credentials: false',"tailscale ssh root@hermes 'python3 -I -B -'"):self.assertIn(text,s)
        self.assertLess(s.index('test_repair_backup_mode.py'),s.index('uses: tailscale/github-action@'))
        self.assertLess(s.index('test_backup_mode_transport.py'),s.index('uses: tailscale/github-action@'))
        self.assertNotIn('retry',s)
if __name__=='__main__':unittest.main()
