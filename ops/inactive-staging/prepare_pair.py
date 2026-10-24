#!/usr/bin/env python3
"""Inactive preparation only, invoked by the separately pinned control bootstrap.

No production controller, hold, switch, restart, environment writer or DB restore.
The caller supplies verified control modules, not modules imported from a build.
Source transport remains the existing app-UID exact-Git-archive workflow step.
Both private probes derive from ONE retained preimage; it is never a maintenance
journal snapshot. Public output contains fixed stages/timings, never data or paths.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import sqlite3
import stat
import tarfile
import time

LIVE = '853b7c1020fb7dab66f302a2603369d5fa8b3dff'
LIVE_TREE = '24fbe62668c996d0821153cf341b24765ef653b1'
PAIR = {'candidate': ('5f256800d65dbe3b69f54e95afa0e8ab30b5e881', '0076161b49d587787472f8c9128c6f261eedc72e'),
        'fallback': ('80ec00902fcc5fe16a17ab814c7d191ad44afb64', 'c90fe5e836022d8084d0f8f936e5d00bb8522be6')}
STATE = Path('/var/lib/bubblewash-release')
WORK = Path('/home/ubuntu/bubblewash-releases')
SOURCE_DIRS = ('.github', 'db', 'docs', 'ops', 'public', 'scripts', 'src', 'tests', 'tooling', 'integration-evidence')
ROOT_FILES = ('.env.production.example', '.gitignore', 'DESIGN.md', 'README.md', 'eslint.config.mjs',
              'next.config.mjs', 'package-lock.json', 'package.json', 'playwright.config.mjs', 'tsconfig.json')
GENERATED = 'tooling/next-eslint-glob/node_modules'
META = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
STAGES = ('BINDING', 'DIRECTORIES', 'BUILD_CANDIDATE', 'BUILD_FALLBACK', 'FREEZE_CANDIDATE',
          'FREEZE_FALLBACK', 'PREIMAGE', 'REHEARSE_CANDIDATE', 'REHEARSE_FALLBACK', 'FINAL')


def require(value):
    if not value:
        raise ValueError('preparation refused')


def metadata(value):
    return tuple(getattr(value, key) for key in META)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def git_object(kind, raw):
    return hashlib.sha1(kind.encode() + b' ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def git_tree(files):
    root = {}
    for name, row in files.items():
        node = root
        parts = name.split('/')
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = (row['gitMode'], row['gitBlob'])
    def tree(node):
        entries = []
        for name, value in node.items():
            directory = isinstance(value, dict)
            mode, digest = ('40000', tree(value)) if directory else value
            entries.append((name + ('/' if directory else ''), mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(digest)))
        return git_object('tree', b''.join(raw for _, raw in sorted(entries)))
    return tree(root)


@contextlib.contextmanager
def anchored_file(root, name, owners):
    """No privileged pathname-following reads from an app-controlled build."""
    parts = Path(name).parts
    require(parts and not Path(name).is_absolute() and all(p not in ('', '.', '..') for p in parts))
    held, bindings = [], []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        held.append(fd)
        require(Path(root).resolve(strict=True) == Path(root))
        root_info = os.fstat(fd)
        require(root_info.st_uid in owners and not root_info.st_mode & 0o022)
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            held.append(child)
            info = os.fstat(child)
            require(info.st_uid in owners and not info.st_mode & 0o022)
            require(metadata(os.stat(part, dir_fd=fd, follow_symlinks=False)) == metadata(info))
            bindings.append((fd, part, child, metadata(info)))
            fd = child
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        held.append(leaf)
        info = os.fstat(leaf)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid in owners and
                not info.st_mode & 0o022 and info.st_size <= 512 * 1024**2)
        yield leaf, info
        require(metadata(os.fstat(leaf)) == metadata(info) and
                metadata(os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)) == metadata(info))
        require(Path(root).resolve(strict=True) == Path(root))
        require(metadata(Path(root).stat()) == metadata(root_info) == metadata(os.fstat(held[0])))
        for parent, name, child, identity in bindings:
            require(metadata(os.stat(name, dir_fd=parent, follow_symlinks=False)) == identity == metadata(os.fstat(child)))
    finally:
        for fd in reversed(held):
            os.close(fd)


def file_row(root, name, owners, sink=None):
    with anchored_file(root, name, owners) as (fd, info):
        digest = hashlib.sha256()
        blob = hashlib.sha1(b'blob ' + str(info.st_size).encode() + b'\0')
        size = 0
        while chunk := os.read(fd, 1024**2):
            size += len(chunk)
            require(size <= info.st_size)
            digest.update(chunk); blob.update(chunk)
            if sink is not None:
                sink.write(chunk)
        require(size == info.st_size)
        return {'type': 'file', 'size': size, 'mode': 0o755 if info.st_mode & 0o111 else 0o644,
                'sha256': digest.hexdigest(), 'gitMode': '100755' if info.st_mode & 0o111 else '100644',
                'gitBlob': blob.hexdigest()}


def source_files(root, owner, candidate=False):
    root = Path(root)
    names = list(ROOT_FILES) + (['playwright.worklists.config.mjs'] if candidate else [])
    for base in SOURCE_DIRS:
        directory = root / base
        if not directory.exists():
            continue
        require(directory.is_dir() and not directory.is_symlink())
        for current, dirs, files in os.walk(directory, followlinks=False):
            relative = Path(current).relative_to(root).as_posix()
            if relative == GENERATED:
                dirs[:] = []; continue
            require(not Path(current).is_symlink())
            for name in dirs:
                require(not (Path(current) / name).is_symlink())
            names.extend((Path(current) / name).relative_to(root).as_posix() for name in files)
    require(len(names) == len(set(names)) and len(names) <= 2000)
    return {name: file_row(root, name, (0, owner)) for name in sorted(names)}


def private_copy(database, destination, deadline):
    """Same readonly backup pattern as preserving.rehearse, not live-row equality."""
    database, destination = Path(database), Path(destination)
    require(database.resolve(strict=True) == database and not any(c in str(database) for c in ('?', '#')))
    info = database.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    with database.open('rb') as stream:
        header = stream.read(100)
    if header[18:20] == b'\x02\x02':
        for suffix in ('-wal', '-shm'):
            sidecar = Path(str(database) + suffix)
            data = sidecar.lstat()
            require(sidecar.resolve(strict=True) == sidecar and stat.S_ISREG(data.st_mode) and data.st_nlink == 1)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    source = target = None
    try:
        source = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
        source.execute('PRAGMA query_only=ON')
        target = sqlite3.connect(destination)
        def progress(*_):
            require(time.monotonic() < deadline)
        source.backup(target, pages=128, progress=progress, sleep=0.1)
        require(target.execute('PRAGMA quick_check').fetchall() == [('ok',)])
    finally:
        if target is not None: target.close()
        if source is not None: source.close()
    after = database.lstat()
    require((after.st_dev, after.st_ino, after.st_uid, after.st_gid) ==
            (info.st_dev, info.st_ino, info.st_uid, info.st_gid))
    with destination.open('rb') as stream:
        os.fsync(stream.fileno())


def ensure_staging_roots(stager):
    """Approved fixed roots only; usable before the protected control package exists."""
    stager.protected_directory(STATE, 0)
    for name, mode in (('releases', 0o755), ('packages', 0o755), ('plans', 0o700), ('rehearsal-evidence', 0o700)):
        path = STATE / name
        if not os.path.lexists(path):
            path.mkdir(mode=mode)
        stager.protected_directory(path, 0)
        require(stat.S_IMODE(path.stat().st_mode) == mode)


def reserve_directories(stager, operation):
    ensure_staging_roots(stager)
    require(re.fullmatch('[1-9][0-9]{0,19}-1', operation))
    private = STATE / 'rehearsal-evidence' / operation
    private.mkdir(mode=0o700)  # Never reuse a partial/uncertain attempt.
    stager.protected_directory(private, 0)
    require(stat.S_IMODE(private.stat().st_mode) == 0o700)
    return private


def build_arguments(root, node, unit, build=None):
    # Private temp HOME/cache avoids unreviewed .npm files in the source tree.
    arguments = ['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--unit=' + unit,
            '--property=User=ubuntu', '--property=Group=ubuntu', '--property=WorkingDirectory=' + str(root),
            '--property=RuntimeMaxSec=900', '--property=ProtectSystem=strict', '--property=ProtectHome=tmpfs',
            '--property=BindPaths=' + str(root), '--property=ReadWritePaths=' + str(root),
            '--property=PrivateTmp=true', '--property=NoNewPrivileges=true', '--property=KillMode=control-group',
            '/usr/bin/env', 'PATH=' + str(Path(node).parent) + ':/usr/bin:/bin', 'HOME=/tmp',
            'npm_config_cache=/tmp/bubblewash-npm-cache', 'NEXT_TELEMETRY_DISABLED=1']
    if build is None:
        return arguments + ['/bin/bash', '-c', 'npm ci --no-audit --no-fund && npm run build']
    # This second exact-source workspace has never contained development deps.
    arguments.insert(arguments.index('/usr/bin/env'), '--property=BindReadOnlyPaths=' + str(build))
    return arguments + ['/bin/bash', '-c',
        'test ! -e .next && cp -a --no-preserve=ownership -- "$1/.next" .next && npm ci --omit=dev --no-audit --no-fund',
        'prepare-production', str(build)]


def canonical_dependency_image(installed):
    """Derive the unchanged stager's public-code image modes, never chmod an install."""
    require(type(installed) is dict and installed and 'next/package.json' in installed and 'better-sqlite3/package.json' in installed)
    image, changes = {}, {}
    for name, row in sorted(installed.items()):
        require(type(name) is str and name and not name.startswith('/') and
                all(part not in ('', '.', '..') for part in name.split('/')))
        require(type(row) is dict)
        if set(row) == {'link'}:
            target = row['link']
            require(type(target) is str and target and not Path(target).is_absolute())
            resolved = os.path.normpath(str(Path(name).parent / target))
            require(resolved in installed and set(installed[resolved]) == {'sha256', 'mode'})
            image[name] = dict(row)
            continue
        require(set(row) == {'sha256', 'mode'} and type(row['sha256']) is str and
                re.fullmatch('[a-f0-9]{64}', row['sha256']) and type(row['mode']) is int)
        mode = row['mode']
        require(0 <= mode <= 0o777 and not mode & 0o022)
        canonical_mode = 0o755 if mode & 0o111 else 0o644
        image[name] = {'sha256': row['sha256'], 'mode': canonical_mode}
        if mode != canonical_mode:
            changes[name] = {'beforeMode': mode, 'afterMode': canonical_mode, 'sha256': row['sha256']}
    return image, changes


