"""Bounded metadata inspection. Never read application environment or database files."""
from itertools import islice
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
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

def summary(flags=(), result='captured', diagnostics=None):
    value = {'schema': 'bubblewash-host-facts-summary/v1', 'result': result, 'flags': sorted(set(flags))}
    if diagnostics is not None: value['diagnostics'] = diagnostics
    validate_summary(value); return value

def validate_summary(value):
    require(isinstance(value, dict) and set(value) in ({'schema', 'result', 'flags'}, {'schema', 'result', 'flags', 'diagnostics'}))
    require(value['schema'] == 'bubblewash-host-facts-summary/v1' and value['result'] in RESULTS)
    require(isinstance(value['flags'], list) and all(type(x) is str and x in FLAGS for x in value['flags']))
    require(value['flags'] == sorted(set(value['flags'])))
    if 'diagnostics' in value: validate_diagnostics(value['diagnostics'])
    require(len(canonical(value)) <= 7000)
    return value

ENV_CHECKS = ('accountValid', 'regularFile', 'ownerMatches', 'primaryGroupMatches', 'modePrivate', 'singleLink', 'canonicalPath', 'ancestorDirectories', 'ancestorOwners', 'ancestorModes', 'attributesAbsent')
UNIT_IDS = ('maintenance-timer', 'maintenance-service', 'application-service')
UNIT_STAGES = ('account-unavailable', 'command-failed', 'properties-invalid', 'inspected')
SOURCE_STAGES = ('not-assessed', 'trusted', 'ownership-unsafe', 'read-or-validation-failed')
PHP_NAME = re.compile(r'(?:php(?:[0-9]{1,2}\.[0-9]{1,2})?(?:-(?:fpm|cli|common|opcache|readline|mysql|pgsql|sqlite3|curl|mbstring|xml|zip|gd|intl|bcmath|soap|redis|imagick|dev|cgi|xdebug|apcu))?|libapache2-mod-php(?:[0-9]{1,2}\.[0-9]{1,2})?)')
PHP_VERSION = re.compile(r'[0-9][A-Za-z0-9.+:~_-]{0,79}')
PHP_PRESENCE = ('servicesInspected', 'phpServicePresent', 'phpServiceActive', 'webServicePresent', 'listenersInspected', 'phpTcpListenerPresent', 'phpNonLoopbackListenerPresent')

def safe_path(value):
    return (type(value) is str and 0 < len(value) <= 256 and re.fullmatch(r'/[A-Za-z0-9_./+@:-]*', value) is not None
            and not value.startswith('//') and value == str(Path(value)) and all(part not in ('.','..') for part in value.split('/')))


def private_binding(item):
    props = item.get('properties', item.get('observedBindingProperties', {}))
    raw = props.get('EnvironmentFiles')
    files = None
    if type(raw) is str and len(raw) <= 1024:
        if raw == '': files = []
        else:
            matches = list(re.finditer(r'(/[^ ]+) \(ignore_errors=(yes|no)\)(?: |$)', raw))
            if 0 < len(matches) <= 2 and ''.join(x.group(0) for x in matches) == raw and all(safe_path(x.group(1)) for x in matches):
                files = [{'path':x.group(1), 'ignoreErrors':x.group(2)=='yes'} for x in matches]
    working = props.get('WorkingDirectory')
    executable = item.get('runningExecutable', {})
    path, digest = executable.get('path'), executable.get('sha256')
    observed = {'path':path,'sha256':digest} if safe_path(path) and type(digest) is str and re.fullmatch('[a-f0-9]{64}',digest) else None
    return {'environmentFiles':files, 'workingDirectory':working if safe_path(working) else None,
            'mainPidExecutable':observed, 'identityScope':'main-pid-not-listener-identity'}


def validate_binding(value):
    require(type(value) is dict and set(value)=={'environmentFiles','workingDirectory','mainPidExecutable','identityScope'})
    require(value['identityScope']=='main-pid-not-listener-identity')
    require(value['workingDirectory'] is None or safe_path(value['workingDirectory']))
    files=value['environmentFiles'];require(files is None or type(files) is list and len(files)<=2)
    for item in files or []:
        require(type(item) is dict and set(item)=={'path','ignoreErrors'} and safe_path(item['path']) and type(item['ignoreErrors']) is bool)
    executable=value['mainPidExecutable']
    require(executable is None or type(executable) is dict and set(executable)=={'path','sha256'} and safe_path(executable['path']) and type(executable['sha256']) is str and re.fullmatch('[a-f0-9]{64}',executable['sha256']))

