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
CANDIDATE_SOURCE_SHA256 = {'src': '43770b9861b9063016b80c9a26778f21d48975da89b7183ee38cabe6a6c07347', 'package.json': '48f1c8740915afbf91091bdedf6ec65de340b2f6fa70b96338c9276e3cbb1c6e', 'package-lock.json': '65ac93becf9f1e4b44af8633e120a547c33a438af5cb6d83f2f8fe1dc77a9e38', 'next.config.mjs': '55c7cca7ffcd8464dd2432dffef6ef2b7e4ebc3ee7d6dc508ba72855626cc08e', 'tsconfig.json': '2545dfb1c43a7c5ae010d7d6457b3dd3cf2df435f3116d8568f9e13b346ff42c'}


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


# Only these reviewed read-only reader changes may differ from the old release.
REVIEWED_READER_TRANSITIONS = {'src/lib/data-store.ts': ('f6e12892fb37b5b6b9925f3feffe0bedf87fb11766da6adbb2de4a0a7bffef05', '06918c193312ae23a3bb3b54617047b731458cbf5d4b7624c9c75269ce70323d'), 'src/lib/staff-accounts.ts': ('f5aabfdc8408d3fd8b94b91df06d2769622d0d2f1b0bf80ea6b6065e2560ec01', '17ac2d96b4d76d8ec46b9401cb5e0b18fd9a028b0fde8af8a2218194486c6374')}
CRITICAL_FILES = ('src/lib/data-store.ts', 'src/lib/operational-store.ts',
                  'src/lib/availability-store.ts', 'src/lib/staff-accounts.ts', 'src/app/api/health/route.ts')


def verify_critical_transition(current, candidate):
    for relative in CRITICAL_FILES:
        pair = (digest(current / relative), digest(candidate / relative))
        expected = REVIEWED_READER_TRANSITIONS.get(relative)
        require(pair == expected if expected is not None else pair[0] == pair[1],
                'database or health implementation requires separate review')


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


# Diagnostic-only secondary request. Only exact fixed categories leave the child;
# the maintenance token is supplied over stdin, never argv, environment or files.
READINESS_BLOCKER_CATEGORIES = {
    'The operations database did not pass its integrity/read check.': 'DB_CHECK',
    'The operations database is unavailable.': 'DB_UNAVAILABLE',
    'The managed staff account store is unavailable.': 'STAFF_STORE',
    'Configure an effective active admin with valid non-demo credentials; disabled or shadowed admin access is not ready.': 'ADMIN',
    'Set BUBBLEWASH_MFA_ENCRYPTION_KEY to a base64-encoded 32-byte key.': 'MFA_CONFIG',
    'Keep BUBBLEWASH_ADMIN_MFA_REQUIRED and NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED aligned.': 'MFA_CONFIG',
    'Set BUBBLEWASH_BACKUP_ENCRYPTION_KEY to a base64-encoded 32-byte key.': 'BACKUP',
    'Set BUBBLEWASH_BACKUP_STATUS_PATH and run an encrypted backup with restore verification.': 'BACKUP',
    'The latest encrypted database backup is missing or older than 30 hours.': 'BACKUP',
    'The latest off-site backup has no successful restore verification.': 'BACKUP',
    'The latest verified backup has not been confirmed in off-host storage.': 'BACKUP',
    'The encrypted backup status file is unavailable or invalid.': 'BACKUP',
}
READINESS_BLOCKER_CATEGORIES.update(dict.fromkeys((
    'Remove BUBBLEWASH_ENABLE_DEMO_LOGIN from production; demo login cannot be enabled in production.',
    'Set BUBBLEWASH_DISABLE_DEMO_LOGIN=true in production.',
    'Set BUBBLEWASH_SESSION_SECRET to a strong 32+ character value in production.',
    'Primary and off-site backup directories must be different mounted destinations.',
    'Set BUBBLEWASH_DATABASE_PATH to an absolute path on the mounted persistent volume.',
    'Set BUBBLEWASH_DATABASE_DRIVER=sqlite for the supported single-replica pilot topology.',
    'Set BUBBLEWASH_PUBLIC_URL to the HTTPS site origin without a path, query, or fragment.',
    'Set BUBBLEWASH_PUBLIC_URL to the public HTTPS site origin.',
    'NEXT_PUBLIC_BUBBLEWASH_WHATSAPP must be a real international-format customer WhatsApp number or remain unset.',
    'NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL must be a valid customer contact email or remain unset.',
    'Set PAYSTACK_SECRET_KEY before enabling online payments.',
    'Enable exactly one trusted client-IP mode for the deployment edge.',
    *('Set ' + name + ' to an absolute path.' for name in (
        'BUBBLEWASH_BACKUP_PRIMARY_DIR', 'BUBBLEWASH_BACKUP_OFFSITE_DIR', 'BUBBLEWASH_BACKUP_STATUS_PATH')),
    *('Set ' + name + ' before enabling automated updates.' for name in (
        'RESEND_API_KEY', 'BUBBLEWASH_EMAIL_FROM', 'BUBBLEWASH_OPERATIONS_EMAIL', 'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID', 'BUBBLEWASH_OPERATIONS_WHATSAPP', 'WHATSAPP_BOOKING_TEMPLATE',
        'WHATSAPP_OPERATIONS_TEMPLATE')),
), 'CONFIG'))
READINESS_CATEGORIES = frozenset((*READINESS_BLOCKER_CATEGORIES.values(), 'UNKNOWN'))
READINESS_STATES = frozenset(('READY', 'BLOCKED', 'DETAIL_UNAVAILABLE', 'RESPONSE_INVALID',
    'RESPONSE_TOO_LARGE', 'HTTP_UNEXPECTED', 'TRANSPORT_FAILED', 'TOKEN_UNAVAILABLE',
    'NAMESPACE_UNVERIFIED', 'TIMEOUT', 'DIAGNOSTIC_FAILED'))
