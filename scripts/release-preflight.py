#!/usr/bin/env python3
"""Aggregate-only host inspection. Never source env files or import app code."""
import base64
import datetime
import json
import hashlib
from pathlib import Path
import posixpath
import pwd
import re
from urllib.parse import quote
import sqlite3
import subprocess

HOME = Path('/home/ubuntu')
CURRENT = HOME / 'bubblewash-pilot'
ENV_FILE = HOME / '.config/bubblewash/env'
TABLES = frozenset('payment_initialization_locks customer_recovery delivery_proofs driver_live_locations workflow_action_claims payment_verifications notification_outbox privacy_requests early_access_signups rate_limits submissions vendor_availability driver_availability vendor_declines assignment_capacity_reservations order_route_fees booking_requests order_holds order_invoices account_service_fees billing_entries staff_credential_overrides admin_mfa_settings admin_mfa_recovery_codes admin_recovery_tokens mfa_replay_guard production_resets production_roster_resets staff_accounts staff_owner_capabilities'.split())

def bounded_text(path):
    with Path(path).open('rb') as handle:
        raw = handle.read(65537)
    if len(raw) > 65536:
        raise ValueError('unsupported input')
    return raw.decode('utf8')

def parse_env(text):
    result = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(('#', ';')):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if not match or match[1] in result:
            raise ValueError('unsupported environment syntax')
        value = match[2].strip()
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError('unsupported environment syntax')
            value = value[1:-1]
        if any(c in value for c in '\\"\'`\x00\r\n'):
            raise ValueError('unsupported environment syntax')
        result[match[1]] = value
    return result

def key_valid(value):
    try:
        return len(base64.b64decode(value, validate=True)) == 32
    except (ValueError, TypeError):
        return False

def configuration(env):
    paths = ['DATABASE_PATH', 'BACKUP_PRIMARY_DIR', 'BACKUP_OFFSITE_DIR', 'BACKUP_STATUS_PATH']
    primary = env.get('BUBBLEWASH_BACKUP_PRIMARY_DIR', '')
    offsite = env.get('BUBBLEWASH_BACKUP_OFFSITE_DIR', '')
    return {
        'productionMode': env.get('NODE_ENV') == 'production',
        'demoDisabled': env.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true' and env.get('BUBBLEWASH_ENABLE_DEMO_LOGIN') != 'true',
        'sqliteConfigured': env.get('BUBBLEWASH_DATABASE_DRIVER') == 'sqlite',
        'sessionSecretLengthValid': len(env.get('BUBBLEWASH_SESSION_SECRET', '')) >= 32,
        'backupKeyFormatValid': key_valid(env.get('BUBBLEWASH_BACKUP_ENCRYPTION_KEY')),
        'mfaKeyFormatValid': key_valid(env.get('BUBBLEWASH_MFA_ENCRYPTION_KEY')),
        'mfaRequired': env.get('BUBBLEWASH_ADMIN_MFA_REQUIRED') == 'true',
        'staffAuthDisabled': env.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'true',
        'maintenanceTokenPresent': bool(env.get('BUBBLEWASH_MAINTENANCE_TOKEN')),
        'absoluteRequiredPaths': all(Path(env.get('BUBBLEWASH_' + key, '')).is_absolute() for key in paths),
        # Match the backup command's POSIX path.resolve check, without accessing
        # the filesystem. This does not prove independent physical storage.
        'distinctBackupPaths': Path(primary).is_absolute() and Path(offsite).is_absolute() and posixpath.normpath('/' + primary.lstrip('/')) != posixpath.normpath('/' + offsite.lstrip('/')),
        'legacyWorkerCredentialsAbsent': not any(env.get(f'BUBBLEWASH_{role}_{field}') for role in ('VENDOR', 'DRIVER', 'SUPPORT') for field in ('EMAIL', 'PASSWORD', 'PASSWORD_HASH', 'ENTITY_ID')),
    }

