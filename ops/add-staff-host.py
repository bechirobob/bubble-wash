#!/usr/bin/env python3
"""One pinned additive Caddy host; no application, database or auth changes."""
import copy
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import urllib.request

CONFIG=Path('/etc/caddy/Caddyfile')
JSON_CONFIG_DIR=Path('/run')
EXPECTED='c65a43156bbb47c376e99cad1b29ac34a75ce406a26f64e49ea963042197875f'
BLOCK=b'\n\n# Separate Bubble Wash staff home-screen app\nstaff.bubblewash.co {\n\treverse_proxy 127.0.0.1:3000\n}\n'
HOST='staff.bubblewash.co'
LIMIT=2*1024*1024
STAGE="binding"

def require(value):
    if not value:raise ValueError('staff route guard refused')

def run(args,raw=None):
    result=subprocess.run(['/usr/bin/caddy',*args],input=raw,capture_output=True,cwd=CONFIG.parent,timeout=30)
    require(result.returncode==0 and len(result.stdout)<=LIMIT)
    return result.stdout

@contextmanager
def temporary_config(raw,parent,suffix):
    protected(parent,True)
    fd,name=tempfile.mkstemp(prefix='.bubblewash-staff-',suffix=suffix,dir=parent)
    path=Path(name)
    try:
        with os.fdopen(fd,'wb') as stream:
            os.fchmod(stream.fileno(),0o600)
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        protected(path)
        yield path
    finally:
        path.unlink()

def adapt(raw):
    # Older Caddy adapt treats '-' as a filename. Keep a real sibling file so
    # relative imports retain their base. Any self-import/glob collision fails
    # adaptation or baseline equality; never rewrite or filter existing imports.
    with temporary_config(raw,CONFIG.parent,'.tmp') as path:
        return json.loads(run(['adapt','--config',str(path),'--adapter','caddyfile']))

def run_json(command,raw):
    # Exact JSON lives outside the import directory. A .json name prevents
    # implicit Caddyfile adaptation in older validate/reload implementations.
    with temporary_config(raw,JSON_CONFIG_DIR,'.json') as path:
        return run([command,'--config',str(path)])

def active():
    with urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=5) as response:raw=response.read(LIMIT+1)
    require(len(raw)<=LIMIT)
    return json.loads(raw)

def verify_delta(before,after):
    """No wildcard, header, upstream, listener, TLS policy or other route changes."""
    expected={'match':[{'host':[HOST]}],
      'handle':[{'handler':'subroute','routes':[{'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:3000'}]}]}]}],
      'terminal':True}
    reduced=copy.deepcopy(after);count=0
    for server in reduced.get('apps',{}).get('http',{}).get('servers',{}).values():
        routes=server.get('routes',[])
        kept=[]
        for route in routes:
            if route==expected:count+=1
            else:kept.append(route)
        if len(kept)!=len(routes):server['routes']=kept
    require(count==1 and reduced==before)

def protected(path,directory=False):
    require(path.resolve(strict=True)==path)
    for parent in (*path.parents,path):
        info=parent.lstat();require(info.st_uid==0 and not info.st_mode & 0o022)
    info=path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1)
    return info

def read_original():
    info=protected(CONFIG)
    require(info.st_size<=131072)
    with os.fdopen(os.open(CONFIG,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:raw=stream.read(131073)
    require(len(raw)==info.st_size and hashlib.sha256(raw).hexdigest()==EXPECTED)
    return raw,info

def replace(raw,info):
    # The temporary is never adapted or loaded while present in the config dir.
    fd,name=tempfile.mkstemp(prefix='.bubblewash-staff-',dir=CONFIG.parent)
    try:
        with os.fdopen(fd,'wb') as stream:
            os.fchmod(stream.fileno(),stat.S_IMODE(info.st_mode));os.fchown(stream.fileno(),info.st_uid,info.st_gid)
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(name,CONFIG)
        directory=os.open(CONFIG.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)

def main():
    global STAGE
    STAGE="binding"
    require(os.geteuid()==0)
    protected(Path('/usr/bin/caddy'))
    original,info=read_original()
    STAGE="baseline-adaptation"
    before=adapt(original)
    # Sibling-file adaptation must equal the persistent file and active state.
    require(json.loads(run(['adapt','--config',str(CONFIG),'--adapter','caddyfile']))==before==active())
    STAGE="exact-additive-delta"
    candidate=original+BLOCK;after=adapt(candidate);verify_delta(before,after)
    encoded=json.dumps(after,separators=(',',':')).encode()
    STAGE='candidate-validation'
    run_json('validate',encoded)
    require(read_original()[0]==original and adapt(original)==before==active())
    STAGE='recovery-copy'
    protected(Path('/var/backups'),True)
    backup=Path(tempfile.mkdtemp(prefix='bubblewash-staff-route-',dir='/var/backups'))
    for name,raw in (('Caddyfile.before',original),('active.before.json',json.dumps(before).encode())):
        fd=os.open(backup/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
    for path in (backup,backup.parent):
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    STAGE="persistent-file"
    require(read_original()[0]==original and active()==before)
    replace(candidate,info)
    try:
        require(adapt(candidate)==after and json.loads(run(['adapt','--config',str(CONFIG),'--adapter','caddyfile']))==after and active()==before)
        STAGE='reload'
        try:run_json('reload',encoded)
        except Exception:
            # An acknowledgement failure is not permission to blindly retry.
            if active()!=after:raise
        STAGE="active-verification"
        require(active()==after and CONFIG.read_bytes()==candidate)
    except Exception:
        # Restore only our own pending disk change when the active service is
        # positively still baseline. Never overwrite an unknown third state.
        if active()==before and CONFIG.read_bytes()==candidate:replace(original,info)
        raise
    print(json.dumps({'ok':True,'host':HOST,'upstream':'127.0.0.1:3000','configurationSha256':hashlib.sha256(candidate).hexdigest(),
                      'backup':str(backup),'otherRoutesUnchanged':True,'automaticHttps':True,'applicationChanged':False}))

if __name__=='__main__':
    try:main()
    except Exception:
        print(json.dumps({'ok':False,'status':'staff-route-refused-or-unverified','stage':STAGE,'automaticRetry':False}))
        raise SystemExit(1)