READINESS_HTTP_STATES = frozenset(('HTTP_200', 'HTTP_503', 'OTHER_HTTP', 'UNAVAILABLE'))
READINESS_READER = r"""
import http.client
import json
import sys

def result(state, http='UNAVAILABLE', categories=()):
    return {'state': state, 'http': http, 'categories': sorted(set(categories))}

def classify(status, raw):
    http = {200: 'HTTP_200', 503: 'HTTP_503'}.get(status, 'OTHER_HTTP')
    if len(raw) > 8192:
        return result('RESPONSE_TOO_LARGE', http)
    if status not in (200, 503):
        return result('HTTP_UNEXPECTED', http)
    try:
        body = json.loads(raw)
        if (not isinstance(body, dict) or body.get('ok') is not (status == 200) or
                body.get('service') != 'Bubble Wash operations app' or
                body.get('readiness') != ('ready' if status == 200 else 'blocked')):
            return result('RESPONSE_INVALID', http)
        if 'checks' not in body:
            return result('DETAIL_UNAVAILABLE', http)
        checks = body['checks']
        if (not isinstance(checks, list) or len(checks) > 64 or
                any(type(item) is not str or len(item) > 512 for item in checks) or
                bool(checks) != (status == 503)):
            return result('RESPONSE_INVALID', http)
        return result('READY' if status == 200 else 'BLOCKED', http,
                      (CATEGORIES.get(item, 'UNKNOWN') for item in checks))
    except Exception:
        return result('RESPONSE_INVALID', http)

def read_ready():
    connection = None
    try:
        token = sys.stdin.buffer.read(4097)
        if not 32 <= len(token) <= 4096 or any(byte < 33 or byte > 126 for byte in token):
            return result('TOKEN_UNAVAILABLE')
        # http.client connects directly: no proxies, redirects or retries.
        connection = http.client.HTTPConnection('127.0.0.1', 3001, timeout=3)
        connection.request('GET', '/api/ready', headers={'Authorization': 'Bearer ' + token.decode('ascii')})
        response = connection.getresponse()
        return classify(response.status, response.read(8193))
    except Exception:
        return result('TRANSPORT_FAILED')
    finally:
        if connection is not None:
            connection.close()

if __name__ == '__main__':
    try:
        outcome = read_ready()
    except BaseException:
        outcome = result('DIAGNOSTIC_FAILED')
    print(json.dumps(outcome), flush=True)
"""


def readiness_diagnostic(candidate, values, unit, pid, report):
    def fixed(state):
        return {'state': state, 'http': 'UNAVAILABLE', 'categories': []}
    token = values.get('BUBBLEWASH_MAINTENANCE_TOKEN', '')
    if not re.fullmatch(r'[!-~]{32,4096}', token):
        return fixed('TOKEN_UNAVAILABLE')
    try:
        if verify_private_network(unit, candidate) != pid:
            return fixed('NAMESPACE_UNVERIFIED')
    except Exception:
        return fixed('NAMESPACE_UNVERIFIED')
    outcome = fixed('DIAGNOSTIC_FAILED')
    try:
        script = 'CATEGORIES = ' + repr(READINESS_BLOCKER_CATEGORIES) + '\n' + READINESS_READER
        completed = subprocess.run(['nsenter', '--target', str(pid), '--net', '--',
                                    'python3', '-I', '-B', '-c', script], input=token.encode('ascii'),
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
                                   timeout=max(0.001, min(7, report.deadline - time.monotonic())))
        if completed.returncode == 0 and len(completed.stdout) <= 1024:
            value = json.loads(completed.stdout)
            if (type(value) is dict and set(value) == {'state', 'http', 'categories'} and
                    type(value['state']) is str and value['state'] in READINESS_STATES and
                    type(value['http']) is str and value['http'] in READINESS_HTTP_STATES and
                    type(value['categories']) is list and len(value['categories']) <= len(READINESS_CATEGORIES) and
                    all(type(item) is str and item in READINESS_CATEGORIES for item in value['categories'])):
                outcome = {**value, 'categories': sorted(set(value['categories']))}
    except subprocess.TimeoutExpired:
        outcome = fixed('TIMEOUT')
    except Exception:
        pass  # Never propagate child output, request details or raw exceptions.
    # A stale/replaced process cannot contribute a trusted diagnosis. The outer
    # rehearsal deadline still applies; cancellation goes directly to cleanup.
    try:
        if verify_private_network(unit, candidate) != pid:
            return fixed('NAMESPACE_UNVERIFIED')
    except Exception:
        return fixed('NAMESPACE_UNVERIFIED')
    return outcome