def validate_diagnostics(value):
    require(type(value) is dict and set(value) == {'environment', 'units', 'php'})
    checks = value['environment']
    require(type(checks) is dict and set(checks) == set(ENV_CHECKS))
    require(all(v is None or type(v) is bool for v in checks.values()))
    units = value['units']; require(type(units) is list and len(units) == 3)
    require([u.get('unit') for u in units] == list(UNIT_IDS))
    for item in units:
        require(set(item) == {'unit', 'stage', 'unitSources', 'executableSource', 'propertyIssue', 'missingProperties', 'binding'} and item['stage'] in UNIT_STAGES)
        validate_binding(item['binding'])
        require(item['executableSource'] in SOURCE_STAGES and item['propertyIssue'] in ('not-assessed','none','missing','duplicate','unknown','malformed','oversized'))
        require(type(item['missingProperties']) is list and item['missingProperties'] == sorted(set(item['missingProperties'])) and all(x in PROPERTIES for x in item['missingProperties']))
        require(type(item['unitSources']) is list and item['unitSources'] == sorted(set(item['unitSources'])) and all(x in SOURCE_STAGES for x in item['unitSources']))
    php = value['php']; require(type(php) is dict and set(php) == {'packages', 'packagesComplete', *PHP_PRESENCE})
    require(type(php['packagesComplete']) is bool and all(type(php[k]) is bool or php[k] is None for k in PHP_PRESENCE))
    require(type(php['packages']) is list and len(php['packages']) <= 24)
    for item in php['packages']:
        require(type(item) is dict and set(item) == {'name', 'version'} and type(item['name']) is str and type(item['version']) is str and PHP_NAME.fullmatch(item['name']) and PHP_VERSION.fullmatch(item['version']))
    require(php['packages'] == sorted(php['packages'], key=lambda x:(x['name'],x['version'])))

