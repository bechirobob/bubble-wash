"""Narrow cleanup core; NOT a standalone live-host entry point.

Host wrapper must hold the existing deployment lock, persistent writer holds and
verify stopped app/maintenance units, fresh verified backup, exact approved plan,
and no external writers. It must keep holds on any error. No app imports/schema
initializers, network calls, logging, new credentials, or automatic restart.
"""
import hashlib
import json
import re

TABLES = tuple('customer_recovery payment_initialization_locks submissions rate_limits workflow_action_claims payment_verifications driver_live_locations driver_location_stops early_access_signups privacy_requests notification_outbox mfa_replay_guard admin_mfa_settings admin_mfa_recovery_codes staff_credential_overrides admin_recovery_tokens delivery_proofs production_resets vendor_availability driver_availability vendor_declines assignment_capacity_reservations production_roster_resets order_route_fees booking_requests order_holds order_invoices account_service_fees billing_entries booking_references vendor_codes operational_work_ownership operational_command_receipts vendor_capacity_confirmations mobile_customer_requests mobile_operations_receipts staff_accounts staff_owner_capabilities research_responses research_notification_outbox'.split())
KEY = '20b2f9aa-77dd-4c7a-8efe-b23f176c77f1'
REFERENCE = 'operator-test-v1'
ROLES = ('DRIVER', 'VENDOR', 'SUPPORT')
REMOVE_KEYS = frozenset('BUBBLEWASH_'+role+'_'+field for role in ROLES for field in ('EMAIL','PASSWORD','PASSWORD_HASH','ENTITY_ID'))
CONFIRMATION = 'REMOVE_THREE_LEGACY_STAFF_LOGIN_ENTRIES_DELETE_ONE_SYNTHETIC_RESPONSE_AND_LINKED_OUTBOX_KEEP_SIGNUP_ADMINS_SETTINGS'

CHECKPOINTS=frozenset(('apply-exact-fingerprint', 'apply-exact-linked-outbox-delete', 'apply-exact-synthetic-delete', 'apply-transaction-confirmation', 'config-byte-bound', 'config-demo-login-disabled', 'config-file-production-mode', 'config-parse', 'config-staff-auth-enabled', 'config-three-legacy-bundles', 'database-foreign-keys', 'database-metadata-fingerprints', 'database-row-fingerprints', 'exact-active-admin-count', 'exact-admin-owner-counts', 'exact-admin-statuses', 'exact-counts-read', 'exact-preserved-signup-notification-audit-counts', 'exact-research-counts', 'initial', 'legacy-login-admin-collision', 'protected-admin-identity-union', 'protected-roster-identities', 'research-outbox-not-sending', 'schema-fixed-table-set', 'schema-read', 'schema-required-tables', 'schema-trigger-view-refusal', 'schema-virtual-refusal', 'synthetic-linked-outbox', 'synthetic-research-email-marker', 'synthetic-research-key', 'synthetic-research-name-marker', 'synthetic-research-payload-markers'))
CHECKPOINT='initial'

def checkpoint(label):
    global CHECKPOINT
    require(label in CHECKPOINTS)
    CHECKPOINT=label

class Refused(Exception):
    pass

def require(ok):
    if not ok: raise Refused('exact cleanup refused')

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',',':')).encode()).hexdigest()

def normalize(value):
    return str(value or '').strip().lower()

