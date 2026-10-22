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
import sys
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
    state = props.get('ActiveState')
    require(state not in ('inactive', 'failed'), 'probe terminal state')
    require(state != 'deactivating', 'probe process stopping')
    require(state != 'activating', 'probe startup pending')
    require(state == 'active', 'probe active state unsupported')
    pid = int(props.get('MainPID', '0'))
    require(pid > 1, 'probe PID unavailable')
    try:
        cwd = (Path('/proc') / str(pid) / 'cwd').resolve(strict=True)
    except FileNotFoundError:
        raise ValueError('probe working directory unavailable') from None
    require(cwd == candidate, 'probe working directory mismatch')
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
CANDIDATE_SOURCE_SHA256 = {'src': '8c13df12e056df03155bbaff504653b1d771c65eefcd7eaf6910cea4d0b8368d', 'package.json': '48f1c8740915afbf91091bdedf6ec65de340b2f6fa70b96338c9276e3cbb1c6e', 'package-lock.json': '65ac93becf9f1e4b44af8633e120a547c33a438af5cb6d83f2f8fe1dc77a9e38', 'next.config.mjs': '55c7cca7ffcd8464dd2432dffef6ef2b7e4ebc3ee7d6dc508ba72855626cc08e', 'tsconfig.json': '2545dfb1c43a7c5ae010d7d6457b3dd3cf2df435f3116d8568f9e13b346ff42c'}


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


