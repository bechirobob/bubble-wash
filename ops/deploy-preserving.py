#!/usr/bin/env python3
"""Manual code-only release. Never rewrite environment, reset data, or install units."""
import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import sqlite3
import stat
import subprocess
import tempfile
import time

HOME = Path('/home/ubuntu')
CURRENT = HOME / 'bubblewash-pilot'
ENV = HOME / '.config/bubblewash/env'
RUNTIME = HOME / 'bubblewash-runtime'
RECEIPT = HOME / 'bubblewash-backups/offhost-release.json'
UNIT = 'bubblewash-local.service'


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def parse(raw):
    require(len(raw) <= 65536, 'environment exceeds bound')
    result = {}
    for line in raw.decode().splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        require(match and match[1] not in result, 'unsupported environment syntax')
        value = match[2].strip()
        if value.startswith(('"', "'")):
            require(len(value) >= 2 and value[-1] == value[0], 'unsupported environment syntax')
            value = value[1:-1]
        require(not any(c in value for c in '\\"\'`\x00\r\n'), 'unsupported environment syntax')
        result[match[1]] = value
    return result


def verify_receipt(receipt, status, now, run_id, store_sha, store_id):
    require(receipt.get('schema') == 'becore-encrypted-backup-release/v2' and
            receipt.get('repository') == 'bechirobob/bubble-wash' and
            receipt.get('storageRepository') == 'bechirobob/becore-backups' and
            receipt.get('storage') == 'private-github-release' and
            receipt.get('storageSha') == store_sha and
            receipt.get('storageRepositoryId') == store_id and
            str(receipt.get('runId')) == run_id, 'backup receipt identity mismatch')
    require(all(receipt.get(k) is True for k in ('encrypted', 'restoreTested', 'downloadVerified')),
            'backup verification proof missing')
    require(receipt.get('automaticExpiry') is False and receipt.get('retentionDays') is None,
            'backup retention mismatch')
    require(re.fullmatch(r'bubblewash-[0-9TZ.:-]+\.sqlite\.enc', receipt.get('filename', '')) and
            re.fullmatch(r'[a-f0-9]{64}', receipt.get('sha256', '')) and
            re.fullmatch(r'[a-f0-9]{40}', receipt.get('sourceSha', '')) and
            type(receipt.get('size')) is int and receipt['size'] > 0, 'backup metadata invalid')
    require(status.get('ok') is True and status.get('filename') == receipt['filename'] and
            status.get('sha256') == receipt['sha256'], 'backup status does not match receipt')
    stamps = [dt.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() for v in
              (status['createdAt'], status['restoreVerifiedAt'], receipt['verifiedAt'], status['offsiteStoredAt'])]
    require(all(0 <= now - value <= 30 * 3600 for value in stamps), 'backup is expired or future-dated')
    require(stamps[0] <= stamps[1] <= stamps[2] + 1 and stamps[2] <= stamps[3] + 1,
            'backup verification chronology mismatch')


def database_fingerprint(path):
    # Only host-local rehearsal snapshots are fingerprinted. No data is printed.
    with sqlite3.connect(path) as db:
        require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'rehearsal database integrity failed')
        schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
        metadata = (db.execute('PRAGMA user_version').fetchone(), db.execute('PRAGMA application_id').fetchone())
        h = hashlib.sha256(repr((schema, metadata)).encode())
        # SELECT * omits hidden rowids, which the application uses as tie-breakers.
        # Hash each rowid together with its row, not as a separate unordered set.
        tables = {row[1]: row for row in db.execute('PRAGMA main.table_list') if row[0] == 'main'}
        for kind, name, _, _ in schema:
            if kind == 'table':
                table = tables.get(name)
                require(table is not None and table[2] == 'table' and table[4] in (0, 1),
                        'rehearsal table identity cannot be completely fingerprinted')
                quoted = '"' + name.replace('"', '""') + '"'
                columns = db.execute('PRAGMA main.table_xinfo(' + quoted + ')').fetchall()
                require(columns and len(columns) == table[3], 'rehearsal table columns cannot be completely fingerprinted')
                selection = '*'
                if table[4] == 0:  # Ordinary rowid table, including INTEGER PRIMARY KEY aliases.
                    names = {column[1].casefold() for column in columns}
                    alias = next((name for name in ('rowid', '_rowid_', 'oid') if name not in names), None)
                    require(alias is not None, 'rehearsal hidden rowid is shadowed by every SQL alias')
                    selection = '"' + alias + '", *'
                rows = sorted(repr(row) for row in db.execute('SELECT ' + selection + ' FROM ' + quoted))
                h.update(name.encode() + b'\0' + '\n'.join(rows).encode())
        return h.hexdigest()


