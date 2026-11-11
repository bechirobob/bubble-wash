import json,unittest
import archive_staging_runner as r
from uat_update_engine import Refused
class Tests(unittest.TestCase):
 def test_fixed_archive_receipt(self):
  value={'archived':True,'automaticRetry':False,'serviceChanged':False}
  self.assertEqual(r.validate_receipt(json.dumps(value).encode()),value)
  for key in value:
   with self.subTest(key=key),self.assertRaises(Refused):r.validate_receipt(json.dumps({**value,key:not value[key]}).encode())
 def test_archive_only_bootstrap(self):
  code=r.bootstrap();compile(code,'bootstrap','exec')
  self.assertIn('.archive(',code);self.assertNotIn('.receive(',code);self.assertNotIn('.execute(',code)
  self.assertIn('signal.alarm(120)',code)
