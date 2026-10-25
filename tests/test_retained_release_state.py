import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('incident',Path(__file__).resolve().parents[1]/'ops/inspect-retained-release-state.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
 def test_safe_read_refuses_link_and_mutable_file(self):
  file=self.root/'data';file.write_bytes(b'private');link=self.root/'link';link.symlink_to(file)
  self.assertEqual(m.read(file),b'private')
  with self.assertRaises(ValueError):m.read(link)
  file.chmod(0o666)
  with self.assertRaises(ValueError):m.read(file)
 def test_snapshot_hash_without_database_connection(self):
  file=self.root/('integration-snapshot-'+m.PLAN_ID[:16]+'.sqlite');file.write_bytes(b'opaque bytes');file.chmod(0o600)
  with patch.object(m,'RUNTIME',self.root):result=m.snapshot(file)
  self.assertEqual(result['size'],12);self.assertEqual(len(result['sha256']),64)
 def test_database_sidecar_metadata_never_reads_contents(self):
  db=self.root/'live.sqlite';db.write_bytes(b'private');wal=Path(str(db)+'-wal');wal.write_bytes(b'private');wal.chmod(0o600)
  with patch.object(m,'read',side_effect=AssertionError('content read forbidden')):
   result=m.database_metadata({'database':str(db),'snapshot':str(self.root/'absent.sqlite')})
  self.assertTrue(result['database']['-wal']['exists']);self.assertFalse(result['database']['-shm']['exists'])
  self.assertNotIn('private',json.dumps(result))
 def test_unit_queries_are_read_only_and_no_args_exposed(self):
  child=types.SimpleNamespace(returncode=0,stdout=b'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=\n')
  with patch.object(m.subprocess,'run',return_value=child) as run:result=m.unit('user','bubblewash-local.service')
  self.assertEqual(result['activeState'],'inactive');self.assertFalse(result['mainPidPresent'])
  self.assertIn('show',run.call_args.args[0]);self.assertNotIn('stop',run.call_args.args[0])
 def test_timer_without_pid_properties_is_supported(self):
  child=types.SimpleNamespace(returncode=0,stdout=b'LoadState=loaded\nActiveState=active\nSubState=waiting\nJob=\n')
  with patch.object(m.subprocess,'run',return_value=child):self.assertFalse(m.unit('system','bubblewash-maintenance.timer')['mainPidPresent'])
 def test_marker_does_not_match_different_current_pointer(self):
  state=self.root/'state';(state/'plans').mkdir(parents=True);runtime=self.root/'runtime';runtime.mkdir()
  old=self.root/'old';old.mkdir();candidate=self.root/'candidate';candidate.mkdir();current=self.root/'current';current.symlink_to(candidate)
  plan={'old':str(old),'candidate':str(candidate),'fallback':str(self.root/'fallback'),'oldSha':'a'*40,'releaseShas':{'candidate':'b'*40,'fallback':'c'*40},'snapshot':str(runtime/('integration-snapshot-'+m.PLAN_ID[:16]+'.sqlite')),'database':str(self.root/'db')}
  raw=json.dumps(plan).encode();(state/'plans'/(m.PLAN_ID+'.json')).write_bytes(raw)
  (runtime/'current-release').write_text('sha='+('a'*40)+'\nrelease=old\npath='+str(old)+'\n')
  with patch.object(m,'STATE',state),patch.object(m,'RUNTIME',runtime),patch.object(m,'CURRENT',current),patch.object(m,'PLAN_SHA',m.hashlib.sha256(raw).hexdigest()),patch.object(m,'unit',return_value={}):
   result=m.inspect()
  self.assertEqual(result['pointer']['knownRole'],'candidate');self.assertFalse(result['marker']['matchesPointerRole'])
 def test_partial_failure_does_not_hide_other_observations_or_private_errors(self):
  with patch.object(m,'STATE',self.root),patch.object(m,'RUNTIME',self.root),patch.object(m,'CURRENT',self.root/'absent'),patch.object(m,'unit',side_effect=ValueError('PRIVATE_TOKEN')):
   result=m.inspect()
  self.assertFalse(result['planVerified']);self.assertEqual(result['journal'],{'exists':False});self.assertFalse(result['holds']['app-hold']['exists'])
  self.assertNotIn('PRIVATE_TOKEN',json.dumps(result));self.assertFalse(result['databaseOpened'])
if __name__=='__main__':unittest.main()
