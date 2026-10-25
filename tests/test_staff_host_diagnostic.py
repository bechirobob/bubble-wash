import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
from contextlib import contextmanager
import tempfile
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
  seq=iter([file,stdin,candidate]);calls=[]
  def run(args,**kwargs):
   calls.append((args,kwargs))
   if args[1]=='version':return SimpleNamespace(returncode=0,stdout=b'v2.6.2 PRIVATE BUILD DETAILS')
   self.assertNotIn('-',args);self.assertNotIn('input',kwargs)
   v=next(seq)
   if isinstance(v,Exception):raise v
   return SimpleNamespace(returncode=1 if v=='failure' else 0, stdout=b'not json' if v=='invalid' else json.dumps(v).encode(),stderr=b'PRIVATE CONFIG SECRETS')
  @contextmanager
  def source(raw):yield Path('/etc/caddy/.private-fixture.tmp')
  with patch.object(m,'source_file',source),patch.object(m.subprocess,'run',side_effect=run),patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(active).encode())),patch.dict(m.os.environ,{},clear=True):
   result=m.baseline_comparison(b'bubblewash.co {\n reverse_proxy localhost:3000\n}\n# {$PRIVATE_NAME}\n')
  self.assertTrue(all(c[0][1] in ('version','adapt') for c in calls));self.assertEqual(len(calls),4)
  output=json.dumps(result)
  for secret in ('private.example','private-secret','PRIVATE CONFIG','PRIVATE_NAME'):self.assertNotIn(secret,output)
  return result
 def test_equal_baseline_candidate_exact(self):
  r=self.exercise();self.assertTrue(r['siblingEqualsFile']);self.assertTrue(r['fileEqualsActive']);self.assertTrue(r['candidateExactAdditiveDelta']);self.assertEqual(r['environmentPlaceholderCount'],1);self.assertEqual(r['environmentPlaceholderUnsetCount'],1)
 def test_stdin_file_context_mismatch(self):
  r=self.exercise(stdin={'other':'SECRET'});self.assertFalse(r['siblingEqualsFile']);self.assertTrue(r['fileEqualsActive']);self.assertFalse(r['candidateExactAdditiveDelta'])
 def test_active_drift_only_classification_no_values(self):
  a=copy.deepcopy(BEFORE);a['logging']={'private':'SECRET'};r=self.exercise(active=a);self.assertFalse(r['fileEqualsActive']);self.assertEqual(r['differentSections'],['logging']);self.assertFalse(r['httpDifference'])
 def test_failed_command_not_equal_or_disclosed(self):
  r=self.exercise(stdin='failure');self.assertEqual(r['sibling']['status'],'adapt-command-failed');self.assertNotIn('siblingEqualsFile',r)
 def test_invalid_json(self):self.assertEqual(self.exercise(file='invalid')['file']['status'],'adapt-non-json')
 def test_timeout(self):self.assertEqual(self.exercise(stdin=subprocess.TimeoutExpired('caddy',30))['sibling']['status'],'adapt-timeout')
 def test_candidate_rejects_unrelated_delta(self):
  a=copy.deepcopy(BEFORE);a['apps']['http']['servers']['srv0']['routes'].append(ROUTE);a['admin']={'disabled':True};self.assertFalse(self.exercise(candidate=a)['candidateExactAdditiveDelta'])
 def test_route_shape_and_diff_redact_secrets(self):
  a=copy.deepcopy(BEFORE);route=copy.deepcopy(ROUTE);route['group']='PRIVATE-GROUP';route['SECRETKEY']='SECRET';a['apps']['http']['servers']['srv0']['routes'].append(route)
  a['apps']['tls']={'automation':{'policies':[{'subjects':['PRIVATEHOST','staff.bubblewash.co']}]}}
  r=self.exercise(candidate=a)['candidateDiagnostic'];out=json.dumps(r)
  for secret in ('PRIVATE-GROUP','SECRETKEY','SECRET','PRIVATEHOST','srv0'):self.assertNotIn(secret,out)
  self.assertEqual(r['staffOnlyRouteShapes'][0]['group'],'REDACTED');self.assertFalse(r['tlsUnchanged'])
 def test_shape_only_mismatch_isolated(self):
  a=copy.deepcopy(BEFORE);route=copy.deepcopy(ROUTE);route['group']='private';a['apps']['http']['servers']['srv0']['routes'].append(route)
  r=self.exercise(candidate=a);self.assertFalse(r['candidateExactAdditiveDelta']);self.assertTrue(r['candidateDiagnostic']['afterRemovingStaffOnlyRoutesEqualsBaseline'])
 def test_order_only_proof(self):
  b=copy.deepcopy(BEFORE);b['apps']['http']['servers']['srv0']['routes'].append({'terminal':False})
  a=copy.deepcopy(b);a['apps']['http']['servers']['srv0']['routes'].reverse();a['apps']['http']['servers']['srv0']['routes'].append(ROUTE)
  self.assertTrue(m.candidate_diagnostic(b,a)['remainingDifferenceIsOnlyTopLevelRouteOrder'])
 def test_sibling_cleanup_on_failure(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory);config=path/'Caddyfile';config.write_bytes(b'original')
   # Production ownership guards remain; this fixture only bypasses ancestor metadata.
   original=Path.lstat
   def metadata(item):
    if item==path or item in path.parents:return SimpleNamespace(st_uid=0,st_mode=0o40755)
    return original(item)
   with patch.object(m,'CONFIG',config),patch.object(Path,'lstat',metadata):
    with self.assertRaises(RuntimeError):
     with m.source_file(b'candidate') as temporary:
      self.assertEqual(temporary.read_bytes(),b'candidate');self.assertEqual(temporary.stat().st_mode & 0o777,0o600);raise RuntimeError('import cycle')
   self.assertEqual(list(path.iterdir()),[config]);self.assertEqual(config.read_bytes(),b'original')
 def test_difference_details_types_counts_redaction_and_bounds(self):
  result=m.difference_details({'PRIVATEKEY':{'subjects':['SECRET1']}},{'PRIVATEKEY':{'subjects':['SECRET2','SECRET3']},'ANOTHERSECRET':42})
  output=json.dumps(result)
  for secret in ('PRIVATEKEY','SECRET1','SECRET2','SECRET3','ANOTHERSECRET','42'):self.assertNotIn(secret,output)
  length=next(item for item in result if item['path'].endswith('/LENGTH'))
  self.assertEqual(length['before'],{'type':'array','count':1});self.assertEqual(length['after'],{'type':'array','count':2})
  presence=next(item for item in result if item['path'].endswith('/PRESENCE'))
  self.assertEqual(presence['before'],{'type':'missing'});self.assertEqual(presence['after'],{'type':'number'})
  self.assertEqual(len(m.difference_details([0]*200,[1]*200)),80)
  a=b=0
  for _ in range(30):a={'SECRET':a};b={'SECRET':b if isinstance(b,dict) else 1}
  deep=m.difference_details(a,b);self.assertLessEqual(len(deep[0]['path'].split('/')),16);self.assertNotIn('SECRET',json.dumps(deep))
if __name__=='__main__':unittest.main()