# This bounded child inspects metadata and integrity only, after probe stop.
# Reference CREATE statements run only in :memory:, never against the copy.
SCHEMA_READER = r"""
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import time
from pathlib import Path

ERRORS = {sqlite3.SQLITE_ERROR: 'SQL_ERROR', sqlite3.SQLITE_BUSY: 'BUSY', sqlite3.SQLITE_LOCKED: 'LOCKED',
          sqlite3.SQLITE_CORRUPT: 'CORRUPT', sqlite3.SQLITE_IOERR: 'IO', sqlite3.SQLITE_NOTADB: 'NOT_DATABASE',
          sqlite3.SQLITE_INTERRUPT: 'TIMEOUT'}
QUERIES = {
    'staffAccounts': ('staff_accounts',
        ('email', 'name', 'role', 'entity_id', 'password_hash', 'credential_version', 'status', 'updated_at'),
        'SELECT email, name, role, entity_id AS entityId, password_hash AS passwordHash, credential_version AS credentialVersion, status, updated_at AS updatedAt FROM staff_accounts ORDER BY name'),
    'credentialOverrides': ('staff_credential_overrides',
        ('role', 'login', 'password_hash', 'credential_version', 'updated_at'),
        "SELECT role, login, password_hash, credential_version, updated_at FROM staff_credential_overrides WHERE role = 'admin'"),
}

def error_code(error):
    return ERRORS.get(getattr(error, 'sqlite_errorcode', 0) & 255, 'OTHER')

def bounded(cursor, limit):
    rows = cursor.fetchmany(limit + 1)
    if len(rows) > limit:
        raise ValueError('bound')
    return rows

def reference_ddl(candidate, pins):
    ddl = []
    for relative, initializer, receiver in (
            ('src/lib/data-store.ts', 'initializeDatabaseSchema', 'db'),
            ('src/lib/staff-accounts.ts', 'initializeStaffAccountsSchema', 'database')):
        descriptor = os.open(Path(candidate) / relative, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as handle:
            metadata = os.fstat(handle.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError('type')
            raw = handle.read(131073)
        if len(raw) > 131072 or hashlib.sha256(raw).hexdigest() != pins[relative]:
            raise ValueError('pin')
        pattern = r'function ' + initializer + r'\([^)]*\) \{\s*' + receiver + r'\.exec\(`([\s\S]*?)`\);\s*\}'
        found = re.findall(pattern, raw.decode())
        if len(found) != 1 or '${' in found[0]:
            raise ValueError('literal')
        ddl.append(found[0])
    return ddl

class CopyUnavailable(Exception):
    pass


def read_pinned_copy(directory, descriptor):
    def metadata(fd):
        value = os.fstat(fd)
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
            raise CopyUnavailable('UNSAFE_FILE')
        return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    before = metadata(descriptor)
    if not 100 <= before[2] <= 64 * 1024 * 1024:
        raise CopyUnavailable('SIZE_BOUND')
    sidecars = {}
    try:
        for suffix in ('-wal', '-journal'):
            name = 'rehearsal.sqlite' + suffix
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            except FileNotFoundError:
                sidecars[name] = None
                continue
            except OSError:
                raise CopyUnavailable('UNSAFE_FILE') from None
            try:
                sidecars[name] = (fd, metadata(fd))
            except BaseException:
                os.close(fd)
                raise
            if sidecars[name][1][2] != 0:
                raise CopyUnavailable('WAL_PRESENT' if suffix == '-wal' else 'JOURNAL_PRESENT')
        with os.fdopen(os.dup(descriptor), 'rb') as handle:
            raw = handle.read(64 * 1024 * 1024 + 1)
        named = os.stat('rehearsal.sqlite', dir_fd=directory, follow_symlinks=False)
        if (len(raw) != before[2] or metadata(descriptor) != before or not stat.S_ISREG(named.st_mode) or
                (named.st_dev, named.st_ino) != before[:2]):
            raise CopyUnavailable('COPY_CHANGED')
        for name, pinned in sidecars.items():
            try:
                named = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                if pinned is not None:
                    raise CopyUnavailable('COPY_CHANGED')
                continue
            if (pinned is None or not stat.S_ISREG(named.st_mode) or metadata(pinned[0]) != pinned[1] or
                    (named.st_dev, named.st_ino, named.st_size, named.st_mtime_ns, named.st_ctime_ns) != pinned[1]):
                raise CopyUnavailable('COPY_CHANGED')
        if raw[:16] != b'SQLite format 3\0' or raw[18:20] not in (b'\x01\x01', b'\x02\x02'):
            raise CopyUnavailable('FORMAT_INVALID')
        # Official sqlite3_deserialize workaround for a checkpointed WAL-mode
        # image. Nonempty WAL/journal is rejected above, never ignored. Only this
        # in-memory header changes; neither private copy nor original is written.
        return raw[:18] + b'\x01\x01' + raw[20:]
    finally:
        for pinned in sidecars.values():
            if pinned is not None:
                os.close(pinned[0])


def inspect_schema(directory, descriptor, candidate, pins):
    source = reference = None
    stage = 'REFERENCE_UNAVAILABLE'
    deadline = time.monotonic() + 3
    try:
        ddl = reference_ddl(candidate, pins)
        reference = sqlite3.connect(':memory:')
        for statement in ddl:
            reference.executescript(statement)
        expected = bounded(reference.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL"), 128)
        stage = 'COPY_UNAVAILABLE'
        raw = read_pinned_copy(directory, descriptor)
        source = sqlite3.connect(':memory:')
        source.deserialize(raw)
        source.execute('PRAGMA query_only=ON')
        source.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 131072)
        source.set_progress_handler(lambda: time.monotonic() >= deadline, 1000)
        stage = 'SCHEMA_UNAVAILABLE'
        missing = mismatched = 0
        definitions = {}
        for kind, name, sql in expected:
            actual = source.execute('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', (kind, name)).fetchone()
            missing += actual is None
            mismatched += actual is not None and actual[0] != sql
            definitions[(kind, name)] = 'MISSING' if actual is None else 'MATCH' if actual[0] == sql else 'MISMATCH'
        output = {'state': 'COMPLETE', 'expectedObjects': len(expected), 'missingObjects': missing, 'mismatchedObjects': mismatched,
                  'integrity': 'NOT_CHECKED', 'integrityError': 'NONE', 'readable': False}
        for label, (name, columns, query) in QUERIES.items():
            objects = bounded(source.execute('SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE', (name,)), 4)
            kinds = [row[0] for row in objects]
            reference_columns = {row[1].lower() for row in bounded(reference.execute('PRAGMA main.table_xinfo(' + name + ')'), 64)}
            item = {'object': 'MISSING' if not kinds else 'TABLE' if kinds == ['table'] else 'OTHER',
                    'definition': definitions[('table', name)], 'missingSchemaColumns': len(reference_columns),
                    'missingQueryColumns': len(columns), 'query': 'NOT_CHECKED', 'error': 'NONE'}
            if item['object'] == 'TABLE':
                actual_columns = {row[1].lower() for row in bounded(source.execute('PRAGMA main.table_xinfo(' + name + ')'), 64)}
                item['missingQueryColumns'] = sum(column not in actual_columns for column in columns)
                item['missingSchemaColumns'] = len(reference_columns - actual_columns)
                try:
                    # Compile only: never execute the SELECT or fetch account rows.
                    source.execute('EXPLAIN ' + query)
                    item['query'] = 'PREPARES'
                except sqlite3.Error as error:
                    item['query'] = 'FAILED'
                    item['error'] = error_code(error)
            output[label] = item
        try:
            output['readable'] = source.execute('SELECT 1').fetchone() == (1,)
            # Page integrity scanning returns only a fixed success flag, never
            # SQLite's error text. It does not fetch or disclose account rows.
            deadline = min(deadline, time.monotonic() + 1)
            output['integrity'] = 'OK' if source.execute('PRAGMA quick_check(1)').fetchone() == ('ok',) else 'FAILED'
        except sqlite3.Error as error:
            output['integrity'] = 'FAILED'
            output['integrityError'] = error_code(error)
        return output
    except CopyUnavailable as error:
        return {'state': 'COPY_UNAVAILABLE', 'error': error.args[0]}
    except Exception as error:
        return {'state': stage, 'error': error_code(error)}
    finally:
        if source is not None:
            source.close()
        if reference is not None:
            reference.close()

if __name__ == '__main__':
    try:
        payload = sys.stdin.buffer.read(4097)
        if len(payload) > 4096:
            raise ValueError('bound')
        value = json.loads(payload)
        result = inspect_schema(value['directory'], value['descriptor'], value['candidate'], value['pins'])
    except BaseException:
        result = {'state': 'SCHEMA_UNAVAILABLE', 'error': 'OTHER'}
    print(json.dumps(result), flush=True)
"""


