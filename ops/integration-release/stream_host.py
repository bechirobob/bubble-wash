#!/usr/bin/env python3
"""Emit a trusted stdin bootstrap, verifying all adapter bytes BEFORE imports."""
import argparse
import sys
from pathlib import Path
import re
sys.dont_write_bytecode = True
from contracts import HERE, VENDOR, digest, require
from host_adapter import adapter_manifest, completion_confirmation

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan-id', default='')
    parser.add_argument('--plan-sha256', default='')
    parser.add_argument('--candidate-sha', default='')
    parser.add_argument('--fallback-sha', default='')
    parser.add_argument('--mode', choices=('inspect-host-evidence','inspect','execute','recover','complete-labels-only'), required=True)
    parser.add_argument('--completion-confirmation', default='')
    args=parser.parse_args()
    if args.mode == 'inspect-host-evidence':
        require(not any((args.plan_id, args.plan_sha256, args.candidate_sha,
                         args.fallback_sha, args.completion_confirmation)),
                'evidence route takes no release inputs')
        # Use existing reviewed modules in memory. Never stage/import host code,
        # create files or instantiate the durable controller for this route.
        guard_name = 'bubblewash-web-a476-baseline/ops/deploy-preserving.py'
        require(digest(HERE/'vendor'/guard_name) == VENDOR[guard_name],
                'historical evidence guard differs')
        modules = [('contracts', HERE/'contracts.py'),
                   ('host_adapter', HERE/'host_adapter.py'),
                   ('evidence_guard', HERE/'vendor/bubblewash-web-a476-baseline/ops/deploy-preserving.py')]
        print('import sys, types, json\nsys.dont_write_bytecode = True')
        for name, path in modules:
            body = path.read_text()
            print('m = types.ModuleType('+repr(name)+')')
            print('m.__file__ = '+repr('/nonexistent-bubblewash-evidence/'+name+'.py'))
            print('sys.modules['+repr(name)+'] = m')
            print('exec(compile('+repr(body)+', m.__file__, "exec"), m.__dict__)')
        print("try:\n print(json.dumps(sys.modules['host_adapter'].inspect_host_evidence(sys.modules['evidence_guard']), sort_keys=True))\nexcept BaseException as error:\n print(json.dumps(sys.modules['host_adapter'].evidence_failure(error), sort_keys=True), file=sys.stderr)\n raise SystemExit(1)")
        raise SystemExit(0)
    require(re.fullmatch('[a-f0-9]{64}',args.plan_id) and re.fullmatch('[a-f0-9]{64}',args.plan_sha256), 'invalid plan identity')
    require(re.fullmatch('[a-f0-9]{40}',args.candidate_sha) and re.fullmatch('[a-f0-9]{40}',args.fallback_sha) and args.candidate_sha != args.fallback_sha, 'invalid published pair')
    completion_confirmation(args.mode, args.completion_confirmation, args.plan_sha256)
    files=adapter_manifest()
    # The approval materialization is host-local; stdin contains only public code
    # hashes and selected review IDs, never env/backup/database content.
    print('''import hashlib, json, os, pathlib, stat, sys
sys.dont_write_bytecode = True
require = lambda value: None if value else (_ for _ in ()).throw(ValueError('bootstrap refused'))
base = pathlib.Path('/var/lib/bubblewash-release/packages') / '''+repr(args.plan_id)+'''
require(os.geteuid() == 0 and base.resolve(strict=True) == base)
for directory in (base, *base.parents):
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
expected = '''+repr(files)+'''
entries = list(base.rglob('*'))
require(all(not p.is_symlink() and '__pycache__' not in p.parts and p.suffix != '.pyc' for p in entries))
for entry in entries:
    info = entry.lstat()
    require((stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) and info.st_uid == 0 and not info.st_mode & 0o022)
    if stat.S_ISREG(info.st_mode):
        require(info.st_nlink == 1)
actual = {p.relative_to(base).as_posix() for p in entries if p.is_file() and p.name != 'source-contracts.json'}
require(actual == set(expected))
for name, pin in expected.items():
    path = base / name
    info = path.lstat()
    require(path.resolve(strict=True) == path)
    for parent in path.parents:
        parent_info = parent.lstat()
        require(stat.S_ISDIR(parent_info.st_mode) and parent_info.st_uid == 0 and not parent_info.st_mode & 0o022)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and not info.st_mode & 0o022)
    require(hashlib.sha256(path.read_bytes()).hexdigest() == pin)
plan_path = pathlib.Path('/var/lib/bubblewash-release/plans/'''+args.plan_id+'''.json')
info = plan_path.lstat()
require(plan_path.resolve(strict=True) == plan_path and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022)
require(hashlib.sha256(plan_path.read_bytes()).hexdigest() == '''+repr(args.plan_sha256)+''')
plan = json.loads(plan_path.read_bytes())
require(plan['releaseShas'] == '''+repr({'candidate':args.candidate_sha,'fallback':args.fallback_sha})+''')
require(hashlib.sha256((base/'source-contracts.json').read_bytes()).hexdigest() == '''+repr(digest(HERE/'source-contracts.json'))+''')
require(plan['sourceContractSha256'] == '''+repr(digest(HERE/'source-contracts.json'))+''')
sys.path.insert(0, str(base))
from host_adapter import main
sys.argv = ['host_adapter', '--plan', '/var/lib/bubblewash-release/plans/'''+args.plan_id+'''.json', '--plan-sha256', '''+repr(args.plan_sha256)+''', '--mode', '''+repr(args.mode)+''', '--completion-confirmation', '''+repr(args.completion_confirmation)+''']
try:
    main()
except BaseException:
    print('Integration host route did not confirm acceptance; inspect durable state before retry.', file=sys.stderr)
    raise SystemExit(1)
''')
