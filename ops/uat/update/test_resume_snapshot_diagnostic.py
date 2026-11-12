import json,os,sqlite3,tempfile,types,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import resume_snapshot_diagnostic as d
class Tests(unittest.TestCase):
 def run_case(self,bad_journal=False,sidecar=False,corrupt=False,live_failure=False):
  with tempfile.TemporaryDirectory() as tmp:
   work=Path(tmp);snapshot=work/'snapshot.sqlite';journal=work/'journal';journal.mkdir();dbpath=work/'live.sqlite'
   (journal/'active-operation').write_text(d.OP+'\n')
   events=['claimed','enter:artifact','done:artifact','enter:stage','done:stage','enter:snapshot','uncertain:snapshot']
   if bad_journal:events[-1]='enter:extension'
   (journal/(d.OP+'.jsonl')).write_text(''.join(json.dumps({'sequence':i,'event':e,'contract':'a'*64 if i==0 else ''})+'\n' for i,e in enumerate(events)))
   if corrupt:snapshot.write_bytes(b'bad sqlite')
   else:
    with sqlite3.connect(snapshot) as db:db.execute('CREATE TABLE synthetic(x INTEGER)')
   if sidecar:(work/'snapshot.sqlite-wal').write_bytes(b'not a real WAL')
   r=types.SimpleNamespace(c=types.SimpleNamespace(trusted=Mock(return_value=(1,2)),read=Mock(side_effect=lambda p,n:Path(p).read_bytes()),production_inventory=Mock(return_value=[])),p=types.SimpleNamespace(verify_runtime=Mock(return_value={'ok':True})))
   live={'schema':'PRIVATE-schema','accounts':'PRIVATE-accounts','active':[('PRIVATE-user',d.resume.OLD_EXPIRY-604800000,d.resume.OLD_EXPIRY)],'records':{'business':'PRIVATE-records'}}
   commits=Mock(return_value=live)
   if live_failure:commits.side_effect=ValueError('PRIVATE exception')
   with patch.object(d.resume,'WORK',work),patch.object(d.resume,'DATABASE',dbpath),patch.object(d.resume,'commitments',commits),patch.object(d.resume.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1)),patch.object(d.admission,'_original',return_value={}),patch.object(d.admission,'_stopped',return_value=None),patch.object(d.admission,'_retained',return_value=('retained',)):
    result=d.diagnose(r,{},dict(runtimeFiles={},unitSha256='test'))
   return result,[call.args[0].name for call in commits.call_args_list]
 def test_fixed_boolean_privacy_and_matching_snapshot(self):
  result,calls=self.run_case();self.assertEqual(set(result['guards']),set(d.GUARDS));self.assertTrue(all(type(x)is bool for x in result['guards'].values()));self.assertNotIn('PRIVATE',repr(result));self.assertTrue(result['guards']['snapshot-integrity']);self.assertTrue(result['guards']['snapshot-records-match']);self.assertEqual(calls,['live.sqlite','snapshot.sqlite'])
 def test_bad_journal_blocks_database_reads(self):
  result,calls=self.run_case(bad_journal=True);self.assertFalse(result['guards']['resume-journal-snapshot-only']);self.assertEqual(calls,[])
 def test_invalid_snapshot_blocks_comparison_read(self):
  result,calls=self.run_case(corrupt=True);self.assertFalse(result['guards']['snapshot-integrity']);self.assertNotIn('snapshot.sqlite',calls)
 def test_sidecar_snapshot_never_opened_by_comparison(self):
  result,calls=self.run_case(sidecar=True);self.assertFalse(result['guards']['snapshot-integrity']);self.assertNotIn('snapshot.sqlite',calls)
 def test_private_failure_not_returned(self):
  result,_=self.run_case(live_failure=True);self.assertFalse(result['guards']['live-readable']);self.assertNotIn('PRIVATE',repr(result))