def freeze(root, release_sha, private, owner, stager, contracts, source):
    """Only root-private archive writes; existing stager owns final extraction."""
    roots = ['.next', 'node_modules']
    names = set(source) | {'.release-sha'}
    links = {}
    for name in roots:
        directory = root / name
        require(directory.is_dir() and not directory.is_symlink())
        for current, dirs, files in os.walk(directory, followlinks=False):
            rel = Path(current).relative_to(root).as_posix()
            if rel == '.next/cache':
                dirs[:] = []; continue
            for child in dirs:
                require(not (Path(current) / child).is_symlink())
            for child in files:
                path = Path(current) / child
                relative = path.relative_to(root).as_posix()
                if path.is_symlink():
                    require(relative.startswith('node_modules/'))
                    target = os.readlink(path)
                    require(not Path(target).is_absolute() and path.resolve(strict=True).is_relative_to(root/'node_modules'))
                    require(path.resolve().is_file())
                    links[relative] = target
                else:
                    names.add(relative)
    # npm --omit=dev still materializes unused nested tooling dependencies on
    # this exact lock. They are not tracked and are NOT part of the runtime.
    # The strict final source/dependency scanners remain unchanged. No symlink
    # from the production dependency tree may escape into this omitted subtree.
    require(not os.path.lexists(root/'node_modules/fast-glob'))
    require(len(names) + len(links) <= stager.MAX_FILES)
    rows = {name: file_row(root, name, (0, owner)) for name in sorted(names)}
    for name, target in links.items():
        resolved = os.path.normpath(str(Path(name).parent / target))
        require(resolved in rows)
        rows[name] = {'type': 'link', 'target': target}
    archive = private / (release_sha + '.tar')
    with archive.open('xb') as raw:
        os.fchmod(raw.fileno(), 0o600)
        with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            for name, row in rows.items():
                item = tarfile.TarInfo(name)
                item.mode = row.get('mode', 0o777)
                if row['type'] == 'link':
                    require(os.readlink(root/name) == row['target'])
                    item.type = tarfile.SYMTYPE; item.linkname = row['target']; tar.addfile(item)
                else:
                    with anchored_file(root, name, (0, owner)) as (fd, info):
                        require(info.st_size == row['size'])
                        item.size = row['size']
                        with os.fdopen(os.dup(fd), 'rb') as stream: tar.addfile(item, stream)
                    require(file_row(root, name, (0, owner)) == row)
            raw.flush(); os.fsync(raw.fileno())
    manifest = {'schema': 'bubblewash-inactive-artifact/v1', 'archiveSha256': contracts.digest(archive),
                'files': {name: {key: value for key, value in row.items() if key not in ('gitMode', 'gitBlob')}
                          for name, row in rows.items()}}
    raw = canonical(manifest)
    manifest_path = private / (release_sha + '-manifest.json')
    with manifest_path.open('xb') as stream:
        os.fchmod(stream.fileno(), 0o600); stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    stager.parse_manifest(raw, sha(raw))
    stager.stage(archive, raw, sha(raw), STATE/'releases', release_sha)
    return STATE/'releases'/release_sha, sha(raw)


