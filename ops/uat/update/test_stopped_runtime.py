import unittest
from live_host_adapter import stopped_runtime
from uat_update_engine import Refused
class Tests(unittest.TestCase):
 def test_stopped(self):stopped_runtime('(uo) 0 "/"',123,None,None);stopped_runtime('(uo) 0 "/"',123,456,'')
 def test_remaining_process_job_or_cgroup(self):
  for args in [('(uo) 1 "/job"',123,None,None),('(uo) 0 "/"',123,123,None),('(uo) 0 "/"',123,None,'234\n')]:
   with self.assertRaises(Refused):stopped_runtime(*args)