def schema_diagnostic(candidate, snapshot, directory_identity, snapshot_identity, timeout=5):
    unavailable = {'state': 'SCHEMA_UNAVAILABLE', 'error': 'OTHER'}
    errors = ('NONE', 'SQL_ERROR', 'BUSY', 'LOCKED', 'CORRUPT', 'IO', 'NOT_DATABASE', 'TIMEOUT', 'OTHER',
              'UNSAFE_FILE', 'SIZE_BOUND', 'WAL_PRESENT', 'JOURNAL_PRESENT', 'COPY_CHANGED', 'FORMAT_INVALID')
    directory = descriptor = None
    try:
        if snapshot.name != 'rehearsal.sqlite':
            return unavailable
        directory = os.open(snapshot.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parent_stat = os.fstat(directory)
        if (parent_stat.st_dev, parent_stat.st_ino) != directory_identity:
            return unavailable
        descriptor = os.open(snapshot.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or
                (metadata.st_dev, metadata.st_ino) != snapshot_identity):
            return unavailable
        payload = json.dumps({'directory': directory, 'descriptor': descriptor, 'candidate': str(candidate),
                             'pins': OWNER_DIAGNOSTIC_SOURCE_SHA256}).encode()
        if len(payload) > 4096:
            return unavailable
        completed = subprocess.run(['python3', '-I', '-B', '-c', SCHEMA_READER], input=payload,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, pass_fds=(directory, descriptor),
                                   timeout=max(0.001, min(5, timeout)))
        after = os.fstat(descriptor)
        named_directory = snapshot.parent.lstat()
        if not stat.S_ISDIR(named_directory.st_mode) or (named_directory.st_dev, named_directory.st_ino) != directory_identity:
            return unavailable
        named = os.stat(snapshot.name, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(named.st_mode) or (named.st_dev, named.st_ino) != snapshot_identity:
            return unavailable
        if ((metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            return unavailable
        if completed.returncode != 0 or len(completed.stdout) > 1024:
            return unavailable
        value = json.loads(completed.stdout)
        if (type(value) is dict and set(value) == {'state', 'error'} and
                type(value['state']) is str and value['state'] in ('REFERENCE_UNAVAILABLE', 'COPY_UNAVAILABLE', 'SCHEMA_UNAVAILABLE') and
                type(value['error']) is str and value['error'] in errors):
            return value
        expected_keys = {'state', 'expectedObjects', 'missingObjects', 'mismatchedObjects', 'staffAccounts', 'credentialOverrides',
                         'integrity', 'integrityError', 'readable'}
        if type(value) is not dict or set(value) != expected_keys or value['state'] != 'COMPLETE':
            return unavailable
        for key in ('expectedObjects', 'missingObjects', 'mismatchedObjects'):
            if type(value[key]) is not int or not 0 <= value[key] <= 128:
                return unavailable
        if (type(value['integrity']) is not str or value['integrity'] not in ('NOT_CHECKED', 'OK', 'FAILED') or
                type(value['integrityError']) is not str or value['integrityError'] not in errors or type(value['readable']) is not bool):
            return unavailable
        for label, limit in (('staffAccounts', 8), ('credentialOverrides', 5)):
            item = value[label]
            if (type(item) is not dict or set(item) != {'object', 'definition', 'missingSchemaColumns', 'missingQueryColumns', 'query', 'error'} or
                    type(item['object']) is not str or item['object'] not in ('MISSING', 'TABLE', 'OTHER') or
                    type(item['definition']) is not str or item['definition'] not in ('MISSING', 'MATCH', 'MISMATCH') or
                    type(item['missingSchemaColumns']) is not int or not 0 <= item['missingSchemaColumns'] <= 64 or
                    type(item['missingQueryColumns']) is not int or not 0 <= item['missingQueryColumns'] <= limit or
                    type(item['query']) is not str or item['query'] not in ('NOT_CHECKED', 'PREPARES', 'FAILED') or
                    type(item['error']) is not str or item['error'] not in errors):
                return unavailable
        return value
    except subprocess.TimeoutExpired:
        return {'state': 'TIMEOUT', 'error': 'TIMEOUT'}
    except Exception:
        return unavailable

    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory is not None:
            os.close(directory)

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
        self.readiness = None
        self.schema = None
        self.directory_identity = None
        self.snapshot_identity = None

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
                          'cleanup': self.cleanup, 'activationAttempted': False,
                          **({'readinessDiagnostic': self.readiness} if self.readiness is not None else {}),
                          **({'schemaDiagnostic': self.schema} if self.schema is not None else {})}), flush=True)


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
    report.directory_identity = identity
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


def rehearse(candidate, values, db, status_path, owner, unit, report=None, prepare_snapshot=None):
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
        if report is not None:
            metadata = snapshot.lstat()
            report.snapshot_identity = (metadata.st_dev, metadata.st_ino)
        if prepare_snapshot is not None:
            require(report is not None, 'copy preparation requires bounded rehearsal')
            rehearsal_stage(report, 'COPY_REPAIR')
            prepare_snapshot(snapshot)
        require_no_owner_enrollment(snapshot)
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
                try:
                    network_command(['curl', '--fail', '--silent', '--max-time', '15', '--output', '/dev/null',
                                     'http://127.0.0.1:3001' + path], probe_pid)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as error:
                    if report is not None and label == 'READY':
                        report.fail(error)  # Diagnosis can never replace or forgive this failure.
                        report.readiness = readiness_diagnostic(candidate, values, unit + '-probe.service', probe_pid, report)
                    raise
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
                    if report.readiness and report.readiness.get('state') == 'BLOCKED' and set(report.readiness.get('categories', ())) & {'DB_CHECK', 'STAFF_STORE'}:
                        # Probe is verified stopped; this optional five-second
                        # schema-only check cannot enable activation or writes.
                        remaining = report.deadline - time.monotonic()
                        report.schema = (schema_diagnostic(candidate, snapshot, report.directory_identity, report.snapshot_identity, remaining) if remaining > 0 else
                                         {'state': 'TIMEOUT', 'error': 'TIMEOUT'})
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


# BEGIN EXACT OWNER TRANSITION: no CLI/environment override is accepted.
OWNER_LIVE_SOURCE_MANIFEST = {'src': '43770b9861b9063016b80c9a26778f21d48975da89b7183ee38cabe6a6c07347', 'package.json': '48f1c8740915afbf91091bdedf6ec65de340b2f6fa70b96338c9276e3cbb1c6e', 'package-lock.json': '65ac93becf9f1e4b44af8633e120a547c33a438af5cb6d83f2f8fe1dc77a9e38', 'next.config.mjs': '55c7cca7ffcd8464dd2432dffef6ef2b7e4ebc3ee7d6dc508ba72855626cc08e', 'tsconfig.json': '2545dfb1c43a7c5ae010d7d6457b3dd3cf2df435f3116d8568f9e13b346ff42c'}
OWNER_CANDIDATE_SOURCE_MANIFEST = {'src': 'c822ddce363039869d9d2fc3f7c4dad306131f376b2e51d43dada1894bc9e10e', 'package.json': 'e01b6015c536c3086bac51d6318d2afd4acd9b84ec79eff30deac52a733c5a9d', 'package-lock.json': '65ac93becf9f1e4b44af8633e120a547c33a438af5cb6d83f2f8fe1dc77a9e38', 'next.config.mjs': '5953ea9f63a70e14ae51eef4b14f4765da6a7c8fe7168fc55234472fdaf37665', 'tsconfig.json': '2545dfb1c43a7c5ae010d7d6457b3dd3cf2df435f3116d8568f9e13b346ff42c'}
# Owner transition from verified preserving release a47697dd444225c8bbc0d5c11a17c3c2a02567d4.
OWNER_LIVE_COMMIT = 'a47697dd444225c8bbc0d5c11a17c3c2a02567d4'
OWNER_DIAGNOSTIC_SOURCE_SHA256 = {'src/lib/data-store.ts': '06918c193312ae23a3bb3b54617047b731458cbf5d4b7624c9c75269ce70323d', 'src/lib/staff-accounts.ts': 'ad91d3738399529d58ef14894f6f12a15a123905c8b7a5e2eedbd5a9df37ce85'}
# Any further source change requires a new independent review, never a runtime override.
PRESERVING_ROUTE_SHA256 = '29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a'
OWNER_STAFF_OLD_SHA256 = '17ac2d96b4d76d8ec46b9401cb5e0b18fd9a028b0fde8af8a2218194486c6374'
OWNER_STAFF_NEW_SHA256 = 'ad91d3738399529d58ef14894f6f12a15a123905c8b7a5e2eedbd5a9df37ce85'
OWNER_CANDIDATE_SOURCE_SHA256 = {'docs/PERSONAL_OWNER_ENROLLMENT.md': '83b7dc1a7268b38894f4f4d4113e6795e35f4fed1f91497473b17fcd0d2150a0', 'next.config.mjs': '5953ea9f63a70e14ae51eef4b14f4765da6a7c8fe7168fc55234472fdaf37665', 'package.json': 'e01b6015c536c3086bac51d6318d2afd4acd9b84ec79eff30deac52a733c5a9d', 'scripts/invite-additional-owner.mjs': '80a4950c6f49d6a1f7fd8cd2597ea5fa97345cf94eb8d9b1941d8acfcf382348', 'src/app/admin/page.tsx': 'd774c2372f2e22a3b6c429c692743660f4434ef08f2f208085759195d8dea06b', 'src/app/api/admin/mfa/enroll/route.ts': '30bd62dc5d05a8f2ea0b75225fcaf3ca8f772e19e3649c7f9bdf4382c39c9b30', 'src/app/api/login/route.ts': 'ce1fbeacbea1cef1f0bb0c6ce8676a841524c853f42e047ec89c89065e75269d', 'src/app/api/orders/advance/route.ts': '7be45e19ee127f0b201db4c421762e276e6f0e3f000dbd53024bcb42243ab495', 'src/app/api/ready/route.ts': 'afe8b17f43388f0ec492c2b8f172c0a9f4bb350990d75b067627de67d89bd91a', 'src/app/api/staff/accounts/route.ts': '9e7b90bd4d355704b5431b4929aecbadd7d0aef963fa9a74ed5987d5dc44026b', 'src/app/drivers/page.tsx': '27cedba3b116456bc3dc91f2f78f5084bd6ac07fab967d8c8d0046c336356f07', 'src/app/support/page.tsx': '30a8a5321fbc6dda38f4202e8e7907fcb66e4f21528eb881d491b45d8774a843', 'src/app/vendors/page.tsx': '2f3479726b1f11b84b1112574610f6dc0fd481a55f6502e4635feb9a026da8b4', 'src/components/LoginPage.tsx': '9502fcd40ba0b35bc3a7ab091ac953089e0a89f3063cff6dbf07932be274920b', 'src/components/StaffWorkspaces.tsx': '5726d4c9e52a2eb2a6d9170bd689ff927dc9be32c8ca5d7a49adffbb132ab9d7', 'src/lib/admin-mfa.ts': '15c78716d909d298542ce777d98b8d2dae5f67a8327aa427117f9656b6dcf4f5', 'src/lib/auth.ts': '470f0b92c371b20a88ef831f537732006d370ac02c7de9ca0727a90716f4cc81', 'src/lib/order-workflow.ts': 'ef5614a8ea143c866b4a1e5b041c8a15a56a39e8aa5c8a2d5903a6df3d3d1735', 'src/lib/staff-accounts.ts': 'ad91d3738399529d58ef14894f6f12a15a123905c8b7a5e2eedbd5a9df37ce85', 'src/lib/staff-identity.ts': '73296d246fac48806cf332501e91f5ef4838e8ed399b1a9af6de0847d7500b48', 'tests/browser/personal-owner-mfa.spec.mjs': '4519d88305bb919588633f6509a9e27d8dbadde9e9f33e45443bfdcf78a5b3f5', 'tests/personal-owner-http.integration.mjs': '96cc42efe0bb5b52af398a0fa86680c4e02dbb66492a72aa40b7098458c248ec', 'tests/personal-owner-mfa.integration.mjs': 'db23ccf48a7fa36098a317ca075179c3cccc20aae9822f93b0115f7da31efc45', 'tests/personal-owner.integration.mjs': '6523573d77bdfd8839810e589faa088ac69d658efa7eb0ec4a62e64a691910dd', 'tests/worker-workspaces.test.mjs': '80379cae504b8c63c2a205a0cc64924210d6782649e25dd51b801f3f738c5195', 'tests/readiness-readonly.fixture.mjs': '9961fc88015d8ec734b1a83c5b0fcf4bd1ac92919808e9e3935487939a010f3d', 'tests/readiness-readonly.test.mjs': '975aa72f9afd50902a38767da84fedd83bec0913ff0a7615bcc5997e268ed410', 'tests/owner-enrollment-preservation.fixture.mjs': 'ad832039a54f9eda7d094306a8a0acd51502ae33ea188b357627f263dffd60e1', 'tests/owner-enrollment-preservation.test.mjs': 'de5062ce89f0b01843f97b67c470168da13ea799f8e3e82ec005c538a4e10ddb'}
UNCHANGED_OWNER_MODULES = (
    'src/lib/data-store.ts', 'src/lib/operational-store.ts',
    'src/lib/availability-store.ts', 'src/app/api/health/route.ts',
)


def require_owner_pins(candidate):
    require(candidate.is_dir() and not candidate.is_symlink() and candidate.resolve(strict=True) == candidate,
            'owner pin checks require a canonical candidate directory')
    pins = (OWNER_STAFF_OLD_SHA256, OWNER_STAFF_NEW_SHA256, *OWNER_CANDIDATE_SOURCE_SHA256.values(), *OWNER_LIVE_SOURCE_MANIFEST.values(), *OWNER_CANDIDATE_SOURCE_MANIFEST.values())
    require(all(isinstance(pin, str) and re.fullmatch(r'[a-f0-9]{64}', pin) for pin in pins),
            'exact owner source review pins are incomplete; rollout disabled')
    require(OWNER_STAFF_OLD_SHA256 != OWNER_STAFF_NEW_SHA256, 'owner route requires its exact reviewed transition')
    require(OWNER_CANDIDATE_SOURCE_SHA256.get('src/lib/staff-accounts.ts') == OWNER_STAFF_NEW_SHA256,
            'owner transition and candidate pins disagree')
    preserving = candidate / 'ops/deploy-preserving.py'
    require(preserving.is_file() and preserving.resolve(strict=True) == preserving and
            digest(preserving) == PRESERVING_ROUTE_SHA256,
            'reviewed preserving route changed; owner route requires renewed review')


def verify_owner_code(current, candidate):
    require_owner_pins(candidate)
    require(source_manifest(current) == OWNER_LIVE_SOURCE_MANIFEST and source_manifest(candidate) == OWNER_CANDIDATE_SOURCE_MANIFEST,
            "full owner source/dependency transition lacks exact compatibility review")
    for relative in (*UNCHANGED_OWNER_MODULES, 'src/lib/staff-accounts.ts'):
        for tree in (current, candidate):
            path = tree / relative
            require(path.is_file() and not path.is_symlink(), 'guarded source must be a regular file')
    for relative in UNCHANGED_OWNER_MODULES:
        require(digest(current / relative) == digest(candidate / relative),
                'unreviewed database or health implementation change')
    require(digest(current / 'src/lib/staff-accounts.ts') == OWNER_STAFF_OLD_SHA256 and
            digest(candidate / 'src/lib/staff-accounts.ts') == OWNER_STAFF_NEW_SHA256,
            'staff implementation is not the exact independently reviewed owner transition')
    verify_owner_candidate(candidate)


def verify_owner_candidate(candidate):
    require_owner_pins(candidate)
    require(source_manifest(candidate) == OWNER_CANDIDATE_SOURCE_MANIFEST, "full owner candidate source/dependency manifest changed")
    for relative, pin in {'src/lib/staff-accounts.ts': OWNER_STAFF_NEW_SHA256, **OWNER_CANDIDATE_SOURCE_SHA256}.items():
        path = candidate / relative
        require(path.is_file() and not path.is_symlink() and digest(path) == pin,
                'reviewed owner candidate implementation changed')


def require_no_owner_enrollment(path):
    # Read only the private rehearsal copy. This route cannot grant an account.
    with sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True) as database:
        database.execute('PRAGMA query_only=ON')
        require(database.execute("SELECT 1 FROM sqlite_master WHERE name = 'staff_owner_capabilities'").fetchone() is None,
                'owner capability schema already exists; initial code-only route does not apply')
