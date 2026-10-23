"""Bounded metadata inspection. Never read application environment or database files."""
from itertools import islice
import hashlib
import json
import os
from pathlib import Path
import pwd
import selectors
import signal
import stat
import subprocess
import time

LIMIT = 2 * 1024 * 1024
UNITS = (('system', 'bubblewash-maintenance.timer'), ('system', 'bubblewash-maintenance.service'), ('user', 'bubblewash-local.service'))
PROPERTIES = ('LoadState', 'ActiveState', 'SubState', 'NeedDaemonReload', 'FragmentPath', 'DropInPaths', 'MainPID', 'User', 'Group', 'WorkingDirectory', 'RootDirectory', 'EnvironmentFiles')
FLAGS = frozenset(('unit-unavailable', 'manager-unavailable', 'pending-reload', 'unsafe-source', 'metadata-incomplete', 'space-unavailable', 'space-exhausted', 'php-incomplete', 'launch-executable-unresolved', 'operator-exclusion-unresolved', 'staging-capacity-unassessed', 'generator-overrides-unobserved', 'installer-env-metadata-unavailable', 'installer-env-owner-mode-unsafe', 'installer-env-attributes-present', 'installer-env-binding-unverified', 'deployment-lock-unverified', 'tool-unavailable', 'php-indicators-observed', 'php-no-indicators-observed-incomplete', 'installer-metadata-preconditions-observed', 'installer-metadata-preconditions-unverified'))
RESULTS = frozenset(('captured', 'inspection-failed', 'encryption-unavailable', 'transport-failed', 'storage-failed'))

def require(value):
    if not value: raise ValueError('inspection refused')

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()

def strict_json(raw):
    def pairs(items):
        result = dict(items); require(len(result) == len(items)); return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))

def summary(flags=(), result='captured'):
    value = {'schema': 'bubblewash-host-facts-summary/v1', 'result': result, 'flags': sorted(set(flags))}
    validate_summary(value); return value

def validate_summary(value):
    require(isinstance(value, dict) and set(value) == {'schema', 'result', 'flags'})
    require(value['schema'] == 'bubblewash-host-facts-summary/v1' and value['result'] in RESULTS)
    require(isinstance(value['flags'], list) and all(type(x) is str and x in FLAGS for x in value['flags']))
    require(value['flags'] == sorted(set(value['flags'])))
    return value

def bounded(args, data=None, timeout=20, limit=LIMIT, env=None):
    """Bound both pipes while reading; kill the entire new group on every error."""
    process = subprocess.Popen(args, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
        env=env or {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}, bufsize=0)
    chunks = {process.stdout: bytearray(), process.stderr: bytearray()}
    started = time.monotonic(); offset = 0
    try:
        with selectors.DefaultSelector() as poll:
            for pipe in chunks: os.set_blocking(pipe.fileno(), False); poll.register(pipe, selectors.EVENT_READ)
            if data is not None: os.set_blocking(process.stdin.fileno(), False); poll.register(process.stdin, selectors.EVENT_WRITE)
            while poll.get_map():
                require(time.monotonic() - started < timeout)
                for event, _ in poll.select(0.1):
                    pipe = event.fileobj
                    if pipe is process.stdin:
                        if offset < len(data): offset += os.write(pipe.fileno(), data[offset:offset+65536])
                        if offset == len(data): poll.unregister(pipe); pipe.close()
                    else:
                        block = os.read(pipe.fileno(), 65536)
                        if not block: poll.unregister(pipe); pipe.close(); continue
                        require(len(chunks[pipe]) + len(block) <= limit); chunks[pipe].extend(block)
            require(process.wait(timeout=max(0.1, timeout-(time.monotonic()-started))) == 0)
        return bytes(chunks[process.stdout])
    finally:
        # The leader may already have exited while a descendant still owns pipes.
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait()
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe and not pipe.closed: pipe.close()

def command(args): return bounded(args, timeout=10, limit=1024*1024).decode('utf-8', 'strict')

