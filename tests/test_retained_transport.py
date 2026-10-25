import importlib.util
import json
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'ops/integration-release'))
import stream_host as s
class RetainedTransportTests(unittest.TestCase):
    def request(self):
        c=json.loads((s.HERE/'source-contracts.json').read_text())
        r={'runId':'99999999999','runAttempt':1,'candidateSha':c['profiles']['integration-candidate-v1']['publicationCommit'],'fallbackSha':c['profiles']['integration-fallback-v1']['publicationCommit'],'backupSha256':'a'*64,'receiptRun':'99999999998','storeSha':'b'*40,'storeId':1,'node':{'path':'/usr/bin/node','sha256':'c'*64},'retainedPins':{'operation':'40144518668-1','pair':{label:{'manifestSha256':'d'*64,'archiveSha256':'e'*64,'archiveSize':100} for label in ('candidate','fallback')},'preimage':{'sha256':'f'*64,'size':100}}}
        return r,c
    def test_validate_and_compile_explicit_resume(self):
        r,c=self.request();s.validate_preparation_request(r,c,True);payload=s.preparation_bootstrap('resume-retained',r);compile(payload,'resume','exec');self.assertIn("'retainedPins'",payload);self.assertIn("mode='resume-retained'",payload)
    def test_original_prepare_rejects_retained_input(self):
        r,c=self.request()
        with self.assertRaises(ValueError):s.validate_preparation_request(r,c)
    def test_prior_run_not_reused(self):
        r,c=self.request();r['runId']='40144518668'
        with self.assertRaises(ValueError):s.validate_preparation_request(r,c,True)
    def test_malformed_pins_refused(self):
        r,c=self.request();r['retainedPins']['preimage']['sha256']='not-a-hash'
        with self.assertRaises(ValueError):s.validate_preparation_request(r,c,True)
    def test_workflow_stages_only_original_prepare(self):
        w=(ROOT/'.github/workflows/integration-code-deploy.yml').read_text();part=w.split('- name: Stage exact sources into four fresh inactive app-UID workspaces',1)[1].split('- name:',1)[0]
        self.assertIn("if: inputs.mode == 'prepare'\n",part);self.assertNotIn('resume-retained',part)
        self.assertIn("if: inputs.mode != 'prepare' && inputs.mode != 'resume-retained' && inputs.mode != 'materialize'",w)
        self.assertIn('--mode "$RELEASE_MODE" --preparation-request',w)
if __name__=='__main__':unittest.main()