def config(raw):
    checkpoint('config-byte-bound')
    require(type(raw) is bytes and len(raw)<=65536)
    values={};kept=[]
    checkpoint('config-parse')
    for line in raw.decode().splitlines(keepends=True):
        text=line.strip()
        if not text or text.startswith(('#',';')):
            kept.append(line);continue
        match=re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)=(.*)',text)
        require(match is not None and match[1] not in values)
        value=match[2].strip()
        if value.startswith(('"',"'")):
            require(len(value)>=2 and value[-1]==value[0]);value=value[1:-1]
        require(not any(c in value for c in '\\"\'`\x00\r\n'))
        values[match[1]]=value
        if match[1] not in REMOVE_KEYS:kept.append(line)
    checkpoint('config-file-production-mode');require(values.get('NODE_ENV')=='production')
    checkpoint('config-demo-login-disabled');require(values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN')=='true')
    checkpoint('config-staff-auth-enabled')
    require(values.get('BUBBLEWASH_STAFF_AUTH_DISABLED')!='true')
    checkpoint('config-three-legacy-bundles')
    for role in ROLES:
        require(bool(values.get('BUBBLEWASH_'+role+'_EMAIL','').strip()) and bool(values.get('BUBBLEWASH_'+role+'_PASSWORD_HASH','')))
    return values,''.join(kept).encode()

def database_state(db):
    checkpoint('schema-read')
    schema=list(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))
    checkpoint('schema-trigger-view-refusal')
    require(not any(row[0] in ('trigger','view') for row in schema))
    names=[row[1] for row in schema if row[0]=='table']
    checkpoint('schema-fixed-table-set')
    require(set(names)<=set(TABLES))
    checkpoint('schema-virtual-refusal')
    require(all(not re.search(r'\bVIRTUAL\b',row[3] or '',re.I) for row in schema if row[0]=='table'))
    required={'staff_accounts','staff_owner_capabilities','staff_credential_overrides','admin_mfa_settings','research_responses','research_notification_outbox','early_access_signups','notification_outbox','submissions'}
    checkpoint('schema-required-tables')
    require(required<=set(names))
    contents={}
    checkpoint('database-row-fingerprints')
    for name in names:
        ddl=next(row[3] for row in schema if row[0]=='table' and row[1]==name)
        columns={row[1].lower() for row in db.execute('PRAGMA table_info("'+name+'")')}
        require('_rowid_' not in columns)
        projection='*' if re.search(r'\bWITHOUT\s+ROWID\b',ddl,re.I) else '_rowid_,*'
        rows=list(db.execute('SELECT '+projection+' FROM "'+name+'" LIMIT 10001'))
        require(len(rows)<=10000)
        encoded=sorted(json.dumps(tuple(row),separators=(',',':'),default=lambda b: {'blob':bytes(b).hex()}) for row in rows)
        require(sum(len(row) for row in encoded)<=16*1024**2)
        contents[name]=digest(encoded)
    checkpoint('database-metadata-fingerprints')
    metadata={key:db.execute('PRAGMA '+key).fetchone()[0] for key in ('user_version','application_id')}
    sequence_exists=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").fetchone()
    metadata['sequence']=list(db.execute('SELECT name,seq FROM sqlite_sequence ORDER BY name')) if sequence_exists else []
    return digest({'schema':schema,'metadata':metadata}),contents

