import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('adapter',ROOT/'ops/deploy-abigail-update.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)

class Invocation(unittest.TestCase):
    def setUp(self):
        self.raw=(ROOT/'ops/abigail-deployment-acceptance.json').read_text();self.backup=(ROOT/'ops/abigail-backup-evidence.json').read_text();profile,sources=a.read_inputs()
        self.payload={'profile':profile,'sources':sources,'acceptanceRaw':self.raw,'backupRaw':self.backup}
    def test_changed_acceptance_refuses_before_constructing_host(self):
        self.payload["acceptanceRaw"] += " "
        with mock.patch.object(a,'prepare_review') as prepare,self.assertRaisesRegex(ValueError,'Deployment disabled'):a.entry(self.payload)
        prepare.assert_not_called()
    def test_truthy_json_and_kwargs_cannot_bypass_pinned_acceptance(self):
        value=json.loads(self.raw);value['deploymentAccepted']=False
        with self.assertRaises(ValueError):a.require_acceptance(json.dumps(value,indent=2)+'\n')
        with self.assertRaises(ValueError):a.entry(deploymentAccepted=True)
    def test_in_memory_backup_payload_requires_exact_original_bytes(self):
        self.assertEqual(a.read_backup_evidence(self.backup),a.read_backup_evidence())
        with self.assertRaises(ValueError):a.read_backup_evidence(self.backup+' ')
    def test_synthetic_accepted_route_calls_only_bound_existing_deployer(self):
        b=a.read_backup_evidence()['context'];args=types.SimpleNamespace(sha=a.CANDIDATE,expected_live=a.REFERENCE,backup_sha256=b['backupSha256'],receipt_run=b['receiptRun'],store_sha=b['storeSha'],store_id=b['storeId'])
        update=types.SimpleNamespace(arguments=lambda:args,workspace_pwa=types.SimpleNamespace(deploy=mock.Mock()))
        with mock.patch.object(a,'prepare_review',return_value=update),mock.patch.object(a.signal,'signal'):a.entry(self.payload)
        update.workspace_pwa.deploy.assert_called_once_with(update,args)
    def test_runner_requires_exact_accepted_run_ids(self):
        values={'RUNTIME_SHA':a.CANDIDATE,'CI_RUN':a.CI_RUN,'BROWSER_RUN':a.BROWSER_RUN}
        with mock.patch.dict(a.os.environ,values):a.require_runner_runs()
        for key in values:
            with mock.patch.dict(a.os.environ,{**values,key:'different'}),self.assertRaises(ValueError):a.require_runner_runs()
    def test_runner_backup_mismatch_refuses_before_emitting(self):
        output=io.StringIO()
        values={'RUNTIME_SHA':a.CANDIDATE,'CI_RUN':a.CI_RUN,'BROWSER_RUN':a.BROWSER_RUN,'BACKUP_SHA':'0'*64}
        with mock.patch.object(a,'require_acceptance'),mock.patch.dict(a.os.environ,values),mock.patch.object(a,'prepare_review') as prepare,contextlib.redirect_stdout(output),self.assertRaises(ValueError):a.emit()
        self.assertEqual(output.getvalue(),'');prepare.assert_not_called()
    def test_host_rechecks_false_acceptance_even_if_runner_check_is_stubbed(self):
        output=io.StringIO()
        original=Path.read_text
        def changed(path,*args,**kwargs):
            raw=original(path,*args,**kwargs)
            if path.name=='abigail-deployment-acceptance.json':
                value=json.loads(raw);value['deploymentAccepted']=False
                return json.dumps(value)
            return raw
        with mock.patch.object(Path,'read_text',changed),mock.patch.object(a,'require_acceptance'),mock.patch.dict(a.os.environ,{'RUNTIME_SHA':a.CANDIDATE,'CI_RUN':a.CI_RUN,'BROWSER_RUN':a.BROWSER_RUN,'BACKUP_SHA':a.read_backup_evidence()['context']['backupSha256'],'RECEIPT_RUN':a.read_backup_evidence()['context']['receiptRun'],'BACKUP_STORE_SHA':a.read_backup_evidence()['context']['storeSha'],'BACKUP_STORE_ID':a.read_backup_evidence()['context']['storeId']}),contextlib.redirect_stdout(output):a.emit()
        result=subprocess.run([sys.executable,'-I','-B','-'],input=output.getvalue(),text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'');self.assertIn('Deployment disabled',result.stderr)

if __name__=='__main__':unittest.main()
