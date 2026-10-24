"""Private host operation, streamed in memory; app work runs only after irreversible privilege drop."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import signal
import stat
import sys

HOME = Path('/home/ubuntu')
ENV = HOME / '.config/bubblewash/env'
CURRENT = HOME / 'bubblewash-pilot'
RUNTIME = HOME / 'bubblewash-runtime'
FIELDS = {'ownerEmail', 'reviewedSha', 'runtimeSha', 'nodePath', 'nodeSha256', 'mode', 'deliveryApproved', 'sourcePins'}
NODE_PROGRAM = """import {runSyntheticResearchTest} from './scripts/send-synthetic-research-test.mjs';
const [mode,databasePath]=process.argv.slice(1);
const result=await runSyntheticResearchTest({mode,databasePath,input:process.stdin});
process.stdout.write(JSON.stringify(result)+'\\n');"""


def validate_request(value):
    if type(value) is not dict or set(value) != FIELDS:
        raise ValueError('request refused')
    if not re.fullmatch(r'[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+', value.get('ownerEmail', '')) or len(value['ownerEmail']) > 254:
        raise ValueError('recipient refused')
    if not all(re.fullmatch('[a-f0-9]{40}', value.get(k, '')) for k in ('reviewedSha', 'runtimeSha')) or not re.fullmatch('[a-f0-9]{64}', value.get('nodeSha256', '')):
        raise ValueError('pin refused')
    for key in ('nodePath',):
        path = value.get(key)
        if type(path) is not str or not path.startswith('/') or len(path) > 4096 or any(c in path for c in ('\0', '\r', '\n')) or '..' in Path(path).parts:
            raise ValueError('path refused')
    if value.get('mode') not in ('check', 'send') or type(value.get('deliveryApproved')) is not bool or value['mode'] == 'send' and not value['deliveryApproved']:
        raise ValueError('mode refused')
    pins = value.get('sourcePins')
    required = {'scripts/send-synthetic-research-test.mjs', 'tests/alias-loader.mjs', 'db/proposed/research-v1.sql', 'package.json', 'package-lock.json', 'src/lib/research/provider.ts', 'src/lib/data-store.ts'}
    if type(pins) is not dict or not required.issubset(pins) or len(pins) > 500:
        raise ValueError('source pins refused')
    for name, digest in pins.items():
        if type(name) is not str or Path(name).is_absolute() or '..' in Path(name).parts or not re.fullmatch(r'[A-Za-z0-9_./()\[\]-]+', name) or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('source pins refused')
    return value


@contextmanager
def retained_environment(f, installer, uid, gid):
    # Existing descriptor-relative installer pattern, but read-only: no replacement.
    parent = ENV.parent
    f.require(parent.resolve(strict=True) == parent)
    parents = {}
    for path in (parent, parent.parent):
        info = path.stat()
        f.require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, uid) and not info.st_mode & 0o022)
        parents[path] = installer.identity(info)[:6]
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        parent_identity = installer.identity(os.fstat(directory))[:6]
        fd = os.open(ENV.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        f.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == uid and info.st_gid == gid
                  and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 65536 and not os.listxattr(fd))
        raw = os.read(fd, 65537)
        f.require(len(raw) == info.st_size)
        def unchanged():
            for path, expected in parents.items():
                f.require(path.resolve(strict=True) == path and installer.identity(path.stat())[:6] == expected)
            f.require(parent.resolve(strict=True) == parent and installer.identity(parent.lstat())[:6] == parent_identity)
            f.require(installer.identity(os.stat(ENV.name, dir_fd=directory, follow_symlinks=False)) == installer.identity(info))
            f.require(installer.identity(os.fstat(fd)) == installer.identity(info))
            os.lseek(fd, 0, os.SEEK_SET)
            f.require(os.read(fd, 65537) == raw)
        unchanged()
        yield raw, unchanged
    finally:
        if fd is not None: os.close(fd)
        os.close(directory)


def validate_result(value):
    allowed = [(False, 'blocked'), (False, 'ready'), (False, 'already-attempted'), (True, 'accepted'), (True, 'review-required'), (None, 'review-required')]
    if type(value) is not dict or set(value) != {'attempted', 'status'} or not any(type(value['attempted']) is type(a) and value['attempted'] == a and value['status'] == s for a, s in allowed):
        raise ValueError('result refused')
    return value


def verify_source(f, release, pins, uid):
    f.require(release.is_absolute() and release.resolve(strict=True) == release)
    for name, expected in pins.items():
        file = release / name
        entry = f.source(file, uid, 4 * 1024 * 1024)
        f.require(file.resolve(strict=True) == file and entry['trustedOwnership'] and entry['sha256'] == expected)
    # Same-user execution accepts protected root/app-owned dependencies.
    # No app code runs as root; no package installation or ownership repair.
    modules = release / 'node_modules'
    f.require(modules.is_dir() and modules.resolve(strict=True) == modules)
    count = 0
    for parent, dirs, files in os.walk(modules, followlinks=False):
        for path in [Path(parent), *(Path(parent) / name for name in dirs + files)]:
            count += 1; f.require(count <= 150000)
            info = path.lstat()
            f.require(info.st_uid in (0, uid))
            if stat.S_ISLNK(info.st_mode):
                f.require(path.resolve(strict=True).is_relative_to(modules))
            else:
                f.require((stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) and not info.st_mode & 0o022)

    f.require(count > 1)


def verify_runtime(f, preflight, release, node, uid, database):
    # Bind the independently supplied executable pin to the actual listener,
    # not merely systemd MainPID, which can be npm or a launcher.
    env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(HOME), 'LC_ALL': 'C',
           'XDG_RUNTIME_DIR': f'/run/user/{uid}', 'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{uid}/bus'}
    ctl = f.trusted_executable('/usr/bin/systemctl')
    fields = 'LoadState,ActiveState,NeedDaemonReload,MainPID,WorkingDirectory,EnvironmentFiles'
    raw = f.bounded([ctl, '--user', 'show', 'bubblewash-local.service', '--property=' + fields], env=env, limit=8192)
    unit = preflight.parse_env(raw.decode())
    f.require(set(unit) == set(fields.split(',')) and unit['LoadState'] == 'loaded' and unit['ActiveState'] == 'active' and unit['NeedDaemonReload'] == 'no')
    f.require(Path(unit['WorkingDirectory']).resolve(strict=True) == release and unit['EnvironmentFiles'] == f'{ENV} (ignore_errors=no)')
    main = int(unit['MainPID']); f.require(main > 1)
    main_identity = preflight.process_identity(main)
    ss = f.trusted_executable('/usr/bin/ss')
    raw = f.bounded([ss, '-H', '-ltnp', 'sport = :3000'], env=env, limit=8192)
    listeners = set(re.findall(rb'pid=(\d+)', raw)); f.require(len(listeners) == 1)
    listener = int(next(iter(listeners))); identity = preflight.process_identity(listener)
    proc = Path('/proc') / str(listener)
    f.require(proc.stat().st_uid == uid and (proc / 'exe').resolve(strict=True) == Path(node)
              and (proc / 'cwd').resolve(strict=True) == release
              and (Path('/proc') / str(main) / 'cwd').resolve(strict=True) == release)
    f.require(preflight.bounded_bytes(proc / 'cgroup', 65536) == preflight.bounded_bytes(Path('/proc') / str(main) / 'cgroup', 65536))
    f.require(preflight.runtime_flags(listener).get('NODE_ENV') == 'production')
    # Retain only the configured DB binding; no process values are reported.
    database_values = [entry.partition(b'=')[2] for entry in
                       preflight.bounded_bytes(proc / 'environ', 1024 * 1024).split(b'\0')
                       if entry.partition(b'=')[0] == b'BUBBLEWASH_DATABASE_PATH']
    f.require(database_values == [str(database).encode()])
    f.require(identity == preflight.process_identity(listener) and main_identity == preflight.process_identity(main))


def run(request, f, installer, preflight, uid, gid, lock_unchanged):
    request = validate_request(request)
    # Retained root-acquired lock; all environment/source/app work is app-UID only.
    attempted = False
    try:
        with retained_environment(f, installer, uid, gid) as (raw, env_unchanged):
            configured = preflight.parse_env(raw.decode())
            f.require(configured.get('NODE_ENV', 'production') == 'production' and configured.get('BUBBLEWASH_DATABASE_DRIVER') == 'sqlite')
            database_path = configured.get('BUBBLEWASH_DATABASE_PATH', '')
            f.require(database_path.startswith('/') and len(database_path) <= 4096 and
                      not any(c in database_path for c in ('\0', '\r', '\n')) and '..' not in Path(database_path).parts)
            key = configured.get('BUBBLEWASH_RESEARCH_RESEND_KEY', '')
            f.require(re.fullmatch(r're_[A-Za-z0-9_-]{16,200}', key))
            release = CURRENT.resolve(strict=True)
            marker = RUNTIME / 'current-release'
            marker_info = f.source(marker, uid, 65536); f.require(marker_info['trustedOwnership'])
            marker_raw = preflight.bounded_text(marker)
            marker_value = preflight.parse_env(marker_raw)
            f.require(marker_value.get('sha') == request['runtimeSha'] and Path(marker_value.get('path', '')).resolve(strict=True) == release)
            verify_source(f, release, request['sourcePins'], uid)
            node = f.trusted_executable(request['nodePath'])
            f.require(node == request['nodePath'] and f.source(node, 0, 128 * 1024 * 1024)['sha256'] == request['nodeSha256'])
            clean = {'PATH': '/usr/bin:/bin', 'HOME': str(HOME), 'LC_ALL': 'C'}
            f.require(re.fullmatch(rb'v22\.\d+\.\d+\n', f.bounded([node, '--version'], env=clean, limit=128)))
            database = Path(database_path); info = database.lstat()
            f.require(database.resolve(strict=True) == database and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                      and info.st_uid == uid and not info.st_mode & 0o022)
            f.require(all(x.get('kind') == 'directory' and x.get('uid') in (0, uid) and not x.get('mode', 0) & 0o022 for x in f.ancestry(database.parent)))
            for suffix in ('-wal', '-shm', '-journal'):
                sidecar = Path(str(database) + suffix)
                if sidecar.exists() or sidecar.is_symlink():
                    item = sidecar.lstat()
                    f.require(stat.S_ISREG(item.st_mode) and item.st_nlink == 1 and item.st_uid == uid and not item.st_mode & 0o022 and sidecar.resolve(strict=True) == sidecar)
            binding = tuple(getattr(info, k) for k in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink'))
            def unchanged():
                lock_unchanged(); env_unchanged()
                f.require(CURRENT.resolve(strict=True) == release and preflight.bounded_text(marker) == marker_raw)
                f.require(f.source(marker, uid, 65536) == marker_info)
                f.require(database.resolve(strict=True) == database and tuple(getattr(database.lstat(), k) for k in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink')) == binding)
            verify_runtime(f, preflight, release, node, uid, database)
            unchanged()
            child_env = {**clean, 'NODE_ENV': 'production', 'BUBBLEWASH_DATABASE_PATH': str(database), 'BUBBLEWASH_RESEARCH_RESEND_KEY': key}
            private = json.dumps({'ownerEmail': request['ownerEmail']}, separators=(',', ':')).encode()
            os.chdir(release)
            # Existing helper does all exact schema checks and the atomic claim.
            # Its output is parsed, never blindly relayed. No retries on any layer.
            attempted = request['mode'] == 'send'
            out = f.bounded([node, '--conditions=react-server', '--experimental-strip-types', '--experimental-loader=./tests/alias-loader.mjs', '--input-type=module', '-e', NODE_PROGRAM, '--', '--' + request['mode'], str(database)], private, env=child_env, timeout=45, limit=8192)
            value = validate_result(f.strict_json(out))
            if request['mode'] == 'check': f.require(value['attempted'] is False and value['status'] in ('ready', 'blocked', 'already-attempted'))
            unchanged()
            return value
    except BaseException:
        return {'attempted': None if attempted else False, 'status': 'review-required' if attempted else 'blocked'}


def main(f, installer, preflight):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    def deadline(*_): raise TimeoutError('operation deadline')
    signal.signal(signal.SIGALRM, deadline); signal.alarm(120)
    result = {'attempted': False, 'status': 'blocked'}
    try:
        # Host identity is bound by the fixed authenticated root@hermes transport.
        f.require(os.geteuid() == 0)
        account = pwd.getpwnam('ubuntu'); f.require(account.pw_uid > 0)
        with installer.deployment_lock(RUNTIME, account.pw_uid) as lock_unchanged:
            os.setgroups([]); os.setgid(account.pw_gid); os.setuid(account.pw_uid)
            f.require(os.geteuid() == account.pw_uid and os.getuid() == account.pw_uid)
            lock_unchanged()
            signal.alarm(5)
            raw = sys.stdin.buffer.read(128 * 1024 + 1); f.require(len(raw) <= 128 * 1024)
            request = validate_request(f.strict_json(raw)); signal.alarm(120)
            result = run(request, f, installer, preflight, account.pw_uid, account.pw_gid, lock_unchanged)
    except BaseException: pass
    finally: signal.alarm(0)
    print(json.dumps(result, separators=(',', ':')))