def database_report(database_path):
    target = Path(database_path)
    if not target.is_absolute() or target.is_symlink() or not target.is_file():
        return {'inspected': False, 'unsupportedPath': True}
    with target.open('rb') as handle:
        header = handle.read(100)
    if len(header) != 100 or not header.startswith(b'SQLite format 3\x00'):
        return {'inspected': False, 'unsupportedFormat': True}
    # mode=ro can create WAL shared-memory files. Never use immutable=1 on a
    # running database: that would ignore committed WAL data and misreport it.
    if header[18] == 2 or header[19] == 2 or Path(str(target) + '-wal').exists() or Path(str(target) + '-journal').exists():
        return {'inspected': False, 'journalModeRequiresSeparateSafeInspection': True}
    # Host-memory diagnostic only: never connect SQLite to the live source.
    if target.stat().st_size > 64 * 1024 * 1024:
        return {'inspected': False, 'databaseExceedsInspectionBound': True}
    with target.open('rb') as handle:
        content = handle.read(64 * 1024 * 1024 + 1)
    with target.open('rb') as handle:
        repeated = handle.read(64 * 1024 * 1024 + 1)
    if len(content) > 64 * 1024 * 1024 or content != repeated or Path(str(target) + '-wal').exists() or Path(str(target) + '-journal').exists() or content[18:20] != b'\x01\x01':
        return {'inspected': False, 'databaseChangedDuringInspection': True}
    if not hasattr(sqlite3.Connection, 'deserialize'):
        return {'inspected': False, 'inMemoryInspectionUnsupported': True}
    connection = sqlite3.connect(':memory:')
    try:
        connection.deserialize(content)
        connection.execute('PRAGMA temp_store = MEMORY')
        connection.execute('PRAGMA trusted_schema = OFF')
        connection.execute('PRAGMA query_only = ON')
        connection.execute('BEGIN')
        schema = connection.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
        tables = [name for kind, name in schema if kind == 'table']
        unknown = sum(name not in TABLES for name in tables)
        report = {'inspected': True, 'diagnosticOnlyNotTransactionalInventory': True, 'tableCount': len(tables), 'unknownTableCount': unknown, 'viewsOrTriggers': sum(kind in ('view', 'trigger') for kind, _ in schema)}
        if unknown or report['viewsOrTriggers']:
            report['inventoryBlockedBySchema'] = True
            return report
        # No arbitrary identifiers or database values ever reach the output.
        report['knownTableCounts'] = {name: connection.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for name in sorted(tables)}
        report['integrityOk'] = connection.execute('PRAGMA quick_check').fetchall() == [('ok',)]
        if 'staff_accounts' in tables:
            report['adminCount'] = connection.execute("SELECT count(*) FROM staff_accounts WHERE role='admin'").fetchone()[0]
            report['nonadminCount'] = connection.execute("SELECT count(*) FROM staff_accounts WHERE role!='admin' OR role IS NULL").fetchone()[0]
        return report
    finally:
        connection.close()

def owner_database_report(database_path, email, env):
    target = Path(database_path)
    if not target.is_absolute() or target.is_symlink() or not target.is_file():
        return {'inspected': False, 'unsupportedPath': True}
    # Read committed WAL state correctly. Never immutable=1, app imports, or DDL.
    # SQLite may maintain -shm bookkeeping; no account/database data is written.
    connection = sqlite3.connect('file:' + quote(str(target), safe='/') + '?mode=ro', uri=True, timeout=5)
    try:
        connection.execute('PRAGMA query_only = ON')
        connection.execute('PRAGMA trusted_schema = OFF')
        connection.execute('PRAGMA temp_store = MEMORY')
        connection.execute('BEGIN')
        schema = connection.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
        tables = [name for kind, name in schema if kind == 'table']
        if any(name not in TABLES for name in tables) or any(kind in ('view', 'trigger') for kind, _ in schema):
            return {'inspected': False, 'unsupportedSchema': True}
        return {**owner_collision_report(connection, tables, email, env), 'walAwareReadTransaction': True,
                'sqliteSharedMemoryBookkeepingPossible': True, 'accountDataWritten': False}
    finally:
        connection.close()