def metadata(path, content=False, max_bytes=1024*1024):
    path = Path(path); require(path.is_absolute() and '..' not in path.parts)
    try: info = path.lstat()
    except FileNotFoundError: return {'path': str(path), 'absent': True}
    value = {'path': str(path), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode), 'links': info.st_nlink,
             'kind': 'file' if stat.S_ISREG(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'link' if stat.S_ISLNK(info.st_mode) else 'other'}
    if value['kind'] == 'link': value['target'] = os.readlink(path)
    if content:
        require(value['kind'] == 'file' and info.st_nlink == 1 and info.st_size <= max_bytes)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            require(os.fstat(fd) == info); sha = hashlib.sha256(); size = 0
            while True:
                block = os.read(fd, 65536)
                if not block: break
                size += len(block); require(size <= max_bytes); sha.update(block)
            after = os.fstat(fd)
            require((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
            value['sha256'] = sha.hexdigest()
        finally: os.close(fd)
    return value

def ancestry(path):
    path = Path(path)
    return [metadata(item) for item in (path, *path.parents)]

def source(path, uid, max_bytes=1024*1024):
    entry = metadata(path, content=True, max_bytes=max_bytes); entry['ancestry'] = ancestry(Path(path).parent)
    entry['trustedOwnership'] = entry['uid'] in (0, uid) and not entry['mode'] & 0o022 and all(
        item.get('kind') == 'directory' and item['uid'] in (0, uid) and not item['mode'] & 0o022 for item in entry['ancestry'])
    return entry

def trusted_executable(filename):
    """Resolve only a fixed caller-selected binary; require protected link and target."""
    path = Path(filename)
    require(path.is_absolute() and '..' not in path.parts)
    original = metadata(path)
    require(original.get('kind') in ('file', 'link') and original.get('uid') == 0)
    require(original['kind'] == 'link' or not original['mode'] & 0o022)
    require(all(x.get('kind') == 'directory' and x.get('uid') == 0 and not x.get('mode', 0) & 0o022 for x in ancestry(path.parent)))
    resolved = path.resolve(strict=True)
    entry = source(resolved, 0, 128*1024*1024)
    require(entry['trustedOwnership'] and os.access(resolved, os.X_OK))
    require(path.resolve(strict=True) == resolved and metadata(path) == original)
    return str(resolved)

def installer_metadata(uid, gid):
    flags = set(); report = {'lockAcquired': False, 'environmentValuesRead': False, 'environmentMetadataSafe': False, 'deploymentLockMetadataSafe': False, 'toolsMetadataSafe': False}
    env = Path('/home/ubuntu/.config/bubblewash/env')
    try:
        info = metadata(env); report['environment'] = info
        report['environmentAncestry'] = ancestry(env.parent)
        names = os.listxattr(env, follow_symlinks=False)
        report['environmentAttributes'] = {'xattrsPresent': bool(names), 'posixAclPresent': any(n in ('system.posix_acl_access','system.posix_acl_default') for n in names)}
        if names: flags.add('installer-env-attributes-present')
        safe = (type(uid) is int and uid > 0 and type(gid) is int and gid >= 0 and
                info.get('kind') == 'file' and info.get('uid') == uid and info.get('gid') == gid and
                info.get('mode') == 0o600 and info.get('links') == 1 and
                env.resolve(strict=True) == env and bool(report['environmentAncestry']) and all(
                x.get('kind') == 'directory' and x.get('uid') in (0, uid) and not x.get('mode', 0) & 0o022
                for x in report['environmentAncestry']))
        report['environmentMetadataSafe'] = safe and not names
        if not safe: flags.add('installer-env-owner-mode-unsafe')
    except Exception: flags.add('installer-env-metadata-unavailable')
    try:
        lock=metadata('/home/ubuntu/bubblewash-runtime/deploy.lock'); report['deploymentLock']=lock
        parents=ancestry('/home/ubuntu/bubblewash-runtime');report['deploymentLockAncestry']=parents
        safe = (lock.get('kind') == 'file' and lock.get('links') == 1 and lock.get('uid') in (0,uid) and not lock.get('mode',0)&0o022 and bool(parents) and all(x.get('kind')=='directory' and x.get('uid') in (0,uid) and not x.get('mode',0)&0o022 for x in parents) and Path('/home/ubuntu/bubblewash-runtime').resolve(strict=True) == Path('/home/ubuntu/bubblewash-runtime'))
        report['deploymentLockMetadataSafe'] = safe
        if not safe: flags.add('deployment-lock-unverified')
    except Exception: flags.add('deployment-lock-unverified')
    report['tools']=[]
    for name in ('/usr/bin/python3','/usr/bin/systemctl'):
        try:
            resolved = Path(trusted_executable(name))
            path=Path(name); item=metadata(path);item['resolved']=metadata(resolved);item['ancestry']=ancestry(resolved.parent)
            item['available']=True; item['trustedExecutable']=True; report['tools'].append(item)
            if not item['available']: flags.add('tool-unavailable')
        except Exception: report['tools'].append({'path':name,'available':False});flags.add('tool-unavailable')
    report['toolsMetadataSafe'] = len(report['tools']) == 2 and all(x.get('available') is True and x.get('trustedExecutable') is True for x in report['tools'])
    return report,flags

def php_indicators_observed(report):
    packages = report.get('packages', {})
    if packages.get('inspected') is True and packages.get('result'): return True
    services = report.get('services', {})
    if services.get('inspected') is True and any(x.get('name', '').startswith('php') for x in services.get('result', [])): return True
    for item, field in ((report.get('processes', {}), 'phpNamedCount'), (report.get('tcpListeners', {}).get('result', {}), 'phpTcpListenerCount')):
        count = item.get(field)
        if type(count) is int and count > 0: return True
    return False

def collect(php, run=command):
    flags = {'operator-exclusion-unresolved', 'staging-capacity-unassessed', 'generator-overrides-unobserved'}
    report = {'schema': 'bubblewash-host-facts/v1', 'readOnly': True, 'units': [], 'space': [], 'sourceCandidates': [],
              'limitations': {'operatorExclusionVerified': False, 'allLaunchSourcesInspected': False, 'generatorOverridesInspected': False,
                              'environmentRead': False, 'databaseRead': False, 'stagingCapacityEstablished': False}}
    try:
        account = pwd.getpwnam('ubuntu'); uid, gid = account.pw_uid, account.pw_gid
    except KeyError: uid = gid = None; flags.add('manager-unavailable')
    for manager, name in UNITS:
        item = {'manager': manager, 'unit': name, 'inspected': False}; report['units'].append(item)
        if manager == 'user' and uid is None: continue
        prefix = [] if manager == 'system' else ['/usr/sbin/runuser', '-u', 'ubuntu', '--', '/usr/bin/env', f'XDG_RUNTIME_DIR=/run/user/{uid}', f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus']
        try:
            raw = run(prefix + ['/usr/bin/systemctl', '--system' if manager == 'system' else '--user', 'show', name, '--no-pager', '--property=' + ','.join(PROPERTIES)])
            props = {}
            for line in raw.splitlines():
                key, sep, value = line.partition('='); require(sep and key in PROPERTIES and key not in props and len(value) < 8192); props[key] = value
            require(set(props) == set(PROPERTIES)); item.update(inspected=True, properties=props, sources=[])
            if props['LoadState'] != 'loaded': flags.add('unit-unavailable')
            if props['NeedDaemonReload'] == 'yes': flags.add('pending-reload')
            elif props['NeedDaemonReload'] != 'no': flags.add('metadata-incomplete')
            paths = ([props['FragmentPath']] if props['FragmentPath'] else []) + props['DropInPaths'].split()
            require(len(paths) <= 64)
            if not paths: flags.add('metadata-incomplete')
            for path in paths:
                try:
                    value = source(path, uid); item['sources'].append(value)
                    if not value['trustedOwnership']: flags.add('unsafe-source')
                except Exception: item['sources'].append({'path': path, 'inspected': False}); flags.add('unsafe-source')
            pid = props['MainPID']
            if pid.isdigit() and int(pid) > 1:
                try:
                    executable = os.readlink('/proc/' + pid + '/exe'); item['runningExecutable'] = source(executable, 0, 128*1024*1024)
                    if not item['runningExecutable']['trustedOwnership']: flags.add('unsafe-source')
                except Exception: flags.add('launch-executable-unresolved')
            elif name.endswith('.service'): flags.add('launch-executable-unresolved')
        except Exception: flags.add('manager-unavailable')
    report['installerMetadata'], installer_flags = installer_metadata(uid, gid); flags.update(installer_flags)
    app = next(item for item in report['units'] if item['manager'] == 'user')
    binding = app.get('properties',{}).get('EnvironmentFiles') == '/home/ubuntu/.config/bubblewash/env (ignore_errors=no)' and app.get('properties',{}).get('LoadState') == 'loaded'
    if not binding: flags.add('installer-env-binding-unverified')
    installer_safe = binding and all(report['installerMetadata'].get(name) is True for name in ('environmentMetadataSafe', 'deploymentLockMetadataSafe', 'toolsMetadataSafe'))
    flags.add('installer-metadata-preconditions-observed' if installer_safe else 'installer-metadata-preconditions-unverified')
    for root in ('/etc/systemd/system', '/etc/systemd/user', '/home/ubuntu/.config/systemd/user', '/run/systemd/system', '/usr/lib/systemd/system', '/usr/lib/systemd/user'):
        for manager, name in UNITS:
            if (manager == 'user') != ('/user' in root): continue
            for path in (Path(root)/name, Path(root)/(name+'.d')):
                try:
                    report['sourceCandidates'].append(metadata(path))
                    if path.is_dir() and not path.is_symlink():
                        children = list(islice(path.iterdir(), 65)); require(len(children) <= 64)
                        report['sourceCandidates'].extend(metadata(child) for child in sorted(children))
                except Exception: flags.add('metadata-incomplete')
    for path in ('/var/lib', '/home/ubuntu', '/home/ubuntu/.hermes', '/home/ubuntu/bubblewash-releases'):
        try:
            fs = os.statvfs(path); report['space'].append({'path': path, 'availableBytes': fs.f_bavail*fs.f_frsize, 'availableInodes': fs.f_favail, 'ancestry': ancestry(path)})
            if fs.f_bavail == 0 or fs.f_favail == 0: flags.add('space-exhausted')
        except Exception: report['space'].append({'path': path, 'inspected': False}); flags.add('space-unavailable')
    php.command = run
    report['php'] = php.collect()
    if any(report['php'].get(key, {}).get('inspected') is not True for key in ('packages', 'services', 'tcpListeners', 'processes')): flags.add('php-incomplete')
    flags.add('php-indicators-observed' if php_indicators_observed(report['php']) else 'php-no-indicators-observed-incomplete')
    return report, summary(flags)
