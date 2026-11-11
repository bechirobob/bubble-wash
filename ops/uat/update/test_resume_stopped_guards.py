import json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import resume_stopped_receiver as r
import stopped_resume_guards as g
import resume_stopped_runner as runner

class Guards(unittest.TestCase):
 def test_exact_retained_events(self):
  rows=[dict(sequence=i,event=e,contract='a'*64 if i==0 else '') for i,e in enumerate(g.EVENTS)]
  raw=lambda:('\n'.join(json.dumps(x) for x in rows)+'\n').encode()
  g.validate_journal((g.OP+'\n').encode(),raw())
  for event in ('enter:snapshot','done:switch','done:start'):
   rows[-1]['event']=event
   with self.assertRaises(ValueError):g.validate_journal((g.OP+'\n').encode(),raw())
 def test_wal_without_shm_never_opens_sqlite(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'test.sqlite';p.touch(mode=0o600);p.chmod(0o600)
   w=Path(str(p)+'-wal');w.write_bytes(b'wal');w.chmod(0o600)
   with patch.object(r,'DATABASE',p),patch.object(r.sqlite3,'connect') as connect:
    with self.assertRaises(ValueError):r.commitments(p)
    connect.assert_not_called()
 def test_closed_sqlite_reads_immutable_and_creates_no_sidecars(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'test.sqlite';db=sqlite3.connect(p)
   db.executescript("CREATE TABLE staff_uat_accounts(username TEXT,status TEXT,starts_at INT,expires_at INT); INSERT INTO staff_uat_accounts VALUES('test','active',1,2);");db.close();p.chmod(0o600)
   with patch.object(r,'DATABASE',p):
    value=r.commitments(p);self.assertEqual(value['active'],[('test',1,2)])
   self.assertEqual(list(Path(d).iterdir()),[p])
 def test_runner_dispatches_only_new_receiver_and_transmits_sql_source(self):
  code=runner.bootstrap();compile(code,'synthetic','exec')
  self.assertIn("sys.modules['resume_stopped_receiver'].receive",code)
  self.assertIn("module.__source__=item['source']",code)
  self.assertIn(('offline_uat_extension','ops/uat/update/offline_uat_extension.py'),runner.MODULES)
  self.assertNotIn('restore_original_start',code)