# END EXACT OWNER TRANSITION


def main(lock_unchanged, report=None, repair_action=None):
    parser = ReleaseArgumentParser()
    for key in ('candidate', 'sha', 'expected-live', 'backup-sha256', 'receipt-run', 'store-sha', 'store-id'):
        parser.add_argument('--' + key, required=True)
    parser.add_argument('--rehearsal-only', action='store_true')
    parser.add_argument('--run-id')
    parser.add_argument('--run-attempt')
    if repair_action is not None:
        # This flag exists only for the separately published repair runner.
        # The normal deployment CLI cannot enter or supply this callback.
        parser.add_argument('--repair-staff-schema', action='store_true', required=True)
    args = parser.parse_args()
    if repair_action is not None:
        require(not args.rehearsal_only and report is not None, 'repair entrypoint mismatch')
    else:
        require(args.rehearsal_only == (report is not None), 'rehearsal entrypoint mismatch')
    if args.rehearsal_only or repair_action is not None:
        require(re.fullmatch(r'[1-9][0-9]{0,19}', args.run_id or '') and
                re.fullmatch(r'[1-9][0-9]{0,5}', args.run_attempt or ''), 'invalid diagnostic run identity')
    else:
        require(args.run_id is None and args.run_attempt is None, 'diagnostic arguments require rehearsal mode')
    require(os.geteuid() == 0, 'root host execution required')
    require(args.expected_live == OWNER_LIVE_COMMIT, 'owner release requires exact reviewed live commit')
    require(all(re.fullmatch(r'[a-f0-9]{40}', v) for v in (args.sha, args.expected_live, args.store_sha)), 'invalid commit pin')
    require(re.fullmatch(r'[a-f0-9]{64}', args.backup_sha256) and re.fullmatch(r'[1-9][0-9]*', args.receipt_run) and
            re.fullmatch(r'[1-9][0-9]*', args.store_id), 'invalid receipt pin')
    candidate = Path(args.candidate)
    require(candidate.resolve(strict=True) == candidate and candidate.parent == HOME / 'bubblewash-releases' and not candidate.is_symlink() and
            re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + args.sha[:12], candidate.name), 'invalid candidate directory')
    require_owner_pins(candidate)
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
    verify_owner_code(current, candidate)
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
    unit = 'bubblewash-owner-' + candidate.name

    def unchanged():
        lock_unchanged()
        verify_owner_code(current, candidate)
        stat = ENV.stat()
        require(ENV.read_bytes() == raw and (stat.st_mode, stat.st_uid, stat.st_gid, stat.st_ino) ==
                (metadata.st_mode, metadata.st_uid, metadata.st_gid, metadata.st_ino), 'environment changed during release')
        require(RECEIPT.read_bytes() == receipt_raw, 'receipt changed during release')
        require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size == receipt['size'] and
                digest(archive) == args.backup_sha256, 'encrypted backup changed during release')
        verify_receipt(receipt, json.loads(status_path.read_bytes()), time.time(), args.receipt_run, args.store_sha, int(args.store_id))

    if repair_action is not None:
        # Exact same preflight, lock and receipt checks, but no build or
        # activation function is reachable from this separate repair entrypoint.
        def verify_existing():
            unchanged()
            require(CURRENT.resolve(strict=True) == current and (RUNTIME / 'current-release').read_bytes() == old_marker,
                    'live release drifted during preparation')
            check_runtime(current, values)
            health(3000)
            lock_unchanged()
        repair_action(candidate, values, db, status_path, owner,
                      'bubblewash-staff-repair-' + args.run_id + '-' + args.run_attempt,
                      report, verify_existing)
        return
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
                      'databaseReset': False, 'rollbackReleaseRetained': True, 'ownerEnrollmentPerformed': False}))


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
            print('Owner code-only deployment failed closed; inspect the release pointer and service before any retry.', flush=True)
        raise SystemExit(1)
    finally:
        if report is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
