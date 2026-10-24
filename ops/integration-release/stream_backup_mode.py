#!/usr/bin/env python3
"""Stream one reviewed directory repair; no mutable host code imports."""
import argparse
import hashlib
import os
from pathlib import Path
import re

HERE=Path(__file__).resolve().parent
CONFIRMATION='repair-backup-directory-group-write'
GUARD_SHA256='29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a'
REPAIR_SHA256='e5e4957f395ccec9a710de0de6f931bd7e7444b8d7840fa084fe59611356ea51'


def build(source_sha, confirmation):
    if not (re.fullmatch('[a-f0-9]{40}',source_sha or '') and source_sha==os.environ.get('GITHUB_SHA') and confirmation==CONFIRMATION):
        raise ValueError('reviewed repair identity required')
    modules=[]
    for name,path,expected in (
        ('repair_guard',HERE/'vendor/bubblewash-web-a476-baseline/ops/deploy-preserving.py',GUARD_SHA256),
        ('repair_backup_mode',HERE/'repair_backup_mode.py',REPAIR_SHA256)):
        raw=path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=expected:
            raise ValueError('reviewed repair source differs')
        modules.append((name,raw.decode()))
    program="import sys,types,json\nsys.dont_write_bytecode=True\n"
    for name,body in modules:
        program+='m=types.ModuleType('+repr(name)+');m.__file__='+repr('/nonexistent-reviewed-repair/'+name+'.py')+';sys.modules['+repr(name)+']=m\n'
        program+='exec(compile('+repr(body)+',m.__file__,"exec"),m.__dict__)\n'
    program+="result=sys.modules['repair_backup_mode'].repair_backup_mode(sys.modules['repair_guard'])\n"
    program+="assert result=={'ok':True,'status':'backup-directory-group-write-removed'}\nprint(json.dumps(result,sort_keys=True))\n"
    import textwrap
    return 'try:\n'+textwrap.indent(program,' ')+"except BaseException:\n import json,sys\n print(json.dumps({'ok':False,'status':'backup-directory-repair-unconfirmed','inspectBeforeRetry':True,'automaticRetry':False}),file=sys.stderr)\n raise SystemExit(1)\n"


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-sha',required=True)
    parser.add_argument('--confirmation',required=True)
    args=parser.parse_args()
    print(build(args.source_sha,args.confirmation))
