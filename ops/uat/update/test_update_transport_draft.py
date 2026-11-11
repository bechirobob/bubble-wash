import hashlib,io,os,struct,tempfile,unittest
from pathlib import Path
from update_receiver_draft import validate_request,receive_artifact
from update_runner_draft import validate_context,bootstrap,write_stream,prepare_bundle
from uat_update_engine import Refused
R=dict(operationId='synthetic-update-operation-01',candidateRevision='b'*40,artifactSha256=hashlib.sha256(b'fixture').hexdigest(),artifactSize=7,interruptionApproved=True,quietWindowCoordinated=True,adminRouteApproved=True,expectedExpiryMs=10000000)
class Tests(unittest.TestCase):
 def test_request_requires_all_attestations(self):
  validate_request(R)
  for key in ('interruptionApproved','quietWindowCoordinated','adminRouteApproved'):
   with self.assertRaises(Refused):validate_request({**R,key:False})
 def test_context_first_attempt_and_no_debug(self):
  e=dict(GITHUB_REPOSITORY='bechirobob/bubble-wash',GITHUB_REF='refs/heads/main',GITHUB_SHA='a'*40,GITHUB_RUN_ATTEMPT='1',GITHUB_EVENT_NAME='workflow_dispatch');validate_context(e,'a'*40)
  for changes in ({'GITHUB_RUN_ATTEMPT':'2'},{'RUNNER_DEBUG':'1'},{'GITHUB_SHA':'b'*40}):
   with self.assertRaises(Refused):validate_context({**e,**changes},'a'*40)
 def test_missing_expiry_and_nonmain_candidate_refused(self):
  without=dict(R);without.pop('expectedExpiryMs')
  with self.assertRaises(Refused):validate_request(without)
  e=dict(GITHUB_REPOSITORY='bechirobob/bubble-wash',GITHUB_REF='refs/heads/main',GITHUB_SHA='a'*40,GITHUB_RUN_ATTEMPT='1',GITHUB_EVENT_NAME='workflow_dispatch')
  with self.assertRaises(Refused):prepare_bundle('/not-accessed','a'*40,'b'*40,e,R)
 def test_constant_small_bootstrap(self):
  code=bootstrap();compile(code,'synthetic','exec');self.assertLess(len(code),4096);self.assertIn('1048576',code)
 def test_stream_and_exclusive_receive(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'input').write_bytes(b'fixture');out=io.BytesIO();write_stream(out,b'header',p/'input',7,R['artifactSha256']);self.assertEqual(out.getvalue(),b'headerfixture')
   fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
   try:
    receive_artifact(io.BytesIO(b'fixture'),fd,7,R['artifactSha256']);self.assertEqual((p/'artifact.tar.gz').read_bytes(),b'fixture')
    with self.assertRaises(FileExistsError):receive_artifact(io.BytesIO(b'fixture'),fd,7,R['artifactSha256'])
   finally:os.close(fd)
 def test_trailing_artifact_refused(self):
  with tempfile.TemporaryDirectory() as d:
   fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY)
   try:
    with self.assertRaises(Refused):receive_artifact(io.BytesIO(b'fixtureextra'),fd,7,R['artifactSha256'])
   finally:os.close(fd)
