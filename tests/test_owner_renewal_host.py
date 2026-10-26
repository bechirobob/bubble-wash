"""No host execution or credentials: source, refusal and private transport contracts."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest import mock
ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
host=load('renewal','ops/owner-renewal-host.py');old=load('old','ops/owner-document-host.py');host.old=old
transport=load('transport','ops/owner-renewal-transport.py')
req={'mode':'check','approved':False,'recipient':{'email':'fixture@example.invalid','name':'Fixture'},'context':{'controlSha':'a'*40,'runtimeSha':host.LIVE,'runId':'123','runAttempt':'1','actor':'fixture'},'publicKey':'','backup':None,'expectedFingerprint':''}
class RenewalHostTests(unittest.TestCase):
 def test_check_accepts_no_mutation_inputs(self):self.assertEqual(host.validate(copy.deepcopy(req)),req)
 def test_wrong_runtime_refused(self):
  r=copy.deepcopy(req);r['context']['runtimeSha']='b'*40
  with self.assertRaises(ValueError):host.validate(r)
 def test_retry_refused(self):
  r=copy.deepcopy(req);r['context']['runAttempt']='2'
  with self.assertRaises(ValueError):host.validate(r)
 def test_check_cannot_carry_fingerprint(self):
  r=copy.deepcopy(req);r['expectedFingerprint']='a'*64
  with self.assertRaises(ValueError):host.validate(r)
 def test_renew_requires_approval(self):
  r=copy.deepcopy(req);r['mode']='renew-document'
  with self.assertRaises(ValueError):host.validate(r)
 def test_new_or_additive_modes_refused(self):
  for mode in ('issue-document','create','reset'):
   with self.assertRaises(ValueError):host.validate({**req,'mode':mode})
 def test_public_status_allowlist(self):
  r={'eligible':True,'fingerprint':'a'*64,'state':'invited','role':'admin','allStaffAccess':True}
  host.result_valid(r)
  for extra in ({'email':'fixture@example.invalid'},{'token':'private'},{'expiresAt':'today'}):
   with self.assertRaises(ValueError):host.result_valid({**r,**extra})
 def test_unknown_private_labels_refused(self):
  r={'eligible':False,'fingerprint':'a'*64,'state':'private-value','role':'admin','allStaffAccess':True}
  with self.assertRaises(ValueError):host.result_valid(r)
 def test_explicit_configuration_preserved(self):
  host.modules={'preserving':types.SimpleNamespace(parse=lambda raw:json.loads(raw))}
  d={'NODE_ENV':'production','BUBBLEWASH_BOOKINGS_DISABLED':'true','BUBBLEWASH_STAFF_AUTH_DISABLED':'false','BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false'}
  raw=json.dumps(d).encode();self.assertEqual(host.configuration(raw),(d,raw))
  with self.assertRaises(ValueError):host.configuration(json.dumps({**d,'BUBBLEWASH_BOOKINGS_DISABLED':'false'}).encode())
 def test_all_dependency_hashes_checked(self):
  for path in transport.SOURCE_PINS:self.assertTrue(transport.source(path))
 def test_payload_compiles_and_never_uses_old_entry(self):
  pins={'runtimeSha':host.LIVE,'runtimePins':json.loads((ROOT/'ops/pwa-update-source-pins.json').read_bytes())}
  raw=transport.payload(req,pins);compile(raw,'fixture','exec')
  self.assertIn(b'host.main(',raw);self.assertNotIn(b'base.entry(',raw)
 def test_no_service_or_config_mutation_paths(self):
  tree=ast.parse((ROOT/'ops/owner-renewal-host.py').read_text())
  attrs={n.func.attr for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)}
  self.assertFalse(attrs & {'stop','hold','resume','mutate','recovery_copy','unlink','replace','service'})
 def test_child_explicit_unprivileged_uid_and_groups(self):
  tree=ast.parse((ROOT/'ops/owner-renewal-host.py').read_text())
  calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='Popen']
  self.assertEqual(len(calls),1);kw={k.arg:ast.unparse(k.value) for k in calls[0].keywords}
  self.assertEqual(kw['user'],'host.owner.pw_uid');self.assertEqual(kw['group'],'host.owner.pw_gid');self.assertEqual(kw['extra_groups'],'[]')
  self.assertEqual(kw['stdout'],'subprocess.PIPE');self.assertEqual(kw['stderr'],'subprocess.PIPE')
 def test_backup_skipped_only_for_readonly(self):
  source=(ROOT/'ops/owner-renewal-host.py').read_text()
  self.assertIn("if request['mode']=='renew-document':super().backup(values)",source)
  self.assertIn('host.unchanged(raw);host.effective(host.values)',source)
 def test_workflow_is_manual_and_sequential(self):
  s=(ROOT/'.github/workflows/owner-invitation-renewal.yml').read_text()
  for x in ('workflow_dispatch:','group: bubblewash-production','cancel-in-progress: false','node-version: 22','contents: read','--runner-only','status_fingerprint'):
   self.assertIn(x,s)
  self.assertNotIn('schedule:',s);self.assertNotIn('issue-document',s)
if __name__=='__main__':unittest.main()
