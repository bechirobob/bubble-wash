"""Aggregate-only preparatory inventory. No cleanup, credential or schema changes.

Run only through a separately reviewed private host transport. Output consists of
fixed labels, counts and booleans; never emit database/configuration values/errors.
SQLite mode=ro/query_only prevents database writes; ordinary WAL reader locking
may touch an existing shared-memory sidecar. No immutable mode (would omit WAL).
"""
import json
import fcntl
from contextlib import contextmanager
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

ENV = Path('/home/ubuntu/.config/bubblewash/env')
CURRENT = Path('/home/ubuntu/bubblewash-pilot')
TABLES = tuple('customer_recovery payment_initialization_locks submissions rate_limits workflow_action_claims payment_verifications driver_live_locations driver_location_stops early_access_signups privacy_requests notification_outbox mfa_replay_guard admin_mfa_settings admin_mfa_recovery_codes staff_credential_overrides admin_recovery_tokens delivery_proofs production_resets vendor_availability driver_availability vendor_declines assignment_capacity_reservations production_roster_resets order_route_fees booking_requests order_holds order_invoices account_service_fees billing_entries booking_references vendor_codes operational_work_ownership operational_command_receipts vendor_capacity_confirmations mobile_customer_requests mobile_operations_receipts staff_accounts staff_owner_capabilities research_responses research_notification_outbox'.split())
TYPES = tuple('driver-route-log laundry-inventory-log vendor-job-update qr-bag-intake client-onboarding pickup-booking checkout-request customer-registration customer-security-update admin-operation invoice-audit operations-work-action payment-update staff-account-action staff-onboarding driver-onboarding vendor-application support-ticket support-ticket-action'.split())
ROLES = ('admin', 'vendor', 'driver', 'support')
STATUSES = ('active', 'invited', 'suspended')

def require(ok):
    if not ok:
        raise ValueError('inspection refused')

def secure_file(path, limit=None):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o022)
    require(limit is None or info.st_size <= limit)
    return info

