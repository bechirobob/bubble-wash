import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('adapter',ROOT/'ops/deploy-abigail-update.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)

class Template(unittest.TestCase):
    def setUp(self):self.text=(ROOT/'.github/workflows/abigail-update-deploy.yml').read_text()
    def test_manual_workflow_has_repository_main_and_concurrency_guards(self):
        self.assertIn('workflow_dispatch:',self.text)
        self.assertIn("if: github.repository == 'bechirobob/bubble-wash' && github.ref == 'refs/heads/main'",self.text)
        self.assertIn('group: bubblewash-production',self.text)
        self.assertIn('cancel-in-progress: false',self.text)
    def test_distinct_control_runtime_and_first_attempt_gates(self):
        for text in ['"$CONTROL_SHA" == "$GITHUB_SHA"',a.CANDIDATE,a.REFERENCE,'"$GITHUB_RUN_ATTEMPT" == 1','--runner-only','--check-runtime','--check-hosted-runs']:
            self.assertIn(text,self.text)
        self.assertIn('fetch-depth: 0',self.text)
        self.assertLess(self.text.index('--runner-only'),self.text.index('ref: ${{ inputs.runtime_sha }}'))
    def test_emission_is_before_host_staging_and_refuses_unbound_inputs(self):
        self.assertLess(self.text.index('--emit'),self.text.index('Connect through existing'))
        result=subprocess.run([sys.executable,'-B',str(ROOT/'ops/deploy-abigail-update.py'),'--emit'],capture_output=True,text=True,env={k:v for k,v in os.environ.items() if k not in ("RUNTIME_SHA","CI_RUN","BROWSER_RUN")})
        self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'');self.assertIn('ValueError',result.stderr)
    def test_focused_ci_has_no_host_or_dispatch_permissions(self):
        text=(ROOT/'.github/workflows/abigail-deployment-checks.yml').read_text()
        for forbidden in ('workflow_dispatch:','tailscale','secrets.','environment:','--emit','root@'):
            self.assertNotIn(forbidden,text)
        self.assertIn('contents: read',text);self.assertIn('fetch-depth: 0',text)
        self.assertIn("test_abigail_*.py",text);self.assertIn('--runner-only',text)
    def test_existing_hosted_run_guard_rejects_retry_wrong_source_and_pr(self):
        update=a.prepare_review(*a.read_inputs())
        path='.github/workflows/browser-regression.yml'
        run={'head_sha':a.CANDIDATE,'path':path,'event':'push','status':'completed','conclusion':'success','run_attempt':1,'head_repository':{'full_name':'bechirobob/bubble-wash'},'repository':{'full_name':'bechirobob/bubble-wash'}}
        update.verify_hosted_run(run,a.CANDIDATE,path)
        for change in [{'run_attempt':2},{'head_sha':'0'*40},{'event':'pull_request'},{'conclusion':'failure'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):update.verify_hosted_run({**run,**change},a.CANDIDATE,path)

if __name__=='__main__':unittest.main()
