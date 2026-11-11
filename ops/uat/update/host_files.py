"""Descriptor-based filesystem primitives. No CLI, network or service actions.
Caller must establish service shutdown/exclusivity before snapshot or exchange.
"""
import ctypes
import hashlib
import json
import os
import re
import sqlite3
import stat
import tarfile
import time
from pathlib import Path

class Refused(ValueError):pass
NOFOLLOW=os.O_NOFOLLOW

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()

def database_fingerprints(db):
    """Shared exact schema/account commitment. Caller owns read transaction."""
    schema=db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    accounts=db.execute('SELECT * FROM staff_uat_accounts ORDER BY username').fetchall()
    if not 0<len(accounts)<=1000:raise Refused('account count refused')
    return {'schema':hashlib.sha256(canonical(schema)).hexdigest(),
            'accounts':hashlib.sha256(canonical(accounts)).hexdigest()}

def identity(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def component(name):
    if not isinstance(name,str) or name in ('','.','..') or '/' in name or '\\' in name or '\x00' in name:raise Refused('invalid component')
    return name

def trusted_directory(path,owner=0):
    """Walk absolute ancestry with held descriptors. Returns owned descriptor.
    Writable sticky /tmp is NOT trusted. Tests use private descendants only via
    already-open fixture descriptors rather than weakening this host guard.
    """
    p=Path(path)
    if not p.is_absolute() or '..' in p.parts:raise Refused('absolute path required')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW)
    try:
        for part in p.parts[1:]:
            nxt=os.open(component(part),os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=nxt
            s=os.fstat(fd)
            if s.st_uid!=owner or s.st_mode&0o022:raise Refused('untrusted directory')
        return fd
    except BaseException:os.close(fd);raise

def private_directory(parent,name):
    os.mkdir(component(name),0o700,dir_fd=parent);os.fsync(parent)
    return os.open(name,os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW,dir_fd=parent)

def _write(fd,data):
    while data:
        n=os.write(fd,data)
        if n<=0:raise Refused('short write')
        data=data[n:]

def artifact_digest(fd):
    """pread never disturbs a shared tarfile/gzip descriptor's buffered offset."""
    h=hashlib.sha256();offset=0
    while chunk:=os.pread(fd,1024*1024,offset):h.update(chunk);offset+=len(chunk)
    return h.hexdigest()

def open_relative_directory(root,name):
    """Bounded descriptors: root plus at most two traversal descriptors."""
    fd=os.dup(root)
    try:
        for part in name.split('/') if name else ():
            nxt=os.open(component(part),os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=nxt
        return fd
    except BaseException:os.close(fd);raise

def extract_candidate(parent,artifact_name,candidate_name,expected_sha,revision,source_pins):
    """Verify one held regular archive; extract into new private directory.
    source_pins must come from independent reviewed source, not archive contents.
    Existing files/dirs are never overwritten. Failure retains partial candidate.
    """
    if not re.fullmatch('[a-f0-9]{64}',expected_sha) or not re.fullmatch('[a-f0-9]{40}',revision) or not source_pins:raise Refused('missing reviewed binding')
    allowed={'.next','node_modules','public','src','scripts','db','tooling','package.json','package-lock.json','next.config.mjs','tsconfig.json','uat-build.json','SOURCE_REVISION'}
    fd=os.open(component(artifact_name),os.O_RDONLY|NOFOLLOW,dir_fd=parent)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size>1024**3 or before.st_uid!=os.geteuid() or before.st_mode&0o022:raise Refused('untrusted archive')
        if artifact_digest(fd)!=expected_sha:raise Refused('artifact mismatch')
        with os.fdopen(os.dup(fd),'rb') as stream,tarfile.open(fileobj=stream,mode='r:*') as archive:
            seen={};total=0
            for m in archive:
                name=m.name.rstrip('/')
                parts=name.split('/')
                if any(component(x)!=x for x in parts) or parts[0] not in allowed or name in seen or not(m.isdir() or m.isfile()) or m.mode&0o7000 or m.size<0 or (m.isdir() and m.size):raise Refused('unsafe archive member')
                if any(x=='.env' or x.startswith('.env.') for x in parts):raise Refused('environment forbidden')
                total+=m.size;seen[name]=m
                if total>4*1024**3 or len(seen)>100000:raise Refused('archive limit')
            for name,m in seen.items():
                parts=name.split('/')
                for i in range(1,len(parts)):
                    ancestor='/'.join(parts[:i])
                    if ancestor in seen and not seen[ancestor].isdir():raise Refused('file ancestor')
            for name in ('SOURCE_REVISION','uat-build.json','.next/BUILD_ID','node_modules/next/dist/bin/next','package.json','next.config.mjs','src/lib/uat-accounts.ts','scripts/uat-account.mjs',*source_pins):
                if name not in seen or not seen[name].isfile():raise Refused('required reviewed file missing')
            if seen['SOURCE_REVISION'].size!=41 or archive.extractfile(seen['SOURCE_REVISION']).read()!= (revision+'\n').encode():raise Refused('source revision mismatch')
            if seen['uat-build.json'].size>4096:raise Refused('oversized receipt')
            receipt=json.load(archive.extractfile(seen['uat-build.json']))
            if receipt!={'schema':'bubblewash-uat-build/v1','revision':revision,'onlinePayments':False,'automatedUpdates':False,'providerCredentialsIncluded':False}:raise Refused('receipt mismatch')
            for name,pin in source_pins.items():
                if not re.fullmatch('[a-f0-9]{64}',pin) or hashlib.file_digest(archive.extractfile(seen[name]),'sha256').hexdigest()!=pin:raise Refused('independent source pin mismatch')
            # Re-hash held archive after inspection to detect concurrent edits.
            if artifact_digest(fd)!=expected_sha or identity(os.fstat(fd))!=identity(before):raise Refused('archive changed')
            out=private_directory(parent,candidate_name)
            try:
                if '.next/cache' in seen and not seen['.next/cache'].isdir():raise Refused('cache target must be a directory')
                all_dirs={'','.next','.next/cache'}
                for name,m in seen.items():
                    parts=name.split('/')
                    for i in range(1,len(parts)+(1 if m.isdir() else 0)):all_dirs.add('/'.join(parts[:i]))
                for name in sorted(all_dirs-{''},key=lambda x:(x.count('/'),x)):
                    parentname,_,base=name.rpartition('/')
                    parent_fd=open_relative_directory(out,parentname)
                    try:
                        child=private_directory(parent_fd,base)
                        os.close(child)
                    finally:os.close(parent_fd)
                for name,m in seen.items():
                    if not m.isfile():continue
                    parentname,_,base=name.rpartition('/')
                    parent_fd=open_relative_directory(out,parentname)
                    try:
                        target=os.open(base,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o644,dir_fd=parent_fd)
                        try:
                            src=archive.extractfile(m);size=0
                            while chunk:=src.read(1024*1024):_write(target,chunk);size+=len(chunk)
                            if size!=m.size:raise Refused('archive truncated')
                            os.fchmod(target,0o644);os.fsync(target)
                        finally:os.close(target)
                        os.fsync(parent_fd)
                    finally:os.close(parent_fd)
                # Candidate stays beneath private WORK; chmod only after complete
                # extraction. Open/close each directory rather than retaining N fds.
                for name in sorted(all_dirs,key=lambda x:(-x.count('/'),x)):
                    directory_fd=open_relative_directory(out,name)
                    try:os.fchmod(directory_fd,0o755);os.fsync(directory_fd)
                    finally:os.close(directory_fd)
            finally:os.close(out)
        if artifact_digest(fd)!=expected_sha or identity(os.fstat(fd))!=identity(before):raise Refused('archive changed during extraction')
        # Parent must be exclusively controlled by reviewed root operator.
        # Holding inode prevents pathname replacement, not privileged concurrent writes.
    finally:os.close(fd)

def exchange_apps(parent,app='app',candidate='candidate',candidate_parent=None):
    """Atomic Linux exchange. Old app is retained at candidate; no auto rollback.
    Caller journals BEFORE/AFTER. fsync failure means uncertain, never retry.
    """
    component(app);component(candidate)
    other=parent if candidate_parent is None else candidate_parent
    if app==candidate and os.fstat(parent).st_ino==os.fstat(other).st_ino:raise Refused('same directory')
    a=os.open(app,os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW,dir_fd=parent)
    b=os.open(candidate,os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW,dir_fd=other)
    try:
        if os.fstat(a).st_dev!=os.fstat(b).st_dev:raise Refused('cross-device exchange')
        libc=ctypes.CDLL(None,use_errno=True)
        rename=libc.renameat2;rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
        if rename(parent,app.encode(),other,candidate.encode(),2)!=0:raise OSError(ctypes.get_errno(),'atomic exchange refused')
        os.fsync(parent);os.fsync(other)
    finally:os.close(a);os.close(b)

def closed_snapshot(db_parent,db_name,out_parent,snapshot_name,expected_schema,expected_accounts):
    """Stopped, writer-excluded SQLite backup. Committed WAL is read via siblings.
    Existing SHM read marks may change; database and WAL content must not change.
    Caller must establish and hold exclusive writer exclusion throughout.
    """
    component(db_name);component(snapshot_name)
    handles={};metadata={};hashes={}
    def content(fd):
        os.lseek(fd,0,0);h=hashlib.sha256()
        while chunk:=os.read(fd,1024*1024):h.update(chunk)
        return h.hexdigest()
    try:
        for suffix in ('','-wal','-shm','-journal'):
            try:fd=os.open(db_name+suffix,os.O_RDONLY|NOFOLLOW,dir_fd=db_parent)
            except FileNotFoundError:
                if not suffix:raise
                metadata[suffix]=None;continue
            handles[suffix]=fd;info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_mode&0o022:raise Refused('untrusted sqlite object')
            if suffix and info.st_uid!=metadata[''].st_uid:raise Refused('sqlite owner mismatch')
            if suffix=='-journal' and info.st_size:raise Refused('unresolved rollback journal')
            metadata[suffix]=info
            if suffix in ('','-wal'):hashes[suffix]=content(fd)
        has_wal=metadata['-wal'] is not None and metadata['-wal'].st_size>0
        if has_wal and (metadata['-shm'] is None or metadata['-shm'].st_size==0):raise Refused('existing WAL requires trusted SHM')
        uri=f'file:/proc/self/fd/{db_parent}/{db_name}?mode=ro'+('' if has_wal else '&immutable=1')
        src=sqlite3.connect(uri,uri=True,timeout=2)
        try:
            src.execute('PRAGMA query_only=ON');src.execute('PRAGMA trusted_schema=OFF')
            target=os.open(snapshot_name,os.O_CREAT|os.O_EXCL|os.O_RDWR|NOFOLLOW,0o600,dir_fd=out_parent)
            try:
                dst=sqlite3.connect(f'file:/proc/self/fd/{target}?mode=rw',uri=True)
                try:
                    deadline=time.monotonic()+30
                    def bounded_backup(status,remaining,total):
                        if time.monotonic()>=deadline:raise Refused('snapshot time budget exceeded')
                    src.backup(dst,pages=128,progress=bounded_backup,sleep=0.05)
                    if dst.execute('PRAGMA integrity_check').fetchone()!=('ok',):raise Refused('snapshot integrity')
                    fp=database_fingerprints(dst)
                    if (fp['schema'],fp['accounts'])!=(expected_schema,expected_accounts):raise Refused('snapshot invariant mismatch')
                    dst.commit()
                finally:dst.close()
                os.fsync(target);os.fsync(out_parent)
            finally:os.close(target)
        finally:src.close()
        for suffix,prior in metadata.items():
            try:current=os.stat(db_name+suffix,dir_fd=db_parent,follow_symlinks=False)
            except FileNotFoundError:current=None
            if prior is None:
                if current is not None:raise Refused('unexpected sidecar created')
                continue
            if current is None or not stat.S_ISREG(current.st_mode):raise Refused('sqlite object replaced')
            stable=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_uid,x.st_mode,x.st_nlink)
            if stable(current)!=stable(prior):raise Refused('sqlite identity changed')
            if suffix!='-shm' and identity(current)!=identity(prior):raise Refused('sqlite metadata changed')
            if suffix in hashes and content(handles[suffix])!=hashes[suffix]:raise Refused('database or WAL changed')
    finally:
        for fd in handles.values():os.close(fd)


def extract_archive(artifact,dest,sha,revision,source_pins):
    # Pins are mandatory; deriving them from candidate input is forbidden.
    artifact=Path(artifact);dest=Path(dest)
    if artifact.parent!=dest.parent:raise Refused('archive and candidate must share protected update directory')
    parent=trusted_directory(dest.parent)
    try:extract_candidate(parent,artifact.name,dest.name,sha,revision,source_pins)
    finally:os.close(parent)

def exchange_directories(app,candidate):
    app=Path(app);candidate=Path(candidate)
    a=trusted_directory(app.parent);b=trusted_directory(candidate.parent)
    try:exchange_apps(a,app.name,candidate.name,b)
    finally:os.close(a);os.close(b)

def snapshot_database(source,destination,expected_schema,expected_accounts):
    source=Path(source);destination=Path(destination)
    a=trusted_directory(source.parent);b=trusted_directory(destination.parent)
    try:closed_snapshot(a,source.name,b,destination.name,expected_schema,expected_accounts)
    finally:os.close(a);os.close(b)