def command(args, timeout=30):
    # Captured stderr/stdout may contain application diagnostics. Never expose it.
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout).stdout.decode()


def ctl(*args):
    uid = pwd.getpwnam('ubuntu').pw_uid
    return command(['runuser', '-u', 'ubuntu', '--', 'env', f'XDG_RUNTIME_DIR=/run/user/{uid}',
                    f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus', 'systemctl', '--user', *args])


def network_command(args, pid=None, timeout=30):
    prefix = ['nsenter', '--target', str(pid), '--net', '--'] if pid is not None else []
    return command([*prefix, *args], timeout=timeout)


def verify_network_shape(probe_inode, host_inode, links, route_groups):
    require(probe_inode != host_inode, 'probe shares production network namespace')
    require(len(links) == 1 and links[0].get('ifname') == 'lo', 'probe has external network interfaces')
    for routes in route_groups:
        require(all(route.get('dev') == 'lo' and route.get('dst') != 'default' for route in routes),
                'probe has external network routes')


def verify_private_network(unit, candidate):
    props = parse(command(['systemctl', 'show', unit, '--property=ActiveState,MainPID']).encode())
    pid = int(props.get('MainPID', '0'))
    require(props.get('ActiveState') == 'active' and pid > 1 and
            (Path('/proc') / str(pid) / 'cwd').resolve() == candidate, 'probe process unavailable')
    probe_inode = (Path('/proc') / str(pid) / 'ns/net').stat().st_ino
    host_inode = Path('/proc/self/ns/net').stat().st_ino
    links = json.loads(network_command(['ip', '-j', 'link', 'show'], pid))
    routes = [json.loads(network_command(['ip', family, '-j', 'route', 'show', 'table', 'all'], pid))
              for family in ('-4', '-6')]
    verify_network_shape(probe_inode, host_inode, links, routes)
    return pid


def check_runtime(target, values, unit=UNIT, port=3000, user=True, network_pid=None):
    arguments = ['show', unit, '--property=LoadState,ActiveState,MainPID,WorkingDirectory,EnvironmentFiles']
    output = ctl(*arguments) if user else command(['systemctl', *arguments])
    props = parse(output.encode())
    require(props.get('LoadState') == 'loaded' and props.get('ActiveState') == 'active', 'service not active')
    require(Path(props.get('WorkingDirectory', '/nonexistent')).resolve() == target and
            props.get('EnvironmentFiles') == f'{ENV} (ignore_errors=no)', 'service target mismatch')
    pid = int(props.get('MainPID', '0'))
    require(pid > 1 and (Path('/proc') / str(pid) / 'cwd').resolve() == target, 'service process mismatch')
    if network_pid is not None:
        require(pid == network_pid, 'probe process changed')
    listeners = network_command(['ss', '-H', '-ltnp', 'sport = :' + str(port)], network_pid)
    pids = set(re.findall(r'pid=(\d+)', listeners))
    require(len(pids) == 1, 'ambiguous production listener')
    listener = next(iter(pids))
    require((Path('/proc') / listener / 'cwd').resolve() == target and
            (Path('/proc') / listener / 'cgroup').read_bytes() == (Path('/proc') / str(pid) / 'cgroup').read_bytes(),
            'listener outside release service')
    for process in (str(pid), listener):
        runtime = dict(item.decode().split('=', 1) for item in (Path('/proc') / process / 'environ').read_bytes().split(b'\0') if b'=' in item)
        require(all(runtime.get(k) == v for k, v in values.items()), 'runtime configuration drift')
        require(runtime.get('NODE_ENV') == 'production' and runtime.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true',
                'unsafe effective production mode')


def health(port, network_pid=None):
    for _ in range(30):
        try:
            raw = network_command(['curl', '--fail', '--silent', '--max-time', '3', '--max-filesize', '4096',
                           f'http://127.0.0.1:{port}/api/health'], network_pid, timeout=5)
            value = json.loads(raw)
            require(value.get('ok') is True and value.get('service') == 'Bubble Wash' and value.get('status') == 'alive',
                    'unexpected health response')
            return
        except (subprocess.SubprocessError, OSError, ValueError):
            time.sleep(1)
    raise ValueError('release health verification failed')


def activate(current, candidate, service, validate):
    """Keep the existing release and all live data. Roll back code only on failure."""
    require(current.is_symlink(), 'current release must already be a symlink')
    previous = current.resolve(strict=True)
    temporary = current.parent / ('.preserving-switch-' + str(os.getpid()))
    require(not temporary.exists() and not temporary.is_symlink(), 'switch path already exists')
    stopped = False
    try:
        stopped = True  # stop may have succeeded even if its command reports failure
        service('stop', UNIT)
        temporary.symlink_to(candidate)
        os.replace(temporary, current)
        service('start', UNIT)
        validate(candidate)
    except BaseException:
        if stopped:
            try:
                service('stop', UNIT)
            except Exception:
                pass  # Restore the pointer, then restart and verify the old release.
            if temporary.is_symlink():
                temporary.unlink()
            temporary.symlink_to(previous)
            os.replace(temporary, current)
            service('restart', UNIT)
            validate(previous)
            print('Previous release restored and verified; no database restore was attempted.', flush=True)
        raise
    finally:
        if temporary.is_symlink():
            temporary.unlink()


# Exact source/dependency transition, not an inference from a partial SQL grep.
# Review evidence identifies all changed writers and their retained-code readers.
LIVE_SOURCE_SHA256 = {'src': '23387dd00e0c0a97da2f0f125d853e6b4a289009b758760377a49409fca0ac56', 'package.json': 'd33a04aae78f35b296c6f32ce3523136f2144d42694934113eff42fec01a1c52', 'package-lock.json': '5a3190f9d986628f05a8534ddb462b706bca0bb4b3caadc6e49b6328c84b056f', 'next.config.mjs': '55c7cca7ffcd8464dd2432dffef6ef2b7e4ebc3ee7d6dc508ba72855626cc08e', 'tsconfig.json': '2545dfb1c43a7c5ae010d7d6457b3dd3cf2df435f3116d8568f9e13b346ff42c'}
CANDIDATE_SOURCE_SHA256 = {'src': '8c13df12e056df03155bbaff504653b1d771c65eefcd7eaf6910cea4d0b8368d', 'package.json': 'fcebaa669a21c414d74cc921b4603d67cea338a8f11ef82bc18d60301c100b23', 'package-lock.json': '16bf7696ddfa1a4201c3fceb068f466e21287739d23cb7bb78ae80f9d1fb8ca8', 'next.config.mjs': '55c7cca7ffcd8464dd2432dffef6ef2b7e4ebc3ee7d6dc508ba72855626cc08e', 'tsconfig.json': '2545dfb1c43a7c5ae010d7d6457b3dd3cf2df435f3116d8568f9e13b346ff42c'}


def source_manifest(release):
    source = release / 'src'
    require(source.is_dir() and source.resolve(strict=True) == source, 'invalid source directory')
    rows = []
    for path in sorted(source.rglob('*')):
        require(not path.is_symlink(), 'source symlinks are not supported')
        if path.is_dir():
            continue
        require(path.is_file(), 'source must contain only regular files')
        rows.append((path.relative_to(source).as_posix(), digest(path)))
    require(rows, 'source tree is empty')
    result = {'src': hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()}
    for name in ('package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json'):
        path = release / name
        require(path.is_file() and not path.is_symlink(), 'invalid dependency manifest')
        result[name] = digest(path)
    return result


def verify_source_transition(current, candidate):
    require(source_manifest(current) == LIVE_SOURCE_SHA256 and
            source_manifest(candidate) == CANDIDATE_SOURCE_SHA256,
            'source or dependency transition lacks exact compatibility review')


@contextmanager
def deployment_lock(runtime, app_uid):
    """Use the existing shared inode, without following links or creating files."""
    require(runtime.resolve(strict=True) == runtime, 'runtime path must be canonical')
    directory = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        directory_stat = os.fstat(directory)
        require(stat.S_ISDIR(directory_stat.st_mode) and directory_stat.st_uid in (0, app_uid) and
                not directory_stat.st_mode & 0o022, 'unsafe runtime directory')
        lock = os.open('deploy.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        lock_stat = os.fstat(lock)
        require(stat.S_ISREG(lock_stat.st_mode) and lock_stat.st_nlink == 1 and
                lock_stat.st_uid in (0, app_uid) and not lock_stat.st_mode & 0o022, 'unsafe existing deployment lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

        def unchanged():
            current_directory = runtime.lstat()
            current_lock = os.stat('deploy.lock', dir_fd=directory, follow_symlinks=False)
            fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink')
            require(runtime.resolve(strict=True) == runtime and
                    all(getattr(current_directory, key) == getattr(directory_stat, key) for key in fields) and
                    all(getattr(current_lock, key) == getattr(lock_stat, key) for key in fields) and
                    os.fstat(lock).st_nlink == 1, 'shared deployment lock identity changed')
        unchanged()
        yield unchanged
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)


def public_health():
    # This check is part of activation, not a post-commit workflow step.
    raw = command(['curl', '--fail', '--silent', '--show-error', '--retry', '3', '--max-time', '15',
                   '--max-filesize', '4096', '--write-out', '\n%{http_code}',
                   'https://bubblewash.co/api/health'], timeout=90)
    body, _, status_code = raw.rpartition('\n')
    require(status_code == '200', 'public liveness requires HTTP 200 without redirect')
    value = json.loads(body)
    require(isinstance(value, dict) and value.get('ok') is True and value.get('service') == 'Bubble Wash' and
            value.get('status') == 'alive', 'unexpected public health response')


def main(lock_unchanged):
    parser = argparse.ArgumentParser()
    for key in ('candidate', 'sha', 'expected-live', 'backup-sha256', 'receipt-run', 'store-sha', 'store-id'):
        parser.add_argument('--' + key, required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'root host execution required')
    require(all(re.fullmatch(r'[a-f0-9]{40}', v) for v in (args.sha, args.expected_live, args.store_sha)), 'invalid commit pin')
    require(re.fullmatch(r'[a-f0-9]{64}', args.backup_sha256) and re.fullmatch(r'[1-9][0-9]*', args.receipt_run) and
            re.fullmatch(r'[1-9][0-9]*', args.store_id), 'invalid receipt pin')
    candidate = Path(args.candidate)
    require(candidate.resolve(strict=True) == candidate and candidate.parent == HOME / 'bubblewash-releases' and not candidate.is_symlink() and
            re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + args.sha[:12], candidate.name), 'invalid candidate directory')
    require((candidate / '.release-sha').read_text().strip() == args.sha, 'candidate SHA mismatch')
    require(CURRENT.is_symlink(), 'current release must be a symlink for code-only rollback')
    current = CURRENT.resolve(strict=True)
    require(current != candidate and (current / '.next/BUILD_ID').is_file(), 'rollback release missing')
    old_marker = (RUNTIME / 'current-release').read_bytes()
    marker_values = parse(old_marker)
    require(marker_values.get('sha') == args.expected_live and
            Path(marker_values.get('path', '/nonexistent')).resolve() == current, 'live SHA or marker path mismatch')
    require(not ENV.is_symlink() and ENV.is_file(), 'unsupported environment file')
    raw = ENV.read_bytes()
    metadata = ENV.stat()
    values = parse(raw)
    require(values.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'false' and values.get('BUBBLEWASH_BOOKINGS_DISABLED') == 'true',
            'expected unlocked staff and paused bookings')
    require(values.get('NODE_ENV') in (None, 'production') and values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true', 'unsafe production mode')
    db = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
    require(db.is_absolute() and db.resolve(strict=True) == db and db.is_file() and not db.is_symlink() and not db.is_relative_to(current) and
            not db.is_relative_to(candidate), 'database must be stable and outside release directories')
    require(not (current / 'data/submissions.jsonl').exists() and not (candidate / 'data/submissions.jsonl').exists(),
            'legacy import would mutate data')
    verify_source_transition(current, candidate)
    # Additional schema/health byte-identity checks remain in force.
    for relative in ('src/lib/data-store.ts', 'src/lib/operational-store.ts',
                     'src/lib/availability-store.ts', 'src/lib/staff-accounts.ts', 'src/app/api/health/route.ts'):
        require(digest(current / relative) == digest(candidate / relative), 'database or health implementation requires separate review')
    receipt_raw = RECEIPT.read_bytes()
    receipt = json.loads(receipt_raw)
    require(receipt.get('sha256') == args.backup_sha256, 'encrypted archive pin mismatch')
    status_path = Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH', ''))
    require(status_path.is_absolute(), 'backup status path invalid')
    verify_receipt(receipt, json.loads(status_path.read_bytes()), time.time(), args.receipt_run, args.store_sha, int(args.store_id))
    archive = Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR', '')) / receipt['filename']
    require(archive.is_absolute() and archive.is_file() and not archive.is_symlink() and
            archive.stat().st_size == receipt['size'] and digest(archive) == receipt['sha256'], 'encrypted backup mismatch')
    check_runtime(current, values)
    health(3000)
    owner = pwd.getpwnam('ubuntu')
    unit = 'bubblewash-preserving-' + candidate.name
    # Build without production EnvironmentFile or production secrets/database.
    command(['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--unit=' + unit + '-build',
             '--property=User=ubuntu', '--property=Group=ubuntu', '--property=WorkingDirectory=' + str(candidate),
             '--property=RuntimeMaxSec=900', '--property=ProtectSystem=strict', '--property=ProtectHome=tmpfs',
             '--property=BindPaths=' + str(candidate), '--property=ReadWritePaths=' + str(candidate),
             '--property=PrivateTmp=true', '--property=NoNewPrivileges=true',
             '/usr/bin/env', 'HOME=' + str(candidate), 'NEXT_TELEMETRY_DISABLED=1',
             '/bin/bash', '-c', 'npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund'], timeout=930)
    require((candidate / '.next/BUILD_ID').is_file(), 'candidate build missing')
    # Snapshot stays private on the VPS. No public artifact or key transfer.
    with tempfile.TemporaryDirectory(prefix='release-rehearsal-', dir=RUNTIME) as directory:
        os.chown(directory, owner.pw_uid, owner.pw_gid)
        snapshot = Path(directory) / 'rehearsal.sqlite'
        # SQLite's read-only backup API includes committed WAL. Never use immutable=1.
        # Existing WAL shared-memory bookkeeping may be touched; no SQL writes or migration run on the source.
        with db.open('rb') as handle:
            header = handle.read(100)
        if header[18:20] == b'\x02\x02':
            for suffix in ('-wal', '-shm'):
                sidecar = Path(str(db) + suffix)
                require(sidecar.is_file() and not sidecar.is_symlink(), 'WAL requires existing regular sidecars')
        with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as source, sqlite3.connect(snapshot) as target:
            source.execute('PRAGMA query_only=ON')
            source.backup(target)
        os.chmod(snapshot, 0o600)
        os.chown(snapshot, owner.pw_uid, owner.pw_gid)
        before = database_fingerprint(snapshot)
        try:
            command(['systemd-run', '--quiet', '--collect', '--unit=' + unit + '-probe', '--property=User=ubuntu',
                     '--property=Group=ubuntu', '--property=WorkingDirectory=' + str(candidate),
                     '--property=EnvironmentFile=' + str(ENV), '--property=RuntimeMaxSec=180',
                     '--property=ProtectSystem=strict', '--property=ProtectHome=tmpfs',
                     '--property=BindReadOnlyPaths=' + str(candidate) + ' ' + str(status_path),
                     '--property=BindPaths=' + directory, '--property=ReadWritePaths=' + directory,
                     '--property=StandardOutput=null', '--property=StandardError=null', '--property=PrivateTmp=true',
                     '--property=NoNewPrivileges=true', '--property=PrivateNetwork=true',
                     '/usr/bin/env', 'NODE_ENV=production', 'BUBBLEWASH_DATABASE_PATH=' + str(snapshot),
                     str(candidate / 'node_modules/.bin/next'), 'start', '-H', '127.0.0.1', '-p', '3001'])
            probe_pid = verify_private_network(unit + '-probe.service', candidate)
            health(3001, probe_pid)
            probe_values = {**values, 'NODE_ENV': 'production', 'BUBBLEWASH_DATABASE_PATH': str(snapshot)}
            check_runtime(candidate, probe_values, unit + '-probe.service', 3001, False, probe_pid)
            for path in ('/', '/services', '/book', '/track', '/manage', '/early-access', '/api/ready'):
                network_command(['curl', '--fail', '--silent', '--max-time', '15', '--output', '/dev/null',
                                 'http://127.0.0.1:3001' + path], probe_pid)
            check_runtime(candidate, probe_values, unit + '-probe.service', 3001, False, probe_pid)
            require(verify_private_network(unit + '-probe.service', candidate) == probe_pid, 'probe namespace changed')
        finally:
            command(['systemctl', 'stop', unit + '-probe.service'])
        require(database_fingerprint(snapshot) == before, 'candidate rehearsal changed schema or data; separate migration review required')

    def unchanged():
        lock_unchanged()
        verify_source_transition(current, candidate)
        stat = ENV.stat()
        require(ENV.read_bytes() == raw and (stat.st_mode, stat.st_uid, stat.st_gid, stat.st_ino) ==
                (metadata.st_mode, metadata.st_uid, metadata.st_gid, metadata.st_ino), 'environment changed during release')
        require(RECEIPT.read_bytes() == receipt_raw, 'receipt changed during release')
        require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size == receipt['size'] and
                digest(archive) == args.backup_sha256, 'encrypted backup changed during release')
        verify_receipt(receipt, json.loads(status_path.read_bytes()), time.time(), args.receipt_run, args.store_sha, int(args.store_id))

    def write_marker(content):
        marker = RUNTIME / 'current-release'
        with tempfile.NamedTemporaryFile(dir=RUNTIME, prefix='.release-marker-', delete=False) as handle:
            handle.write(content)
            os.fchmod(handle.fileno(), 0o600)
            os.fchown(handle.fileno(), owner.pw_uid, owner.pw_gid)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, marker)

    def validate(target):
        health(3000)
        check_runtime(target, values)
        public_health()
        unchanged()
        if target == candidate:
            write_marker(f'sha={args.sha}\nrelease={candidate.name}\npath={candidate}\n'.encode())
        else:
            write_marker(old_marker)

    unchanged()
    require(CURRENT.resolve(strict=True) == current and (RUNTIME / 'current-release').read_bytes() == old_marker,
            'live release drifted during preparation')
    check_runtime(current, values)
    lock_unchanged()
    activate(CURRENT, candidate, ctl, validate)
    # No readiness request against live DB. It was proven only against a copy.
    print(json.dumps({'ok': True, 'sha': args.sha, 'previousSha': args.expected_live,
                      'configurationUnchanged': True, 'staffLoginUnlocked': True, 'bookingsPaused': True,
                      'databaseReset': False, 'rollbackReleaseRetained': True}))


if __name__ == '__main__':
    def interrupted(*_):
        raise RuntimeError('release interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        with deployment_lock(RUNTIME, pwd.getpwnam('ubuntu').pw_uid) as lock_unchanged:
            main(lock_unchanged)
    except BaseException:
        # Do not leak configuration, SQLite rows, or captured process diagnostics.
        print('Preserving deployment failed closed; inspect the release pointer and service before any retry.', flush=True)
        raise SystemExit(1)
