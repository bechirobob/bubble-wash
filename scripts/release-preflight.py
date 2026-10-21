#!/usr/bin/env python3
"""Aggregate-only host inspection. Never source env files or import app code."""
import base64
import datetime
import json
from pathlib import Path
import pwd
import re
import sqlite3
import subprocess

HOME = Path('/home/ubuntu')
CURRENT = HOME / 'bubblewash-pilot'
ENV_FILE = HOME / '.config/bubblewash/env'
TABLES = frozenset('payment_initialization_locks customer_recovery delivery_proofs driver_live_locations workflow_action_claims payment_verifications notification_outbox privacy_requests early_access_signups rate_limits submissions vendor_availability driver_availability vendor_declines assignment_capacity_reservations order_route_fees booking_requests order_holds order_invoices account_service_fees billing_entries staff_credential_overrides admin_mfa_settings admin_mfa_recovery_codes admin_recovery_tokens mfa_replay_guard production_resets production_roster_resets staff_accounts'.split())

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
        'distinctBackupPaths': bool(env.get('BUBBLEWASH_BACKUP_PRIMARY_DIR')) and env.get('BUBBLEWASH_BACKUP_PRIMARY_DIR') != env.get('BUBBLEWASH_BACKUP_OFFSITE_DIR'),
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

def backup_report(status_path):
    result = {}
    for label, file in [('status', status_path), ('receipt', HOME / 'bubblewash-backups/offhost-release.json')]:
        try:
            value = json.loads(bounded_text(file))
            stamp = value.get('createdAt' if label == 'status' else 'verifiedAt', '')
            age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))).total_seconds()
            result[label + 'AgeWithin30Hours'] = 0 <= age <= 30 * 3600
            result[label + 'MetadataValid'] = bool(value.get('ok') and value.get('restoreVerifiedAt') and value.get('offsiteStoredAt')) if label == 'status' else (value.get('schema') == 'becore-encrypted-backup-release/v2' and value.get('storageRepository') == 'bechirobob/becore-backups' and value.get('repository') == 'bechirobob/bubble-wash' and all(value.get(k) is True for k in ('encrypted', 'restoreTested', 'downloadVerified')))
        except Exception:
            result[label + 'Readable'] = False
    return result

def collect():
    result = {'readOnlyIntent': True, 'resetExecuted': False, 'backupCreated': False,
              'limits': {'interactiveOwnerLoginProven': False, 'interactiveMfaProven': False, 'allWritersIdentified': False, 'ingressMaintenanceProven': False, 'privateDestinationWriteAccessProven': False, 'effectiveRuntimeEnvironmentProven': False}}
    try:
        env = parse_env(bounded_text(ENV_FILE))
    except Exception:
        return {**result, 'environmentInspectionSupported': False}
    result['environmentInspectionSupported'] = True
    result['configuration'] = configuration(env)
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