def owner_collision_report(connection, tables, email, env):
    required_tables = {name: name in tables for name in ('staff_accounts', 'staff_credential_overrides', 'submissions')}
    if not all(required_tables.values()):
        return {'inspected': False, 'requiredSchemaMissing': True, 'requiredTablePresence': required_tables,
                'collisionInspectionBlockedReason': 'required-schema-not-present-no-initialization-performed'}
    types = []
    if any(env.get('BUBBLEWASH_' + role + '_EMAIL', '').strip().lower() == email for role in ('ADMIN', 'VENDOR', 'DRIVER', 'SUPPORT')):
        types.append('configured')
    if connection.execute('SELECT 1 FROM staff_credential_overrides WHERE lower(trim(login)) = ?', (email,)).fetchone():
        types.append('master')
    account = connection.execute('SELECT role, status FROM staff_accounts WHERE lower(trim(email)) = ?', (email,)).fetchone()
    if account:
        types.append('managed')
    roster = connection.execute("SELECT 1 FROM submissions WHERE json_extract(data, '$.submissionType') IN ('staff-onboarding', 'vendor-application', 'driver-onboarding') AND (lower(trim(json_extract(data, '$.email'))) = ? OR lower(trim(json_extract(data, '$.staffEmail'))) = ?) LIMIT 1", (email, email)).fetchone()
    if roster:
        types.append('roster')
    return {'inspected': True, 'requiredTablePresence': required_tables, 'duplicatePresent': bool(types), 'duplicateTypes': types,
            'managedRole': account[0] if account and account[0] in ('admin', 'vendor', 'driver', 'support') else 'unknown' if account else None,
            'managedStatus': account[1] if account and account[1] in ('active', 'invited', 'suspended') else 'unknown' if account else None}


def owner_delivery_configuration(env):
    sender = env.get('BUBBLEWASH_EMAIL_FROM', '').strip()
    # Never emit arbitrary environment values. Identify only the known public
    # sender; another sender must be reviewed privately before any delivery.
    sender_category = 'updates@bubblewash.co' if sender in ('updates@bubblewash.co', 'Bubble Wash <updates@bubblewash.co>') else 'other-official-domain' if re.fullmatch(r'(?:[^<>\r\n]+<[^<>@\s]+@bubblewash\.co>|[^<>@\s]+@bubblewash\.co)', sender) else 'missing-or-invalid'
    raw = env.get('BUBBLEWASH_MFA_ENCRYPTION_KEY', '').strip()
    try:
        key = base64.b64decode(raw + '=' * (-len(raw) % 4), validate=True)
        mfa_key_ready = len(key) == 32 and base64.b64encode(key).decode().rstrip('=') == raw.rstrip('=')
    except (ValueError, TypeError):
        mfa_key_ready = False
    return {'transportScope': 'shared-application-only', 'privateOwnerTransportInspected': False,
            'resendConfigured': bool(env.get('RESEND_API_KEY')), 'configuredSenderCategory': sender_category,
            'mfaRequired': env.get('BUBBLEWASH_ADMIN_MFA_REQUIRED') == 'true',
            'personalMfaKeyReady': mfa_key_ready, 'providerCredentialValidated': False, 'emailSent': False}


def release_pin_matches(expected):
    if not re.fullmatch('[0-9a-f]{40}', expected):
        return False
    try:
        marker = parse_env(bounded_text(HOME / 'bubblewash-runtime/current-release'))
        return marker.get('sha') == expected and Path(marker.get('path', '/nonexistent')).resolve(strict=True) == CURRENT.resolve(strict=True)
    except Exception:
        return False


def command(args, env=None):
    return subprocess.run(args, env=env, check=True, text=True, capture_output=True, timeout=10).stdout