def read_config():
    before = secure_file(ENV, 65536)
    with os.fdopen(os.open(ENV, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as f:
        require(f.fileno() >= 0 and os.fstat(f.fileno()) == before)
        raw = f.read(65537)
        require(os.fstat(f.fileno()) == before == ENV.lstat())
    result = {}
    for line in raw.decode().splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        require(match is not None and match[1] not in result)
        value = match[2].strip()
        if value.startswith(('"', "'")):
            require(len(value) >= 2 and value[-1] == value[0])
            value = value[1:-1]
        require(not any(c in value for c in '\\"\'`\x00\r\n'))
        result[match[1]] = value
    return result

def inventory(db, env):
    # Caller must supply an existing database, never application's initializing
    # getDatabase(). Queries use fixed identifiers and parameterized values.
    names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    for name in TABLES:
        if name in names:
            ddl = db.execute('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?', (name,)).fetchone()[0]
            require(ddl and not re.search(r'\bVIRTUAL\b', ddl, re.I))
    def count(sql, args=()):
        value = db.execute(sql, args).fetchone()[0]
        require(type(value) is int and value >= 0)
        return value
    out = {'schema': 'bubblewash-test-data-inventory/v1', 'logicalReadOnly': True,
           'tables': {name: count('SELECT count(*) FROM "'+name+'"') if name in names else None for name in TABLES},
           'unknownTableCount': len(names-set(TABLES)),
           'staffAuthGloballyDisabled': env.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'true'}
    protected = ["lower(trim(a.role)) LIKE '%admin%'", "lower(trim(a.role)) LIKE '%owner%'", 'lower(trim(a.email))=lower(trim(?))']
    protected_args = (env.get('BUBBLEWASH_ADMIN_EMAIL', ''),)
    if 'staff_owner_capabilities' in names:
        protected.append('EXISTS(SELECT 1 FROM staff_owner_capabilities c WHERE lower(trim(c.email))=lower(trim(a.email)))')
    if 'staff_credential_overrides' in names:
        protected.append('EXISTS(SELECT 1 FROM staff_credential_overrides c WHERE lower(trim(c.login))=lower(trim(a.email)))')
    if 'admin_mfa_settings' in names:
        protected.append('EXISTS(SELECT 1 FROM admin_mfa_settings c WHERE lower(trim(c.admin_email))=lower(trim(a.email)))')
    protected_sql = '('+' OR '.join(protected)+')'
    if 'staff_accounts' in names:
        out['managedAccounts'] = {
            'roleStatusCounts': {role: {status: count('SELECT count(*) FROM staff_accounts WHERE role=? AND status=?', (role,status)) for status in STATUSES} for role in ROLES},
            'unclassifiedRoleOrStatusCount': count('SELECT count(*) FROM staff_accounts WHERE role NOT IN (?,?,?,?) OR status NOT IN (?,?,?) OR role IS NULL OR status IS NULL', ROLES+STATUSES),
            'protectedAdminRelatedCount': count('SELECT count(*) FROM staff_accounts a WHERE '+protected_sql, protected_args),
            'nonAdminCandidateCount': count('SELECT count(*) FROM staff_accounts a WHERE role IN (?,?,?) AND NOT '+protected_sql, ('vendor','driver','support')+protected_args),
            'protectedNonAdminRoleCount': count('SELECT count(*) FROM staff_accounts a WHERE role IN (?,?,?) AND '+protected_sql, ('vendor','driver','support')+protected_args)}
    out['legacyConfiguration'] = {}
    for role in ROLES:
        prefix = 'BUBBLEWASH_'+role.upper()+'_'
        email = env.get(prefix+'EMAIL', '')
        out['legacyConfiguration'][role] = {'loginConfigured': bool(email),
            'passwordHashConfigured': bool(env.get(prefix+'PASSWORD_HASH')),
            'entityBindingConfigured': bool(env.get(prefix+'ENTITY_ID')),
            'managedCollisionCount': count('SELECT count(*) FROM staff_accounts WHERE lower(trim(email))=lower(trim(?))', (email,)) if email and 'staff_accounts' in names else 0,
            'matchesConfiguredAdmin': bool(email and email.strip().lower() == env.get('BUBBLEWASH_ADMIN_EMAIL','').strip().lower())}
    if 'submissions' in names:
        # Malformed JSON is separately counted; it must not trigger a raw error.
        valid = 'CASE WHEN json_valid(data) THEN data ELSE \'{}\' END'
        counts = {kind: count('SELECT count(*) FROM submissions WHERE json_extract('+valid+',\'$.submissionType\')=?',(kind,)) for kind in TYPES}
        out['submissionCategories'] = counts
        out['staffRosterRoleCounts'] = {role: count('SELECT count(*) FROM submissions WHERE json_extract('+valid+',\'$.submissionType\')=\'staff-onboarding\' AND json_extract('+valid+',\'$.staffRole\')=?',(role,)) for role in ('Admin','Operations','Support')}
        out['unclassifiedStaffRosterCount'] = counts['staff-onboarding']-sum(out['staffRosterRoleCounts'].values())
        out['unclassifiedSubmissionCount'] = out['tables']['submissions']-sum(counts.values())
        out['malformedSubmissionJsonCount'] = count('SELECT count(*) FROM submissions WHERE NOT json_valid(data)')
    if 'research_responses' in names:
        out['knownSyntheticResearchCount'] = count("SELECT count(*) FROM research_responses WHERE submission_key=? AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.reference')=?", ('20b2f9aa-77dd-4c7a-8efe-b23f176c77f1','operator-test-v1'))
        out['unclassifiedResearchCount'] = out['tables']['research_responses']-out['knownSyntheticResearchCount']
    return out

@contextmanager
def deployment_read_lock():
    # Same existing inode as deployment, no creation; fail if deployment active.
    path = Path('/home/ubuntu/bubblewash-runtime/deploy.lock')
    before = secure_file(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(os.fstat(fd) == before)
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        yield
        after = secure_file(path)
        require((before.st_dev,before.st_ino)==(after.st_dev,after.st_ino))
    finally:
        os.close(fd)


def inspect():
    require(os.geteuid() == 0)
    env = read_config()
    path = Path(env.get('BUBBLEWASH_DATABASE_PATH', ''))
    require(path.is_absolute() and '..' not in path.parts and path.is_relative_to('/home/ubuntu'))
    require(CURRENT.is_symlink())
    current = CURRENT.resolve(strict=True)
    require(not path.is_relative_to(current) and not path.is_relative_to('/home/ubuntu/bubblewash-releases'))
    main = secure_file(path, 2*1024**3)
    # Refuse missing WAL sidecars: do not allow a read connection to create them.
    for suffix in ('-wal','-shm'):
        secure_file(Path(str(path)+suffix), 2*1024**3)
    require(not (current/'data/submissions.jsonl').exists())
    start = time.monotonic()
    with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True, timeout=5) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        db.set_progress_handler(lambda: 1 if time.monotonic()-start > 20 else 0, 10000)
        # Only SELECT, READ, built-in scalar functions, BEGIN/ROLLBACK permitted.
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_TRANSACTION}
        db.set_authorizer(lambda action,a,b,c,d: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
        db.execute('BEGIN')
        result = inventory(db, env)
        db.execute('ROLLBACK')
        after = secure_file(path, 2*1024**3)
        require((main.st_dev,main.st_ino)==(after.st_dev,after.st_ino))
        result['legacyImportAbsent'] = True
        return result

if __name__ == '__main__':
    try:
        with deployment_read_lock():
            result = inspect()
        print(json.dumps(result,sort_keys=True))
    except BaseException:
        # Never expose SQL, config, private values, filesystem paths or tracebacks.
        print('{"schema":"bubblewash-test-data-inventory/v1","inspectionFailed":true}')
        raise SystemExit(1)
