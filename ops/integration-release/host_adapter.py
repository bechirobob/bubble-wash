#!/usr/bin/env python3
"""Installed-gate consumer. No install, reload, configuration write, or maintenance start.

Defaults to inspection. Execute/recover require an exact externally reviewed plan
and exclusion receipt. Merely setting a boolean cannot authorize host acceptance.
"""
import argparse
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import signal
import shlex
import sqlite3
import stat
import subprocess
import sys
import time
sys.dont_write_bytecode = True
from contracts import (HERE, BASELINE, PROFILE_NAMES, canonical, digest, object_digest,
                       read_json, regular, relative, require, dependency_manifest,
                       load_controller, verify_source)

STATE = Path('/var/lib/bubblewash-release')
HOME = Path('/home/ubuntu')
RUNTIME = HOME/'bubblewash-runtime'
ENV = HOME/'.config/bubblewash/env'
CURRENT = HOME/'bubblewash-pilot'
RELEASES = STATE/'releases'
OLD_RELEASES = HOME/'bubblewash-releases'
RECEIPT = HOME/'bubblewash-backups/offhost-release.json'
SCOPES = ('root-direct', 'ubuntu-direct', 'other-users', 'cron-at', 'alternate-systemd', 'containers', 'remote-triggers')
SHOW = ('LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'Job', 'ControlGroup',
        'WorkingDirectory', 'EnvironmentFiles', 'User', 'Group', 'FragmentPath')


# This pre-installation route deliberately does not instantiate the release
# controller, create state, inspect unrelated invokers, or query SQLite.
EVIDENCE_UNITS = (('system', 'bubblewash-maintenance.timer'),
                  ('system', 'bubblewash-maintenance.service'),
                  ('user', 'bubblewash-local.service'))
EVIDENCE_COMMON_PROPERTIES = ('LoadState', 'ActiveState', 'SubState',
    'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'Conditions')
EVIDENCE_SERVICE_PROPERTIES = ('MainPID', 'ControlPID', 'ControlGroup',
    'WorkingDirectory', 'EnvironmentFiles', 'User', 'Group')
EVIDENCE_PROPERTIES = EVIDENCE_COMMON_PROPERTIES + EVIDENCE_SERVICE_PROPERTIES
EVIDENCE_STAGES = frozenset(('INITIALIZE', 'LOCK', 'CONFIG', 'MARKER',
    'CURRENT_BINDING', 'DATABASE_BINDING', 'UNIT_PROPERTIES', 'UNIT_CONDITIONS',
    'UNIT_SOURCES', 'UNIT_COMMAND', 'PATH_METADATA', 'BINDING_RECHECK', 'LOCK_RECHECK'))
EVIDENCE_STAGE = 'INITIALIZE'


def evidence_failure(error):
    # Never stringify exceptions: messages, filenames and command output may be private.
    stage = EVIDENCE_STAGE if EVIDENCE_STAGE in EVIDENCE_STAGES else 'INITIALIZE'
    category = ('MISSING' if isinstance(error, FileNotFoundError) else
                'BUSY' if isinstance(error, BlockingIOError) else
                'PERMISSION' if isinstance(error, PermissionError) else
                'REFUSED' if isinstance(error, ValueError) else
                'TIMEOUT' if isinstance(error, subprocess.TimeoutExpired) else
                'OS_ERROR' if isinstance(error, OSError) else 'UNEXPECTED')
    return {'schema': 'bubblewash-bounded-host-failure/v1', 'stage': stage,
            'category': category, 'releaseAcceptance': False}


def evidence_metadata(path):
    """One object only, without traversal, dereferencing, or content disclosure."""
    try:
        info = Path(path).lstat()
    except FileNotFoundError:
        return {'present': False}
    kind = ('directory' if stat.S_ISDIR(info.st_mode) else
            'file' if stat.S_ISREG(info.st_mode) else
            'symlink' if stat.S_ISLNK(info.st_mode) else 'other')
    return {'present': True, 'kind': kind, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'device': info.st_dev,
            'inode': info.st_ino, 'links': info.st_nlink}


def evidence_read(path, owner, maximum=65536):
    """Protected bounded no-follow read; do not reveal its errors or bytes."""
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path,
            'evidence path is not canonical')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                before.st_uid in (0, owner) and not before.st_mode & 0o022 and
                before.st_size <= maximum, 'unsafe evidence object')
        raw = os.read(fd, maximum + 1)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        require(len(raw) <= maximum and all(getattr(value, key) == getattr(before, key)
                for value in (os.fstat(fd), path.stat()) for key in fields), 'evidence object changed')
        return raw
    finally:
        os.close(fd)


def evidence_conditions(host, manager, unit):
    """Typed loaded gate conditions; unknown condition parameters are hash-only."""
    escaped = ''.join(ch if ch.isascii() and ch.isalnum() else '_'+format(ord(ch), '02x') for ch in unit)
    command = host.prefix(manager)+['busctl', '--system' if manager == 'system' else '--user',
        'get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1/unit/'+escaped,
        'org.freedesktop.systemd1.Unit', 'Conditions']
    tokens = shlex.split(host.run(command))
    require(len(tokens) >= 2 and tokens[0] == 'a(sbbsi)' and tokens[1].isdigit(),
            'invalid typed conditions')
    count = int(tokens[1])
    require(count <= 128 and len(tokens) == 2+5*count, 'invalid condition count')
    gates = []; unknown = []
    for offset in range(2, len(tokens), 5):
        kind, trigger, negate, parameter, state = tokens[offset:offset+5]
        require(trigger in ('true', 'false') and negate in ('true', 'false') and
                re.fullmatch('-?[0-9]+', state), 'invalid typed condition fields')
        if kind == 'ConditionPathExists' and parameter in {
                str(STATE/name) for name in ('installed-v1', 'app-hold', 'maintenance-hold')}:
            gates.append({'name': Path(parameter).name, 'trigger': trigger == 'true',
                          'negate': negate == 'true', 'result': int(state)})
        else:
            unknown.append(tokens[offset:offset+5])
    return {'gates': gates, 'otherCount': len(unknown), 'otherSha256': object_digest(unknown)}


