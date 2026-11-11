import contextlib,io,json,tempfile,types,unittest
from update_runner_draft import bounded_transport,validate_receipt
from uat_update_engine import Refused
class Transport:
 @contextlib.contextmanager
 def child_environment(self,command):
  assert command[:3]==['/usr/local/bin/tailscale','ssh','root@hermes']
  yield {'PATH':'/usr/bin','LC_ALL':'C'}
class Selector:
 def __init__(self):self.items={}
 def register(self,stream,event):self.items[stream]=event
 def unregister(self,stream):self.items.pop(stream)
 def get_map(self):return self.items
 def select(self,timeout):return [(types.SimpleNamespace(fileobj=s),0) for s in list(self.items)]
 def close(self):self.items.clear()
class Process:
 def __init__(self,out,err=b'',code=0):
  self.stdout=tempfile.TemporaryFile();self.stderr=tempfile.TemporaryFile();self.stdout.write(out);self.stdout.seek(0);self.stderr.write(err);self.stderr.seek(0);self.code=code;self.killed=False
 def wait(self,timeout):return self.code
 def poll(self):return self.code
 def kill(self):self.killed=True;self.code=-9
class Tests(unittest.TestCase):
 def run_case(self,out,err=b'',code=0,clock=lambda:0):
  p=Process(out,err,code)
  def spawn(command,**kwargs):
   self.assertEqual(kwargs['env'],{'PATH':'/usr/bin','LC_ALL':'C'});self.assertLess(len(command[-1]),4096);return p
  return bounded_transport(io.BytesIO(b'payload'),Transport(),popen=spawn,selector_factory=Selector,clock=clock)
 def test_valid_receipt(self):
  r=self.run_case(b'{"state":"verified","stage":"postverify","automaticRetry":false}')
  self.assertEqual(r['state'],'verified')
 def test_malformed_or_extra_receipt_refused(self):
  for raw in (b'not json',b'{"state":"verified","stage":"stop","automaticRetry":false}',b'{"state":"verified","stage":"postverify","automaticRetry":false,"secret":"bad"}'):
   with self.assertRaises((Refused,ValueError)):self.run_case(raw)
 def test_stdout_stderr_limits(self):
  for out,err in ((b'x'*20000,b''),(b'{}',b'x'*20000)):
   with self.assertRaises(Refused):self.run_case(out,err)
 def test_timeout(self):
  ticks=iter((0,1000))
  with self.assertRaises(Refused):self.run_case(b'',clock=lambda:next(ticks))
 def test_nonzero(self):
  with self.assertRaises(Refused):self.run_case(b'{}',code=1)
if __name__=='__main__':unittest.main()
