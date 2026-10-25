"""Emit only the exact reviewed recovery-only package for existing SSH stdin."""
import base64
import hashlib
import json
from pathlib import Path
import sys
import zlib

ROOT=Path(__file__).resolve().parents[1]
PATHS={'wrapper':'ops/exact-cleanup-host.py','cleanup':'ops/test-data-cleanup-core.py','preserving':'ops/deploy-preserving.py',
       'guards':'ops/deploy-survey-only.py','update':'ops/deploy-survey-update.py'}
ADAPTER='ops/recover-exact-cleanup.py'
PINS='ops/cleanup-recovery-source-pins.json'

def require(value):
    if not value:raise ValueError('exact cleanup package refused')

def payload(root=ROOT):
    pins=json.loads((root/PINS).read_bytes())
    require(pins['schema']=='bubblewash-cleanup-recovery/v1')
    require(pins['runtimeSha']=='1ddf328332836aeefe41d4a4e6f05ed79d4589a3')
    require(pins['runtimePins']==json.loads((root/'ops/pwa-update-source-pins.json').read_bytes()))
    require(set(pins['dependencies'])==set(PATHS))
    sources={}
    for name,path in PATHS.items():
        raw=(root/path).read_bytes();require(len(raw)<=2*1024**2)
        require(hashlib.sha256(raw).hexdigest()==pins['dependencies'][name])
        sources[name]=raw.decode()
    adapter=(root/ADAPTER).read_bytes();require(len(adapter)<=2*1024**2)
    require(hashlib.sha256(adapter).hexdigest()==pins['adapterSha256'])
    return {'pins':pins,'sources':sources,'adapter':adapter.decode()}

def emit(value):
    encoded=base64.b64encode(zlib.compress(json.dumps(value,separators=(',',':')).encode())).decode()
    # Only fixed Python text and a base64 literal. No file extraction, eval of
    # configuration, external fetch, host temporary source file, or secret output.
    return ("import base64,hashlib,json,types,zlib\n"
            "p=json.loads(zlib.decompress(base64.b64decode("+repr(encoded)+")))\n"
            "assert hashlib.sha256(p['adapter'].encode()).hexdigest()==p['pins']['adapterSha256']\n"
            "m=types.ModuleType('exact_cleanup_host')\n"
            "exec(compile(p['adapter'],'exact-cleanup-host','exec'),m.__dict__)\n"
            "m.entry(p['pins'],p['sources'])\n")

if __name__=='__main__':
    try:
        require(sys.argv[1:] in (['--check'],['--emit']))
        value=payload()
        if sys.argv[1:] == ['--emit']:print(emit(value),end='')
        else:print('{"cleanupRecoverySourceVerified":true}')
    except BaseException:
        print('{"cleanupRecoverySourceVerified":false}',file=sys.stderr)
        raise SystemExit(1)