def inspect_host_evidence(guard, run=None):
    """Read-only pre-installation evidence, not release or security acceptance.

    Config, argv, Conditions and unit source bodies never leave the host.
    Their digests bind review evidence without exposing embedded secrets.
    No database is opened: SQLite read-only WAL access can touch shared memory.
    """
    global EVIDENCE_STAGE
    EVIDENCE_STAGE = 'INITIALIZE'
    require(os.geteuid() == 0, 'root evidence reader required')
    uid = pwd.getpwnam('ubuntu').pw_uid
    host = Host.__new__(Host)
    host.uid, host.run = uid, run or Host.command
    import types
    host.c = types.SimpleNamespace(core=types.SimpleNamespace(TIMER=EVIDENCE_UNITS[0][1]))
    result = {'schema': 'bubblewash-bounded-host-evidence/v1',
              'releaseAcceptance': False, 'databaseOpened': False, 'units': {}, 'paths': {}}
    EVIDENCE_STAGE = 'LOCK'
    with guard.deployment_lock(RUNTIME, uid) as lock_unchanged:
        EVIDENCE_STAGE = 'CONFIG'
        config = evidence_read(ENV, uid)
        values = guard.parse(config)
        EVIDENCE_STAGE = 'MARKER'
        marker = evidence_read(RUNTIME/'current-release', uid)
        marker_values = guard.parse(marker)
        EVIDENCE_STAGE = 'CURRENT_BINDING'
        current = CURRENT.resolve(strict=True)
        require(CURRENT.is_symlink() and current.is_dir() and
                current.parent in (OLD_RELEASES, RELEASES), 'unexpected current release binding')
        sha = marker_values.get('sha', '')
        require(re.fullmatch('[a-f0-9]{40}', sha) and
                marker_values.get('path') == str(current), 'current marker mismatch')
        EVIDENCE_STAGE = 'DATABASE_BINDING'
        database = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
        require(database.is_absolute() and database.resolve(strict=True) == database and
                not database.is_relative_to(current) and not database.is_relative_to(RELEASES) and
                not database.is_relative_to(OLD_RELEASES), 'unsafe database binding')
        db_meta = evidence_metadata(database)
        require(db_meta.get('kind') == 'file' and db_meta['links'] == 1,
                'database binding is not regular')
        result['binding'] = {'currentSha': sha, 'currentPathSha256': object_digest(str(current)),
            'markerSha256': hashlib.sha256(marker).hexdigest(),
            'configSha256': hashlib.sha256(config).hexdigest(),
            'databasePathSha256': object_digest(str(database)), 'databaseMetadata': db_meta}
        for manager, unit in EVIDENCE_UNITS:
            EVIDENCE_STAGE = 'UNIT_PROPERTIES'
            properties = EVIDENCE_COMMON_PROPERTIES + (EVIDENCE_SERVICE_PROPERTIES if unit.endswith('.service') else ())
            raw = host.ctl(manager, 'show', unit, '--all', '--property='+','.join(properties))
            props = {}
            for line in raw.splitlines():
                key, sep, value = line.partition('=')
                require(sep and key in properties and key not in props,
                        'unexpected bounded unit property')
                props[key] = value
            require(set(props) == set(properties), 'incomplete bounded unit evidence')
            row = {'propertiesSha256': object_digest(props)}
            for key in ('LoadState', 'ActiveState', 'SubState', 'NeedDaemonReload'):
                require(re.fullmatch('[a-z-]{1,32}', props[key]), 'invalid unit state')
                row[key] = props[key]
            # Never expose raw ExecStart or properties: either can embed secrets.
            for key in (('MainPID', 'ControlPID') if unit.endswith('.service') else ()):
                require(props[key].isdigit(), 'invalid unit pid')
                row[key] = int(props[key])
            for key in ('ControlGroup', 'WorkingDirectory', 'EnvironmentFiles', 'User', 'Group', 'Conditions'):
                if key in props:
                    row[key+'Sha256'] = object_digest(props[key])
            if props['LoadState'] == 'loaded':
                EVIDENCE_STAGE = 'UNIT_CONDITIONS'
                row['loadedConditions'] = evidence_conditions(host, manager, unit)
            EVIDENCE_STAGE = 'UNIT_SOURCES'
            sources = [props['FragmentPath'], *shlex.split(props['DropInPaths'])]
            require(len(sources) <= 33, 'unit source count exceeds bound')
            row['sources'] = []
            for name in filter(None, sources):
                path = Path(name)
                allowed = (Path('/etc/systemd/system'), Path('/etc/systemd/user'),
                    Path('/usr/lib/systemd/system'), Path('/usr/lib/systemd/user'),
                    Path('/run/systemd/system'), Path('/run/systemd/user'),
                    HOME/'.config/systemd/user')
                require(any(path.is_relative_to(parent) for parent in allowed),
                        'unit source outside bounded roots')
                body = evidence_read(path, uid if manager == 'user' else 0)
                row['sources'].append({'pathSha256': object_digest(name), 'metadata': evidence_metadata(path),
                                      'sha256': hashlib.sha256(body).hexdigest()})
            if unit.endswith('.service') and props['LoadState'] == 'loaded':
                EVIDENCE_STAGE = 'UNIT_COMMAND'
                row['execStartSha256'] = object_digest(host.exec_start(manager, unit))
            result['units'][manager+'/'+unit] = row
        EVIDENCE_STAGE = 'PATH_METADATA'
        paths = (Path('/var'), Path('/var/lib'), STATE, STATE/'plans', STATE/'packages',
                 RELEASES, STATE/'installed-v1', STATE/'app-hold', STATE/'maintenance-hold',
                 RUNTIME, RUNTIME/'deploy.lock', CURRENT)
        result['paths'] = {str(path): evidence_metadata(path) for path in paths}
        EVIDENCE_STAGE = 'BINDING_RECHECK'
        require(evidence_read(ENV, uid) == config and
                evidence_read(RUNTIME/'current-release', uid) == marker and
                CURRENT.resolve(strict=True) == current and
                evidence_metadata(database) == db_meta, 'binding changed during inspection')
        EVIDENCE_STAGE = 'LOCK_RECHECK'
        lock_unchanged()
    return result


