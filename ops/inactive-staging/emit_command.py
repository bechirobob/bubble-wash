#!/usr/bin/env python3
"""Print a pinned receiver command; does not connect or read an archive."""
import argparse
import base64
import hashlib
from pathlib import Path
import shlex
import sys
import os
import stat

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--source-sha256', required=True)
p.add_argument('--manifest', required=True, type=Path)
p.add_argument('--manifest-sha256', required=True)
p.add_argument('--kind', choices=['release', 'package'], required=True)
p.add_argument('--name', required=True)
p.add_argument('--stream', action='store_true')
p.add_argument('--archive', type=Path)
a = p.parse_args()
source = Path(__file__).with_name('stage_artifact.py').read_bytes()
with a.manifest.open('rb') as manifest_stream:
    manifest = manifest_stream.read(32 * 1024**2 + 1)
if len(manifest) > 32 * 1024**2:
    raise SystemExit('Manifest exceeds transport bound')
if hashlib.sha256(source).hexdigest() != a.source_sha256 or hashlib.sha256(manifest).hexdigest() != a.manifest_sha256:
    raise SystemExit('Receiver or manifest digest differs')
if len(manifest) > 32 * 1024**2:
    raise SystemExit('Manifest exceeds transport bound')
if a.stream:
    if a.archive is None: raise SystemExit('Archive required')
    import json
    expected = json.loads(manifest)['archiveSha256']
    fd = os.open(a.archive, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as archive:
        info = os.fstat(archive.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 2 * 1024**3: raise SystemExit('Archive refused')
        h = hashlib.sha256()
        for block in iter(lambda: archive.read(1024**2), b''): h.update(block)
        if h.hexdigest() != expected: raise SystemExit('Archive digest differs')
        archive.seek(0)
        sys.stdout.buffer.write(len(manifest).to_bytes(8, 'big'))
        sys.stdout.buffer.write(manifest)
        for block in iter(lambda: archive.read(1024**2), b''): sys.stdout.buffer.write(block)
    raise SystemExit(0)
program = "import base64,hashlib,json,sys\ns=" + repr(base64.b64encode(source).decode()) + "\nb=base64.b64decode(s,validate=True)\nassert hashlib.sha256(b).hexdigest()==" + repr(a.source_sha256) + "\nn={'__name__':'reviewed_receiver'}\nexec(compile(b,'<reviewed_receiver>','exec'),n)\ntry:\n size=int.from_bytes(sys.stdin.buffer.read(8),'big')\n if not 0<size<=32*1024**2: raise ValueError('manifest size')\n raw=sys.stdin.buffer.read(size)\n if len(raw)!=size: raise ValueError('manifest truncated')\n r=n['receive'](raw," + repr(a.manifest_sha256) + "," + repr(a.kind) + "," + repr(a.name) + ")\n print(json.dumps(r,sort_keys=True))\nexcept Exception:\n print('{\"ok\":false,\"status\":\"staging-refused-or-incomplete\",\"inspectBeforeRetry\":true}')\n raise SystemExit(1)\n"
print('python3 -I -B -c ' + shlex.quote(program))