def probe_node_identity(core, adapter, target, node, unit, proc=Path('/proc')):
    """Only the fixed private probe's MainPID/listener, not a host process inventory."""
    before_node = adapter.protected(node['path'], parents=True)
    require(adapter.digest(node['path']) == node['sha256'])
    main = core.verify_private_network(unit, target)
    listeners = core.network_command(['ss', '-H', '-ltnp', 'sport = :3001'], main)
    listener_ids = set(re.findall(r'pid=(\d+)', listeners))
    require(len(listener_ids) == 1)
    pids = {str(main), *listener_ids}
    require(len(pids) in (1, 2) and all(re.fullmatch('[1-9][0-9]*', pid) and int(pid) > 1 for pid in pids))
    starts = {pid: adapter.process_identity(pid, proc) for pid in pids}
    cgroup = (proc/str(main)/'cgroup').read_bytes()
    for pid in pids:
        process = proc/pid
        require((process/'cwd').resolve(strict=True) == target and (process/'cgroup').read_bytes() == cgroup)
        executable = (process/'exe').resolve(strict=True)
        require(str(executable) == node['path'] and adapter.digest(executable) == node['sha256'])
        require(adapter.process_identity(pid, proc) == starts[pid])
    require(core.verify_private_network(unit, target) == main and
            set(re.findall(r'pid=(\d+)', core.network_command(['ss', '-H', '-ltnp', 'sport = :3001'], main))) == listener_ids)
    require(adapter.protected(node['path'], parents=True) == before_node and adapter.digest(node['path']) == node['sha256'])
    return tuple(sorted(starts.items())), cgroup, before_node


