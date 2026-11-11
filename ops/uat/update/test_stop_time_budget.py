import unittest
from unittest.mock import patch
from live_host_adapter import HostAdapter
from uat_update_engine import Refused
from update_runner_draft import bootstrap
class Tests(unittest.TestCase):
 def adapter(self,deadline):
  a=HostAdapter.__new__(HostAdapter);a.execution_deadline=deadline;return a
 def test_less_than180_seconds_refuses_before_any_host_access(self):
  with patch('live_host_adapter.time.monotonic',return_value=421):
   with self.assertRaises(Refused):self.adapter(600).stop(None)
 def test_missing_budget_refused(self):
  with self.assertRaises(Refused):self.adapter(None)._require_stop_budget()
 def test_budget_and_bootstrap_propagation(self):
  with patch('live_host_adapter.time.monotonic',return_value=420):self.adapter(600)._require_stop_budget()
  code=bootstrap();self.assertLess(code.index('execution_deadline=time.monotonic()+600'),code.index('sys.stdin.buffer.read(4)'));self.assertIn("payload['candidate'],execution_deadline)",code)