# Exact static messages only. Unknown or dynamic exceptions remain generic;
# neither exception text nor host values are ever emitted.
REHEARSAL_GUARD_CODES = {
    'environment exceeds bound': 'KEY_VALUE_BOUND',
    'unsupported environment syntax': 'KEY_VALUE_SYNTAX',
    'backup receipt identity mismatch': 'BACKUP_IDENTITY_MISMATCH',
    'backup verification proof missing': 'BACKUP_PROOF_MISSING',
    'backup retention mismatch': 'BACKUP_RETENTION_MISMATCH',
    'backup metadata invalid': 'BACKUP_METADATA_INVALID',
    'backup status does not match receipt': 'BACKUP_STATUS_MISMATCH',
    'backup is expired or future-dated': 'BACKUP_STALE',
    'backup verification chronology mismatch': 'BACKUP_CHRONOLOGY',
    'rehearsal database integrity failed': 'SNAPSHOT_INTEGRITY',
    'rehearsal table identity cannot be completely fingerprinted': 'FINGERPRINT_TABLE_UNSUPPORTED',
    'rehearsal table columns cannot be completely fingerprinted': 'FINGERPRINT_COLUMNS_UNSUPPORTED',
    'rehearsal hidden rowid is shadowed by every SQL alias': 'FINGERPRINT_ROWID_SHADOWED',
    'probe shares production network namespace': 'PROBE_SHARED_NETWORK',
    'probe has external network interfaces': 'PROBE_EXTERNAL_LINKS',
    'probe has external network routes': 'PROBE_EXTERNAL_ROUTES',
    'probe terminal state': 'PROBE_TERMINAL_STATE',
    'probe process stopping': 'PROBE_PROCESS_STOPPING',
    'probe startup pending': 'PROBE_STARTUP_PENDING',
    'probe active state unsupported': 'PROBE_STATE_UNSUPPORTED',
    'probe PID unavailable': 'PROBE_PID_UNAVAILABLE',
    'probe working directory unavailable': 'PROBE_CWD_UNAVAILABLE',
    'probe working directory mismatch': 'PROBE_CWD_MISMATCH',
    'service not active': 'RUNTIME_NOT_ACTIVE',
    'service target mismatch': 'RUNTIME_TARGET_MISMATCH',
    'service process mismatch': 'RUNTIME_PROCESS_MISMATCH',
    'probe process changed': 'PROBE_PROCESS_CHANGED',
    'ambiguous production listener': 'RUNTIME_LISTENER_AMBIGUOUS',
    'listener outside release service': 'RUNTIME_LISTENER_OUTSIDE_SERVICE',
    'runtime configuration drift': 'RUNTIME_CONFIG_DRIFT',
    'unsafe effective production mode': 'RUNTIME_MODE_UNSAFE',
    'release health verification failed': 'HEALTH_UNAVAILABLE',
    'invalid source directory': 'SOURCE_INVALID',
    'source symlinks are not supported': 'SOURCE_SYMLINK',
    'source must contain only regular files': 'SOURCE_NOT_REGULAR',
    'source tree is empty': 'SOURCE_EMPTY',
    'invalid dependency manifest': 'DEPENDENCY_MANIFEST_INVALID',
    'source or dependency transition lacks exact compatibility review': 'SOURCE_TRANSITION_UNREVIEWED',
    'runtime path must be canonical': 'RUNTIME_PATH_INVALID',
    'unsafe runtime directory': 'RUNTIME_DIRECTORY_UNSAFE',
    'unsafe existing deployment lock': 'LOCK_UNSAFE',
    'shared deployment lock identity changed': 'LOCK_CHANGED',
    'probe state unavailable': 'PROBE_STATE_UNAVAILABLE',
    'unsafe rehearsal cleanup': 'CLEANUP_PATH_UNSAFE',
    'rehearsal directory identity changed': 'CLEANUP_IDENTITY_CHANGED',
    'unexpected rehearsal cleanup entry': 'CLEANUP_ENTRY_UNEXPECTED',
    'rehearsal cleanup entry changed': 'CLEANUP_ENTRY_CHANGED',
    'candidate build missing': 'BUILD_MISSING',
    'diagnostic unit already exists': 'PROBE_UNIT_EXISTS',
    'WAL requires existing regular sidecars': 'SOURCE_WAL_SIDECARS_UNSAFE',
    'probe namespace changed': 'PROBE_NAMESPACE_CHANGED',
    'probe stop not verified': 'PROBE_STOP_UNVERIFIED',
    'candidate rehearsal changed schema or data; separate migration review required': 'FINGERPRINT_MUTATION',
    'unsupported release arguments': 'ARGUMENTS_INVALID',
    'rehearsal entrypoint mismatch': 'MODE_MISMATCH',
    'invalid diagnostic run identity': 'RUN_ID_INVALID',
    'root host execution required': 'EXECUTION_USER_INVALID',
    'invalid commit pin': 'COMMIT_PIN_INVALID',
    'invalid receipt pin': 'RECEIPT_PIN_INVALID',
    'invalid candidate directory': 'CANDIDATE_PATH_INVALID',
    'candidate SHA mismatch': 'CANDIDATE_SHA_MISMATCH',
    'current release must be a symlink for code-only rollback': 'LIVE_POINTER_INVALID',
    'rollback release missing': 'ROLLBACK_MISSING',
    'live SHA or marker path mismatch': 'LIVE_MARKER_MISMATCH',
    'unsupported environment file': 'ENV_FILE_INVALID',
    'expected unlocked staff and paused bookings': 'PROTECTION_FLAGS_MISMATCH',
    'unsafe production mode': 'PRODUCTION_MODE_UNSAFE',
    'database must be stable and outside release directories': 'DATABASE_PATH_INVALID',
    'legacy import would mutate data': 'LEGACY_IMPORT_PRESENT',
    'database or health implementation requires separate review': 'DATABASE_IMPLEMENTATION_CHANGED',
    'encrypted archive pin mismatch': 'ARCHIVE_PIN_MISMATCH',
    'backup status path invalid': 'BACKUP_STATUS_PATH_INVALID',
    'encrypted backup mismatch': 'ARCHIVE_MISMATCH',
    'environment changed during release': 'ENV_CHANGED',
    'receipt changed during release': 'RECEIPT_CHANGED',
    'encrypted backup changed during release': 'ARCHIVE_CHANGED',
    'live release drifted during preparation': 'LIVE_RELEASE_CHANGED',
}


class RehearsalDeadline(BaseException):
    # Must escape health's OSError/ValueError retry, unlike TimeoutError.
    pass


class RehearsalInterrupted(BaseException):
    pass


def release_interrupted(report):
    if report is None:
        raise RuntimeError('release interrupted')
    raise RehearsalInterrupted()


class RehearsalReport:
    """Only fixed codes leave the host; captured commands and exceptions never do."""
    def __init__(self):
        self.stage = 'PREFLIGHT'
        self.failure = None
        self.cleanup = True
        self.safe_to_remove = True
        self.deadline = time.monotonic() + 300

    def fail(self, error):
        if self.failure is None:
            code = ('TIMEOUT' if isinstance(error, (RehearsalDeadline, TimeoutError, subprocess.TimeoutExpired)) else
                    'COMMAND_FAILED' if isinstance(error, subprocess.CalledProcessError) else
                    REHEARSAL_GUARD_CODES.get(error.args[0], 'CHECK_FAILED')
                    if isinstance(error, ValueError) and len(error.args) == 1 and type(error.args[0]) is str else
                    'INTERRUPTED' if isinstance(error, (RehearsalInterrupted, KeyboardInterrupt, SystemExit)) else
                    'IO_FAILED' if isinstance(error, OSError) else
                    'DATABASE_FAILED' if isinstance(error, sqlite3.Error) else 'INTERNAL_FAILED')
            self.failure = {'stage': self.stage, 'error': code}

    def emit(self):
        print(json.dumps({'schema': 'bubblewash-rehearsal/v1', 'ok': self.failure is None,
                          'stage': self.failure['stage'] if self.failure else 'COMPLETE',
                          'error': self.failure['error'] if self.failure else 'NONE',
                          'cleanup': self.cleanup, 'activationAttempted': False}), flush=True)


