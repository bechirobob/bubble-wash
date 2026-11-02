"""Loaded after the unchanged preflight helpers by stream_rollback_preflight.py."""

# Opt-in evidence only: no inventory, app imports, database or HTTP probes.
ROLLBACK_ROOT = Path('/var/lib/bubblewash-release/releases')
ROLLBACK_FILES = ('.release-sha', '.next/BUILD_ID', '.next/required-server-files.json',
                  'package.json', 'package-lock.json', 'node_modules/next/dist/bin/next')
UAT_KEY = 'BUBBLEWASH_UAT_ENABLED'


def inspection_directory(path):
    fd = retained_open(None, '/', True)
    try:
        for part in path.parts[1:]:
            child = retained_open(fd, part, True)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def inspection_file(path, limit):
    fd = inspection_directory(path.parent)
    try:
        return retained_read(fd, path.name, limit)
    finally:
        os.close(fd)


def uat_classification(value):
    return 'absent' if value is None else value if value in ('true', 'false') else 'other'


def rollback_inspection(expected_sha, expected_path):
    """Pinned, fail-closed evidence; hashes do not prove rollback execution."""
    failure = {'readOnly': True, 'inspectionFailed': True}
    fd = None
    try:
        if not re.fullmatch('[0-9a-f]{40}', expected_sha):
            raise ValueError('invalid pin')
        target = Path(expected_path)
        approved = (ROLLBACK_ROOT / expected_sha,)
        historical = HOME / 'bubblewash-releases'
        if str(target) != expected_path or (target not in approved and not (
                target.parent == historical and re.fullmatch(
                    r'\d{8}T\d{6}Z-' + expected_sha[:12], target.name))):
            raise ValueError('invalid pinned path')
        marker_path = HOME / 'bubblewash-runtime/current-release'
        marker_raw = inspection_file(marker_path, 65536)
        marker = parse_env(marker_raw.decode())
        if marker.get('sha') != expected_sha or marker.get('path') != expected_path or CURRENT.resolve(strict=True) != target:
            raise ValueError('live pin mismatch')
        fd = inspection_directory(target)
        directory_before = os.fstat(fd)
        raw_files = {name: retained_read(fd, name, 2 * 1024 * 1024) for name in ROLLBACK_FILES}
        if raw_files['.release-sha'] not in (expected_sha.encode(), (expected_sha + '\n').encode()):
            raise ValueError('release pin mismatch')
        if not re.fullmatch(rb'[A-Za-z0-9_-]{1,128}\n?', raw_files['.next/BUILD_ID']):
            raise ValueError('invalid build identifier')
        env_raw = inspection_file(ENV_FILE, 65536)
        configured = parse_env(env_raw.decode()).get(UAT_KEY)
        uid = pwd.getpwnam('ubuntu').pw_uid
        args = ['runuser', '-u', 'ubuntu', '--', 'env', f'XDG_RUNTIME_DIR=/run/user/{uid}', f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus', 'systemctl', '--user', 'show', 'bubblewash-local.service', '--property=LoadState,ActiveState,MainPID,WorkingDirectory,EnvironmentFiles']
        unit = dict(line.split('=', 1) for line in command(args).splitlines() if '=' in line)
        listeners = set(re.findall(r'pid=(\d+)', command(['ss', '-H', '-ltnp', 'sport = :3000'])))
        if unit.get('LoadState') != 'loaded' or unit.get('ActiveState') != 'active' or len(listeners) != 1 or unit.get('EnvironmentFiles') != f'{ENV_FILE} (ignore_errors=no)' or Path(unit.get('WorkingDirectory', '/')).resolve() != target:
            raise ValueError('service binding failed')
        pids = (int(unit.get('MainPID', '0')), int(next(iter(listeners))))
        identities, flags, cgroups, environments = [], [], [], []
        for pid in pids:
            if pid <= 1:
                raise ValueError('invalid process')
            identities.append(process_identity(pid))
            base = PROC / str(pid)
            if (base / 'cwd').resolve(strict=True) != target or (base / 'exe').resolve().name != 'node':
                raise ValueError('process binding failed')
            cgroups.append(bounded_bytes(base / 'cgroup', 65536))
            environments.append(bounded_bytes(base / 'environ', 1048576))
            values = [entry.partition(b'=')[2] for entry in environments[-1].split(b'\0') if entry.partition(b'=')[0] == UAT_KEY.encode() and b'=' in entry]
            if len(values) > 1:
                raise ValueError('duplicate flag')
            flags.append(values[0].decode() if values else None)
        if not cgroups[0] or cgroups[0] != cgroups[1] or any(
                process_identity(pid) != identity or
                bounded_bytes(PROC / str(pid) / 'environ', 1048576) != environment or
                bounded_bytes(PROC / str(pid) / 'cgroup', 65536) != cgroup
                for pid, identity, environment, cgroup in zip(pids, identities, environments, cgroups)):
            raise ValueError('unstable process binding')
        if any(retained_read(fd, name, 2 * 1024 * 1024) != raw for name, raw in raw_files.items()) or inspection_file(marker_path, 65536) != marker_raw or inspection_file(ENV_FILE, 65536) != env_raw or CURRENT.resolve(strict=True) != target:
            raise ValueError('unstable evidence')
        current_info = target.stat(follow_symlinks=False)
        if (current_info.st_dev, current_info.st_ino, current_info.st_mtime_ns, current_info.st_ctime_ns) != (directory_before.st_dev, directory_before.st_ino, directory_before.st_mtime_ns, directory_before.st_ctime_ns):
            raise ValueError('release replaced')
        return {'readOnly': True, 'inspectionFailed': False,
                'uat': {'key': UAT_KEY, 'configured': uat_classification(configured),
                        'main': uat_classification(flags[0]), 'listener': uat_classification(flags[1]),
                        'exactValuesMatch': configured == flags[0] == flags[1]},
                'rollbackRelease': {'sha': expected_sha, 'path': expected_path,
                    'uid': directory_before.st_uid, 'gid': directory_before.st_gid,
                    'mode': oct(stat.S_IMODE(directory_before.st_mode)),
                    'files': {name: {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} for name, raw in raw_files.items()},
                    'stableDuringRead': True, 'rollbackExecutionProven': False, 'fullTreeVerified': False}}
    except Exception:
        return failure
    finally:
        if fd is not None:
            os.close(fd)

