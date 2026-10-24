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
    'ops/install-research-email.py': '4ed391c609ba79d78d671806427af2808017b7ebe69ac9576578bf735e554a84',
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


def runtime_pins(env, f):
    runtime = env.get('RUNTIME_SHA', '')
    f.require(re.fullmatch('[a-f0-9]{40}', runtime))
    pins = json.loads(source('ops/survey-only-source-pins.json'))
    f.require(pins.get('schema') == 'bubblewash-survey-only/v1')
    tree = pins.get('runtimeTree', '')
    f.require(re.fullmatch('[a-f0-9]{40}', tree))
    clean = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
    def git(*args, limit=4 * 1024 * 1024):
        return f.bounded(['/usr/bin/git', '-C', str(ROOT), *args], env=clean, limit=limit)
    f.require(git('rev-parse', runtime + '^{tree}', limit=128).decode().strip() == tree)
    files = pins.get('runtimeFiles')
    f.require(type(files) is dict and 1 <= len(files) <= 500)
    entries = git('ls-tree', '-r', '-z', runtime, limit=128 * 1024).split(b'\0')
    actual = {}
    for entry in entries:
        if not entry: continue
        metadata, name = entry.split(b'\t', 1)
        mode, kind, blob = metadata.split()
        f.require(mode in (b'100644', b'100755') and kind == b'blob')
        name = name.decode('utf-8')
        f.require(name not in actual)
        actual[name] = blob.decode('ascii')
    f.require(set(actual) == set(files))
    for name, expected in files.items():
        f.require(type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected))
        f.require(hashlib.sha256(git('cat-file', 'blob', actual[name])).hexdigest() == expected)
    return runtime, files


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
    runtime, files = runtime_pins(env, f)
    value = {'ownerEmail': owner, 'reviewedSha': reviewed, 'runtimeSha': runtime, 'nodePath': env.get('VERIFIED_NODE_PATH', ''),
             'nodeSha256': env.get('VERIFIED_NODE_SHA256', ''),
             'mode': mode, 'deliveryApproved': env.get('DELIVERY_APPROVED') == 'true',
             'sourcePins': files}
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
