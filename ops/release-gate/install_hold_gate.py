#!/usr/bin/env python3
"""Reviewed pre-migration gate install/reversal. Default is read-only inspection.
No app/service restart, holds, release switch, environment content read or DB open.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import stat
import subprocess
import sys
import time
import uuid
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
STATE = '/var/lib/bubblewash-release'
APP = 'bubblewash-local.service'
UNITS = (('system', 'bubblewash-maintenance.timer'), ('system', 'bubblewash-maintenance.service'), ('user', APP))
FRAGMENTS = {unit: ('/home/ubuntu/.config/systemd/user/' if manager == 'user' else '/etc/systemd/system/') + unit for manager, unit in UNITS}
DROPINS = {unit: ('/etc/systemd/user/' if manager == 'user' else '/etc/systemd/system/') + unit + '.d/90-bubblewash-release-gate.conf' for manager, unit in UNITS}
SENTINEL = b'bubblewash-release-gate-v1\n'
PINS = {'app.conf': 'f41b345b8ab44f9673668a79d545d335f18bee21833f29d3aaf0a3078d7667ef',
        'maintenance.conf': 'c9f710fa7facbbcc088df492f38c62632a1c1b8e9dd3aef8ea21468bbaf631ee'}
COMMON = ('Id', 'Names', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'Transient')
SERVICE = ('MainPID', 'ControlPID', 'ControlGroup', 'WorkingDirectory', 'EnvironmentFiles', 'User', 'Group')
META = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def object_sha(value):
    return sha(canonical(value))


def properties(raw):
    result = {}
    for line in raw.splitlines():
        key, sep, value = line.partition('=')
        require(sep and key not in result, 'malformed manager properties')
        result[key] = value
    return result


def command(args):
    proc = subprocess.run(args, capture_output=True, timeout=30,
        env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
    require(proc.returncode == 0 and len(proc.stdout) <= 4*1024*1024, 'manager command failed')
    return proc.stdout.decode()


class Installer:
    # root/owner/run injection is for synthetic tests, never exposed by CLI.
    def __init__(self, root=Path('/'), owner=0, run=command, facts=None, accounts=None, evidence_sha256=None, payloads=None):
        self.root = root; self.owner = owner; self.run = run
        self.accounts = accounts if accounts is not None else pwd.getpwall()
        ubuntu = [account for account in self.accounts if account.pw_name == 'ubuntu']
        require(len(ubuntu) == 1, 'ubuntu account ambiguous')
        self.uid = ubuntu[0].pw_uid
        require(facts is not None, 'separately reviewed host evidence required')
        self.facts = facts; self.recovery = None; self.stage = 'INITIALIZE'
        self.evidence_sha256 = evidence_sha256 or object_sha(facts)
        self.payloads = payloads

    def path(self, absolute):
        return self.root / absolute.lstrip('/')

    def exists(self, absolute):
        return os.path.lexists(self.path(absolute))

    def metadata(self, absolute):
        value = self.path(absolute).lstat()
        return [getattr(value, field) for field in META]

    def parents(self, absolute):
        target = self.path(absolute)
        for parent in (target, *target.parents):
            value = parent.lstat()
            require(stat.S_ISDIR(value.st_mode) and value.st_uid == self.owner and
                    not value.st_mode & 0o022, 'unprotected install ancestry')
            if parent == self.root:
                break

    def read(self, absolute, owner=None, maximum=65536, _proc_boot=False):
        require(not _proc_boot or absolute == '/proc/sys/kernel/random/boot_id', 'unexpected virtual reader')
        target = self.path(absolute)
        require(target.resolve(strict=True) == target, 'noncanonical input')
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            value = os.fstat(fd)
            require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and
                    value.st_uid in ((self.owner,) if owner is None else (owner if isinstance(owner, tuple) else (owner,))) and
                    not value.st_mode & 0o022 and value.st_size <= maximum, 'unsafe input')
            chunks = []; size = 0
            while size <= maximum:
                chunk = os.read(fd, min(65536, maximum+1-size))
                if not chunk:
                    break
                chunks.append(chunk); size += len(chunk)
            raw = b''.join(chunks)
            require(len(raw) <= maximum and (_proc_boot or len(raw) == value.st_size) and all(getattr(check, key) == getattr(value, key)
                for check in (os.fstat(fd), target.stat()) for key in META), 'input changed')
            return raw
        finally:
            os.close(fd)

    def boot_id(self):
        value = self.read('/proc/sys/kernel/random/boot_id', maximum=128, _proc_boot=True).decode().strip()
        require(re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value),
                'invalid boot identity')
        return value

    def prefix(self, user=None):
        if user is None:
            return []
        account = next(x for x in self.accounts if x.pw_name == user)
        require(re.fullmatch(r'[A-Za-z0-9_.-]+', user), 'unsupported account identity')
        return ['runuser', '-u', user, '--', 'env', 'XDG_RUNTIME_DIR=/run/user/'+str(account.pw_uid),
                'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/'+str(account.pw_uid)+'/bus']

    def ctl(self, manager, *args):
        require(manager in ('system', 'user'), 'unexpected manager')
        return self.run(self.prefix('ubuntu' if manager == 'user' else None) + ['systemctl'] +
                        (['--user'] if manager == 'user' else []) + list(args))

    def typed(self, manager, unit, interface, prop):
        escaped = ''.join(ch if ch.isascii() and ch.isalnum() else '_'+format(ord(ch), '02x') for ch in unit)
        return shlex.split(self.run(self.prefix('ubuntu' if manager == 'user' else None) +
            ['busctl', '--user' if manager == 'user' else '--system', 'get-property',
             'org.freedesktop.systemd1', '/org/freedesktop/systemd1/unit/'+escaped,
             'org.freedesktop.systemd1.'+interface, prop]))

    def conditions(self, manager, unit):
        tokens = self.typed(manager, unit, 'Unit', 'Conditions')
        require(len(tokens) >= 2 and tokens[0] == 'a(sbbsi)' and tokens[1].isdigit(), 'invalid conditions')
        count = int(tokens[1]); require(count <= 128 and len(tokens) == 2+5*count, 'invalid condition count')
        result = []
        for index in range(2, len(tokens), 5):
            name, trigger, negate, parameter, state = tokens[index:index+5]
            require(trigger in ('false', 'true') and negate in ('false', 'true') and
                    re.fullmatch('-?[0-9]+', state), 'invalid condition structure')
            result.append([name, trigger == 'true', negate == 'true', parameter])
        return sorted(result)

    def exec_digest(self, manager, unit):
        tokens = self.typed(manager, unit, 'Service', 'ExecStart')
        require(len(tokens) >= 2 and tokens[0] == 'a(sasbttttuii)' and tokens[1].isdigit(), 'invalid command structure')
        count = int(tokens[1]); require(0 < count <= 8, 'invalid command count')
        offset = 2; rows = []
        for _ in range(count):
            require(offset+2 <= len(tokens) and tokens[offset+1].isdigit(), 'invalid command argc')
            executable = tokens[offset]; argc = int(tokens[offset+1]); offset += 2
            require(0 < argc <= 128 and offset+argc+8 <= len(tokens), 'invalid command argv')
            argv = tokens[offset:offset+argc]; offset += argc
            ignore = tokens[offset]; meta = tokens[offset+1:offset+8]; offset += 8
            require(ignore in ('false', 'true') and all(re.fullmatch('[0-9]+', x) for x in meta[:5]) and
                    all(re.fullmatch('-?[0-9]+', x) for x in meta[5:]) and
                    Path(executable).is_absolute() and argv[0] == executable, 'invalid command metadata')
            rows.append({'path': executable, 'argv': argv, 'ignoreFailure': ignore == 'true'})
        require(offset == len(tokens), 'trailing command metadata')
        return object_sha(rows)

    def payload(self, unit):
        name = 'app.conf' if unit == APP else 'maintenance.conf'
        raw = self.payloads[name] if self.payloads is not None else (HERE/name).read_bytes()
        require(sha(raw) == PINS[name], 'drop-in bytes changed')
        return raw

    def snapshot(self, installed):
        result = {}
        for manager, unit in UNITS:
            expected = self.facts['units'][manager+'/'+unit]
            keys = COMMON + (SERVICE if unit.endswith('.service') else ())
            value = properties(self.ctl(manager, 'show', unit, '--all', '--property='+','.join(keys)))
            require(set(value) == set(keys) and value['Id'] == value['Names'] == unit and
                    value['Transient'] == 'no' and value['LoadState'] == 'loaded' and
                    value['NeedDaemonReload'] == 'no', 'unit identity or reload contract differs')
            require(value['FragmentPath'] == FRAGMENTS[unit], 'unexpected unit fragment')
            sources = expected['sources']
            require(len(sources) == 1 and object_sha(FRAGMENTS[unit]) == sources[0]['pathSha256'], 'source evidence differs')
            require(sha(self.read(FRAGMENTS[unit], owner=self.uid if manager == 'user' else self.owner)) ==
                    sources[0]['sha256'], 'unit source changed')
            require(value['ActiveState'] == expected['ActiveState'] and value['SubState'] == expected['SubState'], 'unit state changed')
            wanted = []
            if installed:
                dropin = DROPINS[unit]
                self.parents(str(Path(dropin).parent))
                require(self.read(dropin) == self.payload(unit), 'installed gate changed')
                require(stat.S_IMODE(self.path(dropin).lstat().st_mode) == 0o644, 'gate mode differs')
                wanted = [['ConditionPathExists', False, False, STATE+'/installed-v1'],
                          ['ConditionPathExists', False, True, STATE+('/app-hold' if unit == APP else '/maintenance-hold')]]
            require(shlex.split(value['DropInPaths']) == ([DROPINS[unit]] if installed else []), 'effective drop-in set differs')
            require(self.conditions(manager, unit) == sorted(wanted), 'loaded Conditions differ')
            for key in ('WorkingDirectory', 'EnvironmentFiles', 'User', 'Group', 'ControlGroup'):
                if key in value:
                    require(object_sha(value[key]) == expected[key+'Sha256'], 'service identity changed')
            if unit.endswith('.service'):
                require(value['MainPID'].isdigit() and value['ControlPID'] == '0' and
                        int(value['MainPID']) == expected['MainPID'], 'service process changed')
                require(self.exec_digest(manager, unit) == expected['execStartSha256'], 'loaded executable changed')
            result[manager+'/'+unit] = {k: object_sha(v) for k, v in value.items() if k != 'DropInPaths'}
        binding = self.facts['binding']
        current = self.path('/home/ubuntu/bubblewash-pilot')
        require(current.is_symlink(), 'current is not a release pointer')
        resolved = current.resolve(strict=True)
        logical = '/'+str(resolved.relative_to(self.root)) if self.root != Path('/') else str(resolved)
        require(object_sha(logical) == binding['currentPathSha256'], 'current release changed')
        marker = self.read('/home/ubuntu/bubblewash-runtime/current-release', owner=(self.owner, self.uid))
        require(sha(marker) == binding['markerSha256'], 'release marker changed')
        # Metadata only: do not read environment credentials or any database bytes.
        env = '/home/ubuntu/.config/bubblewash/env'
        require(self.path(env).resolve(strict=True) == self.path(env), 'environment path changed')
        result['configMetadata'] = self.metadata(env)
        result['pointerMetadata'] = self.metadata('/home/ubuntu/bubblewash-pilot')
        result['markerMetadata'] = self.metadata('/home/ubuntu/bubblewash-runtime/current-release')
        result['bootId'] = self.boot_id()
        pid = self.facts['units']['user/'+APP]['MainPID']
        process = self.path('/proc/'+str(pid)+'/stat').read_text().rsplit(')', 1)[1].split()
        require(len(process) >= 20 and process[19].isdigit(), 'app process identity unavailable')
        result['appProcessStart'] = process[19]
        return result

    def scoped_user_collision_check(self, installed=False):
        # Exact same-name files/managers only. This is NOT an invoker-exclusion audit.
        paths = {'/etc/systemd/user', '/run/systemd/user', '/usr/local/lib/systemd/user',
                 '/usr/lib/systemd/user', '/lib/systemd/user', '/etc/xdg/systemd/user',
                 '/usr/local/share/systemd/user', '/usr/share/systemd/user'}
        for account in self.accounts:
            home = Path(account.pw_dir)
            if home.is_absolute() and str(home) not in ('/', '/nonexistent'):
                paths.update(str(home/part) for part in ('.config/systemd/user', '.config/systemd/user.control', '.local/share/systemd/user'))
            runtime = '/run/user/'+str(account.pw_uid)
            paths.update(runtime+'/systemd/'+part for part in
                ('user', 'user.control', 'transient', 'generator', 'generator.early', 'generator.late'))
            if self.exists(runtime+'/bus'):
                prefix = self.prefix(account.pw_name)+['systemctl', '--user']
                unit_paths = self.run(prefix+['show', '--property=UnitPath', '--value']).split()
                require(unit_paths and all(Path(p).is_absolute() for p in unit_paths), 'unknown user unit path')
                paths.update(unit_paths)
                if account.pw_name != 'ubuntu':
                    raw = properties(self.run(prefix+['show', APP, '--all', '--property=LoadState,FragmentPath,DropInPaths']))
                    require(set(raw) == {'LoadState', 'FragmentPath', 'DropInPaths'} and
                            raw['LoadState'] in (('not-found', 'bad-setting') if installed else ('not-found',)) and
                            raw['FragmentPath'] == '' and shlex.split(raw['DropInPaths']) in
                            ([[], [DROPINS[APP]]] if installed else [[]]), 'other user has same-name unit')
        require(self.exists('/run/user/'+str(self.uid)+'/bus'), 'ubuntu manager unavailable')
        for parent in paths:
            # Reading metadata does not load or reload another account's unit.
            if parent == '/home/ubuntu/.config/systemd/user':
                require(not self.exists(parent+'/'+APP+'.d'), 'ubuntu local drop-in collision')
                continue
            require(not self.exists(parent+'/'+APP), 'same-name global or other-user source exists')
            candidate = parent+'/'+APP+'.d'
            if candidate == str(Path(DROPINS[APP]).parent) and self.exists(STATE):
                continue
            require(not self.exists(candidate), 'same-name other-user drop-in exists')

    def clean_managers(self):
        # daemon-reload is manager-wide. Refuse any already-pending loaded-unit reload.
        for manager in ('system', 'user'):
            listing = self.ctl(manager, 'list-units', '--all', '--plain', '--no-legend', '--no-pager')
            ids = [line.split()[0] for line in listing.splitlines() if line.strip()]
            require(ids and len(ids) <= 10000 and len(ids) == len(set(ids)) and
                    all(re.fullmatch(r'[A-Za-z0-9_.:@\\-]+', name) for name in ids), 'ambiguous loaded unit inventory')
            seen = set()
            for start in range(0, len(ids), 100):
                raw = self.ctl(manager, 'show', '--all', '--property=Id,NeedDaemonReload', '--', *ids[start:start+100])
                for block in raw.strip().split('\n\n'):
                    row = properties(block)
                    require(set(row) == {'Id', 'NeedDaemonReload'} and row['Id'] in ids and
                            row['Id'] not in seen and row['NeedDaemonReload'] == 'no', 'unrelated pending manager reload')
                    seen.add(row['Id'])
            require(seen == set(ids), 'loaded unit inventory incomplete')

    @contextlib.contextmanager
    def lock(self):
        runtime = self.path('/home/ubuntu/bubblewash-runtime')
        require(runtime.resolve(strict=True) == runtime, 'noncanonical runtime')
        old = self.metadata('/home/ubuntu/bubblewash-runtime')
        value = runtime.lstat()
        require(stat.S_ISDIR(value.st_mode) and value.st_uid in (self.owner, self.uid) and not value.st_mode & 0o022, 'unsafe lock directory')
        path = runtime/'deploy.lock'
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid in (self.owner, self.uid) and
                    info.st_nlink == 1 and not info.st_mode & 0o022, 'unsafe shared lock')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def unchanged():
                current = path.lstat()
                require(self.metadata('/home/ubuntu/bubblewash-runtime')[:6] == old[:6] and
                        all(getattr(current, key) == getattr(info, key) for key in META) and
                        os.fstat(fd).st_nlink == 1, 'shared deployment lock changed')
            unchanged(); yield unchanged; unchanged()
        finally:
            os.close(fd)

    def sync(self, absolute):
        fd = os.open(self.path(absolute), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def mkdir(self, absolute, mode):
        self.parents(str(Path(absolute).parent))
        os.mkdir(self.path(absolute), mode)
        os.chown(self.path(absolute), self.owner, self.owner)
        os.chmod(self.path(absolute), mode)
        self.sync(str(Path(absolute).parent))

    def publish(self, absolute, raw, mode):
        parent = str(Path(absolute).parent); self.parents(parent)
        temporary = parent+'/.gate-staged-'+uuid.uuid4().hex
        fd = os.open(self.path(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        try:
            os.fchown(fd, self.owner, self.owner)
            os.fchmod(fd, mode)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(raw); stream.flush(); os.fsync(fd)
        finally:
            os.close(fd)
        # link is atomic no-clobber: complete bytes only; never replace a collision.
        os.link(self.path(temporary), self.path(absolute), follow_symlinks=False)
        self.path(temporary).unlink(); self.sync(parent)

    def reload(self):
        self.stage = 'SYSTEM_RELOAD'
        self.ctl('system', 'daemon-reload')
        self.stage = 'UBUNTU_RELOAD'
        self.ctl('user', 'daemon-reload')

    def preflight(self, installed=False):
        self.scoped_user_collision_check(installed); self.clean_managers()
        for parent in ('/var/lib', '/etc/systemd/system', '/etc/systemd/user'):
            self.parents(parent)
        require(len({self.metadata(parent)[0] for parent in
                    ('/var/lib', '/etc/systemd/system', '/etc/systemd/user')}) == 1,
                'reversal archive must share the target filesystem')
        if not installed:
            require(not self.exists(STATE), 'state directory collision')
            for name in DROPINS.values():
                require(not self.exists(str(Path(name).parent)), 'target drop-in directory collision')
        return self.snapshot(installed)

    def install(self, evidence_check=None):
        self.stage = 'LOCK'
        with self.lock() as unchanged:
            self.stage = 'EVIDENCE_RECHECK'
            if evidence_check is not None:
                evidence_check(unchanged)
            self.stage = 'PREFLIGHT'
            before = self.preflight(); unchanged()
            self.stage = 'STATE_CREATE'
            self.mkdir(STATE, 0o755)
            self.stage = 'SENTINEL_PUBLISH'
            self.publish(STATE+'/installed-v1', SENTINEL, 0o644)
            self.stage = 'RECEIPT_PUBLISH'
            self.publish(STATE+'/gate-installation.json', canonical({'schema': 'bubblewash-gate-installation/v1',
                'before': before, 'evidenceSha256': self.evidence_sha256, 'baselineEvidence': self.facts, 'issuedAt': int(time.time())}), 0o600)
            self.stage = 'DROPINS_PUBLISH'
            for _, unit in UNITS:
                self.mkdir(str(Path(DROPINS[unit]).parent), 0o755)
                self.publish(DROPINS[unit], self.payload(unit), 0o644)
            unchanged(); self.reload()
            self.stage = 'INSTALL_VERIFY'
            require(self.snapshot(True) == before, 'post-install preservation changed')
            unchanged()
        return {'installed': True, 'restarted': False, 'databaseOpened': False, 'releaseAcceptance': False}

    def reverse(self, evidence_check=None):
        self.stage = 'LOCK'
        with self.lock() as unchanged:
            self.stage = 'EVIDENCE_RECHECK'
            if evidence_check is not None:
                evidence_check(unchanged)
            self.stage = 'REVERSE_PREFLIGHT'
            self.parents(STATE)
            require(set(p.name for p in self.path(STATE).iterdir()) == {'installed-v1', 'gate-installation.json'},
                    'holds, transition or additional release state: reversal forbidden')
            require(self.read(STATE+'/installed-v1') == SENTINEL, 'sentinel changed')
            receipt = json.loads(self.read(STATE+'/gate-installation.json'))
            require(receipt['schema'] == 'bubblewash-gate-installation/v1' and
                    receipt['evidenceSha256'] == self.evidence_sha256 and
                    object_sha(receipt['baselineEvidence']) == self.evidence_sha256, 'installation receipt changed')
            before = self.preflight(installed=True)
            require(before == receipt['before'], 'pre-migration binding or process changed')
            for _, unit in UNITS:
                parent = self.path(str(Path(DROPINS[unit]).parent))
                require(set(p.name for p in parent.iterdir()) == {Path(DROPINS[unit]).name}, 'drop-in directory changed')
            unchanged()
            self.stage = 'REVERSAL_ARCHIVE'
            recovery = '/var/lib/bubblewash-gate-reversal-'+uuid.uuid4().hex
            self.mkdir(recovery, 0o700); self.recovery = recovery
            # Do not remove the sentinel until both managers have unloaded the gates.
            for _, unit in UNITS:
                parent = str(Path(DROPINS[unit]).parent)
                os.rename(self.path(parent), self.path(recovery+'/'+unit+'.d'))
                self.sync(str(Path(parent).parent)); self.sync(recovery)
            self.reload()
            self.stage = 'REVERSAL_VERIFY'
            require(self.snapshot(False) == before, 'post-reversal preservation changed')
            unchanged()
            require(set(p.name for p in self.path(STATE).iterdir()) == {'installed-v1', 'gate-installation.json'},
                    'release state appeared: retain sentinel')
            self.stage = 'STATE_ARCHIVE'
            os.rename(self.path(STATE), self.path(recovery+'/release-state'))
            self.sync('/var/lib'); self.sync(recovery)
        return {'reversed': True, 'restarted': False, 'databaseOpened': False, 'recoveryPath': recovery}


STAGES = frozenset(('INITIALIZE', 'EVIDENCE_INPUT', 'EVIDENCE_RECHECK', 'LOCK', 'PREFLIGHT', 'STATE_CREATE',
    'SENTINEL_PUBLISH', 'RECEIPT_PUBLISH', 'DROPINS_PUBLISH', 'SYSTEM_RELOAD', 'UBUNTU_RELOAD',
    'INSTALL_VERIFY', 'REVERSE_PREFLIGHT', 'REVERSAL_ARCHIVE', 'REVERSAL_VERIFY', 'STATE_ARCHIVE'))


def diagnostic(error, stage, action, recovery=None):
    category = ('MISSING' if isinstance(error, FileNotFoundError) else
                'COLLISION' if isinstance(error, FileExistsError) else
                'BUSY' if isinstance(error, BlockingIOError) else
                'PERMISSION' if isinstance(error, PermissionError) else
                'REFUSED' if isinstance(error, ValueError) else
                'TIMEOUT' if isinstance(error, subprocess.TimeoutExpired) else
                'OS_ERROR' if isinstance(error, OSError) else 'UNEXPECTED')
    return {'ok': False, 'stage': stage if stage in STAGES else 'INITIALIZE', 'category': category,
            'action': action, 'stateMayBePartial': action != 'inspect' and stage not in
            ('INITIALIZE', 'EVIDENCE_INPUT', 'EVIDENCE_RECHECK', 'LOCK', 'PREFLIGHT', 'REVERSE_PREFLIGHT'),
            'automaticRollback': False, 'recoveryPath': recovery}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('inspect', 'install', 'reverse-before-migration'), default='inspect')
    parser.add_argument('--evidence-sha256', required=True, help='Approved canonical JSON SHA-256 of private host evidence provided on stdin')
    args = parser.parse_args()
    installer = None; stage = 'INITIALIZE'
    try:
        require(os.geteuid() == 0 and os.getegid() == 0, 'root:root execution required')
        stage = 'EVIDENCE_INPUT'
        raw = sys.stdin.buffer.read(65537)
        require(len(raw) <= 65536 and re.fullmatch('[a-f0-9]{64}', args.evidence_sha256), 'private reviewed evidence differs')
        facts = json.loads(raw)
        require(object_sha(facts) == args.evidence_sha256, 'private reviewed evidence differs')
        require(facts['schema'] == 'bubblewash-bounded-host-evidence/v1' and
                facts['releaseAcceptance'] is False and facts['databaseOpened'] is False,
                'unsupported host evidence')
        installer = Installer(facts=facts, evidence_sha256=args.evidence_sha256)
        if args.action == 'install':
            result = installer.install()
        elif args.action == 'reverse-before-migration':
            result = installer.reverse()
        else:
            installer.stage = 'LOCK'
            with installer.lock():
                installer.stage = 'PREFLIGHT'; installer.preflight()
            result = {'preflight': True, 'changed': False, 'releaseAcceptance': False}
    except Exception as error:
        result = diagnostic(error, installer.stage if installer else stage, args.action,
                            installer.recovery if installer else None)
        print(json.dumps(result, sort_keys=True)); return 1
    print(json.dumps(result, sort_keys=True)); return 0


if __name__ == '__main__':
    sys.exit(main())