def resume_rehearsal_deadline(report):
    if report is not None:
        signal.setitimer(signal.ITIMER_REAL, max(0.001, report.deadline - time.monotonic()))


def rehearsal_stage(report, stage):
    if report is not None:
        report.stage = stage


def probe_state(unit):
    # A --collect unit may disappear after stop. Accept only explicit unloaded
    # properties, never a failed/unparseable systemctl request as proof of stop.
    result = subprocess.run(['systemctl', 'show', unit,
                             '--property=LoadState,ActiveState,MainPID'],
                            capture_output=True, timeout=10, check=False)
    require(result.returncode in (0, 1), 'probe state unavailable')
    props = parse(result.stdout)
    require(props.get('LoadState') in ('loaded', 'not-found') and
            props.get('ActiveState') in ('active', 'activating', 'deactivating', 'inactive', 'failed') and
            re.fullmatch(r'[0-9]+', props.get('MainPID', '')), 'probe state unavailable')
    require(result.returncode == 0 or props.get('LoadState') == 'not-found', 'probe state unavailable')
    return props


def probe_stopped(props):
    return props.get('ActiveState') in ('inactive', 'failed') and props.get('MainPID') == '0'


def remove_rehearsal_directory(directory, identity, owner):
    """Delete only our stopped probe's private inode; never follow replacements."""
    path = Path(directory)
    require(path.parent == RUNTIME and path.name.startswith('release-rehearsal-') and
            path.resolve(strict=True) == path and not path.is_symlink(), 'unsafe rehearsal cleanup')
    parent = os.open(RUNTIME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    root = None
    try:
        root = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        current = os.fstat(root)
        require(stat.S_ISDIR(current.st_mode) and current.st_uid == owner.pw_uid and
                current.st_gid == owner.pw_gid and not current.st_mode & 0o077 and
                (current.st_dev, current.st_ino) == identity, 'rehearsal directory identity changed')
        # Bounded leaf-only cleanup. Unexpected contents are retained, never
        # recursively traversed. Validate every entry before deleting any.
        allowed = {'rehearsal.sqlite', 'rehearsal.sqlite-wal', 'rehearsal.sqlite-shm', 'rehearsal.sqlite-journal'}
        entries = {}
        with os.scandir(root) as scan:
            for entry in scan:
                require(entry.name in allowed and len(entries) < len(allowed), 'unexpected rehearsal cleanup entry')
                item = entry.stat(follow_symlinks=False)
                require(stat.S_ISREG(item.st_mode) and item.st_nlink == 1 and
                        item.st_uid in (0, owner.pw_uid) and item.st_gid in (0, owner.pw_gid),
                        'unexpected rehearsal cleanup entry')
                entries[entry.name] = (item.st_dev, item.st_ino)
        for name, identity_before in entries.items():
            item = os.stat(name, dir_fd=root, follow_symlinks=False)
            require((item.st_dev, item.st_ino) == identity_before and stat.S_ISREG(item.st_mode),
                    'rehearsal cleanup entry changed')
            os.unlink(name, dir_fd=root)
        named = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        require((named.st_dev, named.st_ino) == identity and stat.S_ISDIR(named.st_mode),
                'rehearsal directory identity changed')
        os.rmdir(path.name, dir_fd=parent)
    finally:
        if root is not None:
            os.close(root)
        os.close(parent)


@contextmanager
def rehearsal_directory(owner, report, unit):
    if report is None:
        with tempfile.TemporaryDirectory(prefix='release-rehearsal-', dir=RUNTIME) as directory:
            os.chown(directory, owner.pw_uid, owner.pw_gid)
            yield directory
        return
    prefix = 'release-rehearsal-' + unit.removeprefix('bubblewash-rehearsal-') + '-'
    directory = tempfile.mkdtemp(prefix=prefix, dir=RUNTIME)
    report.cleanup = False
    os.chown(directory, owner.pw_uid, owner.pw_gid)
    metadata = Path(directory).lstat()
    identity = (metadata.st_dev, metadata.st_ino)
    try:
        yield directory
    except BaseException as error:
        report.fail(error)
        raise
    finally:
        # Deadline cannot interrupt our bounded stop/cleanup after expiring.
        signal.setitimer(signal.ITIMER_REAL, 0)
        if report.safe_to_remove:
            rehearsal_stage(report, 'CLEANUP')
            try:
                remove_rehearsal_directory(directory, identity, owner)
                report.cleanup = True
            except BaseException as error:
                report.fail(error)
                raise
        resume_rehearsal_deadline(report)


def rehearse(candidate, values, db, status_path, owner, unit, report=None):
    rehearsal_stage(report, 'BUILD_ARTIFACT')
    require((candidate / '.next/BUILD_ID').is_file(), 'candidate build missing')
    if report is not None:
        rehearsal_stage(report, 'PROBE_ABSENT')
        state = probe_state(unit + '-probe.service')
        require(state['LoadState'] == 'not-found' and probe_stopped(state), 'diagnostic unit already exists')
    rehearsal_stage(report, 'SNAPSHOT')
    with rehearsal_directory(owner, report, unit) as directory:
        snapshot = Path(directory) / 'rehearsal.sqlite'
        # Consistent backup includes committed WAL. No source SQL writes or
        # migrations; normal source WAL/SHM read coordination may still occur.
        with db.open('rb') as handle:
            header = handle.read(100)
        if header[18:20] == b'\x02\x02':
            for suffix in ('-wal', '-shm'):
                sidecar = Path(str(db) + suffix)
                require(sidecar.is_file() and not sidecar.is_symlink(), 'WAL requires existing regular sidecars')
        source = target = None
        try:
            source = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)
            target = sqlite3.connect(snapshot)
            source.execute('PRAGMA query_only=ON')
            if report is None:
                source.backup(target)
            else:
                def backup_progress(*_):
                    if time.monotonic() >= report.deadline:
                        raise RehearsalDeadline()
                source.backup(target, pages=128, progress=backup_progress, sleep=0.1)
        finally:
            if target is not None:
                target.close()
            if source is not None:
                source.close()
        os.chmod(snapshot, 0o600)
        os.chown(snapshot, owner.pw_uid, owner.pw_gid)
        rehearsal_stage(report, 'FINGERPRINT_BEFORE')
        before = database_fingerprint(snapshot)
        try:
            rehearsal_stage(report, 'PROBE_START')
            if report is not None:
                report.safe_to_remove = False  # launch outcome may be uncertain
            # Type=simple reports success after fork, before cwd/namespace setup.
            # Type=exec supplies the setup barrier; all later guards stay strict.
            command(['systemd-run', '--quiet', '--collect', '--unit=' + unit + '-probe',
                     '--property=Type=exec', '--property=User=ubuntu',
                     '--property=Group=ubuntu', '--property=WorkingDirectory=' + str(candidate),
                     '--property=EnvironmentFile=' + str(ENV), '--property=RuntimeMaxSec=180',
                     '--property=ProtectSystem=strict', '--property=ProtectHome=tmpfs',
                     '--property=BindReadOnlyPaths=' + str(candidate) + ' ' + str(status_path),
                     '--property=BindPaths=' + directory, '--property=ReadWritePaths=' + directory,
                     '--property=StandardOutput=null', '--property=StandardError=null', '--property=PrivateTmp=true',
                     '--property=NoNewPrivileges=true', '--property=PrivateNetwork=true',
                     *(['--property=KillMode=control-group'] if report is not None else []),
                     '/usr/bin/env', 'NODE_ENV=production', 'BUBBLEWASH_DATABASE_PATH=' + str(snapshot),
                     str(candidate / 'node_modules/.bin/next'), 'start', '-H', '127.0.0.1', '-p', '3001'])
            rehearsal_stage(report, 'NAMESPACE_BEFORE')
            probe_pid = verify_private_network(unit + '-probe.service', candidate)
            rehearsal_stage(report, 'HEALTH')
            health(3001, probe_pid)
            probe_values = {**values, 'NODE_ENV': 'production', 'BUBBLEWASH_DATABASE_PATH': str(snapshot)}
            rehearsal_stage(report, 'RUNTIME_BEFORE')
            check_runtime(candidate, probe_values, unit + '-probe.service', 3001, False, probe_pid)
            routes = (('/', 'HOME'), ('/services', 'SERVICES'), ('/book', 'BOOK'), ('/track', 'TRACK'),
                      ('/manage', 'MANAGE'), ('/early-access', 'EARLY_ACCESS'), ('/api/ready', 'READY'))
            for path, label in routes:
                rehearsal_stage(report, 'ROUTE_' + label)
                network_command(['curl', '--fail', '--silent', '--max-time', '15', '--output', '/dev/null',
                                 'http://127.0.0.1:3001' + path], probe_pid)
            rehearsal_stage(report, 'RUNTIME_AFTER')
            check_runtime(candidate, probe_values, unit + '-probe.service', 3001, False, probe_pid)
            rehearsal_stage(report, 'NAMESPACE_AFTER')
            require(verify_private_network(unit + '-probe.service', candidate) == probe_pid, 'probe namespace changed')
        except BaseException as error:
            if report is not None:
                report.fail(error)
            raise
        finally:
            rehearsal_stage(report, 'PROBE_STOP')
            if report is not None:
                signal.setitimer(signal.ITIMER_REAL, 0)
            try:
                command(['systemctl', 'stop', unit + '-probe.service'])
                if report is not None:
                    # A failed/uncertain stop never authorizes deletion, even
                    # if a later observation happens to say not-found.
                    stopped = probe_stopped(probe_state(unit + '-probe.service'))
                    require(stopped, 'probe stop not verified')
                    report.safe_to_remove = True
            except BaseException as error:
                if report is not None:
                    report.fail(error)
                raise
        resume_rehearsal_deadline(report)
        rehearsal_stage(report, 'FINGERPRINT_AFTER')
        require(database_fingerprint(snapshot) == before, 'candidate rehearsal changed schema or data; separate migration review required')


class ReleaseArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('unsupported release arguments')


def main(lock_unchanged, report=None):
    parser = ReleaseArgumentParser()
    for key in ('candidate', 'sha', 'expected-live', 'backup-sha256', 'receipt-run', 'store-sha', 'store-id'):
        parser.add_argument('--' + key, required=True)
    parser.add_argument('--rehearsal-only', action='store_true')
    parser.add_argument('--run-id')
    parser.add_argument('--run-attempt')
    args = parser.parse_args()
    require(args.rehearsal_only == (report is not None), 'rehearsal entrypoint mismatch')
    if args.rehearsal_only:
        require(re.fullmatch(r'[1-9][0-9]{0,19}', args.run_id or '') and
                re.fullmatch(r'[1-9][0-9]{0,5}', args.run_attempt or ''), 'invalid diagnostic run identity')
    else:
        require(args.run_id is None and args.run_attempt is None, 'diagnostic arguments require rehearsal mode')
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

    if args.rehearsal_only:
        # This branch returns before any build, activation, or marker writer is
        # defined/called. Its only service mutation is its own transient probe.
        unit = 'bubblewash-rehearsal-' + args.run_id + '-' + args.run_attempt
        rehearse(candidate, values, db, status_path, owner, unit, report)
        rehearsal_stage(report, 'UNCHANGED')
        unchanged()
        require(CURRENT.resolve(strict=True) == current and (RUNTIME / 'current-release').read_bytes() == old_marker,
                'live release drifted during preparation')
        check_runtime(current, values)
        health(3000)
        lock_unchanged()
        return
    # Build without production EnvironmentFile or production secrets/database.
    command(['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--unit=' + unit + '-build',
             '--property=User=ubuntu', '--property=Group=ubuntu', '--property=WorkingDirectory=' + str(candidate),
             '--property=RuntimeMaxSec=900', '--property=ProtectSystem=strict', '--property=ProtectHome=tmpfs',
             '--property=BindPaths=' + str(candidate), '--property=ReadWritePaths=' + str(candidate),
             '--property=PrivateTmp=true', '--property=NoNewPrivileges=true',
             '/usr/bin/env', 'HOME=' + str(candidate), 'NEXT_TELEMETRY_DISABLED=1',
             '/bin/bash', '-c', 'npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund'], timeout=930)
    rehearse(candidate, values, db, status_path, owner, unit)

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
    report = RehearsalReport() if '--rehearsal-only' in sys.argv else None
    def interrupted(*_):
        release_interrupted(report)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        if report is not None:
            def deadline(*_):
                raise RehearsalDeadline()
            signal.signal(signal.SIGALRM, deadline)
            signal.setitimer(signal.ITIMER_REAL, 300)
        with deployment_lock(RUNTIME, pwd.getpwnam('ubuntu').pw_uid) as lock_unchanged:
            main(lock_unchanged, report)
        if report is not None:
            report.emit()
    except BaseException as error:
        if report is not None:
            report.fail(error)
            report.emit()
        else:
            # Never leak configuration, rows, or captured process diagnostics.
            print('Preserving deployment failed closed; inspect the release pointer and service before any retry.', flush=True)
        raise SystemExit(1)
    finally:
        if report is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
