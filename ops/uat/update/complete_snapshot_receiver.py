"""Complete one verified stopped UAT attempt without repeating its snapshot.
Existing snapshot, original journal and compatible rollback are retained.
"""
import fcntl,hashlib,os,time
from pathlib import Path
import resume_stopped_receiver as prior
import resume_snapshot_diagnostic as diagnostic
import stopped_resume_guards as admission
from uat_update_engine import Contract,FileJournal
WORK=Path('/opt/bubblewash-uat/complete-verified-snapshot')
OP='uat-complete-20261112-8bd37b0-01'
ARTIFACT_SHA='d5cdfb39241c8cdfcd88c4f30a095d4f1973d154bbd93e96d9a2404d9ec4e14b'
ARTIFACT_SIZE=149973815

def complete(r,original,candidate,execution_deadline):
 stage='admission';lock=None;root=None;work=None;journal=None
 try:
  prior.require(os.geteuid()==0 and candidate['runtimeRevision']==diagnostic.REVISION)
  r.c.trusted(admission.WORK/'host.lock',mode=0o600)
  lock=os.open(admission.WORK/'host.lock',os.O_RDONLY|os.O_NOFOLLOW);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  first=diagnostic.diagnose(r,original,candidate)
  prior.require(first['readOnly'] is True and all(first['guards'].values()))
  baseline=prior.commitments(prior.DATABASE);prior.require(prior.commitments(prior.WORK/'snapshot.sqlite')==baseline)
  # Exact artifact retained from the approved successful staging, not new code.
  artifact=prior.WORK/'artifact.tar.gz';r.c.trusted(artifact,mode=0o600)
  with artifact.open('rb') as f:prior.require(os.fstat(f.fileno()).st_size==ARTIFACT_SIZE and hashlib.file_digest(f,'sha256').hexdigest()==ARTIFACT_SHA)
  owner=prior.pwd.getpwnam('bubblewash-uat');prior.require(owner.pw_uid>0 and owner.pw_gid>0 and owner.pw_shell=='/usr/sbin/nologin' and owner.pw_dir==str(prior.DATABASE.parent))
  identity=r.c.trusted(prior.DATABASE,owner=owner.pw_uid,mode=0o600)[:2]
  loaded=r.loaded_unit();configuration=prior.config(r);production=r.c.production_inventory();retained=admission._retained(r)
  previous_journal=[r.c.read(prior.WORK/'journal'/name,8192) for name in ('active-operation',diagnostic.OP+'.jsonl')]
  snapshot_identity=r.c.trusted(prior.WORK/'snapshot.sqlite',mode=0o600)
  def stable(stopped=True):
   prior.require(admission._retained(r)==retained and r.loaded_unit()==loaded and prior.config(r)==configuration and r.c.production_inventory()==production)
   prior.require(r.c.trusted(prior.DATABASE,owner=owner.pw_uid,mode=0o600)[:2]==identity)
   prior.require(r.c.trusted(prior.WORK/'snapshot.sqlite',mode=0o600)==snapshot_identity)
   prior.require([r.c.read(prior.WORK/'journal'/name,8192) for name in ('active-operation',diagnostic.OP+'.jsonl')]==previous_journal)
   if stopped:admission._stopped(r)
  stable();prior.require(int(time.time()*1000)<prior.OLD_EXPIRY-120000)
  root=prior.fs.trusted_directory(WORK.parent);work=prior.fs.private_directory(root,WORK.name)
  fd=prior.fs.private_directory(work,'journal');os.close(fd)
  contract=Contract(OP,original['runtimeRevision'],candidate['runtimeRevision'],ARTIFACT_SHA,configuration,baseline['accounts'],baseline['schema'],prior.OLD_EXPIRY)
  journal=FileJournal(WORK/'journal');journal.claim(contract)
  # Revalidate immediately before the only database write, after durable claim.
  prior.require(all(diagnostic.diagnose(r,original,candidate)['guards'].values()))
  prior.require(prior.commitments(prior.DATABASE)==baseline and prior.commitments(prior.WORK/'snapshot.sqlite')==baseline)
  stable();prior.require(int(time.time()*1000)<prior.OLD_EXPIRY-120000)
  prior.require(type(execution_deadline) in (int,float) and execution_deadline-time.monotonic()>=120)
  stage='extension';journal.record('enter:'+stage)
  prior.extend_offline(r,baseline,OP,owner)
  extended=prior.commitments(prior.DATABASE)
  prior.require(extended['accounts']==baseline['accounts'] and extended['active']==baseline['active'])
  prior.require(set(extended['records'])==set(baseline['records'])|{'staff_uat_extensions'})
  prior.require(all(extended['records'][k]==v for k,v in baseline['records'].items() if k!='staff_uat_audit'))
  stable();journal.record('done:'+stage)
  stage='switch';journal.record('enter:'+stage)
  r.p.verify_runtime(prior.APP,prior.UNIT,original['runtimeRevision'],original['runtimeFiles'],original['unitSha256'])
  for name in ('candidate','compatible-rollback'):r.p.verify_runtime(prior.WORK/name,prior.UNIT,candidate['runtimeRevision'],candidate['runtimeFiles'],candidate['unitSha256'])
  prior.fs.exchange_directories(prior.APP,prior.WORK/'candidate')
  r.p.verify_runtime(prior.APP,prior.UNIT,candidate['runtimeRevision'],candidate['runtimeFiles'],candidate['unitSha256']);stable();journal.record('done:'+stage)
  stage='start';journal.record('enter:'+stage)
  r.t.exchange(['/usr/bin/systemctl','--job-mode=fail','start',prior.SERVICE],b'',timeout=45,limit=4096);journal.record('done:'+stage)
  stage='postverify';journal.record('enter:'+stage);deadline=time.monotonic()+30
  while True:
   try:
    after=r.c.collect_restart_isolation(candidate,before_restart=False)
    prior.require(after['database']=={'device':str(identity[0]),'inode':str(identity[1])} and after['productionPaths']==production)
    stable(False);r.health();prior.require(prior.commitments(prior.DATABASE)==extended)
    prior.require(r.c.collect_restart_isolation(candidate,before_restart=False)==after)
    journal.record('done:'+stage)
    return {'state':'verified','stage':stage,'automaticRetry':False}
   except Exception:
    if time.monotonic()>=deadline:raise
    time.sleep(1)
 except Exception:
  if journal is not None:
   try:journal.record('uncertain:'+stage)
   except Exception:pass
  return {'state':'inspection-required','stage':stage,'automaticRetry':False}
 finally:
  if journal is not None:journal.close()
  for fd in (work,root,lock):
   if fd is not None:os.close(fd)
