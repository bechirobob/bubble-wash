import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
s=importlib.util.spec_from_file_location('diagnostic',Path(__file__).resolve().parents[1]/'ops'/'inspect-staff-host.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
BEFORE={'apps':{'http':{'servers':{'srv0':{'listen':[':443'],'routes':[{'match':[{'host':['private.example']}],'handle':[{'handler':'private-secret'}]}]}}}}}
ROUTE={'match':[{'host':['staff.bubblewash.co']}],'handle':[{'handler':'subroute','routes':[{'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:3000'}]}]}]}],'terminal':True}
class Tests(unittest.TestCase):
 def exercise(self, stdin=BEFORE,file=BEFORE,active=BEFORE,candidate=None):
  if candidate is None:
   candidate=copy.deepcopy(BEFORE);candidate['apps']['http']['servers']['srv0']['routes'].append(ROUTE)
  seq=iter([stdin,file,candidate]);calls=[]
  def run(args,**kwargs):
   calls.append((args,kwargs));v=next(seq)
   if isinstance(v,Exception):raise v
   return SimpleNamespace(returncode=1 if v=='failure' else 0, stdout=b'not json' if v=='invalid' else json.dumps(v).encode(),stderr=b'PRIVATE CONFIG SECRETS')
  with patch.object(m.subprocess,'run',side_effect=run),patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(active).encode())),patch.dict(m.os.environ,{},clear=True):
   result=m.baseline_comparison(b'bubblewash.co {\n reverse_proxy localhost:3000\n}\n# {$PRIVATE_NAME}\n')
  self.assertTrue(all(c[0][1]=='adapt' for c in calls));self.assertEqual(len(calls),3)
  output=json.dumps(result)
  for secret in ('private.example','private-secret','PRIVATE CONFIG','PRIVATE_NAME'):self.assertNotIn(secret,output)
  return result
 def test_equal_baseline_candidate_exact(self):
  r=self.exercise();self.assertTrue(r['stdinEqualsFile']);self.assertTrue(r['fileEqualsActive']);self.assertTrue(r['candidateExactAdditiveDelta']);self.assertEqual(r['environmentPlaceholderCount'],1);self.assertEqual(r['environmentPlaceholderUnsetCount'],1)
 def test_stdin_file_context_mismatch(self):
  r=self.exercise(stdin={'other':'SECRET'});self.assertFalse(r['stdinEqualsFile']);self.assertTrue(r['fileEqualsActive']);self.assertFalse(r['candidateExactAdditiveDelta'])
 def test_active_drift_only_classification_no_values(self):
  a=copy.deepcopy(BEFORE);a['logging']={'private':'SECRET'};r=self.exercise(active=a);self.assertFalse(r['fileEqualsActive']);self.assertEqual(r['differentSections'],['logging']);self.assertFalse(r['httpDifference'])
 def test_failed_command_not_equal_or_disclosed(self):
  r=self.exercise(stdin='failure');self.assertEqual(r['stdin']['status'],'adapt-command-failed');self.assertNotIn('stdinEqualsFile',r)
 def test_invalid_json(self):self.assertEqual(self.exercise(file='invalid')['file']['status'],'adapt-non-json')
 def test_timeout(self):self.assertEqual(self.exercise(stdin=subprocess.TimeoutExpired('caddy',30))['stdin']['status'],'adapt-timeout')
 def test_candidate_rejects_unrelated_delta(self):
  a=copy.deepcopy(BEFORE);a['apps']['http']['servers']['srv0']['routes'].append(ROUTE);a['admin']={'disabled':True};self.assertFalse(self.exercise(candidate=a)['candidateExactAdditiveDelta'])
if __name__=='__main__':unittest.main()
