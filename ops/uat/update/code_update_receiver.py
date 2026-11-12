"""REVIEW DRAFT. No CLI or import-time IO. Never install/dispatch unreviewed.
Stream is artifact bytes only; request and pins arrive in source-bound bootstrap.
"""
import hashlib
import os
from types import SimpleNamespace
from uat_update_engine import Contract,FileJournal,execute,Refused
from code_update_host import HostAdapter,WORK,pins,PREVIOUS,CANDIDATE,EXPIRY
import host_files


def validate_request(r):
    required={'operationId','candidateRevision','artifactSha256','artifactSize','interruptionApproved','quietWindowCoordinated','adminRouteApproved','expectedExpiryMs'}
    if not isinstance(r,dict) or set(r)!=required:raise Refused('request fields')
    for key in ('interruptionApproved','quietWindowCoordinated','adminRouteApproved'):
        if r[key] is not True:raise Refused('approval missing')
    if type(r['artifactSize']) is not int or not 0<r['artifactSize']<=1024**3:raise Refused('artifact bound')
    if 'expectedExpiryMs' in r and (type(r['expectedExpiryMs']) is not int or r['expectedExpiryMs']<=0):raise Refused('expiry constraint')
    # Reuse engine exact syntax validation without deriving host private values.
    Contract(r['operationId'],'a'*40,r['candidateRevision'],r['artifactSha256'],'b'*64,'c'*64,'d'*64,1).validate()


def receive_artifact(stream,work_fd,size,expected):
    fd=os.open('artifact.tar.gz',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=work_fd)
    h=hashlib.sha256();remaining=size
    try:
        os.fchmod(fd,0o600)
        while remaining:
            chunk=stream.read(min(1024*1024,remaining))
            if not chunk:raise Refused('artifact truncated')
            h.update(chunk);host_files._write(fd,chunk);remaining-=len(chunk)
        if stream.read(1) or h.hexdigest()!=expected:raise Refused('artifact stream mismatch')
        os.fsync(fd);os.fsync(work_fd)
    finally:os.close(fd)


class PreparedAdapter:
    """One preinspection establishes private commitments without reacquiring flock."""
    def __init__(self,host):self.host=host;self.used=False
    def inspect(self,c):
        if self.used:raise Refused('preinspection replay')
        self.used=True
        if self.host.c.collect_restart_isolation(self.host.original,before_restart=False)!=self.host.before:raise Refused('preinspection stale')
        result=self.host._evidence(c.previous_revision);result.require(c,c.previous_revision)
        return result
    def __getattr__(self,name):return getattr(self.host,name)


def receive(stream,request,controls,original_pins,candidate_pins,execution_deadline):
    """Only source-bound bootstrap may call. Returns closed nonsensitive receipt.
    New WORK required; retained WORK blocks every repeat, even before engine claim.
    Host-wide alarm/deadline and exact-source authorization are bootstrap duties.
    """
    stage='admission';adapter=None;root=None;work=None
    try:
        validate_request(request)
        if os.geteuid()!=0:raise Refused('root required')
        pins(original_pins,original_pins['runtimeRevision']);pins(candidate_pins,request['candidateRevision'])
        if original_pins['runtimeRevision']!=PREVIOUS or request['candidateRevision']!=CANDIDATE or request['expectedExpiryMs']!=EXPIRY:raise Refused('successor identity differs')
        root=host_files.trusted_directory(WORK.parent)
        # Exact exclusive creation intentionally refuses any retained update tree.
        work=host_files.private_directory(root,WORK.name)
        journal=host_files.private_directory(work,'journal');os.close(journal)
        stage='artifact'
        receive_artifact(stream,work,request['artifactSize'],request['artifactSha256'])
        stage='inspection'
        adapter=HostAdapter(controls,original_pins,candidate_pins,host_files,execution_deadline=execution_deadline)
        evidence=adapter.inspect(SimpleNamespace(previous_revision=original_pins['runtimeRevision'],candidate_revision=request['candidateRevision']))
        if 'expectedExpiryMs' in request and request['expectedExpiryMs']!=evidence.expiry_ms:raise Refused('expiry constraint differs')
        contract=Contract(request['operationId'],original_pins['runtimeRevision'],request['candidateRevision'],request['artifactSha256'],evidence.configuration_sha256,evidence.accounts_sha256,evidence.schema_sha256,evidence.expiry_ms)
        stage='transaction';receipt=execute(contract,PreparedAdapter(adapter),FileJournal(WORK/'journal'))
        return {'state':receipt.state,'stage':receipt.stage,'automaticRetry':False}
    except Exception:
        return {'state':'inspection-required','stage':stage,'automaticRetry':False}
    finally:
        if adapter is not None:adapter.close()
        if work is not None:os.close(work)
        if root is not None:os.close(root)
