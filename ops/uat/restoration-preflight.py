"""Local preparation: read-only validators for a future pinned UAT restoration receiver.

No host command runner, network client, dispatch, secret storage, or mutation entrypoint.
Inputs to pure validators MUST come from a reviewed read-only host collector, not
workflow assertions. Only fixed summaries may leave the confidential receiver.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import time

ORIGINAL_START = 1793056773802
WINDOW = 604800000
APP = '/opt/bubblewash-uat/app'
DATA = '/var/lib/bubblewash-uat'
DATABASE = DATA + '/uat.sqlite'
UNIT = '/etc/systemd/system/bubblewash-uat.service'
ENVIRONMENT = '/etc/bubblewash-uat/environment'
SERVICE = 'bubblewash-uat.service'
SCHEMA = {'staff_uat_accounts': "CREATE TABLE staff_uat_accounts (username TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','vendor','driver','support')), entity_id TEXT NOT NULL, password_hash TEXT NOT NULL, credential_version TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at - starts_at = 604800000), status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')), created_at INTEGER NOT NULL)", 'staff_uat_audit': 'CREATE TABLE staff_uat_audit (id TEXT PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, occurred_at INTEGER NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)'}
ROLES = {'admin', 'vendor', 'driver', 'support'}
PIN_FILES = {'src/lib/uat-environment.ts', 'src/lib/passwords.ts', 'src/lib/uat-accounts.ts',
             'src/lib/auth.ts', 'scripts/uat-account.mjs', 'scripts/uat-sealed-handover.mjs'}
EXPECTED_ENV = {
    'BUBBLEWASH_UAT_ENABLED':'true', 'BUBBLEWASH_UAT_ISOLATION_CONFIRMED':'true',
    'BUBBLEWASH_PUBLIC_URL':'https://uat.bubblewash.co', 'BUBBLEWASH_DATABASE_PATH':DATABASE,
    'BUBBLEWASH_UAT_DATA_ROOT':DATA, 'BUBBLEWASH_DATABASE_DRIVER':'sqlite',
    'BUBBLEWASH_DISABLE_DEMO_LOGIN':'true', 'BUBBLEWASH_STAFF_AUTH_DISABLED':'false',
    'BUBBLEWASH_BOOKINGS_DISABLED':'false', 'NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED':'false',
    'NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false', 'BUBBLEWASH_RESEARCH_EMAIL_ENABLED':'false',
    'BUBBLEWASH_TRUST_PROXY_HEADERS':'false', 'BUBBLEWASH_TRUST_EDGE_HEADERS':'false', 'NEXT_TELEMETRY_DISABLED':'1',
}
FORBIDDEN_ENV = {'PAYSTACK_SECRET_KEY', 'RESEND_API_KEY', 'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID', 'BUBBLEWASH_RESEARCH_RESEND_KEY', 'BUBBLEWASH_OWNER_RESEND_KEY',
    'NEXT_PUBLIC_BUBBLEWASH_WHATSAPP', 'NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL'}


def require(condition):
    if not condition:
        raise ValueError('UAT restoration preflight refused')


def parse_environment(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 16384)
    values = {}
    for row in raw.decode('utf-8').splitlines():
        key, separator, value = row.partition('=')
        require(separator and re.fullmatch('[A-Z][A-Z0-9_]*', key) and key not in values)
        values[key] = value
    return values


def verify_environment(file_raw, process_raw):
    configured = parse_environment(file_raw)
    require(set(configured) == set(EXPECTED_ENV) | {'BUBBLEWASH_SESSION_SECRET'})
    require(all(configured[k] == v for k, v in EXPECTED_ENV.items()))
    require(re.fullmatch('[A-Za-z0-9_-]{64}', configured['BUBBLEWASH_SESSION_SECRET']))
    require(isinstance(process_raw, bytes) and 0 < len(process_raw) <= 65536)
    # /proc/PID/environ is parsed privately; never return it or any value from it.
    require(process_raw.endswith(b'\0'))
    process = {}
    for entry in process_raw[:-1].split(b'\0'):
        require(entry and b'\n' not in entry and b'\r' not in entry)
        key, sep, value = entry.partition(b'=')
        require(sep and re.fullmatch(b'[A-Z][A-Z0-9_]*',key))
        key, value = key.decode('ascii'), value.decode('utf-8')
        require(key not in process)
        process[key] = value
    require(all(process.get(k) == v for k, v in configured.items()))
    require(process.get('NODE_ENV') == 'production' and process.get('HOME') == DATA)
    require(not (FORBIDDEN_ENV & process.keys()))
    inherited = {'NODE_ENV','HOME','PATH','USER','LOGNAME','LANG','LC_ALL','INVOCATION_ID',
                 'JOURNAL_STREAM','SYSTEMD_EXEC_PID','MEMORY_PRESSURE_WATCH','MEMORY_PRESSURE_WRITE'}
    require(set(process) <= set(configured) | inherited)
    require(not any(k not in configured for k in process if k.startswith(('BUBBLEWASH_', 'NEXT_PUBLIC_BUBBLEWASH_'))))
    require(not any(process.get(k) for k in ('NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH')))
    return {'configuredEnvironmentVerified': True, 'runningEnvironmentVerified': True, 'providerCredentialsAbsent': True}


def verify_runtime(app, unit, revision, pins, unit_pin):
    """Reads actual files. Caller must separately verify ancestry/ownership/mounts."""
    require(re.fullmatch('[a-f0-9]{40}', revision) and set(pins) == PIN_FILES)
    require(re.fullmatch('[a-f0-9]{64}', unit_pin))
    paths = {name: Path(app) / name for name in PIN_FILES}
    paths['SOURCE_REVISION'] = Path(app) / 'SOURCE_REVISION'
    paths['unit'] = Path(unit)
    for path in paths.values():
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1048576)
        require(path.resolve(strict=True) == path.absolute())
    require(paths['SOURCE_REVISION'].read_bytes() == (revision + '\n').encode())
    require(all(re.fullmatch('[a-f0-9]{64}', value) for value in pins.values()))
    require(all(hashlib.sha256(paths[name].read_bytes()).hexdigest() == value for name, value in pins.items()))
    require(hashlib.sha256(paths['unit'].read_bytes()).hexdigest() == unit_pin)
    return {'installedRuntimeVerified': True, 'runtimeRevision': revision, 'runtimeSourcesVerified': True, 'unitSourceVerified': True}


def verify_service(properties, process, uid, gid):
    """Compare fixed normalized `systemctl show` evidence and /proc evidence.

    The collector must parse systemd's set properties without accepting unknown
    syntax. Unknown serialization fails; do not silently weaken comparisons.
    """
    require(type(uid) is int and uid > 0 and type(gid) is int and gid > 0)
    expected = {'ActiveState':'active', 'SubState':'running', 'FragmentPath':UNIT,
        'DropInPaths':'', 'User':'bubblewash-uat', 'Group':'bubblewash-uat',
        'WorkingDirectory':APP, 'NoNewPrivileges':True, 'ProtectSystem':'strict',
        'ProtectHome':True, 'PrivateTmp':True, 'PrivateDevices':True,
        'ProtectKernelTunables':True, 'ProtectKernelModules':True, 'ProtectKernelLogs':True,
        'ProtectControlGroups':True, 'ProtectClock':True, 'RestrictSUIDSGID':True,
        'RestrictRealtime':True, 'LockPersonality':True, 'RestrictNamespaces':True,
        'CapabilityBoundingSet':[], 'AmbientCapabilities':[], 'ReadWritePaths':[DATA],
        'BindPaths':[[DATA+'/cache', APP+'/.next/cache']],
        'InaccessiblePaths':['/etc/bubblewash','/opt/bubblewash','/var/lib/bubblewash'],
        'RestrictAddressFamilies':['AF_INET','AF_INET6','AF_UNIX'],
        'IPAddressDeny':['0.0.0.0/0','::/0'], 'IPAddressAllow':['127.0.0.0/8','::1/128'],
        'SystemCallFilterDeny':['connect'], 'SystemCallErrorNumber':'EPERM',
        'SocketBindDeny':['any'], 'SocketBindAllow':['ipv4:tcp:3108'],
        'EnvironmentFiles':[ENVIRONMENT], 'UMask':'0077'}
    require(all(properties.get(k) == v for k, v in expected.items()))
    pid = properties.get('MainPID')
    require(type(pid) is int and pid > 1 and process.get('pid') == pid)
    require(process.get('uids') == [uid]*4 and process.get('gids') == [gid]*4 and process.get('groups') == [gid])
    require(process.get('cwd') == APP and process.get('executable') == '/usr/bin/node')
    require(process.get('NoNewPrivs') == 1 and process.get('Seccomp') == 2 and process.get('effectiveCapabilities') == 0)
    require(process.get('cgroup') == properties.get('ControlGroup') == '/system.slice/'+SERVICE)
    require(process.get('listeners') == [{'address':'127.0.0.1','port':3108,'pid':pid}])
    return {'runningServiceIdentityVerified':True, 'effectiveSandboxVerified':True, 'loopbackListenerVerified':True}


def mount_backing(path, mountinfo):
    """Map a real absolute path to (device, filesystem path), catching bind aliases."""
    require(isinstance(mountinfo, str) and len(mountinfo) <= 1048576)
    require(PurePosixPath(path).is_absolute() and '..' not in PurePosixPath(path).parts)
    candidates = []
    def unescape(value):
        # Kernel mountinfo uses these four escapes, not shell quoting.
        return re.sub(r'\\(040|011|012|134)', lambda m: chr(int(m[1], 8)), value)
    for line in mountinfo.splitlines():
        left, sep, right = line.partition(' - ')
        require(sep)
        fields, tail = left.split(), right.split()
        require(len(fields) >= 6 and len(tail) >= 3 and re.fullmatch(r'\d+:\d+', fields[2]))
        root, mountpoint = PurePosixPath(unescape(fields[3])), PurePosixPath(unescape(fields[4]))
        require(root.is_absolute() and mountpoint.is_absolute())
        try: relative = PurePosixPath(path).relative_to(mountpoint)
        except ValueError: continue
        # Overlay/union backing cannot be established from mountinfo alone.
        require(tail[0] not in ('overlay', 'aufs'))
        candidates.append((len(mountpoint.parts), fields[2], str(root / relative)))
    require(candidates)
    deepest = max(x[0] for x in candidates)
    matches = [x for x in candidates if x[0] == deepest]
    require(len(matches) == 1)
    return matches[0][1:]


def verify_storage_isolation(uat_paths, production_paths, host_mountinfo, service_mountinfo):
    """Paths are resolved privately from host config; no names/paths leave this function.

    Mapping checks supplement mandatory inode/ownership checks by the collector.
    Shared physical disks are allowed; shared underlying directories are not.
    """
    require(set(uat_paths) == {APP, DATA, DATABASE, ENVIRONMENT})
    require(len(production_paths) >= 3)
    # Include every descendant mount, not just the roots: bind aliases can hide below them.
    inspected = set(uat_paths) | {DATA+'/cache'}
    for raw in service_mountinfo.splitlines():
        fields = raw.partition(' - ')[0].split()
        require(len(fields) >= 6)
        point = fields[4]
        if any(point == root or point.startswith(root+'/') for root in (APP,DATA)):
            require('\\' not in point)
            inspected.add(point)
    cache = APP+'/.next/cache'
    require(mount_backing(cache, service_mountinfo) == mount_backing(DATA+'/cache', host_mountinfo))
    def overlaps(a, b):
        return a == b or a in b.parents or b in a.parents
    for uat in inspected:
        for production in production_paths:
            require(not overlaps(PurePosixPath(uat), PurePosixPath(production)))
            host_uat = mount_backing(uat, service_mountinfo)
            host_prod = mount_backing(production, host_mountinfo)
            if host_uat[0] == host_prod[0]:
                require(not overlaps(PurePosixPath(host_uat[1]), PurePosixPath(host_prod[1])))
        # The running namespace must expose the same UAT backing as the host.
        if uat != cache:
            require(mount_backing(uat, service_mountinfo) == mount_backing(uat, host_mountinfo))
    return {'mountBackingsIndependent':True, 'runningNamespaceStorageVerified':True}


def inspect_accounts(path, now_ms=None, require_eligible=True):
    """Open existing SQLite read-only, with WAL visibility and a consistent snapshot.

    Returns only fixed aggregate state. Never reads passwords/hashes/versions.
    No normal application imports, expiry housekeeping, migrations, or HTTP.
    """
    path = Path(path)
    require(path.is_absolute() and path.is_file() and not path.is_symlink() and path.resolve() == path)
    for suffix in ('-wal', '-shm'):
        require(not Path(str(path)+suffix).is_symlink())
    now_ms = int(time.time()*1000) if now_ms is None else now_ms
    db = sqlite3.connect(path.as_uri()+'?mode=ro', uri=True, timeout=2)
    try:
        db.execute('PRAGMA query_only=ON'); db.execute('PRAGMA trusted_schema=OFF'); db.execute('BEGIN')
        require(db.execute('PRAGMA query_only').fetchone() == (1,))
        require(db.execute('PRAGMA trusted_schema').fetchone() == (0,))
        for table in ('staff_uat_accounts','staff_uat_audit','vendor_availability','driver_availability'):
            require(db.execute("SELECT type FROM sqlite_master WHERE name=?",(table,)).fetchone() == ('table',))
        for table, expected in SCHEMA.items():
            require(db.execute('SELECT sql FROM sqlite_master WHERE name=?',(table,)).fetchone() == (expected,))
        require(not db.execute("SELECT 1 FROM sqlite_master WHERE (type='trigger' OR (type='index' AND sql IS NOT NULL)) AND tbl_name IN ('staff_uat_accounts','staff_uat_audit') LIMIT 1").fetchone())
        counts = dict(db.execute('SELECT status,COUNT(*) FROM staff_uat_accounts GROUP BY status').fetchall())
        require(set(counts) <= {'active','expired','revoked'} and sum(counts.values()) <= 1000)
        if not require_eligible:
            return {'readOnly':True,'totalAccountCount':sum(counts.values()),'revokedAccountCount':counts.get('revoked',0)}
        original = db.execute("SELECT username FROM staff_uat_audit WHERE action='created' AND actor='approved-uat-issuance' AND starts_at=? AND expires_at=? LIMIT 5",(ORIGINAL_START,ORIGINAL_START+WINDOW)).fetchall()
        require(len(original) == 4 and len({r[0] for r in original}) == 4)
        targets = []
        for (username,) in original:
            row = db.execute('SELECT role,entity_id,starts_at,expires_at,status FROM staff_uat_accounts WHERE username=?',(username,)).fetchone()
            require(row is not None)
            role, entity, start, end, status = row
            require(role in ROLES and status in ('active','expired') and start == ORIGINAL_START and end == start+WINDOW and now_ms >= end)
            require(not db.execute("SELECT 1 FROM staff_uat_audit WHERE username=? AND action IN ('revoked','restored-original-before','restored-original-after') LIMIT 1",(username,)).fetchone())
            if role in ('vendor','driver'):
                require(entity and db.execute('SELECT 1 FROM '+role+'_availability WHERE '+role+'_id=?',(entity,)).fetchone())
            else: require(not entity)
            targets.append(role)
        require(set(targets) == ROLES)
        return {'readOnly':True, 'originalCohortEligible':True, 'originalRoleCount':4,
                'totalAccountCount':sum(counts.values()), 'revokedAccountCount':counts.get('revoked',0)}
    finally:
        db.close()


if __name__ == '__main__':
    # Deliberately not a live host collector or an execution route.
    print(json.dumps({'ok':False,'readOnly':True,'collectorImplemented':False,'automaticRetry':False}))
    raise SystemExit(1)
