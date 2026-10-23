#!/usr/bin/env python3
"""One bounded private SSH invocation; protected recipient stays on stdin only."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shlex
import stat
import sys
import types
import zlib

ROOT = Path(__file__).resolve().parents[1]
PINS = {
    'ops/host-facts/facts.py': '42ff5948773808b941ad2c9f8a7b6a6db95329b812d9d42ff2cf92b06df0f0eb',
    'ops/install-research-email.py': '91029c53f5b0e3160e5a8595f832a1242b0c8d454992aab199f0050f2756c583',
}
RUNTIME_FILES = ('scripts/send-synthetic-research-test.mjs', 'tests/alias-loader.mjs', 'db/proposed/research-v1.sql', 'package.json', 'package-lock.json')


def source(name):
    path = ROOT / name; info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError('source refused')
    raw = path.read_bytes()
    if name in PINS and hashlib.sha256(raw).hexdigest() != PINS[name]: raise ValueError('source drift')
    return raw


def module(name, path):
    value = types.ModuleType(name); value.__file__ = str(ROOT / path)
    exec(compile(source(path), path, 'exec'), value.__dict__)
    return value


def public_program():
    definitions = [('facts', 'ops/host-facts/facts.py'), ('installer', 'ops/install-research-email.py'), ('preflight', 'scripts/release-preflight.py'), ('operator', 'ops/run-research-test.py')]
    program = 'import sys,types\nsys.dont_write_bytecode=True\n'
    for name, path in definitions:
        program += f'{name}=types.ModuleType({name!r});exec(compile({source(path)!r},{path!r},"exec"),{name}.__dict__)\n'
    program += 'operator.main(facts,installer,preflight)\n'
    packed = base64.b64encode(zlib.compress(program.encode(), 9))
    code = 'import base64,zlib;exec(compile(zlib.decompress(base64.b64decode(' + repr(packed) + ')),"<reviewed-survey-operator>","exec"))'
    return '/usr/bin/python3 -I -B -c ' + shlex.quote(code)


def request(env, owner, f, host):
    f.require(env.get('GITHUB_REPOSITORY') == 'bechirobob/bubble-wash' and env.get('GITHUB_REF') == 'refs/heads/main' and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch')
    f.require(env.get('RUNNER_DEBUG') != '1' and env.get('ACTIONS_STEP_DEBUG') != 'true')
    reviewed = env.get('REVIEWED_SHA', '')
    f.require(re.fullmatch('[a-f0-9]{40}', reviewed) and env.get('GITHUB_SHA') == reviewed)
    clean = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
    f.require(f.bounded(['/usr/bin/git', '-C', str(ROOT), 'rev-parse', 'HEAD'], env=clean, limit=128).decode().strip() == reviewed)
    f.require(f.bounded(['/usr/bin/git', '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=all'], env=clean, limit=8192) == b'')
    mode = env.get('TEST_MODE', '')
    f.require(mode != 'send' or env.get('GITHUB_RUN_ATTEMPT') == '1')
    names = [*(str(p.relative_to(ROOT)) for p in (ROOT / 'src').rglob('*') if p.is_file()), *RUNTIME_FILES]
    value = {'ownerEmail': owner, 'reviewedSha': reviewed, 'nodePath': env.get('VERIFIED_NODE_PATH', ''),
             'nodeSha256': env.get('VERIFIED_NODE_SHA256', ''), 'databasePath': env.get('VERIFIED_DATABASE_PATH', ''),
             'mode': mode, 'deliveryApproved': env.get('DELIVERY_APPROVED') == 'true',
             'sourcePins': {name: hashlib.sha256(source(name)).hexdigest() for name in sorted(set(names))}}
    return host.validate_request(value)


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    owner = os.environ.pop('BUBBLEWASH_OWNER_EMAIL', '')
    result = {'attempted': False, 'status': 'blocked'}
    started = False
    try:
        f = module('facts', 'ops/host-facts/facts.py')
        host = module('operator', 'ops/run-research-test.py')
        value = request(os.environ, owner, f, host)
        home = os.environ.get('HOME', '')
        f.require(Path(home).is_absolute() and len(home) <= 4096 and not any(c in home for c in ('\0', '\r', '\n')))
        clean = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': home, 'LC_ALL': 'C'}
        data = f.canonical(value); f.require(len(data) <= 128 * 1024)
        command = public_program(); f.require(len(command) < 100000)
        started = value['mode'] == 'send'
        raw = f.bounded(['/usr/local/bin/tailscale', 'ssh', 'root@hermes', command], data, timeout=180, limit=8192, env=clean)
        result = host.validate_result(f.strict_json(raw))
        if value['mode'] == 'check': f.require(result['attempted'] is False and result['status'] in ('ready', 'blocked', 'already-attempted'))
    except BaseException:
        result = {'attempted': None if started else False, 'status': 'review-required' if started else 'blocked'}
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['status'] in ('ready', 'accepted') else 1


if __name__ == '__main__':
    sys.exit(main())