def inspect(db,raw):
    env,replacement=config(raw)
    schema,contents=database_state(db)
    checkpoint('database-foreign-keys')
    require(list(db.execute('PRAGMA foreign_key_check'))==[])
    # These unions protect even malformed/inactive admin-related identities.
    checkpoint('protected-admin-identity-union')
    protected={normalize(env.get('BUBBLEWASH_ADMIN_EMAIL'))}
    protected.update(normalize(r[0]) for r in db.execute('SELECT email FROM staff_accounts'))
    protected.update(normalize(r[0]) for r in db.execute('SELECT email FROM staff_owner_capabilities'))
    protected.update(normalize(r[0]) for r in db.execute('SELECT login FROM staff_credential_overrides'))
    protected.update(normalize(r[0]) for r in db.execute('SELECT admin_email FROM admin_mfa_settings'))
    checkpoint('protected-roster-identities')
    for (data,) in db.execute('SELECT data FROM submissions'):
        value=json.loads(data)
        if value.get('submissionType')=='staff-onboarding':
            protected.update(normalize(value.get(key)) for key in ('staffEmail','email'))
    protected.discard('')
    legacy=[normalize(env['BUBBLEWASH_'+role+'_EMAIL']) for role in ROLES]
    checkpoint('legacy-login-admin-collision')
    require(len(set(legacy))==3 and not any(email in protected for email in legacy))
    checkpoint('exact-counts-read')
    counts={name:db.execute('SELECT count(*) FROM "'+name+'"').fetchone()[0] for name in contents}
    checkpoint('exact-admin-owner-counts')
    require(counts['staff_accounts']==2 and counts['staff_owner_capabilities']==2)
    checkpoint('exact-admin-statuses')
    require(db.execute("SELECT count(*) FROM staff_accounts WHERE role='admin' AND status IN ('active','invited')").fetchone()[0]==2)
    checkpoint('exact-active-admin-count')
    require(db.execute("SELECT count(*) FROM staff_accounts WHERE role='admin' AND status='active'").fetchone()[0]==1)
    checkpoint('exact-preserved-signup-notification-audit-counts')
    require(counts['early_access_signups']==1 and counts['notification_outbox']==1 and counts['submissions']==3)
    checkpoint('exact-research-counts')
    require(counts['research_responses']==1 and counts['research_notification_outbox']==1)
    checkpoint('synthetic-research-key')
    row=db.execute('SELECT id,payload FROM research_responses WHERE submission_key=?',(KEY,)).fetchone()
    require(row is not None)
    checkpoint('synthetic-research-payload-markers')
    payload=json.loads(row[1]);require(payload.get('submissionKey')==KEY and payload.get('reference')==REFERENCE)
    # Defend against the fixed marker being attached to a real response.
    checkpoint('synthetic-research-email-marker')
    require(payload.get('identity',{}).get('email')=='synthetic-test@example.invalid')
    checkpoint('synthetic-research-name-marker')
    require(payload.get('identity',{}).get('name')=='TEST ONLY — SYNTHETIC SURVEY RESPONSE')
    checkpoint('synthetic-linked-outbox')
    require(db.execute('SELECT count(*) FROM research_notification_outbox WHERE response_id=?',(row[0],)).fetchone()[0]==1)
    # Do not interrupt an in-flight delivery; do not remove delivery dedupe while
    # any sending worker may exist. Wrapper separately proves stopped workers.
    checkpoint('research-outbox-not-sending')
    require(db.execute("SELECT count(*) FROM research_notification_outbox WHERE state='sending'").fetchone()[0]==0)
    keep={k:v for k,v in contents.items() if k not in ('research_responses','research_notification_outbox')}
    fingerprint=digest({'schema':schema,'contents':contents,'configurationSha256':hashlib.sha256(raw).hexdigest(),
                        'replacementSha256':hashlib.sha256(replacement).hexdigest(),'operation':CONFIRMATION})
    return {'schema':'bubblewash-exact-test-cleanup/v1','fingerprint':fingerprint,
            'legacyLoginBundlesToRemove':3,'syntheticResearchRowsToDelete':1,'linkedResearchOutboxRowsToDelete':1,
            'earlyAccessSignupsPreserved':1,'generalNotificationRowsPreserved':1,'managedAdminAccountsPreserved':2,
            '_preserved':keep,'_schema':schema,'_replacement':replacement,'_researchId':row[0]}

def public_plan(plan):
    return {key:value for key,value in plan.items() if not key.startswith('_')}

def apply_in_transaction(db,raw,expected_fingerprint,confirmation):
    """Called only inside wrapper-owned BEGIN IMMEDIATE; never commits or edits env.

    Returns replacement bytes for guarded atomic installation. Wrapper must keep
    app/maintenance held through DB commit and env installation and verify both
    before any restart. On error/crash, holds remain and operator recovers using
    the approved backup; no silent rollback/start or partial-success reporting.
    """
    checkpoint('apply-transaction-confirmation')
    require(db.in_transaction and confirmation==CONFIRMATION)
    before=inspect(db,raw)
    checkpoint('apply-exact-fingerprint')
    require(re.fullmatch('[a-f0-9]{64}',expected_fingerprint or '') is not None and before['fingerprint']==expected_fingerprint)
    checkpoint('apply-exact-linked-outbox-delete')
    require(db.execute('DELETE FROM research_notification_outbox WHERE response_id=?',(before['_researchId'],)).rowcount==1)
    checkpoint('apply-exact-synthetic-delete')
    require(db.execute('DELETE FROM research_responses WHERE id=? AND submission_key=?',(before['_researchId'],KEY)).rowcount==1)
    schema,contents=database_state(db)
    require(schema==before['_schema'])
    require({k:v for k,v in contents.items() if k not in ('research_responses','research_notification_outbox')}==before['_preserved'])
    require(db.execute('SELECT count(*) FROM research_responses').fetchone()[0]==0)
    require(db.execute('SELECT count(*) FROM research_notification_outbox').fetchone()[0]==0)
    require(list(db.execute('PRAGMA foreign_key_check'))==[])
    return before['_replacement']
