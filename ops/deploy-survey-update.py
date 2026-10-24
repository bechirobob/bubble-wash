#!/usr/bin/env python3
"""One pinned code-only update. No production configuration or SQLite writes."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import tempfile
import time
import sys
import zlib

core = guards = pins = None
STAGE = 'binding'


def require(value):
    if not value:
        raise ValueError('survey update refused')


def stage(value):
    global STAGE
    require(value in ('binding', 'source', 'config', 'database', 'backup', 'runtime', 'build', 'rehearsal', 'switch', 'verification'))
    STAGE = value


def open_configuration(values):
    require(values.get('BUBBLEWASH_RESEARCH_OPEN') == 'true' and
            values.get('BUBBLEWASH_RESEARCH_EMAIL_ENABLED') == 'true' and
            values.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'false' and
            values.get('BUBBLEWASH_BOOKINGS_DISABLED') == 'true' and
            values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true' and
            values.get('NODE_ENV') in (None, 'production'))


def content_commitment(files):
    """Canonical path/type/content commitment, never a stored file inventory."""
    directories = sorted({parent.as_posix() for name in files for parent in Path(name).parents if parent != Path('.')})
    records = [('d', name) for name in directories] + [('f', name, files[name]) for name in sorted(files)]
    return {'files': len(files), 'directories': len(directories),
            'sha256': hashlib.sha256(json.dumps(records, separators=(',', ':')).encode()).hexdigest()}


def source_snapshot(release, owner):
    """Inspect only explicit source roots, using held no-follow directory FDs.

    Unpinned root entries remain outside scope, exactly as in v1. Unknown
    files inside the explicit source roots and even empty directories are
    refused. Only the existing lockfile-declared tooling dependency subtree
    is excluded within those roots. Empty-directory rejection is stricter
    than the old map.
    """
    scope = pins['sourceScope']
    root_files, root_dirs = set(scope['rootFiles']), set(scope['directories'])
    excluded = set(scope.get('excludedSubtrees', []))
    require(all(not Path(name).is_absolute() and '..' not in Path(name).parts and
                len(Path(name).parts) > 1 and Path(name).parts[0] in root_dirs for name in excluded))
    require(not root_files & root_dirs and
            all(name not in ('', '.', '..') and '/' not in name for name in root_files | root_dirs))
    fields = (*guards.IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    def identity(info, keys=fields):
        return tuple(getattr(info, key) for key in keys)
    def approved(info, directory):
        require(info.st_uid in (0, owner.pw_uid) and not info.st_mode & 0o022 and
                (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1))
    root_info = guards.safe_path(release, owner, True)
    # Root inode/ownership must stay bound, but unpinned generated children
    # may change its size, link count or timestamps between validations.
    root_fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid')
    held, bindings, files, directories = [], [], {}, set()
    identities = {'root': identity(root_info, root_fields)}
    try:
        root = os.open(release, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        held.append(root)
        require(identity(os.fstat(root), root_fields) == identity(root_info, root_fields))
        def visit(parent, name, relative, expected_directory=None):
            if relative in excluded:
                return  # No reads or traversal into existing generated dependencies.
            require(len(bindings) < 1024 and len(Path(relative).parts) <= 32)
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            directory = stat.S_ISDIR(before.st_mode)
            require(expected_directory is None or directory == expected_directory)
            approved(before, directory)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                         (os.O_DIRECTORY if directory else 0), dir_fd=parent)
            if directory:
                held.append(fd)
            try:
                require(identity(os.fstat(fd)) == identity(before))
                bindings.append((parent, name, identity(before)))
                if directory:
                    directories.add(relative)
                    identities['d/' + relative] = identity(before, guards.IDENTITY)
                    names = sorted(os.listdir(fd))
                    for child in names:
                        visit(fd, child, relative + '/' + child)
                    require(sorted(os.listdir(fd)) == names)
                    require(identity(os.fstat(fd)) == identity(before))
                else:
                    require(before.st_size <= 32 * 1024 * 1024)
                    digest, size = hashlib.sha256(), 0
                    while chunk := os.read(fd, 65536):
                        size += len(chunk)
                        require(size <= before.st_size)
                        digest.update(chunk)
                    require(size == before.st_size and identity(os.fstat(fd)) == identity(before))
                    files[relative] = digest.hexdigest()
                    identities['f/' + relative] = identity(before)
            finally:
                if not directory:
                    os.close(fd)
        for name in sorted(root_files):
            visit(root, name, name, False)
        for name in sorted(root_dirs):
            visit(root, name, name, True)
        require(directories == {parent.as_posix() for name in files for parent in Path(name).parents if parent != Path('.')})
        for parent, name, before in bindings:
            require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == before)
        require(identity(os.fstat(root), root_fields) == identity(root_info, root_fields) and
                identity(guards.safe_path(release, owner, True), root_fields) == identity(root_info, root_fields))
        return files, identities
    finally:
        for fd in reversed(held):
            os.close(fd)


def verify_sources(current, candidate, owner):
    stage('source')
    require(core.source_manifest(current) == pins['baselineSource'] and
            core.source_manifest(candidate) == pins['candidateSource'])
    old, old_identity = source_snapshot(current, owner)
    new, new_identity = source_snapshot(candidate, owner)
    require(content_commitment(old) == pins['baselineContent'] and content_commitment(new) == pins['runtimeContent'])
    require(sorted(name for name in set(old) | set(new) if old.get(name) != new.get(name)) == pins['allowedChanges'])
    require(all(name in old and name in new and old[name] == new[name] for name in pins['criticalFiles']))
    return {'old': old_identity, 'new': new_identity}


def check_runtime():
    """Bind the clean hosted checkout to the exact reviewed Git tree and content."""
    import types
    global pins, guards
    here = Path(__file__).resolve().parent
    pins = json.loads((here / 'survey-update-source-pins.json').read_bytes())
    raw = (here / 'deploy-survey-only.py').read_bytes()
    require(hashlib.sha256(raw).hexdigest() == pins['dependencies']['deploy-survey-only.py'])
    guards = types.ModuleType('reviewed_source_guards')
    exec(compile(raw, 'reviewed-source-guards', 'exec'), guards.__dict__)
    verify_checkout(Path('runtime-artifact').resolve(strict=True), os.environ.get('RUNTIME_SHA'),
                    types.SimpleNamespace(pw_uid=os.getuid()))
    print('{"ok":true,"exactRuntimeContent":true}')


def verify_checkout(release, runtime_sha, owner):
    import subprocess
    def git(*args):
        return subprocess.check_output(['git', '-C', str(release), *args])
    require(git('rev-parse', 'HEAD').decode().strip() == pins['runtimeSha'] == runtime_sha)
    require(git('rev-parse', 'HEAD^{tree}').decode().strip() == pins['runtimeTree'])
    tracked = {}
    for row in git('ls-tree', '-rz', '--full-tree', 'HEAD').split(b'\0'):
        if not row:
            continue
        metadata, name = row.split(b'\t', 1)
        mode, kind, _ = metadata.split()
        require(kind == b'blob' and mode in (b'100644', b'100755'))
        name = name.decode()
        require(name not in tracked)
        tracked[name] = mode == b'100755'
    files, _ = source_snapshot(release, owner)
    require(set(files) == set(tracked) and content_commitment(files) == pins['runtimeContent'])
    require(all(bool((release / name).stat().st_mode & 0o111) == executable for name, executable in tracked.items()))


def rehearse_both(current, candidate, values, db, status_path, owner, unit):
    stage('rehearsal')
    def deadline(*_):
        raise core.RehearsalDeadline()
    previous = signal.signal(signal.SIGALRM, deadline)
    try:
        for label, target in (('rollback', current), ('candidate', candidate)):
            report = core.RehearsalReport()
            signal.setitimer(signal.ITIMER_REAL, 300)
            try:
                # Existing private-network snapshot rehearsal fingerprints every
                # schema object and rowid before/after. No repair/migration hook.
                core.rehearse(target, values, db, status_path, owner, unit + '-' + label, report)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
    finally:
        signal.signal(signal.SIGALRM, previous)


def deploy(args):
    require(os.geteuid() == 0 and args.expected_live == pins['baseSha'] and args.sha == pins['runtimeSha'] and
            all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (args.sha, args.expected_live, args.store_sha)) and
            re.fullmatch(r'[a-f0-9]{64}', args.backup_sha256) and
            re.fullmatch(r'[1-9][0-9]*', args.receipt_run) and re.fullmatch(r'[1-9][0-9]*', args.store_id))
    owner = pwd.getpwnam('ubuntu')
    require(owner.pw_uid > 0)
    with core.deployment_lock(core.RUNTIME, owner.pw_uid) as lock_unchanged:
        candidate = Path(args.candidate)
        require(candidate.parent == core.HOME / 'bubblewash-releases' and
                re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + args.sha[:12], candidate.name))
        guards.safe_path(candidate, owner, True)
        require(guards.inspect_read(candidate / '.release-sha', owner, 'candidate', 128).decode().strip() == args.sha)
        require(core.CURRENT.is_symlink())
        current = core.CURRENT.resolve(strict=True)
        require(current != candidate and current.parent == candidate.parent and (current / '.next/BUILD_ID').is_file())
        marker_path = core.RUNTIME / 'current-release'
        marker_raw = guards.inspect_read(marker_path, owner, 'current')
        marker = core.parse(marker_raw)
        require(marker.get('sha') == pins['baseSha'] and marker.get('path') == str(current) and
                guards.inspect_read(current / '.release-sha', owner, 'current', 128).decode().strip() == pins['baseSha'])
        sources = verify_sources(current, candidate, owner)
        stage('config')
        raw, env_identity = guards.environment_snapshot(core.ENV, owner, None)
        config_hash = hashlib.sha256(raw).hexdigest()
        values = core.parse(raw)
        open_configuration(values)
        db = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
        require(str(db) == values.get('BUBBLEWASH_DATABASE_PATH') and
                not db.is_relative_to(current) and not db.is_relative_to(candidate))
        stage('database')
        db_identity = guards.database_identity(db, owner)
        require(not (current / 'data/submissions.jsonl').exists() and not (candidate / 'data/submissions.jsonl').exists())
        stage('backup')  # Receipt pin failures must not be misreported as source.
        receipt_raw = guards.inspect_read(core.RECEIPT, owner, 'backup')
        receipt = json.loads(receipt_raw)
        require(receipt.get('sha256') == args.backup_sha256)
        status_path = Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH', ''))
        archive = Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR', '')) / receipt['filename']
        require(status_path.is_absolute() and archive.is_absolute())

        def identities():
            lock_unchanged()
            require(verify_sources(current, candidate, owner) == sources)
            stage('config')
            require(guards.environment_snapshot(core.ENV, owner, config_hash) == (raw, env_identity))
            stage('database')
            require(guards.database_identity(db, owner) == db_identity)

        def backup():
            stage('backup')
            require(guards.inspect_read(core.RECEIPT, owner, 'backup') == receipt_raw and
                    not archive.is_symlink() and archive.is_file() and archive.stat().st_size == receipt['size'] and
                    core.digest(archive) == args.backup_sha256)
            core.verify_receipt(receipt, json.loads(status_path.read_bytes()), time.time(),
                                args.receipt_run, args.store_sha, int(args.store_id))

        def baseline_bound():
            identities()
            require(core.CURRENT.resolve(strict=True) == current and
                    guards.inspect_read(marker_path, owner, 'current') == marker_raw)

        backup()
        stage('runtime')
        guards.runtime_flags(current, values, True)
        core.health(3000)
        unit = 'bubblewash-survey-update-' + candidate.name
        stage('build')
        core.command(['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--unit=' + unit + '-build',
                      '--property=User=ubuntu', '--property=Group=ubuntu', '--property=WorkingDirectory=' + str(candidate),
                      '--property=RuntimeMaxSec=900', '--property=ProtectSystem=strict', '--property=ProtectHome=tmpfs',
                      '--property=BindPaths=' + str(candidate), '--property=ReadWritePaths=' + str(candidate),
                      '--property=PrivateTmp=true', '--property=NoNewPrivileges=true',
                      '/usr/bin/env', 'HOME=' + str(candidate), 'NEXT_TELEMETRY_DISABLED=1', '/bin/bash', '-c',
                      'npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund'], timeout=930)
        sources = verify_sources(current, candidate, owner)
        rehearse_both(current, candidate, values, db, status_path, owner, unit)
        baseline_bound()
        backup()
        stage('runtime')
        guards.runtime_flags(current, values, True)

        def write_marker(content):
            def write_as_app():
                identities()
                with tempfile.NamedTemporaryFile(dir=core.RUNTIME, prefix='.release-marker-', delete=False) as handle:
                    handle.write(content)
                    os.fchmod(handle.fileno(), 0o600)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(handle.name, marker_path)
            guards.migrate_as_app(owner, write_as_app)

        def validate(target):
            stage('verification')
            require(target in (current, candidate))
            core.health(3000)
            guards.runtime_flags(target, values, True)
            core.public_health()
            identities()
            backup()
            write_marker((f'sha={args.sha}\nrelease={candidate.name}\npath={candidate}\n'.encode()
                          if target == candidate else marker_raw))

        def service(action, name):
            stage('switch')
            return core.ctl(action, name)

        # No migration_service wrapper. The only production service actions are
        # the existing stop/start and code-only rollback to this exact live tree.
        stage('switch')
        core.activate(core.CURRENT, candidate, service, validate)
        print('{"ok":true,"codeOnly":true,"configurationUnchanged":true,"databaseRestored":false}', flush=True)


def verify_hosted_run(run, runtime_sha, workflow):
    require(run.get('head_sha') == runtime_sha and run.get('path') == workflow and
            run.get('event') in ('push', 'workflow_dispatch') and run.get('status') == 'completed' and
            run.get('conclusion') == 'success' and run.get('run_attempt') == 1 and
            run.get('head_repository', {}).get('full_name') == 'bechirobob/bubble-wash' and
            run.get('repository', {}).get('full_name') == 'bechirobob/bubble-wash')


def check_hosted_runs():
    import urllib.request
    sha = os.environ.get('RUNTIME_SHA', '')
    require(re.fullmatch(r'[a-f0-9]{40}', sha))
    for variable, workflow in (('BROWSER_RUN', '.github/workflows/browser-regression.yml'),
                               ('CI_RUN', '.github/workflows/pilot-ci.yml')):
        run = os.environ.get(variable, '')
        require(re.fullmatch(r'[1-9][0-9]*', run))
        request = urllib.request.Request('https://api.github.com/repos/bechirobob/bubble-wash/actions/runs/' + run,
            headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'bubblewash-survey-update'})
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(262145)
        require(len(raw) <= 262144)
        verify_hosted_run(json.loads(raw), sha, workflow)
    print('{"ok":true,"exactHostedVerification":true}')


def arguments():
    parser = argparse.ArgumentParser()
    for key in ('candidate', 'sha', 'expected-live', 'backup-sha256', 'receipt-run', 'store-sha', 'store-id'):
        parser.add_argument('--' + key, required=True)
    return parser.parse_args()


def entry():
    def interrupted(*_):
        raise RuntimeError('update interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        deploy(arguments())
    except BaseException:
        print(json.dumps({'ok': False, 'status': 'review-required', 'stage': STAGE, 'automaticRetry': False}), flush=True)
        raise SystemExit(1)


def emit():
    here = Path(__file__).resolve().parent
    public_pins = json.loads((here / 'survey-update-source-pins.json').read_bytes())
    sources = {name: (here / name).read_bytes() for name in public_pins['dependencies']}
    require(all(hashlib.sha256(sources[name]).hexdigest() == digest for name, digest in public_pins['dependencies'].items()))
    payload = {'core': sources['deploy-preserving.py'].decode(), 'guards': sources['deploy-survey-only.py'].decode(),
               'guardPins': json.loads(sources['survey-only-source-pins.json']), 'adapter': Path(__file__).read_text(), 'pins': public_pins}
    encoded = base64.b64encode(zlib.compress(json.dumps(payload, separators=(',', ':')).encode())).decode()
    print("import base64,json,types,zlib\np=json.loads(zlib.decompress(base64.b64decode(" + repr(encoded) + ")))\n"
          "c=types.ModuleType('preserving_reviewed'); exec(compile(p['core'],'preserving-reviewed','exec'),c.__dict__)\n"
          "g=types.ModuleType('survey_guards_reviewed'); exec(compile(p['guards'],'survey-guards-reviewed','exec'),g.__dict__); g.core=c; g.pins=p['guardPins']\n"
          "a=types.ModuleType('survey_update_reviewed'); exec(compile(p['adapter'],'survey-update-reviewed','exec'),a.__dict__); a.core=c; a.guards=g; a.pins=p['pins']; a.entry()")


if __name__ == '__main__':
    if sys.argv[1:] == ['--emit']:
        emit()
    elif sys.argv[1:] == ['--check-runtime']:
        check_runtime()
    elif sys.argv[1:] == ['--check-hosted-runs']:
        check_hosted_runs()
    else:
        raise SystemExit('Use the reviewed control workflow emitter.')
