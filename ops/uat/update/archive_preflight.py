"""One fixed retained-preflight archive. No CLI, network or import-time IO.
Never resumes update, deletes data, changes accounts or touches application code.
"""
import ctypes
import fcntl
import hashlib
import os
from pathlib import Path
import stat
from live_host_adapter import DATABASE,database_commitments

WORK='update'
ARCHIVE='update-preflight-cd16d2d'
PARENT=Path('/opt/bubblewash-uat')
ARTIFACT_SHA='ccdd45baabb7382bce8872e010681b6630c50cd851e662e54477ce4df66f9b7a'
ARTIFACT_SIZE=149974479
ORIGINAL='f4fd4ce424c2b363fc5a2196432e0ac2ce7c05a1'

class Refused(ValueError):pass

def require(ok):
    if not ok:raise Refused('retained preflight archive refused')

def ident(s):return (s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def open_checked(parent,name,directory,mode):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|(os.O_DIRECTORY if directory else 0),dir_fd=parent)
    try:
        info=os.fstat(fd)
        require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==mode)
        if not directory:require(info.st_nlink==1)
        return fd,info
    except BaseException:os.close(fd);raise

def _archive(parent,controls,pins):
    """Internal fd entry for synthetic testing. Public API fixes every path."""
    fds=[]
    try:
        require(pins['runtimeRevision']==ORIGINAL)
        work,wi=open_checked(parent,WORK,True,0o700);fds.append(work)
        require(set(os.listdir(work))=={'artifact.tar.gz','journal','host.lock'})
        lock,li=open_checked(work,'host.lock',False,0o600);fds.append(lock)
        require(li.st_size==0)
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        journal,ji=open_checked(work,'journal',True,0o700);fds.append(journal)
        require(os.listdir(journal)==[])
        artifact,ai=open_checked(work,'artifact.tar.gz',False,0o600);fds.append(artifact)
        require(ai.st_size==ARTIFACT_SIZE)
        h=hashlib.sha256();offset=0
        while chunk:=os.pread(artifact,1024*1024,offset):h.update(chunk);offset+=len(chunk)
        require(h.hexdigest()==ARTIFACT_SHA and offset==ARTIFACT_SIZE)
        first=controls.c.collect_restart_isolation(pins,before_restart=False)
        require(database_commitments(DATABASE)['expiry']==1794457808095)
        loaded=controls.loaded_unit();controls.quiet_sample()
        require(controls.c.collect_restart_isolation(pins,before_restart=False)==first)
        require(controls.loaded_unit()==loaded);controls.quiet_sample()
        require(set(os.listdir(work))=={'artifact.tar.gz','journal','host.lock'} and os.listdir(journal)==[])
        for fd,original,name,dirfd in ((work,wi,WORK,parent),(lock,li,'host.lock',work),(journal,ji,'journal',work),(artifact,ai,'artifact.tar.gz',work)):
            require(ident(os.fstat(fd))==ident(original) and ident(os.stat(name,dir_fd=dirfd,follow_symlinks=False))==ident(original))
        # RENAME_NOREPLACE makes any existing archive a hard refusal. Do not use
        # os.rename, which can replace an empty destination directory.
        libc=ctypes.CDLL(None,use_errno=True);rename=libc.renameat2
        rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
        if rename(parent,WORK.encode(),parent,ARCHIVE.encode(),1):raise OSError(ctypes.get_errno(),'retained archive rename refused')
        os.fsync(parent)
        archived=os.stat(ARCHIVE,dir_fd=parent,follow_symlinks=False)
        require((archived.st_dev,archived.st_ino)==(wi.st_dev,wi.st_ino))
        require(set(os.listdir(work))=={'artifact.tar.gz','journal','host.lock'} and os.listdir(journal)==[])
        require(ident(os.fstat(artifact))==ident(ai))
        require(controls.c.collect_restart_isolation(pins,before_restart=False)==first)
        require(controls.loaded_unit()==loaded)
        return {'archived':True,'automaticRetry':False,'serviceChanged':False}
    except Exception:
        # A false receipt can follow the rename (e.g. fsync/postcheck failure).
        # It authorizes read-only inspection, never automatic retry or cleanup.
        return {'archived':False,'automaticRetry':False,'serviceChanged':False}
    finally:
        for fd in reversed(fds):os.close(fd)

def archive_preflight(controls,pins,filesystem):
    parent=None
    try:
        require(os.geteuid()==0)
        parent=filesystem.trusted_directory(PARENT)
        return _archive(parent,controls,pins)
    except Exception:return {'archived':False,'automaticRetry':False,'serviceChanged':False}
    finally:
        if parent is not None:os.close(parent)

# Fixed public alias for source-bound receiver. No standalone invocation.
def archive(controls,pins):
    import host_files
    return archive_preflight(controls,pins,host_files)
