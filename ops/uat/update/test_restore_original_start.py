import json,os,tempfile,types,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import restore_original_start as m
class Tests(unittest.TestCase):
 def test_journal_exact_no_switch(self):
  raw=b''.join((json.dumps(dict(sequence=i,event=e,contract='a'*64 if i==0 else ''))+'\n').encode() for i,e in enumerate(m.EVENTS))
  m.validate_journal((m.OP+'\n').encode(),raw)
  with self.assertRaises(ValueError):m.validate_journal((m.OP+'\n').encode(),raw.replace(b'uncertain:stopped',b'enter:switch'))
 def setup_fake(self,root):
  (root/'host.lock').touch()
  return types.SimpleNamespace(c=types.SimpleNamespace(trusted=Mock(),collect_restart_isolation=Mock()),t=types.SimpleNamespace(exchange=Mock()),health=Mock())
 def test_single_start_and_marker_blocks_repeat(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);r=self.setup_fake(root)
   with patch.object(m,'WORK',root),patch.object(m,'_retained',return_value='same'),patch.object(m,'_original',return_value='same'),patch.object(m,'_stopped'),patch.object(m.os,'geteuid',return_value=0):
    self.assertEqual(m.restore(r,{})['state'],'verified');self.assertEqual(m.restore(r,{})['state'],'precheck-failed')
   r.t.exchange.assert_called_once();self.assertEqual(r.t.exchange.call_args.args[0],['/usr/bin/systemctl','--job-mode=fail','start',m.SERVICE]);self.assertTrue((root/m.ATTEMPT).exists())
 def test_uncertain_start_never_retries(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);r=self.setup_fake(root);r.t.exchange.side_effect=TimeoutError()
   with patch.object(m,'WORK',root),patch.object(m,'_retained',return_value='same'),patch.object(m,'_original',return_value='same'),patch.object(m,'_stopped'),patch.object(m.os,'geteuid',return_value=0):self.assertEqual(m.restore(r,{})['state'],'start-uncertain')
   r.t.exchange.assert_called_once();self.assertTrue((root/m.ATTEMPT).exists())
 def test_precheck_refuses_without_marker_or_start(self):
  with patch.object(m,'_retained',side_effect=ValueError()),patch.object(m.os,'geteuid',return_value=0):
   r=Mock();self.assertEqual(m.restore(r,{})['state'],'precheck-failed');r.t.exchange.assert_not_called()
