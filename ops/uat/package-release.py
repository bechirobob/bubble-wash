#!/usr/bin/env python3
"""Package a runner-built, exact-source UAT release; no host operations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import io


def package(root, output, revision):
    if not re.fullmatch('[a-f0-9]{40}', revision): raise ValueError('revision')
    if output.exists() or output.is_symlink(): raise ValueError('existing output')
    required = ['.next', 'node_modules', 'public', 'src', 'scripts', 'package.json', 'next.config.mjs', 'tsconfig.json']
    optional = ['db', 'tooling', 'package-lock.json']
    entries = required + [p for p in optional if (root / p).exists()]
    for name in required:
        if not (root / name).exists(): raise ValueError('missing build input')
    forbidden = {'.env', '.git', 'secrets'}
    def excluded(path):
        rel = path.relative_to(root).parts
        return (len(rel) >= 2 and rel[:2] == ('.next', 'cache')) or '.bin' in rel
    def inspect(path, ancestry=()):
        if excluded(path): return
        if path.name in forbidden or path.name.startswith('.env.'): raise ValueError('secret/config input')
        actual = path.resolve(strict=True)
        if path.is_symlink():
            # Only npm's package-internal links may be materialized. No home,
            # system, generated external target or production data can be copied.
            if not actual.is_relative_to((root / 'node_modules').resolve()): raise ValueError('external package link')
        if actual in ancestry: raise ValueError('cyclic package link')
        if actual.is_dir():
            for child in path.iterdir(): inspect(child, (*ancestry, actual))
        elif not actual.is_file(): raise ValueError('special object')
    for name in entries: inspect(root / name)
    with output.open('xb') as out, tarfile.open(fileobj=out,mode='w:gz',dereference=True) as tar:
        def clean(info):
            path = root / info.name
            if excluded(path): return None
            info.uid=info.gid=0; info.uname=info.gname='root'; info.mode=0o755 if info.isdir() else 0o644
            return info
        for name in entries: tar.add(root / name,arcname=name,filter=clean)
        receipt={'schema':'bubblewash-uat-build/v1','revision':revision,'onlinePayments':False,'automatedUpdates':False,'providerCredentialsIncluded':False}
        for name,raw in [('uat-build.json',json.dumps(receipt,sort_keys=True).encode()),('SOURCE_REVISION',(revision+'\n').encode())]:
            info=tarfile.TarInfo(name);info.size=len(raw);info.mode=0o644;tar.addfile(info,io.BytesIO(raw))
    with output.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'sha256':digest,'size':output.stat().st_size,'revision':revision}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    root=Path.cwd();revision=os.environ.get('SOURCE_SHA','')
    if subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()!=revision:raise SystemExit('Source pin refused')
    subprocess.run(['git','diff','--exit-code','--quiet'],check=True)
    print(json.dumps(package(root,args.output,revision),sort_keys=True))
