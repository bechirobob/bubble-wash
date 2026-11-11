import json,unittest
import inspect_retained_runner as r
from uat_update_engine import Refused
class Tests(unittest.TestCase):
 def test_fixed_receipt(self):
  value={'readOnly':True,'automaticRetry':False,'guards':dict.fromkeys(r.GUARDS,True)}
  self.assertEqual(r.validate_receipt(json.dumps(value).encode()),value)
  for key,val in [('readOnly',False),('automaticRetry',True),('guards',{'secret':'no'})]:
   with self.subTest(key=key),self.assertRaises(Refused):r.validate_receipt(json.dumps({**value,key:val}).encode())
 def test_readonly_bootstrap(self):
  code=r.bootstrap();compile(code,'bootstrap','exec')
  self.assertIn('.diagnose(',code);self.assertNotIn('.receive(',code);self.assertNotIn('.execute(',code)
  self.assertIn('signal.alarm(120)',code)
