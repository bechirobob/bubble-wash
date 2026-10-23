#!/usr/bin/env python3
"""Read-only dedicated-key presence check. No value, hash, path or error output."""
import json
import os
import pwd
import resource
import re
import stat
import subprocess
import sys

def require(value):
    if not value: raise ValueError('invalid environment')

FIELDS = ('appIdentityReady','deploymentLockReady','serviceBindingReady','parentGuardChecked',
          'parentGuardEligible','fileSafetyReady','parseReady','bindingStable')

def parse_environment(raw):
    require(len(raw) <= 65536 and b'\x00' not in raw)
    entries = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith((b'#', b';')):
            continue
        match = re.fullmatch(rb'([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        require(match and match[1] not in entries)
        value = match[2].strip()
        if value.startswith((b'"', b"'")):
            require(len(value) >= 2 and value[-1:] == value[:1])
            value = value[1:-1]
        require(not any(c in value for c in (b'\\', b'"', b"'", b'`', b'\r', b'\n')))
        entries[match[1]] = value
    return entries


def result():
    return {**dict.fromkeys(FIELDS, False), 'dedicatedKeyPresent':None, 'emailFlagDisabled':None}

def validate(value):
    if type(value) is not dict or set(value) != {*FIELDS,'dedicatedKeyPresent','emailFlagDisabled'}:
        raise ValueError('invalid state')
    if not all(type(value[k]) is bool for k in FIELDS): raise ValueError('invalid state')
    if not all(value[k] is None or type(value[k]) is bool for k in ('dedicatedKeyPresent','emailFlagDisabled')): raise ValueError('invalid state')
    if value['bindingStable'] and not all(value[k] for k in FIELDS if k not in ('parentGuardEligible','bindingStable')): raise ValueError('invalid state')
    if not value['bindingStable'] and any(value[k] is not None for k in ('dedicatedKeyPresent','emailFlagDisabled')): raise ValueError('invalid state')
    return value

def inspect_file(i, uid, unchanged, state):
    path=i.ENV;parent=path.parent
    i.require(parent.resolve(strict=True)==parent)
    parents=[p.stat() for p in (parent,parent.parent)]
    state['parentGuardChecked']=True
    state['parentGuardEligible']=all(p.st_uid in (0,uid) and not p.st_mode&0o022 for p in parents)
    # Reading never grants write eligibility. Reject foreign-owned parents even for a snapshot.
    i.require(all(stat.S_ISDIR(p.st_mode) and p.st_uid in (0,uid) for p in parents))
    directory=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    fd=None
    try:
        parent_id=i.identity(os.fstat(directory))[:6]
        i.require(parent_id==i.identity(parents[0])[:6])
        fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
        original=os.fstat(fd)
        i.require(stat.S_ISREG(original.st_mode) and original.st_nlink==1 and original.st_uid==uid
                  and stat.S_IMODE(original.st_mode)==0o600 and original.st_size<=65536 and not os.listxattr(fd))
        state['fileSafetyReady']=True
        raw=os.read(fd,65537);i.require(len(raw)==original.st_size)
        entries=parse_environment(raw);state['parseReady']=True
        unchanged()
        i.require(parent.resolve(strict=True)==parent and i.identity(parent.lstat())[:6]==parent_id)
        i.require(i.identity(os.stat(path.name,dir_fd=directory,follow_symlinks=False))==i.identity(original))
        os.lseek(fd,0,os.SEEK_SET);i.require(os.read(fd,65537)==raw)
        i.require(i.identity(os.fstat(fd))==i.identity(original))
        i.require(all(i.identity(p.stat())[:6]==i.identity(before)[:6] for p,before in zip((parent,parent.parent),parents)))
        unchanged()
        state['bindingStable']=True
        state['dedicatedKeyPresent']=i.KEY in entries
        state['emailFlagDisabled']=entries.get(i.FLAG)==b'false'
    finally:
        if fd is not None:os.close(fd)
        os.close(directory)

def run(i, uid, state):
    with i.deployment_lock(i.RUNTIME,uid) as unchanged:
        state['deploymentLockReady']=True
        response=subprocess.run(['/usr/bin/systemctl','--user','show','bubblewash-local.service',
            '--property=LoadState,EnvironmentFiles'],capture_output=True,timeout=20,check=True,
            env={'PATH':'/usr/bin:/bin','HOME':'/home/ubuntu','XDG_RUNTIME_DIR':f'/run/user/{uid}'})
        properties=dict(line.split('=',1) for line in response.stdout.decode().splitlines() if '=' in line)
        i.require(properties.get('LoadState')=='loaded' and properties.get('EnvironmentFiles')==f'{i.ENV} (ignore_errors=no)')
        state['serviceBindingReady']=True
        inspect_file(i,uid,unchanged,state)
    return state

def main(i):
    state=result()
    try:
        resource.setrlimit(resource.RLIMIT_CORE,(0,0))
        i.require(os.geteuid()==0 and len(sys.argv)==1 and os.uname().nodename.split('.')[0].lower()=='hermes')
        account=pwd.getpwnam('ubuntu');i.require(account.pw_uid>0)
        os.setgroups([]);os.setgid(account.pw_gid);os.setuid(account.pw_uid)
        i.require(os.geteuid()==account.pw_uid and os.getuid()==account.pw_uid)
        state['appIdentityReady']=True
        run(i,account.pw_uid,state)
    except BaseException:
        state['bindingStable']=False;state['dedicatedKeyPresent']=None;state['emailFlagDisabled']=None
    print(json.dumps(validate(state),sort_keys=True,separators=(',',':')))