def pinned_rehearsal_report(core, adapter, target, node, unit):
    """Explicit extra guards at two stages of the exact pinned historical helper.

    All inherited report/error/cleanup behavior remains in force. No command,
    controller, source selector or historical guard is replaced.
    """
    class PinnedReport(core.RehearsalReport):
        def __init__(self):
            self.node_stages = []
            self.node_identity = None
            super().__init__()

        @property
        def stage(self):
            return self._stage

        @stage.setter
        def stage(self, value):
            self._stage = value
            if value not in ('RUNTIME_BEFORE', 'RUNTIME_AFTER'):
                return
            require(self.node_stages == ([] if value == 'RUNTIME_BEFORE' else ['RUNTIME_BEFORE']))
            identity = probe_node_identity(core, adapter, target, node, unit)
            if self.node_identity is not None:
                require(identity == self.node_identity)
            self.node_identity = identity
            self.node_stages.append(value)
    return PinnedReport()


def rehearse_pair(core, adapter, candidate, fallback, preimage, values, status, owner, node, operation, bound, set_stage=lambda _: None):
    """Copy-only use of the reviewed migration methods. No durable state exists."""
    initial = core.database_fingerprint(preimage)
    timings = {}
    previous = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(core.RehearsalDeadline()))
    try:
        for label, target in (('candidate', candidate), ('fallback', fallback)):
            set_stage('REHEARSE_' + label.upper())
            bound()
            require(core.database_fingerprint(preimage) == initial)
            host = adapter.Host.__new__(adapter.Host)
            host.plan = {'candidate': str(candidate), 'snapshot': str(preimage), 'node': node}
            host.run = adapter.Host.command
            def prepare(copy):
                require(Path(copy).resolve(strict=True) != preimage.resolve(strict=True) and
                        Path(copy).name == 'rehearsal.sqlite' and Path(copy).parent.parent == core.RUNTIME)
                started = time.monotonic()
                host.migrate(copy)
                host.acknowledgement(host.feature(copy, '--verify'),
                    {'ok': True, 'status': 'exact-post-feature-ready', 'databaseChanged': False})
                adapter.verify_completion_data(preimage, copy, 'complete')
                timings[label + 'MigrationAndProofSeconds'] = round(time.monotonic() - started, 3)
            report = pinned_rehearsal_report(core, adapter, target, node,
                                             'bubblewash-prepare-' + operation + '-' + label + '-probe.service')
            started = time.monotonic()
            signal.setitimer(signal.ITIMER_REAL, 300)
            try:
                core.rehearse(target, values, preimage, status, owner,
                              'bubblewash-prepare-' + operation + '-' + label, report, prepare_snapshot=prepare)
                require(report.failure is None and report.cleanup and report.safe_to_remove and
                        report.node_stages == ['RUNTIME_BEFORE', 'RUNTIME_AFTER'])
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
            require(core.database_fingerprint(preimage) == initial)
            timings[label + 'RehearsalSeconds'] = round(time.monotonic() - started, 3)
            bound()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    return timings