def unit_report(unit, user=False):
    args = ['systemctl', *(['--user'] if user else []), 'show', unit, '--property=LoadState,ActiveState,SubState,MainPID,WorkingDirectory,EnvironmentFiles']
    if user:
        uid = pwd.getpwnam('ubuntu').pw_uid
        args = ['runuser', '-u', 'ubuntu', '--', 'env', f'XDG_RUNTIME_DIR=/run/user/{uid}', f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus', *args]
    values = dict(line.split('=', 1) for line in command(args).splitlines() if '=' in line)
    result = {'loaded': values.get('LoadState') == 'loaded', 'active': values.get('ActiveState') == 'active', 'fullyStopped': values.get('ActiveState') == 'inactive' and values.get('SubState') == 'dead' and values.get('MainPID', '0') == '0'}
    if unit.endswith('.service'):
        result['workingDirectoryMatchesCurrent'] = Path(values.get('WorkingDirectory', '/nonexistent')).resolve() == CURRENT.resolve()
        result['environmentFileMatchesExpected'] = values.get('EnvironmentFiles') == f'{ENV_FILE} (ignore_errors=no)'
    return result

def status_metadata_valid(value):
    try:
        values = [value[key] for key in ('createdAt', 'restoreVerifiedAt', 'offsiteStoredAt')]
        # Accept explicit-offset calendar timestamps, not Python-only ISO forms
        # such as week dates that the application's Date parser rejects.
        if not all(isinstance(stamp, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)', stamp) for stamp in values):
            return False
        stamps = [datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')) for stamp in values]
        return value.get('ok') is True and stamps[0] <= stamps[1] <= stamps[2]
    except (KeyError, TypeError, ValueError, AttributeError):
        return False

def backup_report(status_path):
    result = {}
    for label, file in [('status', status_path), ('receipt', HOME / 'bubblewash-backups/offhost-release.json')]:
        try:
            value = json.loads(bounded_text(file))
            stamp = value.get('createdAt' if label == 'status' else 'verifiedAt', '')
            age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))).total_seconds()
            result[label + 'AgeWithin30Hours'] = 0 <= age <= 30 * 3600
            result[label + 'MetadataValid'] = status_metadata_valid(value) if label == 'status' else (value.get('schema') == 'becore-encrypted-backup-release/v2' and value.get('storageRepository') == 'bechirobob/becore-backups' and value.get('repository') == 'bechirobob/bubble-wash' and all(value.get(k) is True for k in ('encrypted', 'restoreTested', 'downloadVerified')))
        except Exception:
            result[label + 'Readable'] = False
    return result

# Only operational flags are retained from /proc; never emit process environment.
LOGIN_FLAGS = ('BUBBLEWASH_STAFF_AUTH_DISABLED', 'BUBBLEWASH_BOOKINGS_DISABLED',
               'BUBBLEWASH_DISABLE_DEMO_LOGIN', 'BUBBLEWASH_ENABLE_DEMO_LOGIN',
               'BUBBLEWASH_ADMIN_MFA_REQUIRED', 'NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED')
PROC = Path('/proc')
RESTORE_FILES = ('src/app/api/health/route.ts', 'src/lib/auth.ts',
                 'src/lib/booking-policy.ts', '.next/BUILD_ID')


def flag_state(value):
    return 'absent' if value is None else value if value in ('true', 'false') else 'other'


def operational_flags(env):
    return {'productionMode': env.get('NODE_ENV') == 'production',
            'productionModePresent': 'NODE_ENV' in env,
            **{name: flag_state(env.get(name)) for name in LOGIN_FLAGS}}


def bounded_bytes(path, limit):
    with Path(path).open('rb') as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('unsupported input')
    return raw


def process_identity(pid):
    raw = bounded_bytes(PROC / str(pid) / 'stat', 65536)
    # Only PID and start ticks identify the same process; CPU counters change.
    head, tail = raw.rsplit(b')', 1)
    return head.split(b' ', 1)[0], tail.split()[19]


