#!/usr/bin/env python3
"""Manual host-only emergency gate restoration. No explicit account/database mutation commands."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import tempfile
import time

HOME = Path('/home/ubuntu')
ENV = HOME / '.config/bubblewash/env'
RUNTIME = HOME / 'bubblewash-runtime'
CURRENT = HOME / 'bubblewash-pilot'
AUTH = 'BUBBLEWASH_STAFF_AUTH_DISABLED'
BOOK = 'BUBBLEWASH_BOOKINGS_DISABLED'
UNIT = 'bubblewash-local.service'
PROC = Path('/proc')


def parse(raw):
    if len(raw) > 65536:
        raise ValueError('configuration exceeds bound')
    result = {}
    for line in raw.decode('utf8').splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if not match or match[1] in result:
            raise ValueError('unsupported configuration syntax')
        value = match[2].strip()
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError('unsupported configuration syntax')
            value = value[1:-1]
        if any(c in value for c in '\\"\'`\x00\r\n'):
            raise ValueError('unsupported configuration syntax')
        result[match[1]] = value
    return result


def prepare(raw, preserve_bookings):
    values = parse(raw)
    if values.get(AUTH) != 'true':
        raise ValueError('expected active emergency lock')
    if values.get(BOOK) not in (None, '', 'true', 'false'):
        raise ValueError('unsupported booking flag')
    if values.get(BOOK) != 'true' and not preserve_bookings:
        raise ValueError('booking preservation approval required')
    changes = {AUTH: 'false'}
    if values.get(BOOK) != 'true':
        changes[BOOK] = 'true'
    lines = raw.decode('utf8').splitlines(keepends=True)
    seen = set()
    for index, line in enumerate(lines):
        match = re.match(r'\s*([A-Za-z_][A-Za-z0-9_]*)=', line)
        if match and match[1] in changes:
            name = match[1]
            lines[index] = f'{name}={changes[name]}\n'
            seen.add(name)
    result = ''.join(lines)
    for name in changes.keys() - seen:
        if result and not result.endswith('\n'):
            result += '\n'
        result += f'{name}={changes[name]}\n'
    changed = parse(result.encode())
    assert changed == {**values, **changes}
    return result.encode()


def command(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=30).stdout.decode()


def ctl(*args):
    uid = pwd.getpwnam('ubuntu').pw_uid
    return command(['runuser', '-u', 'ubuntu', '--', 'env', f'XDG_RUNTIME_DIR=/run/user/{uid}', f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus', 'systemctl', '--user', *args])


def source_fingerprint(target):
    # Expected digest must come from independent review of this CURRENT release,
    # including booking-policy semantics and a pure /api/health handler.
    digest = hashlib.sha256()
    for name in ('src/app/api/health/route.ts', 'src/lib/auth.ts', 'src/lib/booking-policy.ts', '.next/BUILD_ID'):
        path = target / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 262144:
            raise ValueError('unsupported reviewed source')
        digest.update(name.encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def process_environment(pid):
    raw = (PROC / str(pid) / 'environ').read_bytes()
    return dict(entry.decode().split('=', 1) for entry in raw.split(b'\0') if b'=' in entry)


def verify_runtime(expected_sha, expected_source_digest, values):
    marker = parse((RUNTIME / 'current-release').read_bytes())
    target = CURRENT.resolve(strict=True)
    if marker.get('sha') != expected_sha or Path(marker.get('path', '/nonexistent')).resolve() != target:
        raise ValueError('release mismatch')
    if not (target / '.next/BUILD_ID').is_file():
        raise ValueError('build missing')
    if source_fingerprint(target) != expected_source_digest:
        raise ValueError('reviewed source mismatch')
    props = dict(line.split('=', 1) for line in ctl('show', UNIT, '--property=LoadState,ActiveState,MainPID,WorkingDirectory,EnvironmentFiles').splitlines() if '=' in line)
    if props.get('LoadState') != 'loaded' or props.get('ActiveState') != 'active':
        raise ValueError('service not active')
    if Path(props.get('WorkingDirectory', '/nonexistent')).resolve() != target or props.get('EnvironmentFiles') != f'{ENV} (ignore_errors=no)':
        raise ValueError('service configuration mismatch')
    pid = int(props.get('MainPID', '0'))
    if pid <= 1 or (PROC / str(pid) / 'cwd').resolve() != target:
        raise ValueError('process mismatch')
    listeners = command(['ss', '-H', '-ltnp', 'sport = :3000'])
    listener_pids = set(re.findall(r'pid=(\d+)', listeners))
    if len(listener_pids) != 1:
        raise ValueError('ambiguous application listener')
    listener = int(next(iter(listener_pids)))
    if (PROC / str(listener) / 'cwd').resolve() != target or (PROC / str(listener) / 'exe').resolve().name != 'node':
        raise ValueError('listener process mismatch')
    if (PROC / str(listener) / 'cgroup').read_bytes() != (PROC / str(pid) / 'cgroup').read_bytes():
        raise ValueError('listener outside service')
    runtime = process_environment(listener)
    main_runtime = process_environment(pid)
    if any(main_runtime.get(key) != value for key, value in values.items()):
        raise ValueError('main process configuration mismatch')
    # Compare the full expected environment silently, not just the lock. This
    # rejects stale runtime credentials/MFA/configuration before touching disk.
    if any(runtime.get(key) != value for key, value in values.items()):
        raise ValueError('runtime configuration mismatch')
    if runtime.get('NODE_ENV') != 'production' or runtime.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') != 'true':
        raise ValueError('unsafe production mode')


def health():
    for _ in range(20):
        try:
            response = command(['curl', '--silent', '--max-time', '3', '--max-filesize', '4096', '--write-out', '\n%{http_code}', 'http://127.0.0.1:3000/api/health'])
            body, status = response.rsplit('\n', 1)
            value = json.loads(body)
            if status != '200' or value.get('ok') is not True or value.get('service') != 'Bubble Wash' or value.get('status') != 'alive':
                raise ValueError('unexpected health response')
            return
        except (subprocess.SubprocessError, OSError, ValueError, AttributeError):
            time.sleep(1)
    raise ValueError('health verification failed')


def atomic_write(path, raw, metadata):
    fd, name = tempfile.mkstemp(prefix='.staff-restore-', dir=path.parent)
    try:
        os.fchmod(fd, stat.S_IMODE(metadata.st_mode))
        os.fchown(fd, metadata.st_uid, metadata.st_gid)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def apply(raw, replacement, metadata, verify):
    # Caller holds deploy lock and has secured a host-only rollback copy.
    try:
        atomic_write(ENV, replacement, metadata)
        ctl('restart', UNIT)
        health()
        verify(parse(replacement))
    except BaseException:
        atomic_write(ENV, raw, metadata)
        ctl('restart', UNIT)
        health()
        verify(parse(raw))
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-release', required=True)
    parser.add_argument('--reviewed-source-digest', required=True)
    parser.add_argument('--preserve-unavailable-bookings', choices=['true', 'false'], default='false')
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch('[0-9a-f]{40}', args.expected_release) or not re.fullmatch('[0-9a-f]{64}', args.reviewed_source_digest):
        raise ValueError('invalid execution context')
    if RUNTIME.is_symlink() or not RUNTIME.is_dir() or ENV.is_symlink():
        raise ValueError('unsupported host paths')
    lock_path = RUNTIME / 'deploy.lock'
    if lock_path.is_symlink():
        raise ValueError('unsupported lock path')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        metadata = ENV.stat()
        if metadata.st_nlink != 1 or not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_uid != pwd.getpwnam('ubuntu').pw_uid:
            raise ValueError('configuration permissions mismatch')
        raw = ENV.read_bytes()
        values = parse(raw)
        print(json.dumps({'staffAuthDisabled': values.get(AUTH) == 'true', 'bookingsIndependentlyDisabled': values.get(BOOK) == 'true'}), flush=True)
        replacement = prepare(raw, args.preserve_unavailable_bookings == 'true')
        verify = lambda env: verify_runtime(args.expected_release, args.reviewed_source_digest, env)
        verify(values)
        health()
        # Secure backup remains on host only, never uploaded or printed.
        backup_dir = RUNTIME / 'staff-access-rollback'
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        backup_stat = backup_dir.lstat()
        if not stat.S_ISDIR(backup_stat.st_mode) or backup_stat.st_uid != 0 or stat.S_IMODE(backup_stat.st_mode) != 0o700:
            raise ValueError('unsafe rollback directory')
        fd, _ = tempfile.mkstemp(prefix='environment-', dir=backup_dir)
        with os.fdopen(fd, 'wb') as backup:
            backup.write(raw)
            backup.flush()
            os.fsync(backup.fileno())
        if ENV.read_bytes() != raw:
            raise ValueError('configuration changed during preparation')
        apply(raw, replacement, metadata, verify)
        print(json.dumps({'staffGateRestored': True, 'publicBookingsRemainUnavailable': True, 'accountMutationCommandsRun': False, 'accountsPreservedVerification': 'not-performed', 'interactiveLoginVerified': False}))


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise InterruptedError('restoration interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except BaseException:
        # Deliberately suppress exception detail, subprocess output and env data.
        print('Staff restoration did not complete. Host state requires verification; no automatic retry.', flush=True)
        raise SystemExit(1)
