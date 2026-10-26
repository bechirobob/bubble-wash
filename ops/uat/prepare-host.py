#!/usr/bin/env python3
"""Fail-closed, additive UAT install. Default is read-only planning.
Never edits routing or production/staging, starts a unit, or issues test accounts.
An apply writes a NEW UAT-only session secret, never reads production environment.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import pwd
import grp
import re
import secrets
import shutil
import stat
import subprocess
import tarfile

ROOTS = ('/opt/bubblewash-uat', '/var/lib/bubblewash-uat', '/etc/bubblewash-uat')
UNIT = '/etc/systemd/system/bubblewash-uat.service'
GIB = 1024 ** 3
MAX_BYTES = 4 * GIB


def refuse(message):
    raise ValueError(message)


def admit(facts, expanded_bytes):
    if facts.get('schema') != 'bubblewash-uat-capacity/v1' or facts.get('readOnly') is not True:
        refuse('Unrecognized host evidence')
    memory = facts.get('memoryBytes', {}).get('MemAvailable')
    free = (facts.get('varLibBytes') or {}).get('free')
    cpus = facts.get('cpuCount')
    loads = facts.get('loadAverage')
    if not isinstance(memory, int) or memory < GIB:
        refuse('At least 1 GiB currently available memory is required')
    if not isinstance(free, int) or free < max(4 * GIB, expanded_bytes + 2 * GIB):
        refuse('Insufficient spare storage including recovery reserve')
    if not isinstance(cpus, int) or cpus < 2 or not isinstance(loads, list) or len(loads) != 3 or any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 or v >= cpus for v in loads):
        refuse('CPU/load admission is blocked')
    if facts.get('tcpListening', {}).get('3108') is not False:
        refuse('UAT port is occupied or inspection unavailable')
    if facts.get('uatUserAlreadyExists') is not False or facts.get('uatPathsAlreadyExist') != {p: False for p in ROOTS}:
        refuse('Existing UAT identity/path requires separate recovery review')
    state = facts.get('uatUnitState') or ''
    if set(state.strip().splitlines()) != {'LoadState=not-found', 'ActiveState=inactive', 'SubState=dead'}:
        refuse('UAT unit already exists or inspection unavailable')


def inspect_archive(artifact, digest, revision):
    if not re.fullmatch(r'[0-9a-f]{64}', digest) or not re.fullmatch(r'[0-9a-f]{40}', revision):
        refuse('Exact artifact digest and full source revision are required')
    if artifact.is_symlink() or not artifact.is_file() or artifact.stat().st_size > GIB:
        refuse('Expected bounded regular release archive')
    hasher = hashlib.sha256()
    with artifact.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): hasher.update(chunk)
    if hasher.hexdigest() != digest: refuse('Release digest mismatch')
    names, files, total = set(), set(), 0
    with tarfile.open(artifact, 'r:*') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            parts = path.parts
            if not parts or path.is_absolute() or '..' in parts or str(path) != member.name.rstrip('/') or member.name.rstrip('/') in names:
                refuse('Unsafe or duplicate archive path')
            if not (member.isfile() or member.isdir()) or member.mode & 0o7000 or member.size < 0 or (member.isdir() and member.size != 0):
                refuse('Links, special objects and privileged modes are forbidden')
            if parts[0] in ('.git', 'data', 'secrets') or any(p == '.env' or p.startswith('.env.') for p in parts):
                refuse('Artifact contains a forbidden data or environment path')
            if any(str(parent) in files for parent in path.parents) or (member.isfile() and any(name.startswith(str(path) + '/') for name in names)):
                refuse('Archive file/directory collision')
            names.add(member.name.rstrip('/'))
            if member.isfile(): files.add(str(path))
            total += member.size
            if total > MAX_BYTES or len(names) > 100000: refuse('Release extraction limit exceeded')
        required = {'uat-build.json', 'SOURCE_REVISION', '.next/BUILD_ID', 'package.json', 'node_modules/next/dist/bin/next', 'next.config.mjs', 'src/lib/uat-accounts.ts', 'scripts/uat-account.mjs'}
        if not required.issubset(names): refuse('Prebuilt artifact is incomplete')
        if archive.extractfile('SOURCE_REVISION').read(128) != (revision + '\n').encode(): refuse('Source revision mismatch')
        member = archive.getmember('uat-build.json')
        if member.size > 4096: refuse('Build receipt too large')
        receipt = json.load(archive.extractfile(member))
        if receipt != {'schema': 'bubblewash-uat-build/v1', 'revision': revision, 'onlinePayments': False, 'automatedUpdates': False, 'providerCredentialsIncluded': False}:
            refuse('UAT build receipt mismatch')
    return total


def trusted_parents():
    for name in ('/opt', '/var', '/var/lib', '/etc', '/etc/systemd', '/etc/systemd/system'):
        item = Path(name); info = item.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            refuse('Unsafe target ancestry')
    for target in (*ROOTS, UNIT):
        if os.path.lexists(target): refuse('Refusing existing installation')
    try: grp.getgrnam('bubblewash-uat')
    except KeyError: pass
    else: refuse('UAT group already exists')


def run(command):
    return subprocess.run(command, check=True, stdin=subprocess.DEVNULL, capture_output=True,
                          timeout=30, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})


def new_file(path, value, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, 'w') as stream: stream.write(value)


def install(artifact, revision, unit_source):
    # No destructive rollback: interrupted installs are retained for inspection.
    # Never automatically retry after any writes; collisions fail the next run.
    os.umask(0o077)
    run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', ROOTS[1], '--shell', '/usr/sbin/nologin', 'bubblewash-uat'])
    account = pwd.getpwnam('bubblewash-uat')
    for name in ROOTS: Path(name).mkdir(mode=0o700)
    app = Path(ROOTS[0]) / 'app'; app.mkdir(mode=0o755)
    with tarfile.open(artifact, 'r:*') as archive:
        for member in archive:
            dest = app / member.name
            if member.isdir(): dest.mkdir(parents=True, exist_ok=True, mode=0o755)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                os.fchmod(fd, 0o644)
                with os.fdopen(fd, 'wb') as stream, archive.extractfile(member) as source: shutil.copyfileobj(source, stream)
    # Native modules and scripts need read access, never write access, to root-owned app.
    Path(ROOTS[0]).chmod(0o755)
    for path in app.rglob('*'):
        if path.is_dir(): path.chmod(0o755)
    (app / '.next/cache').mkdir(exist_ok=True, mode=0o755)
    data = Path(ROOTS[1]); os.chown(data, account.pw_uid, account.pw_gid)
    (data / 'cache').mkdir(mode=0o700); os.chown(data / 'cache', account.pw_uid, account.pw_gid)
    environment = '\n'.join([
        'BUBBLEWASH_UAT_ENABLED=true', 'BUBBLEWASH_UAT_ISOLATION_CONFIRMED=true',
        'BUBBLEWASH_PUBLIC_URL=https://uat.bubblewash.co', 'BUBBLEWASH_UAT_DATA_ROOT=' + ROOTS[1],
        'BUBBLEWASH_DATABASE_PATH=' + ROOTS[1] + '/uat.sqlite', 'BUBBLEWASH_DATABASE_DRIVER=sqlite',
        'BUBBLEWASH_SESSION_SECRET=' + secrets.token_urlsafe(48), 'BUBBLEWASH_DISABLE_DEMO_LOGIN=true',
        'BUBBLEWASH_STAFF_AUTH_DISABLED=false', 'BUBBLEWASH_BOOKINGS_DISABLED=true',
        'NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED=false', 'NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false',
        'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=false', 'BUBBLEWASH_TRUST_PROXY_HEADERS=false',
        'BUBBLEWASH_TRUST_EDGE_HEADERS=false', 'NEXT_TELEMETRY_DISABLED=1', ''])
    new_file(Path(ROOTS[2]) / 'environment', environment)
    new_file(Path(ROOTS[2]) / 'release.json', json.dumps({'revision': revision, 'state': 'installed-not-started', 'accountsIssued': False}) + '\n')
    new_file(UNIT, unit_source, 0o644)
    # Verify the new unit, but do not reload/start/enable ANY service here.
    run(['/usr/bin/systemd-analyze', 'verify', UNIT])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--isolation-approved', action='store_true')
    args = parser.parse_args()
    if not args.artifact.is_absolute(): refuse('Absolute root-staged archive path required')
    for target in (args.artifact, *args.artifact.parents):
        info = target.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            refuse('Archive must be staged under root-owned non-writable ancestry')
    total = inspect_archive(args.artifact, args.sha256, args.revision)
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location('capacity', here.parent / 'inspect-uat-capacity.py')
    capacity = importlib.util.module_from_spec(spec); spec.loader.exec_module(capacity)
    facts = capacity.inspect(); admit(facts, total); trusted_parents()
    for mount in ('/opt', '/var/lib', '/etc'):
        if shutil.disk_usage(mount).free < max(4 * GIB, total + 2 * GIB):
            refuse('Insufficient free storage on a destination filesystem')
    if not run(['/usr/bin/node', '--version']).stdout.decode().strip().startswith('v22.'):
        refuse('Existing Node 22 runtime is required; no shared runtime replacement')
    unit_path = here / 'bubblewash-uat.service'
    if unit_path.is_symlink() or not unit_path.is_file(): refuse('Expected reviewed regular unit file')
    unit = unit_path.read_text()
    # Validate syntax on the host before any persistent installation writes.
    run(['/usr/bin/systemd-analyze', 'verify', str(unit_path)])
    if args.apply:
        if os.geteuid() != 0 or not args.isolation_approved: refuse('Root and explicit isolation approval are required')
        # A second live inspection immediately precedes the first write.
        admit(capacity.inspect(), total); trusted_parents()
        inspect_archive(args.artifact, args.sha256, args.revision)
        install(args.artifact, args.revision, unit)
    print(json.dumps({'ok': True, 'action': 'installed-not-started' if args.apply else 'read-only-plan', 'port': 3108, 'revision': args.revision, 'accountsIssued': False, 'productionChanged': False, 'routingChanged': False}))


if __name__ == '__main__':
    try: main()
    except Exception:
        # Do not leak environment, command output, archive input or credentials.
        print(json.dumps({'ok': False, 'error': 'UAT host preparation refused; retain any partial installation for inspection.'}))
        raise SystemExit(1)