def runtime_flags(pid):
    # /proc exposes the environment as a single record; discard all keys except
    # this fixed noncredential allowlist before comparison or reporting.
    raw = bounded_bytes(PROC / str(pid) / 'environ', 1024 * 1024)
    allowed = {key.encode() for key in (*LOGIN_FLAGS, 'NODE_ENV')}
    values = {}
    for entry in raw.split(b'\0'):
        key, sep, value = entry.partition(b'=')
        if sep and key in allowed:
            if key.decode() in values:
                raise ValueError('duplicate runtime flag')
            values[key.decode()] = value.decode()
    return values


def release_login_inspection(env):
    result = {'readOnly': True, 'configuredFlags': operational_flags(env),
              'sourceToBuildProven': False, 'bookingPolicySemanticsProven': False,
              'fullRuntimeEnvironmentCompared': False, 'interactiveLoginProven': False}
    target = CURRENT.resolve(strict=True)
    marker_path = HOME / 'bubblewash-runtime/current-release'
    try:
        raw_marker = bounded_bytes(marker_path, 65536)
        marker = parse_env(raw_marker.decode())
        valid = bool(re.fullmatch('[0-9a-f]{40}', marker.get('sha', '')))
        result['releaseMarker'] = {'shaValid': valid,
                                  'pathMatchesCurrent': Path(marker.get('path', '/nonexistent')).resolve() == target,
                                  'stableDuringRead': raw_marker == bounded_bytes(marker_path, 65536)}
        if valid:
            result['releaseMarker']['sha'] = marker['sha']
    except Exception:
        result['releaseMarker'] = {'inspectionSupported': False}
    hashes = {}
    digest = hashlib.sha256()
    stable = True
    for name in RESTORE_FILES:
        try:
            path = target / name
            if path.is_symlink() or not path.is_file():
                raise ValueError('unsupported source')
            raw = bounded_bytes(path, 262144)
            stable = stable and raw == bounded_bytes(path, 262144)
            hashes[name] = hashlib.sha256(raw).hexdigest()
            if name == '.next/BUILD_ID' and re.fullmatch(rb'[A-Za-z0-9_-]{1,128}\n?', raw):
                result['buildId'] = raw.decode().strip()
            digest.update(name.encode() + b'\0' + raw + b'\0')
        except Exception:
            hashes[name] = None
    result['sourceFileSha256'] = hashes
    result['sourceFilesStableDuringRead'] = stable and all(hashes.values())
    if result['sourceFilesStableDuringRead']:
        result['restorationSourceFingerprint'] = digest.hexdigest()
    try:
        uid = pwd.getpwnam('ubuntu').pw_uid
        args = ['runuser', '-u', 'ubuntu', '--', 'env', f'XDG_RUNTIME_DIR=/run/user/{uid}', f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus', 'systemctl', '--user', 'show', 'bubblewash-local.service', '--property=LoadState,ActiveState,MainPID,WorkingDirectory,EnvironmentFiles']
        unit = dict(line.split('=', 1) for line in command(args).splitlines() if '=' in line)
        pid = int(unit.get('MainPID', '0'))
        if pid <= 1:
            raise ValueError('inactive process')
        before = process_identity(pid)
        main = runtime_flags(pid)
        listener_pids = set(re.findall(r'pid=(\d+)', command(['ss', '-H', '-ltnp', 'sport = :3000'])))
        result['runtime'] = {'serviceActive': unit.get('LoadState') == 'loaded' and unit.get('ActiveState') == 'active',
                             'workingDirectoryMatchesCurrent': Path(unit.get('WorkingDirectory', '/nonexistent')).resolve() == target,
                             'environmentFileMatchesExpected': unit.get('EnvironmentFiles') == f'{ENV_FILE} (ignore_errors=no)',
                             'mainProcessDirectoryMatchesCurrent': (PROC / str(pid) / 'cwd').resolve() == target,
                             'mainProcessFlags': operational_flags(main),
                             'mainFlagsMatchConfiguration': all(main.get(k) == env.get(k) for k in (*LOGIN_FLAGS, 'NODE_ENV')),
                             'uniqueListener': len(listener_pids) == 1}
        if len(listener_pids) == 1:
            listener = int(next(iter(listener_pids)))
            listener_before = process_identity(listener)
            effective = runtime_flags(listener)
            result['runtime'].update({
                'listenerDirectoryMatchesCurrent': (PROC / str(listener) / 'cwd').resolve() == target,
                'listenerIsNode': (PROC / str(listener) / 'exe').resolve().name == 'node',
                'listenerSameServiceCgroup': bounded_bytes(PROC / str(listener) / 'cgroup', 65536) == bounded_bytes(PROC / str(pid) / 'cgroup', 65536),
                'listenerFlags': operational_flags(effective),
                'listenerFlagsMatchConfiguration': all(effective.get(k) == env.get(k) for k in (*LOGIN_FLAGS, 'NODE_ENV')),
                'listenerStableDuringRead': listener_before == process_identity(listener)})
        result['runtime']['mainStableDuringRead'] = before == process_identity(pid)
        result['currentTargetStableDuringRead'] = CURRENT.resolve(strict=True) == target
    except Exception:
        result['runtime'] = {'inspectionSupported': False}
    return result


def collect(owner_email="", expected_live_sha=""):
    result = {'readOnlyIntent': True, 'resetExecuted': False, 'backupCreated': False,
              'limits': {'interactiveOwnerLoginProven': False, 'interactiveMfaProven': False, 'allWritersIdentified': False, 'ingressMaintenanceProven': False, 'privateDestinationWriteAccessProven': False, 'effectiveRuntimeEnvironmentProven': False}}
    if owner_email:
        owner_email = owner_email.strip().lower()
        if len(owner_email) > 160 or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', owner_email) or not release_pin_matches(expected_live_sha):
            return {**result, 'ownerInspection': {'completed': False, 'releasePinOrPrivateInputInvalid': True}}
    try:
        env = parse_env(bounded_text(ENV_FILE))
    except Exception:
        return {**result, 'environmentInspectionSupported': False}
    result['environmentInspectionSupported'] = True
    result['configuration'] = configuration(env)
    try:
        result['staffRestorationInspection'] = release_login_inspection(env)
    except Exception:
        result['staffRestorationInspection'] = {'inspectionSupported': False}
    result['currentReleaseExists'] = CURRENT.is_dir()
    result['legacyImportAbsent'] = not (CURRENT / 'data/submissions.jsonl').exists()
    for key, unit, user in [('applicationUnit', 'bubblewash-local.service', True), ('maintenanceUnit', 'bubblewash-maintenance.service', False), ('maintenanceTimer', 'bubblewash-maintenance.timer', False)]:
        try:
            result[key] = unit_report(unit, user)
        except Exception:
            result[key] = {'inspectionSupported': False}
    try:
        result['database'] = database_report(env.get('BUBBLEWASH_DATABASE_PATH', ''))
    except Exception:
        result['database'] = {'inspected': False, 'inspectionFailed': True}
    if owner_email:
        try:
            owner = owner_database_report(env.get('BUBBLEWASH_DATABASE_PATH', ''), owner_email, env)
        except Exception:
            owner = {'inspected': False, 'inspectionFailed': True}
        still_pinned = release_pin_matches(expected_live_sha)
        result['ownerInspection'] = {**owner, **owner_delivery_configuration(env),
            'completed': owner.get('inspected') is True and still_pinned,
            'releasePinStillMatches': still_pinned, 'accountCreated': False}
    result['backup'] = backup_report(env.get('BUBBLEWASH_BACKUP_STATUS_PATH', ''))
    process_count = 0
    for process in Path('/proc').glob('[0-9]*/comm'):
        try:
            if bounded_text(process).strip() in ('node', 'next-server', 'npm', 'sqlite3'):
                process_count += 1
        except Exception:
            pass
    result['possibleAppOrDatabaseProcessCount'] = process_count
    result['currentReadiness'] = {'probed': False, 'omittedBecauseEndpointMutatesDatabase': True}
    return result

if __name__ == '__main__':
    try:
        print(json.dumps(collect(), sort_keys=True))
    except Exception:
        print('{"readOnlyIntent":true,"inspectionFailed":true}')
        raise SystemExit(1)
