#!/usr/bin/env python3
"""Emit a reviewed in-memory gate operation. Output is for SSH stdin, never logs.
The host computes private bounded evidence in memory; only approved hashes travel.
This does not contact the host or create credentials. No unpinned host imports.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
MODES = ('inspect', 'install', 'reverse-before-migration')
GATE_FILES = ('install_hold_gate.py', 'stream_gate.py', 'app.conf', 'maintenance.conf')
EVIDENCE_FILES = {
    'contracts': 'ops/release-gate/readonly/contracts.py',
    'host_adapter': 'ops/release-gate/readonly/host_adapter.py',
    'evidence_guard': 'ops/release-gate/readonly/deploy-preserving.py',
}


def require(value):
    if not value:
        raise ValueError('stream validation refused')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def bounded_read(path, maximum=1048576):
    require(path.is_absolute() and path.resolve(strict=True) == path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum)
        chunks = []; size = 0
        while size <= maximum:
            chunk = os.read(fd, min(65536, maximum+1-size))
            if not chunk:
                break
            chunks.append(chunk); size += len(chunk)
        raw = b''.join(chunks)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')
        require(len(raw) <= maximum and len(raw) == before.st_size and all(getattr(info, key) == getattr(before, key)
            for info in (os.fstat(fd), path.stat()) for key in fields))
        return raw
    finally:
        os.close(fd)


def validate_inputs(mode, package_sha256, evidence_sha256, installation_evidence_sha256, confirmation):
    require(mode in MODES and re.fullmatch('[a-f0-9]{64}', package_sha256) and
            re.fullmatch('[a-f0-9]{64}', evidence_sha256))
    if mode == 'inspect':
        require(not installation_evidence_sha256 and not confirmation)
    elif mode == 'install':
        require(not installation_evidence_sha256 and confirmation == mode+':'+package_sha256+':'+evidence_sha256)
    else:
        require(re.fullmatch('[a-f0-9]{64}', installation_evidence_sha256) and
                confirmation == mode+':'+package_sha256+':'+evidence_sha256+':'+installation_evidence_sha256)


def load_reviewed(repository, package_sha256, directory=HERE):
    raw = bounded_read(directory/'transport-manifest.json')
    require(digest(raw) == package_sha256)
    manifest = json.loads(raw)
    require(set(manifest) == {'schema', 'gateFiles', 'evidenceFiles'} and
            manifest['schema'] == 'bubblewash-gate-transport/v1' and
            set(manifest['gateFiles']) == set(GATE_FILES) and
            set(manifest['evidenceFiles']) == set(EVIDENCE_FILES.values()))
    result = {}
    for name in GATE_FILES:
        data = bounded_read(directory/name)
        require(digest(data) == manifest['gateFiles'][name]); result[name] = data
    for module, name in EVIDENCE_FILES.items():
        data = bounded_read(repository/name)
        require(digest(data) == manifest['evidenceFiles'][name]); result[module] = data
    return result


def bootstrap(sources, mode, package_sha256, evidence_sha256, installation_evidence_sha256):
    # The selected public sources were authenticated against the independently
    # approved manifest by the caller. The host verifies every embedded byte again.
    modules = [(name, sources[name]) for name in EVIDENCE_FILES]
    modules.append(('gate_installer', sources['install_hold_gate.py']))
    payloads = {name: sources[name] for name in ('app.conf', 'maintenance.conf')}
    program = '''import contextlib, hashlib, json, os, sys, types
sys.dont_write_bytecode = True
stage = 'BOOTSTRAP'
installer = None
def require(value):
 if not value: raise ValueError('refused')
def canonical(value):
 return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def digest(raw):
 return hashlib.sha256(raw).hexdigest()
try:
 require(os.geteuid() == 0 and os.getegid() == 0)
'''
    for name, raw in modules:
        program += ' raw = '+repr(raw)+'\n require(digest(raw) == '+repr(digest(raw))+')\n'
        program += ' module = types.ModuleType('+repr(name)+')\n'
        program += ' module.__file__ = '+repr('/nonexistent-reviewed-bubblewash-gate/'+name+'.py')+'\n'
        program += ' sys.modules['+repr(name)+'] = module\n exec(compile(raw, module.__file__, "exec"), module.__dict__)\n'
    program += ' payloads = '+repr(payloads)+'\n'
    program += ' require({key:digest(value) for key,value in payloads.items()} == '+repr({k:digest(v) for k,v in payloads.items()})+')\n'
    program += ' mode = '+repr(mode)+'\n expected = '+repr(evidence_sha256)+'\n original = '+repr(installation_evidence_sha256)+'\n'
    program += ''' gate = sys.modules['gate_installer']
 adapter = sys.modules['host_adapter']
 guard = sys.modules['evidence_guard']
 installer = gate.Installer(facts={'pendingEvidence': True},
     evidence_sha256=original if mode == 'reverse-before-migration' else expected, payloads=payloads)
 def collect_locked(unchanged):
  # Reuse the already-held lock; never acquire a second flock or open a race
  # between accepting canonical evidence and checking/installing the gates.
  @contextlib.contextmanager
  def retained_lock(runtime, uid):
   require(str(runtime) == '/home/ubuntu/bubblewash-runtime' and uid == installer.uid)
   unchanged()
   yield unchanged
   unchanged()
  proxy = types.SimpleNamespace(parse=guard.parse, deployment_lock=retained_lock)
  installer.stage = 'EVIDENCE_RECHECK'
  facts = adapter.inspect_host_evidence(proxy)
  require(facts['schema'] == 'bubblewash-bounded-host-evidence/v1' and
          facts['databaseOpened'] is False and facts['releaseAcceptance'] is False and digest(canonical(facts)) == expected)
  if mode == 'reverse-before-migration':
   installer.parents(gate.STATE)
   receipt = json.loads(installer.read(gate.STATE+'/gate-installation.json'))
   baseline = receipt['baselineEvidence']
   require(receipt['schema'] == 'bubblewash-gate-installation/v1' and
           receipt['evidenceSha256'] == original and digest(canonical(baseline)) == original)
   installer.facts = baseline
  else:
   installer.facts = facts
  unchanged()
 if mode == 'inspect':
  with installer.lock() as unchanged:
   collect_locked(unchanged)
   # Complete pre-install admission under the same lock, with no writes.
   installer.stage = 'PREFLIGHT'
   installer.preflight()
   unchanged()
  result = {'inspected': True, 'evidenceMatched': True, 'preflight': True, 'procBootIdentityReadable': True,
            'changed': False, 'releaseAcceptance': False}
 elif mode == 'install':
  result = installer.install(evidence_check=collect_locked)
 elif mode == 'reverse-before-migration':
  result = installer.reverse(evidence_check=collect_locked)
 else:
  raise ValueError('refused')
 print(json.dumps(result, sort_keys=True))
except BaseException as error:
 if installer is not None:
  result = sys.modules['gate_installer'].diagnostic(error, installer.stage, mode, installer.recovery)
 else:
  result = {'ok': False, 'stage': 'BOOTSTRAP', 'category': 'REFUSED',
            'stateMayBePartial': False, 'automaticRollback': False, 'releaseAcceptance': False}
 print(json.dumps(result, sort_keys=True))
 raise SystemExit(1)
'''
    return program


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=MODES, default='inspect')
    parser.add_argument('--package-sha256', required=True)
    parser.add_argument('--evidence-sha256', required=True)
    parser.add_argument('--installation-evidence-sha256', default='')
    parser.add_argument('--action-confirmation', default='')
    parser.add_argument('--source-root', type=Path, default=HERE.parents[1])
    args = parser.parse_args()
    try:
        validate_inputs(args.mode, args.package_sha256, args.evidence_sha256,
                        args.installation_evidence_sha256, args.action_confirmation)
        sources = load_reviewed(args.source_root.resolve(strict=True), args.package_sha256)
        value = bootstrap(sources, args.mode, args.package_sha256, args.evidence_sha256, args.installation_evidence_sha256)
        compile(value, '<reviewed-gate-stream>', 'exec')
    except BaseException:
        print('{"ok":false,"stage":"STREAM_VALIDATION","category":"REFUSED"}', file=sys.stderr)
        return 1
    sys.stdout.write(value)
    return 0


if __name__ == '__main__':
    sys.exit(main())