def prepare_pair(request, *, core, guards, scanner, contracts, adapter, stager, contract):
    """All modules and request public pins are authenticated by the control stream.

    The bootstrap may not accept arbitrary source contracts, module paths or
    environment values. The existing exact-hosted-run check runs before tailnet.
    """
    require(os.geteuid() == 0 and set(request) == {'runId', 'runAttempt', 'candidateSha', 'fallbackSha',
            'backupSha256', 'receiptRun', 'storeSha', 'storeId', 'node'})
    require(re.fullmatch('[1-9][0-9]{0,19}', request['runId']) and request['runAttempt'] == 1)
    require(all(request[key+'Sha'] == value[0] for key, value in PAIR.items()))
    require(re.fullmatch('[a-f0-9]{64}', request['backupSha256']) and
            re.fullmatch('[1-9][0-9]{0,19}', request['receiptRun']) and
            re.fullmatch('[a-f0-9]{40}', request['storeSha']) and type(request['storeId']) is int and request['storeId'] > 0)
    node = request['node']
    require(set(node) == {'path', 'sha256'} and re.fullmatch('[a-f0-9]{64}', node['sha256']))
    adapter.protected(node['path'], parents=True)
    require(contracts.digest(node['path']) == node['sha256'])
    owner = pwd.getpwnam('ubuntu')
    operation = request['runId'] + '-1'
    stage, timings = 'BINDING', {}
    try:
        contract_path = adapter.HERE/'source-contracts.json'
        contract_identity = adapter.protected(contract_path, parents=True)
        with contract_path.open('rb') as stream:
            contract_raw = stream.read(131073)
        require(len(contract_raw) <= 131072 and json.loads(contract_raw) == contract)
        contract_digest = sha(contract_raw)
        require(contracts.digest(contract_path) == contract_digest)
        with core.deployment_lock(core.RUNTIME, owner.pw_uid) as locked:
            current = core.CURRENT.resolve(strict=True)
            require(core.CURRENT.is_symlink() and current.parent == WORK)
            marker = guards.inspect_read(core.RUNTIME/'current-release', owner, 'current')
            require(core.parse(marker).get('sha') == LIVE and core.parse(marker).get('path') == str(current))
            release_marker = guards.inspect_read(current/'.release-sha', owner, 'current', 128)
            require(release_marker.decode().strip() == LIVE)
            require(git_tree(source_files(current, owner.pw_uid)) == LIVE_TREE)
            current_files, current_identity = scanner.source_snapshot(current, owner)
            require(scanner.content_commitment(current_files) == scanner.pins['runtimeContent'] and scanner.pins['runtimeSha'] == LIVE)
            raw, env_identity = guards.environment_snapshot(core.ENV, owner, None)
            values = core.parse(raw)
            scanner.open_configuration(values)
            adapter.admit_production_configuration(values)
            database = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
            require(not database.is_relative_to(WORK) and not database.is_relative_to(STATE))
            database_identity = guards.database_identity(database, owner)
            receipt_raw = guards.inspect_read(core.RECEIPT, owner, 'backup')
            receipt = json.loads(receipt_raw)
            require(receipt.get('sha256') == request['backupSha256'])
            status = Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH', ''))
            archive = Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR', '')) / receipt['filename']
            def bound():
                locked()
                require(adapter.protected(contract_path, parents=True) == contract_identity and
                        contracts.digest(contract_path) == contract_digest)
                require(core.CURRENT.resolve(strict=True) == current and guards.inspect_read(core.RUNTIME/'current-release', owner, 'current') == marker)
                require(guards.inspect_read(current/'.release-sha', owner, 'current', 128) == release_marker)
                require(scanner.source_snapshot(current, owner) == (current_files, current_identity))
                require(guards.environment_snapshot(core.ENV, owner, sha(raw)) == (raw, env_identity))
                require(guards.database_identity(database, owner) == database_identity)
                require(guards.inspect_read(core.RECEIPT, owner, 'backup') == receipt_raw)
                require(guards.file_identity(archive, owner, request['backupSha256']) and archive.stat().st_size == receipt['size'])
                core.verify_receipt(receipt, json.loads(guards.inspect_read(status, owner, 'backup')), time.time(),
                                    request['receiptRun'], request['storeSha'], request['storeId'])
                adapter.protected(node['path'], parents=True)
                require(contracts.digest(node['path']) == node['sha256'])
                guards.runtime_flags(current, values, True)
                core.health(3000)
            bound()
            stage = 'DIRECTORIES'
            private = reserve_directories(stager, operation)
            frozen, proofs = {}, {}
            for label, (release_sha, tree) in PAIR.items():
                build = WORK / ('prepare-build-' + operation + '-' + release_sha)
                root = WORK / ('prepare-runtime-' + operation + '-' + release_sha)
                for path in (build, root):
                    guards.safe_path(path, owner, True)
                    require(path.stat().st_uid == owner.pw_uid and not (path/'data/submissions.jsonl').exists())
                    require(guards.inspect_read(path/'.release-sha', owner, 'source', 128).decode().strip() == release_sha)
                    require(not (path/'node_modules').exists() and not (path/'.next').exists())
                    contracts.verify_source(path, contract, 'integration-' + label + '-v1')
                    require(git_tree(source_files(path, owner.pw_uid, label == 'candidate')) == tree)
                source = source_files(root, owner.pw_uid, label == 'candidate')
                require(git_tree(source) == tree)
                contracts.verify_source(root, contract, 'integration-' + label + '-v1')
                stage = 'BUILD_' + label.upper()
                started = time.monotonic()
                core.command(build_arguments(build, node['path'], 'bubblewash-prepare-' + operation + '-' + label + '-build'), timeout=930)
                require(source_files(build, owner.pw_uid, label == 'candidate') == source)
                core.command(build_arguments(root, node['path'], 'bubblewash-prepare-' + operation + '-' + label + '-production', build), timeout=930)
                timings[label+'BuildSeconds'] = round(time.monotonic() - started, 3)
                require(source_files(root, owner.pw_uid, label == 'candidate') == source)
                require((root/'.next/BUILD_ID').is_file())
                installed_dependencies = contracts.dependency_manifest(root/'node_modules')
                dependencies, mode_changes = canonical_dependency_image(installed_dependencies)
                runtime = contracts.runtime_manifest(root, release_sha)
                bound()
                stage = 'FREEZE_' + label.upper()
                frozen[label], artifact = freeze(root, release_sha, private, owner.pw_uid, stager, contracts, source)
                require(git_tree(source_files(frozen[label], 0, label == 'candidate')) == tree)
                contracts.verify_source(frozen[label], contract, 'integration-' + label + '-v1')
                adapter.require_no_runtime_cache(frozen[label])
                require(contracts.dependency_manifest(root/'node_modules') == installed_dependencies)
                require(contracts.dependency_manifest(frozen[label]/'node_modules') == dependencies and
                        contracts.runtime_manifest(frozen[label], release_sha) == runtime)
                proofs[label] = {'sha': release_sha, 'tree': tree, 'artifactManifestSha256': artifact,
                                 'runtime': runtime, 'dependencies': dependencies, 'dependencyModeChanges': mode_changes}
            bound()
            stage = 'PREIMAGE'
            preimage = private/'preimage.sqlite'
            started = time.monotonic()
            private_copy(database, preimage, started+300)
            timings['snapshotSeconds'] = round(time.monotonic()-started, 3)
            bound()
            stage = 'REHEARSE_CANDIDATE'
            def set_stage(value):
                nonlocal stage
                require(value in STAGES)
                stage = value
            timings.update(rehearse_pair(core, adapter, frozen['candidate'], frozen['fallback'], preimage,
                                        values, status, owner, node, operation, bound, set_stage))
            stage = 'FINAL'
            bound()
            for label, root in frozen.items():
                adapter.require_no_runtime_cache(root)
                require(git_tree(source_files(root, 0, label == 'candidate')) == PAIR[label][1])
                require(contracts.runtime_manifest(root, PAIR[label][0]) == proofs[label]['runtime'] and
                        contracts.dependency_manifest(root/'node_modules') == proofs[label]['dependencies'])
            evidence = {'schema': 'bubblewash-inactive-preparation/v1', 'operation': operation, 'liveSha': LIVE,
                        'pair': proofs, 'timings': timings, 'sourceContractSha256': contract_digest,
                        'preimageSha256': contracts.digest(preimage), 'maintenanceApproval': False}
            with (private/'evidence.json').open('xb') as stream:
                os.fchmod(stream.fileno(), 0o600); stream.write(canonical(evidence)); stream.flush(); os.fsync(stream.fileno())
            return {'ok': True, 'status': 'inactive-pair-rehearsed', 'timings': timings, 'productionChanged': False,
                    'liveDatabaseWritten': False, 'automaticRetry': False, 'maintenanceApproval': False}
    except BaseException:
        return {'ok': False, 'status': 'preparation-refused-or-incomplete', 'stage': stage,
                'automaticRetry': False, 'inspectBeforeRetry': True, 'maintenanceApproval': False}


if __name__ == '__main__':
    raise SystemExit('Use the reviewed control bootstrap; no standalone production route.')