def safe_diagnostics(report):
    packages = report.get('php', {}).get('packages', {})
    rows = packages.get('result', []) if packages.get('inspected') is True else []
    accepted = [dict(name=x['name'], version=x['version']) for x in rows if type(x) is dict and type(x.get('name')) is str and type(x.get('version')) is str and PHP_NAME.fullmatch(x['name']) and PHP_VERSION.fullmatch(x['version'])]
    accepted.sort(key=lambda x:(x['name'],x['version']))
    services = report.get('php', {}).get('services', {})
    sr = services.get('result', []) if services.get('inspected') is True else []
    listeners = report.get('php', {}).get('tcpListeners', {})
    lr = listeners.get('result', {}) if listeners.get('inspected') is True else {}
    present = lambda k: lr[k] > 0 if type(lr.get(k)) is int else None
    value = {'environment': report['installerMetadata'].get('environmentChecks', dict.fromkeys(ENV_CHECKS)),
             'units': [{'unit':alias, 'stage':item.get('diagnosticStage','account-unavailable'), 'unitSources':sorted(set(item.get('sourceStages') or ['not-assessed'])), 'executableSource':item.get('executableStage','not-assessed'), 'propertyIssue':item.get('propertyIssue','not-assessed'), 'missingProperties':item.get('missingProperties',[]), 'binding':private_binding(item)} for alias,item in zip(UNIT_IDS,report['units'])],
             'php': {'packages':accepted[:24], 'packagesComplete':packages.get('inspected') is True and len(accepted)==len(rows) and len(accepted)<=24,
                     'servicesInspected':services.get('inspected') is True,
                     'phpServicePresent':any(re.fullmatch(r'php[0-9.]*-fpm\.service',x.get('name','')) for x in sr),
                     'phpServiceActive':any(re.fullmatch(r'php[0-9.]*-fpm\.service',x.get('name','')) and x.get('active') is True for x in sr),
                     'webServicePresent':any(x.get('name') in ('nginx.service','apache2.service','httpd.service') for x in sr),
                     'listenersInspected':listeners.get('inspected') is True,
                     'phpTcpListenerPresent':present('phpTcpListenerCount'), 'phpNonLoopbackListenerPresent':present('phpNonLoopbackTcpListenerCount')}}
    if services.get('inspected') is not True:
        for key in ('phpServicePresent', 'phpServiceActive', 'webServicePresent'): value['php'][key] = None
    validate_diagnostics(value); return value

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
    checks = report['environmentChecks'] = dict.fromkeys(ENV_CHECKS)
    checks['accountValid'] = type(uid) is int and uid > 0 and type(gid) is int and gid >= 0
    env = Path('/home/ubuntu/.config/bubblewash/env')
    try:
        info = metadata(env); report['environment'] = info
        checks.update(regularFile=info.get('kind') == 'file', ownerMatches=info.get('uid') == uid if uid is not None and 'uid' in info else None,
                      primaryGroupMatches=info.get('gid') == gid if gid is not None and 'gid' in info else None,
                      modePrivate=info.get('mode') == 0o600 if 'mode' in info else None, singleLink=info.get('links') == 1 if 'links' in info else None)
        report['environmentAncestry'] = ancestry(env.parent)
        ancestors = report['environmentAncestry']
        checks.update(ancestorDirectories=bool(ancestors) and all(x.get('kind') == 'directory' for x in ancestors),
                      ancestorOwners=bool(ancestors) and all(x.get('uid') in (0,uid) for x in ancestors) if uid is not None else None,
                      ancestorModes=bool(ancestors) and all(not x.get('mode',0) & 0o022 for x in ancestors))
        checks['canonicalPath'] = env.resolve(strict=True) == env
        names = os.listxattr(env, follow_symlinks=False)
        report['environmentAttributes'] = {'xattrsPresent': bool(names), 'posixAclPresent': any(n in ('system.posix_acl_access','system.posix_acl_default') for n in names)}
        if names: flags.add('installer-env-attributes-present')
        checks['attributesAbsent'] = not names
        safe = all(v is True for k,v in checks.items() if k != 'attributesAbsent')
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
        item['diagnosticStage'] = 'command-failed'
        try:
            raw = run(prefix + ['/usr/bin/systemctl', '--system' if manager == 'system' else '--user', 'show', name, '--no-pager', '--property=' + ','.join(PROPERTIES)])
            item['diagnosticStage'] = 'properties-invalid'
            props = {}
            for line in raw.splitlines():
                key, sep, value = line.partition('=')
                issue = 'malformed' if not sep else 'unknown' if key not in PROPERTIES else 'duplicate' if key in props else 'oversized' if len(value) >= 8192 else 'none'
                item['propertyIssue'] = issue; require(issue == 'none'); props[key] = value
                if key in ('EnvironmentFiles','WorkingDirectory'): item.setdefault('observedBindingProperties', {})[key] = value
            item['missingProperties'] = sorted(set(PROPERTIES) - set(props))
            item['propertyIssue'] = 'missing' if item['missingProperties'] else 'none'
            require(not item['missingProperties']); item.update(inspected=True, properties=props, unitSources=[])
            if props['LoadState'] != 'loaded': flags.add('unit-unavailable')
            if props['NeedDaemonReload'] == 'yes': flags.add('pending-reload')
            elif props['NeedDaemonReload'] != 'no': flags.add('metadata-incomplete')
            paths = ([props['FragmentPath']] if props['FragmentPath'] else []) + props['DropInPaths'].split()
            require(len(paths) <= 64)
            item['diagnosticStage'] = 'inspected'; item['sourceStages'] = []
            if not paths: flags.add('metadata-incomplete')
            for path in paths:
                try:
                    value = source(path, uid); item['unitSources'].append(value)
                    item['sourceStages'].append('trusted' if value['trustedOwnership'] else 'ownership-unsafe')
                    if not value['trustedOwnership']: flags.add('unsafe-source')
                except Exception: item['unitSources'].append({'path': path, 'inspected': False}); item['sourceStages'].append('read-or-validation-failed'); flags.add('unsafe-source')
            pid = props['MainPID']
            if pid.isdigit() and int(pid) > 1:
                try:
                    executable = os.readlink('/proc/' + pid + '/exe'); item['runningExecutable'] = source(executable, 0, 128*1024*1024)
                    item['executableStage'] = 'trusted' if item['runningExecutable']['trustedOwnership'] else 'ownership-unsafe'
                    if not item['runningExecutable']['trustedOwnership']: flags.add('unsafe-source')
                except Exception: item['executableStage'] = 'read-or-validation-failed'; flags.add('launch-executable-unresolved')
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
    return report, summary(flags, diagnostics=safe_diagnostics(report))