def protected(path, owner=0, parents=False):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'protected path noncanonical')
    info = regular(path)
    require(info.st_uid == owner and not info.st_mode & 0o022, 'protected file ownership or mode differs')
    if parents:
        for parent in path.parents:
            value = parent.lstat()
            require(stat.S_ISDIR(value.st_mode) and value.st_uid == owner and not value.st_mode & 0o022, 'unprotected gate parent')
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink)


def process_identity(pid, proc=Path('/proc')):
    raw = (proc/str(pid)/'stat').read_text()
    fields = raw.rsplit(')', 1)[1].split()
    require(len(fields) >= 20 and fields[19].isdigit(), 'unreadable process start time')
    return fields[19]


def release_processes(releases, proc=Path('/proc')):
    """All UIDs, no argv/environment output. A vanished PID is the only tolerated race."""
    roots = tuple(str(Path(root)).encode() for root in releases)
    found = {}
    for item in proc.iterdir():
        if not item.name.isdigit() or int(item.name) == os.getpid():
            continue
        try:
            fields = (item/'stat').read_text().rsplit(')', 1)[1].split()
            if fields[0] == 'Z':
                continue
            command = (item/'cmdline').read_bytes()
            # Kernel threads have no cwd and no command line.
            if not command:
                continue
            cwd = os.readlink(item/'cwd').encode()
            arguments = []
            for token in command.split(b'\0'):
                token = token.split(b'=', 1)[-1] if token.startswith(b'-') and b'=' in token else token
                if token and not token.startswith(b'-') and b'/' in token:
                    arguments.append(os.path.normpath(os.path.join(cwd, token)))
            if any(cwd == root or cwd.startswith(root+b'/') or root in command
                   or any(arg == root or arg.startswith(root+b'/') for arg in arguments) for root in roots):
                found[item.name] = process_identity(item.name, proc)
        except FileNotFoundError:
            require(not item.exists(), 'process inventory raced ambiguously')
    return found


def configuration_inventory(paths, allow_links=False):
    """Exact cron/at/container configuration and unit-file inventory, not a boolean."""
    result = {}
    for name in paths:
        path = Path(name)
        require(path.is_absolute() and '..' not in path.parts, 'invalid inventory path')
        if not path.exists() and not path.is_symlink():
            result[name] = {'absent': True}
            continue
        require(not path.is_symlink(), 'inventory root symlink refused')
        entries = [path] if path.is_file() else [path, *sorted(path.rglob('*'))]
        for entry in entries:
            info = entry.lstat()
            if entry.is_symlink():
                require(allow_links, 'inventory symlink refused')
                resolved = entry.resolve(strict=True)
                if resolved == Path('/dev/null'):
                    result[str(entry)] = {'link': os.readlink(entry), 'masked': True}
                else:
                    require(resolved.is_file(), 'inventory directory link refused')
                    regular(resolved)
                    result[str(entry)] = {'link': os.readlink(entry), 'resolved': str(resolved), 'sha256': digest(resolved)}
                continue
            if entry.is_dir():
                result[str(entry)] = {'directory': True, 'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)}
            else:
                regular(entry)
                result[str(entry)] = {'sha256': digest(entry), 'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)}
    return result


class Host:
    def __init__(self, plan, control, run=None, proc=Path('/proc'), cgroup=Path('/sys/fs/cgroup')):
        self.plan = plan
        self.c = control
        self.uid = pwd.getpwnam('ubuntu').pw_uid
        self.run = run or self.command
        self.proc = proc
        self.cgroup = cgroup
        self.groups = {}
        self.captured = {}
        self.roots = [Path(plan[k]) for k in ('old', 'candidate', 'fallback')]
        aliases = plan.get('hostAcceptance', {}).get('launcherAliases', [])
        require(all(isinstance(name, str) and Path(name).is_absolute() and '..' not in Path(name).parts for name in aliases), 'invalid launcher alias')
        self.scan_roots = self.roots + [CURRENT] + [Path(name) for name in aliases]

    @staticmethod
    def command(args, *, env=None, cwd=None, timeout=30):
        # Diagnostics can contain private data. Never surface subprocess output.
        value = subprocess.run(args, env=env, cwd=cwd, timeout=timeout, capture_output=True, check=False)
        require(value.returncode == 0, 'bounded host command failed')
        require(len(value.stdout) <= 4*1024*1024, 'bounded host command output exceeded')
        return value.stdout.decode()

    def prefix(self, manager):
        require(manager in ('system', 'user'), 'unknown manager')
        return [] if manager == 'system' else ['runuser', '-u', 'ubuntu', '--', 'env',
                f'XDG_RUNTIME_DIR=/run/user/{self.uid}', f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{self.uid}/bus']

    def ctl(self, manager, *args):
        return self.run(self.prefix(manager)+['systemctl']+(['--user'] if manager == 'user' else [])+list(args))

    def show(self, manager, unit):
        require((manager, unit) in self.c.core.UNITS, 'unknown managed unit')
        return self.ctl(manager, 'show', unit, '--property='+','.join(SHOW))

    def service(self, manager, action, unit):
        require((manager, unit) in self.c.core.UNITS and
                (action == 'stop' or (manager, action, unit) == ('user', 'start', self.c.core.APP)), 'unsupported service action')
        self.ctl(manager, action, unit)

    def inventory(self):
        required = ['/etc/crontab', '/etc/cron.d', '/etc/cron.hourly', '/etc/cron.daily', '/etc/cron.weekly',
                    '/etc/cron.monthly', '/var/spool/cron', '/var/spool/at', '/etc/docker', '/etc/containers',
                    '/etc/systemd/system', '/run/systemd/system', '/usr/lib/systemd/system',
                    '/etc/systemd/user', '/run/systemd/user', '/usr/lib/systemd/user',
                    '/run/systemd/transient', '/run/systemd/system.control',
                    '/run/systemd/generator', '/run/systemd/generator.early', '/run/systemd/generator.late']
        managers = {'system': ['systemctl']}
        accounts = pwd.getpwall()
        for account in accounts:
            # All accounts with a home plus every extant user bus, not only ubuntu.
            home = Path(account.pw_dir)
            if home.is_absolute() and str(home) not in ('/', '/nonexistent'):
                required.extend(str(home/name) for name in ('.config/systemd/user', '.local/share/systemd/user'))
            runtime = Path('/run/user')/str(account.pw_uid)
            if (runtime/'bus').exists():
                require(re.fullmatch(r'[A-Za-z0-9_.-]+', account.pw_name), 'unsupported user-manager identity')
                managers['user:'+str(account.pw_uid)] = ['runuser', '-u', account.pw_name, '--', 'env',
                    'XDG_RUNTIME_DIR='+str(runtime), 'DBUS_SESSION_BUS_ADDRESS=unix:path='+str(runtime/'bus'),
                    'systemctl', '--user']
                required.extend(str(runtime/'systemd'/name) for name in
                    ('user', 'transient', 'user.control', 'generator', 'generator.early', 'generator.late'))
        require('user:'+str(self.uid) in managers, 'ubuntu user manager unavailable')
        configured = self.plan['hostAcceptance']['inventoryPaths']
        require(set(required).issubset(configured) and len(configured) == len(set(configured)), 'invoker inventory scopes incomplete')
        values = configuration_inventory(configured, allow_links=True)
        units = {}
        for manager, prefix in managers.items():
            installed = self.run(prefix+['list-unit-files', '--type=service,timer,socket,path', '--no-legend', '--no-pager', '--plain'])
            listing = self.run(prefix+['list-units', '--all', '--type=service,timer,socket,path', '--no-legend', '--no-pager', '--plain'])
            ids = []
            for line in listing.splitlines():
                name = line.split()[0]
                require(re.fullmatch(r'[A-Za-z0-9_.:@\\-]+\.(service|timer|socket|path)', name), 'ambiguous loaded unit identity')
                ids.append(name)
            require(len(ids) == len(set(ids)), 'duplicate loaded unit identity')
            loaded = ''
            if ids:
                loaded = self.run(prefix+['show', *sorted(ids), '--property=Id,FragmentPath,SourcePath,DropInPaths,Transient,NeedDaemonReload'])
                seen = set()
                for block in loaded.strip().split('\n\n'):
                    properties = self.c.core.parse_properties(block)
                    require(set(properties) == {'Id', 'FragmentPath', 'SourcePath', 'DropInPaths', 'Transient', 'NeedDaemonReload'}
                            and properties['Id'] in ids and properties['Id'] not in seen
                            and properties['NeedDaemonReload'] == 'no', 'loaded unit inventory incomplete or stale')
                    seen.add(properties['Id'])
                    # Sources outside standard paths must also be explicitly reviewed.
                    for name in [properties['FragmentPath'], properties['SourcePath'], *properties['DropInPaths'].split()]:
                        if name:
                            require(name in values, 'loaded source outside reviewed inventory')
                require(seen == set(ids), 'loaded unit listing incomplete')
            units[manager] = {'installed': installed, 'loaded': loaded}
        return {'files': values, 'unitFiles': units}

    def exclusion(self):
        acceptance = self.plan['hostAcceptance']
        receipt_path = Path(acceptance['exclusionReceipt'])
        protected(receipt_path, parents=True)
        require(digest(receipt_path) == acceptance['exclusionReceiptSha256'], 'invoker review receipt changed')
        receipt = read_json(receipt_path)
        require(set(receipt) == {'schema', 'hostMachineIdSha256', 'bootId', 'issuedAt', 'expiresAt', 'sourceContractSha256', 'inventorySha256', 'excludedInvokers', 'reviewReference'}, 'invoker receipt shape invalid')
        require(receipt['schema'] == 'bubblewash-host-invoker-review/v1'
                and receipt['hostMachineIdSha256'] == digest('/etc/machine-id')
                and receipt['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                and receipt['sourceContractSha256'] == self.plan['sourceContractSha256'], 'invoker receipt not bound to this host/boot/source')
        require(type(receipt['issuedAt']) is int and type(receipt['expiresAt']) is int
                and receipt['issuedAt'] <= time.time() < receipt['expiresAt']
                and 0 < receipt['expiresAt']-receipt['issuedAt'] <= 1800, 'invoker review expired or invalid')
        require(receipt['excludedInvokers'] == list(SCOPES)
                and re.fullmatch(r'[a-f0-9]{64}', receipt['reviewReference']), 'explicit bounded exclusion review missing')
        require(object_digest(self.inventory()) == receipt['inventorySha256'], 'launch inventory changed since review')
        return True

    def exec_start(self, manager, unit):
        require(unit != self.c.core.TIMER, 'timer has no service command')
        escaped = ''.join(ch if ch.isascii() and ch.isalnum() else '_'+format(ord(ch), '02x') for ch in unit)
        command = self.prefix(manager)+['busctl', '--system' if manager == 'system' else '--user',
            'get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1/unit/'+escaped,
            'org.freedesktop.systemd1.Service', 'ExecStart']
        tokens = shlex.split(self.run(command))
        require(len(tokens) >= 2 and tokens[0] == 'a(sasbttttuii)' and tokens[1].isdigit(), 'invalid service command property')
        count = int(tokens[1]); require(0 < count <= 8, 'unsupported service command count')
        offset = 2; result = []
        for _ in range(count):
            require(offset+2 <= len(tokens) and tokens[offset+1].isdigit(), 'truncated service command')
            executable = tokens[offset]; argc = int(tokens[offset+1]); offset += 2
            require(0 < argc <= 128 and offset+argc+8 <= len(tokens), 'truncated service argv')
            argv = tokens[offset:offset+argc]; offset += argc
            ignore = tokens[offset]; metadata = tokens[offset+1:offset+8]; offset += 8
            require(ignore in ('true', 'false') and len(metadata) == 7
                    and all(re.fullmatch(r'[0-9]+', value) for value in metadata[:5])
                    and all(re.fullmatch(r'-?[0-9]+', value) for value in metadata[5:]), 'malformed command execution metadata')
            require(Path(executable).is_absolute() and argv[0] == executable, 'ambiguous static service executable')
            result.append({'path': executable, 'argv': argv, 'ignoreFailure': ignore == 'true'})
        require(offset == len(tokens), 'trailing service command data')
        return result

    def loaded(self, state):
        mapping = {}
        for manager, unit in self.c.core.UNITS:
            entry = self.plan['units'][manager+'/'+unit]
            props = self.c.core.parse_properties(self.show(manager, unit))
            require(props.get('LoadState') == 'loaded', 'unit not loaded')
            expected = entry['properties']
            require(set(expected) == {'WorkingDirectory', 'EnvironmentFiles', 'User', 'Group', 'FragmentPath'}, 'unit contract incomplete')
            require(all(props.get(k) == v for k, v in expected.items()), 'effective unit identity changed')
            if unit != self.c.core.TIMER:
                require(self.exec_start(manager, unit) == entry['execStart'], 'loaded service executable or argv changed')
            require(set(entry['files']) == {expected['FragmentPath'], *entry['dropins']}, 'unit sources incomplete')
            for name, pin in entry['files'].items():
                owner = 0 if name in entry['dropins'] or manager == 'system' else entry['fragmentUid']
                require(owner in (0, self.uid), 'unsupported unit source owner')
                protected(name, owner=owner, parents=name in entry['dropins'])
                require(digest(name) == pin, 'loaded unit source changed')
            mapping[(manager, unit)] = entry['dropins']
        self.c.LoadedGates(state, self.c.SystemdReader(self.uid, self.run), mapping)()
        self.exclusion()
        return True

    def capture(self):
        self.captured = release_processes(self.scan_roots, self.proc)
        for manager, unit in self.c.core.UNITS:
            if unit == self.c.core.TIMER:
                continue
            props = self.c.core.parse_properties(self.show(manager, unit))
            configured = self.plan['units'][manager+'/'+unit]['cgroup']
            require(configured.startswith('/') and '..' not in Path(configured).parts, 'invalid cgroup contract')
            if props.get('ControlGroup'):
                require(props['ControlGroup'] == configured, 'cgroup identity differs')
            group = self.cgroup/configured.lstrip('/')
            require(not group.is_symlink() and group.resolve() == group and group.is_relative_to(self.cgroup), 'noncanonical cgroup')
            if group.exists():
                self.groups[group] = (group.stat().st_dev, group.stat().st_ino)
                for child in (group, *group.rglob('*')):
                    require(not child.is_symlink(), 'unsafe cgroup tree')
                    if child.is_dir():
                        for pid in (child/'cgroup.procs').read_text().split():
                            self.captured[pid] = process_identity(pid, self.proc)
            else:
                require(props.get('MainPID') == '0' and props.get('ControlPID') == '0', 'absent cgroup with process')
                self.groups[group] = (0, 0)  # If newly created/replaced, inspection rejects it.

    def quiet(self):
        require(not release_processes(self.scan_roots, self.proc), 'unmanaged release process remains')
        return self.c.core.inspect_quiescence(self.show, self.groups, self.roots, self.uid,
                 lambda: self.run(['ss', '-H', '-ltnp', 'sport = :3000']), self.captured, proc=self.proc)

    def node(self, target, args, database):
        node = self.plan['node']['path']
        protected(node, parents=True)
        require(digest(node) == self.plan['node']['sha256'], 'node runtime changed')
        environment = {'PATH': str(Path(node).parent)+':/usr/bin:/bin', 'HOME': '/home/ubuntu',
                       'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1',
                       'BUBBLEWASH_DATABASE_PATH': str(database), 'BUBBLEWASH_DISABLE_DEMO_LOGIN': 'true'}
        return self.run(['runuser', '-u', 'ubuntu', '--', node, '--conditions=react-server',
                         '--experimental-strip-types', *args], cwd=target, env=environment, timeout=90).strip()

    def migrate(self, database):
        def acknowledgement(raw):
            def unique(pairs):
                value = dict(pairs)
                require(len(value) == len(pairs), 'duplicate migration result key')
                return value
            # Canonical JSON distinguishes booleans from Python-equal 0/1.
            return canonical(json.loads(raw, object_pairs_hook=unique))

        # Both fixed entrypoints open only the existing database, never the
        # initializing application store. Label maps must commit first: the new
        # outbox preflight deliberately refuses a database missing those maps.
        # A failure between commits remains MIGRATING/held. Recovery does not
        # rerun this callback or restore a snapshot; completion needs separate
        # approval while all writer holds and the deployment lock remain held.
        result = self.node(Path(self.plan['candidate']), ['scripts/migrate-booking-references.mjs', '--database', str(database)], database)
        require(acknowledgement(result) == canonical({'ok': True, 'migration': 'permanent-booking-vendor-labels-v1', 'historicalBackfill': False}), 'label migration result uncertain')
        result = self.node(Path(self.plan['candidate']), ['scripts/migrate-notification-outbox.mjs', '--database', str(database)], database)
        require(acknowledgement(result) == canonical({'ok': True, 'migration': 'notification-outbox-exact-additive-v1'}), 'migration result uncertain')
        return True

    def verify_database(self, database):
        script = ("import Database from 'better-sqlite3';"
                  "import {databaseReadiness} from './src/lib/data-store.ts';"
                  "import {initializeStaffAccountsSchema} from './src/lib/staff-accounts.ts';"
                  "const db=new Database(process.env.BUBBLEWASH_DATABASE_PATH,{readonly:true,fileMustExist:true});"
                  "try{db.pragma('query_only=ON');if(!databaseReadiness(db,[initializeStaffAccountsSchema])||"
                  "!db.prepare('PRAGMA table_info(notification_outbox)').all().some(x=>x.name==='delivery_state'))"
                  "throw Error('schema');console.log('exact-additive-ready');}finally{db.close();}")
        return self.node(Path(self.plan['fallback']), ['--input-type=module', '-e', script], database) == 'exact-additive-ready'

    def completion_schema(self, database):
        # Readiness checks exact core/staff, label schema/high-water and one of
        # the two exact outbox schemas. A missing column alone is not evidence.
        script = ("import Database from 'better-sqlite3';"
                  "import {databaseReadiness} from './src/lib/data-store.ts';"
                  "import {initializeStaffAccountsSchema} from './src/lib/staff-accounts.ts';"
                  "const db=new Database(process.env.BUBBLEWASH_DATABASE_PATH,{readonly:true,fileMustExist:true});"
                  "try{db.pragma('query_only=ON');if(!databaseReadiness(db,[initializeStaffAccountsSchema]))"
                  "throw Error('schema');const complete=db.prepare('PRAGMA table_info(notification_outbox)').all()"
                  ".some(x=>x.name==='delivery_state');if(!complete){"
                  "for(const table of ['booking_references','vendor_codes']){"
                  "if(db.prepare('SELECT count(*) n FROM '+table).get().n!==0||"
                  "db.prepare('SELECT 1 FROM sqlite_sequence WHERE name=?').get(table))throw Error('consumed labels');}}"
                  "console.log(complete?'already-complete':'labels-only');}finally{db.close();}")
        result = self.node(Path(self.plan['candidate']), ['--input-type=module', '-e', script], database)
        require(result in ('labels-only', 'already-complete'), 'completion schema uncertain')
        return result

    def runtime_node(self):
        props = self.c.core.parse_properties(self.show('user', self.c.core.APP))
        pids = {props.get('MainPID')}
        listeners = self.run(['ss', '-H', '-ltnp', 'sport = :3000'])
        pids.update(re.findall(r'pid=(\d+)', listeners))
        require(len(pids) in (1, 2) and all(pid and pid.isdigit() and int(pid) > 1 for pid in pids), 'runtime process identity incomplete')
        for pid in pids:
            executable = (self.proc/pid/'exe').resolve(strict=True)
            require(str(executable) == self.plan['node']['path'] and digest(executable) == self.plan['node']['sha256'], 'running node executable differs')

    def readiness(self, target):
        values = self.c.guards_module().parse(ENV.read_bytes())
        # Token stays in memory and HTTP headers, not argv, output, or an artifact.
        token = values.get('BUBBLEWASH_MAINTENANCE_TOKEN')
        require(isinstance(token, str) and token and '\r' not in token and '\n' not in token, 'readiness authentication unavailable')
        for attempt in range(30):
            connection = http.client.HTTPConnection('127.0.0.1', 3000, timeout=3)
            try:
                self.c.guards_module().check_runtime(target, values)
                self.runtime_node()
                connection.request('GET', '/api/ready', headers={'Authorization': 'Bearer '+token})
                response = connection.getresponse()
                body = response.read(16385)
                require(len(body) <= 16384, 'readiness response too large')
                self.c.core.accept_readiness(response.status, {k.lower():v for k,v in response.getheaders()}, json.loads(body))
                self.c.guards_module().check_runtime(target, values)
                return True
            except (OSError, ValueError, http.client.HTTPException):
                if attempt == 29:
                    raise ValueError('exact authenticated readiness not accepted') from None
                time.sleep(1)
            finally:
                connection.close()
        return False


def validate_plan(plan, host=True):
    require(plan.get('schema') == 'bubblewash-integration-host-plan/v1' and plan.get('oldSha') == BASELINE, 'wrong integration baseline')
    require(plan.get('sourceContractSha256') == digest(HERE/'source-contracts.json'), 'source contract differs')
    contract = read_json(HERE/'source-contracts.json')
    require(set(plan['releaseShas']) == {'candidate', 'fallback'}, 'release pair incomplete')
    require(set(plan['releaseShas'].values()) and all(re.fullmatch('[a-f0-9]{40}', value or '') for value in plan['releaseShas'].values()), 'unmaterialized release SHA')
    require(plan['releaseShas']['candidate'] != plan['releaseShas']['fallback'], 'candidate and fallback commit must differ')
    require(plan['ownerContract']['evidenceSha256'] == plan['ownerEvidenceSha256'], 'owner evidence identity differs')
    protected(plan['ownerEvidencePath'], parents=host)
    require(digest(plan['ownerEvidencePath']) == plan['ownerEvidenceSha256'], 'owner review evidence changed')
    require(plan['ownerContract'].get('reviewed') is True and plan['ownerContract']['files'] == contract['ownerFiles'], 'owner reviewed source contract differs')
    for key, profile in zip(('candidate', 'fallback'), PROFILE_NAMES):
        root = Path(plan[key])
        if host:
            require(root.parent == RELEASES and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-'+plan['releaseShas'][key][:12], root.name), 'invalid installed release directory')
        verify_source(root, contract, profile)
        require(plan['dependencies'][key] == dependency_manifest(root/'node_modules'), 'installed dependency bytes changed')
        require(plan['gitBindings'][key]['commit'] == plan['releaseShas'][key]
                and re.fullmatch('[a-f0-9]{40}', plan['gitBindings'][key]['tree']), 'unmaterialized Git provenance')
        require((root/'.release-sha').read_text().strip() == plan['releaseShas'][key], 'release marker not bound to source commit')
        if host:
            for parent in (root, *root.parents):
                info = parent.lstat()
                require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'unprotected release launch ancestry')
            # Staging must freeze all code/dependencies; writable .next/cache is
            # deliberately outside the reviewed runtime and must be separate.
            for path in [root, *root.rglob('*')]:
                if path.relative_to(root).parts[:2] == ('.next', 'cache'):
                    continue
                info = path.lstat()
                if path.is_symlink():
                    require(path.is_relative_to(root/'node_modules') and path.resolve(strict=True).is_relative_to(root/'node_modules') and info.st_uid == 0, 'runtime symlink escapes frozen dependency tree')
                else:
                    require(info.st_uid == 0 and not info.st_mode & 0o022, 'runtime not frozen under root ownership')
    require(plan['adapterFiles'] == adapter_manifest(), 'adapter implementation changed')
    if host:
        require(os.geteuid() == 0, 'host execution requires root')
        require(plan['current'] == str(CURRENT) and plan['marker'] == str(RUNTIME/'current-release')
                and Path(plan['old']).parent == OLD_RELEASES and plan['state'] == str(STATE), 'host path binding differs')
        require(Path(plan['snapshot']).parent == RUNTIME and re.fullmatch(r'integration-snapshot-[a-f0-9]{16}\.sqlite', Path(plan['snapshot']).name), 'unsafe host snapshot destination')
    return True


def adapter_manifest():
    result = {}
    for path in HERE.rglob('*'):
        require(not path.is_symlink() and '__pycache__' not in path.parts and path.suffix != '.pyc', 'adapter cache or symlink rejected')
        if path.is_dir():
            continue
        regular(path)
        if path.name != 'source-contracts.json':
            result[path.relative_to(HERE).as_posix()] = digest(path)
    return result


def durable_plan(plan, control):
    """Stable journal identity; current expiring evidence is still verified each run.

    Renewing only a host/boot exclusion review or backup receipt must not make a
    crash journal unrecoverable. The full current host plan remains separately
    root-protected, digest-approved and validated under HostGuards every time.
    """
    immutable = ('schema', 'oldSha', 'old', 'candidate', 'fallback', 'current', 'marker', 'state',
                 'database', 'databaseIdentity', 'snapshot', 'releaseShas', 'manifests', 'dependencies',
                 'gitBindings', 'sourceContractSha256', 'adapterFiles', 'ownerContract',
                 'ownerEvidenceSha256', 'ownerEvidencePath', 'node', 'units')
    result = {name: copy.deepcopy(plan[name]) for name in immutable}
    result['guardIdentity'] = {name: plan['guards'][name] for name in ('envSha256', 'database')}
    result['invokerIdentity'] = {name: copy.deepcopy(plan['hostAcceptance'][name])
                                 for name in ('inventoryPaths', 'launcherAliases')}
    result['externalInvokersExcluded'] = True
    result['controllerPins'] = {str(Path(control.__file__).resolve()): digest(control.__file__),
                               str(Path(control.core.__file__).resolve()): digest(control.core.__file__),
                               **{str(HERE/name): pin for name,pin in plan['adapterFiles'].items()}}
    return result


def completion_confirmation(mode, confirmation, plan_sha256):
    if mode == 'complete-labels-only':
        require(isinstance(plan_sha256, str) and re.fullmatch('[a-f0-9]{64}', plan_sha256)
                and confirmation == 'complete-labels-only:' + plan_sha256,
                'explicit completion confirmation must match the reviewed full plan digest')
    else:
        require(not confirmation, 'completion confirmation is not valid for this mode')


def verify_completion_data(snapshot, database):
    """Compare all pre-existing data with the original snapshot, without exporting it."""
    excluded = {'booking_references', 'vendor_codes', 'sqlite_sequence'}
    def fingerprint(path, original):
        path = Path(path)
        require(path.is_absolute() and path.resolve(strict=True) == path
                and not any(char in str(path) for char in ('?', '#')), 'unsafe completion evidence path')
        info = regular(path)
        if original:
            require(info.st_uid == os.geteuid() and not info.st_mode & 0o077,
                    'snapshot evidence must remain private and controller-owned')
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        identity = tuple(getattr(info, field) for field in fields)
        before = digest(path)
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'completion evidence integrity failed')
            schema = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
            if original:
                require(not any(row[1] in excluded - {'sqlite_sequence'} or row[2] in excluded - {'sqlite_sequence'} for row in schema),
                        'original snapshot already contains label maps')
            sequence = [row for row in schema if row[1] == 'sqlite_sequence']
            require(not sequence or sequence == [('table', 'sqlite_sequence', 'sqlite_sequence', 'CREATE TABLE sqlite_sequence(name,seq)')],
                    'sequence schema differs')
            protected_schema = [row for row in schema if row[1] not in excluded and row[2] not in excluded]
            metadata = (db.execute('PRAGMA user_version').fetchone(), db.execute('PRAGMA application_id').fetchone())
            value = hashlib.sha256(repr((protected_schema, metadata)).encode())
            tables = {row[1]: row for row in db.execute('PRAGMA main.table_list') if row[0] == 'main'}
            for kind, name, _, _ in protected_schema:
                if kind != 'table': continue
                table = tables.get(name)
                require(table and table[2] == 'table' and table[4] in (0, 1), 'unsupported completion evidence table')
                quoted = '"' + name.replace('"', '""') + '"'
                columns = db.execute('PRAGMA main.table_xinfo(' + quoted + ')').fetchall()
                require(columns and len(columns) == table[3], 'incomplete completion evidence columns')
                selection = '*'
                if table[4] == 0:
                    names = {column[1].casefold() for column in columns}
                    alias = next((name for name in ('rowid', '_rowid_', 'oid') if name not in names), None)
                    require(alias is not None, 'completion rowid is shadowed')
                    selection = '"' + alias + '",*'
                rows = sorted(repr(row) for row in db.execute('SELECT ' + selection + ' FROM ' + quoted))
                value.update(name.encode() + b'\0' + '\n'.join(rows).encode())
            sequence_rows = db.execute('SELECT name,seq FROM sqlite_sequence ORDER BY name,seq').fetchall() if sequence else []
            require(not any(row[0] in ('booking_references', 'vendor_codes') for row in sequence_rows), 'label sequence was consumed')
            value.update(repr(sequence_rows).encode())
        require(tuple(getattr(regular(path), field) for field in fields) == identity and digest(path) == before,
                'completion evidence changed while reading')
        return value.digest()
    require(fingerprint(snapshot, True) == fingerprint(database, False), 'pre-existing data changed since the migration snapshot')
    return True


def complete_labels_only(control, host):
    """Called only inside the existing HostGuards lock after explicit confirmation."""
    state, plan = control.state, control.plan
    control.inhibit()
    try:
        record = state.read()
        require(isinstance(record, dict) and record.get('phase') in ('MIGRATING', 'MIGRATED')
                and canonical(record) == canonical({'schema': 1, 'phase': record['phase'], 'planHash': control.plan_hash, 'target': None})
                and state.journal.read_bytes() == json.dumps(record, sort_keys=True).encode(),
                'completion requires the same held migration journal')
        control.pins()
        old = Path(plan['old'])
        marker = f"sha={plan['oldSha']}\nrelease={old.name}\npath={old}\n".encode()
        def unchanged():
            control.pins()
            require(state.app_hold.exists() and state.maintenance_hold.exists(), 'completion holds missing')
            require(Path(plan['current']).resolve(strict=True) == old
                    and Path(plan['marker']).read_bytes() == marker, 'completion pointer or marker differs')
            require(control.quiescent() is True, 'completion quiescence lost')
        unchanged()
        database = Path(plan['database'])
        schema = host.completion_schema(database)
        if schema == 'already-complete':
            require(control.verify_database(database) is True, 'complete schema not accepted by fallback')
            unchanged()
            return 'already-complete-held-use-recover'
        require(record['phase'] == 'MIGRATING', 'MIGRATED journal requires a complete schema')
        verify_completion_data(Path(plan['snapshot']), database)
        unchanged()
        require(control.migrate(database) is True, 'completion migration uncertain')
        require(control.verify_database(database) is True, 'completion schema not accepted')
        unchanged()
        control.phase('MIGRATED')
        return 'migration-completed-held-use-recover'
    except BaseException:
        control.inhibit()
        raise


def run_plan(plan, mode, confirmation='', plan_sha256=None):
    require(mode in ('inspect', 'execute', 'recover', 'complete-labels-only'), 'unknown release mode')
    # Reject a missing/wrong confirmation before constructing state or stopping
    # anything. The confirmation is an input guard, not an approval receipt.
    completion_confirmation(mode, confirmation, plan_sha256)
    c = load_controller()
    state = c.DurableState(STATE)
    host = Host(plan, c)
    if mode in ('recover', 'complete-labels-only'):
        # Recovery first restores the installed holds under the shared lock,
        # even if a receipt expired or a runtime pin no longer matches. This
        # preliminary phase can only stop the three fixed existing units.
        with c.guards_module().deployment_lock(RUNTIME, host.uid):
            state.hold()
            failures = []
            for manager, unit in c.core.UNITS:
                try:
                    host.service(manager, 'stop', unit)
                except BaseException as error:
                    failures.append(error)
            require(not failures, 'recovery stop failed; durable holds retained')
    validate_plan(plan)
    values = c.guards_module().parse(ENV.read_bytes())
    require(values.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'false'
            and values.get('BUBBLEWASH_BOOKINGS_DISABLED') == 'true'
            and values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true'
            and values.get('NODE_ENV') in (None, 'production'), 'unsafe production configuration')
    for root in host.roots:
        require(not (root/'data/submissions.jsonl').exists(), 'legacy import file present')
    guard = c.HostGuards(RUNTIME, ENV, RECEIPT, plan['guards'], host.uid)
    with guard.locked() as verify_guard:
        def bound_guard():
            verify_guard()
            validate_plan(plan)
            return True
        bound_guard.database_path = verify_guard.database_path
        bound_guard.marker_path = verify_guard.marker_path
        host.loaded(state)
        host.capture()
        # Boolean is consumed only by the frozen controller, after this adapter's
        # concrete host/receipt verification. Caller cannot supply this shortcut.
        controller_plan = durable_plan(plan, c)
        control = c.Controller(controller_plan, state, bound_guard, host.service, host.quiet,
                               host.migrate, host.verify_database, host.readiness, lambda: host.loaded(state))
        if mode == 'inspect':
            control.pins()
            return 'inspected-no-host-state-changed'
        if mode == 'complete-labels-only':
            return complete_labels_only(control, host)
        return control.recover() if mode == 'recover' else control.execute()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--plan-sha256', required=True)
    parser.add_argument('--mode', choices=('inspect', 'execute', 'recover', 'complete-labels-only'), default='inspect')
    parser.add_argument('--completion-confirmation', default='')
    args = parser.parse_args()
    protected(args.plan, parents=True)
    require(re.fullmatch('[a-f0-9]{64}', args.plan_sha256) and digest(args.plan) == args.plan_sha256, 'exact reviewed plan digest required')
    completion_confirmation(args.mode, args.completion_confirmation, args.plan_sha256)
    plan = read_json(args.plan)
    # SIGTERM/HUP become controlled unwind; SIGKILL/reboot uses durable recovery.
    def interrupted(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    print(json.dumps({'ok': True, 'result': run_plan(plan, args.mode, args.completion_confirmation, args.plan_sha256), 'maintenanceResumed': False, 'databaseRestored': False}))

if __name__ == '__main__':
    sys.dont_write_bytecode = True
    try:
        main()
    except BaseException:
        print('Integration route stopped without acceptance. Inspect durable holds, journal and release pointer before retry; no automatic database restore.', file=sys.stderr)
        raise SystemExit(1)
