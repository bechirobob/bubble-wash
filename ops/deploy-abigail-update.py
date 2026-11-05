#!/usr/bin/env python3
"""Exact approved Abigail code-only deployment; pinned acceptance and live gates."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import types
import sys
import base64
import zlib
import signal
from contextlib import contextmanager

REFERENCE = '277a3f8df85068f3245ddc30a6c446d10d9bdc39'
CANDIDATE = '81ffd4acdff7f64d67767318813c75380a5d0b9c'
PROFILE_SHA256 = 'd573ad8c3bdff143089a462509f6126523f27c2a978b0b8edc48a53084cf15e1'
ROOT = Path(__file__).resolve().parents[1]
SCHEMA_BEFORE = 'e08ba6c4178d96dbb177a057cf0b98ca4bd8f8ce4a9aee3b7cba28f6d73799cd'
UAT_TEMPLATE_SHA = '5f3586ef8a4d4630fa99affb33435e2c7190f098f114144ca90e7b8f958d4ee0'
MAX_SNAPSHOT = 64 * 1024 * 1024
BACKUP_EVIDENCE_SHA = 'c7531ca8e598422bd8d63da6fdaaf0377c7c16ad8ba5c28b286fc4d8e2dc2f5b'
ACCEPTANCE_SHA = '8325514673b35b5155376755a3dc7cec9f44c044d6e1582325237f1bf5e4b908'
CI_RUN = '41995449420'
BROWSER_RUN = '41995449648'


def read_backup_evidence(raw=None):
    raw = (ROOT/'ops/abigail-backup-evidence.json').read_bytes() if raw is None else raw.encode()
    require(hashlib.sha256(raw).hexdigest() == BACKUP_EVIDENCE_SHA)
    evidence = json.loads(raw)['attestation']
    require(evidence['schemaBeforeSha256'] == SCHEMA_BEFORE and
            evidence['context']['runtimeSha'] == REFERENCE and
            evidence['snapshotOnly'] is True and evidence['scratchRemoved'] is True and
            evidence['liveDatabaseOpened'] is False and evidence['liveSchemaVerified'] is False)
    return evidence


def bind_release_review(update, evidence):
    """Bind schema gates to the existing lock, rehearsals and code-only switch.

    This installs checks only. It never exposes or enables deployment entry.
    """
    expected = json.loads(json.dumps(evidence))
    context = expected['context']
    require(expected['schemaBeforeSha256'] == SCHEMA_BEFORE and context['runtimeSha'] == REFERENCE)
    core, guards = update.core, update.guards
    original_lock = core.deployment_lock
    original_rehearsals = update.rehearse_both
    original_activate = core.activate
    state = {}

    @contextmanager
    def locked(runtime, uid):
        require(not state)
        with original_lock(runtime, uid) as verify_lock:
            state['lock'] = verify_lock
            try:
                yield verify_lock
            finally:
                state.clear()

    def bindings():
        require('binding' in state and 'lock' in state)
        state['lock']()
        b = state['binding']
        require(update.verify_sources(b['current'], b['candidate'], b['owner']) == b['sources'])
        require(guards.environment_snapshot(core.ENV, b['owner'], b['envHash']) == (b['envRaw'], b['envIdentity']))
        require(guards.database_identity(b['database'], b['owner']) == b['databaseIdentity'])
        require(guards.inspect_read(core.RECEIPT, b['owner'], 'backup') == b['receiptRaw'])
        status_raw = guards.inspect_read(b['status'], b['owner'], 'backup')
        require(status_raw == b['statusRaw'])
        status = json.loads(status_raw)
        guards.safe_path(b['archive'], b['owner'])
        require(b['archive'].stat().st_size == expected['archiveSize'] and
                core.digest(b['archive']) == context['backupSha256'])
        core.verify_receipt(b['receipt'], status, time.time(), context['receiptRun'], context['storeSha'], int(context['storeId']))
        return b

    def rehearse_both(current, candidate, values, database, status_path, owner, unit):
        require(set(state) == {'lock'})
        state['lock']()
        raw, env_identity = guards.environment_snapshot(core.ENV, owner, None)
        require(core.parse(raw) == values and Path(values['BUBBLEWASH_DATABASE_PATH']) == database and
                Path(values['BUBBLEWASH_BACKUP_STATUS_PATH']) == status_path)
        receipt_raw = guards.inspect_read(core.RECEIPT, owner, 'backup')
        receipt = json.loads(receipt_raw)
        require(receipt['sha256'] == context['backupSha256'] and receipt['size'] == expected['archiveSize'])
        archive = Path(values['BUBBLEWASH_BACKUP_OFFSITE_DIR']) / receipt['filename']
        marker_raw = guards.inspect_read(core.RUNTIME/'current-release', owner, 'current')
        require(core.CURRENT.is_symlink() and core.CURRENT.resolve(strict=True) == current and
                core.parse(marker_raw) == {'sha': REFERENCE, 'release': current.name, 'path': str(current)})
        state['binding'] = dict(current=current, candidate=candidate, owner=owner,
            database=database, databaseIdentity=guards.database_identity(database, owner),
            envRaw=raw, envIdentity=env_identity, envHash=hashlib.sha256(raw).hexdigest(),
            receiptRaw=receipt_raw, receipt=receipt, archive=archive, status=status_path,
            statusRaw=guards.inspect_read(status_path, owner, 'backup'),
            markerRaw=marker_raw, sources=update.verify_sources(current, candidate, owner))
        bindings()
        original_rehearsals(current, candidate, json.loads(json.dumps(values)), database, status_path, owner, unit)
        bindings()
        require(core.CURRENT.resolve(strict=True) == current and
                guards.inspect_read(core.RUNTIME/'current-release', owner, 'current') == marker_raw)
        state['rehearsed'] = True

    def activate(current_link, candidate, service, validate):
        require(state.get('rehearsed') is True and state.get('activationAttempted') is not True)
        b = bindings()
        require(current_link == core.CURRENT and candidate == b['candidate'] and
                current_link.resolve(strict=True) == b['current'])
        state['activationAttempted'] = True
        def check_schema():
            b = bindings()
            target = core.CURRENT.resolve(strict=True)
            require(target in (b['current'], b['candidate']))
            marker = guards.inspect_read(core.RUNTIME/'current-release', b['owner'], 'current')
            if target == b['current']:
                require(marker == b['markerRaw'])
            else:
                require(core.parse(marker) == {'sha': CANDIDATE, 'release': target.name, 'path': str(target)})
            require_live_schema(update, b['database'], b['owner'])
            bindings()
            require(core.CURRENT.is_symlink() and core.CURRENT.resolve(strict=True) == target and
                    guards.inspect_read(core.RUNTIME/'current-release', b['owner'], 'current') == marker)
        return checked_activation(original_activate, check_schema)(current_link, candidate, service, validate)

    core.deployment_lock = locked
    update.rehearse_both = rehearse_both
    core.activate = activate


def schema_digest(connection, deadline):
    # Same canonical projection as the successful backup-copy attestation.
    require(time.monotonic() < deadline)
    connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_SNAPSHOT)
    connection.execute('PRAGMA trusted_schema=OFF')
    connection.execute('PRAGMA temp_store=MEMORY')
    connection.execute('PRAGMA query_only=ON')
    rows = connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
    raw = json.dumps(rows, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    require(0 < len(rows) <= 512 and len(raw) <= 1024 * 1024)
    require(connection.execute('PRAGMA quick_check').fetchall() == [('ok',)])
    require(not connection.execute('PRAGMA foreign_key_check').fetchall())
    require(time.monotonic() < deadline)
    return hashlib.sha256(raw).hexdigest()


def require_copy_schema(snapshot):
    # Invoked only on core.rehearse's own private snapshot, never a live path.
    connection = sqlite3.connect(snapshot.as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        connection.execute('BEGIN')
        require(schema_digest(connection, time.monotonic() + 15) == SCHEMA_BEFORE)
    finally:
        connection.close()


def require_live_schema(update, database, owner):
    # Disabled review composition. Caller must retain the deployment lock and
    # source/environment/receipt bindings. Normal WAL/SHM read coordination can
    # occur; no immutable live read, source SQL write or checkpoint is allowed.
    identity = update.guards.database_identity(database, owner)
    require(database.stat().st_size <= MAX_SNAPSHOT)
    with database.open('rb') as handle:
        header = handle.read(100)
    require(len(header) == 100 and header.startswith(b'SQLite format 3\0'))
    if header[18:20] == b'\x02\x02':
        for suffix in ('-wal', '-shm'):
            sidecar = Path(str(database) + suffix)
            require(sidecar.is_file() and not sidecar.is_symlink())
    deadline = time.monotonic() + 15
    source = target = None
    try:
        source = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)
        source.execute('PRAGMA query_only=ON')
        target = sqlite3.connect(':memory:')
        page_size = source.execute('PRAGMA page_size').fetchone()[0]
        require(type(page_size) is int and 512 <= page_size <= 65536)
        def progress(_status, _remaining, total):
            require(time.monotonic() < deadline and total * page_size <= MAX_SNAPSHOT)
        source.backup(target, pages=128, progress=progress, sleep=0.1)
        require(schema_digest(target, deadline) == SCHEMA_BEFORE)
        require(update.guards.database_identity(database, owner) == identity)
    finally:
        if target is not None:
            target.close()
        if source is not None:
            source.close()


def checked_activation(activate, check_schema):
    # Check while the application still owns its active WAL sidecars. A normal
    # stop can remove them; never create root-owned sidecars on a stopped DB.
    # This is a bounded pre-switch observation, not exclusion of all writers.
    def invoke(current, candidate, service, validate):
        check_schema()
        def checked_validate(target):
            # Always run the original verification/marker restoration first,
            # including during rollback, even if schema remains unacceptable.
            validate(target)
            check_schema()
        return activate(current, candidate, service, checked_validate)
    return invoke


def require(value):
    if not value:
        raise ValueError('Exact Abigail deployment contract refused')


def read_inputs():
    raw = (ROOT/'ops/abigail-deployment-source-pins.json').read_bytes()
    require(hashlib.sha256(raw).hexdigest() == PROFILE_SHA256)
    profile = json.loads(raw)
    sources = {name: (ROOT/'ops'/name).read_text() for name in profile['dependencies']}
    return profile, sources


def prepare_review(profile, sources, backup_raw=None):
    # Freeze all expected values, not merely a caller-provided allowedChanges list.
    canonical = (json.dumps(profile, sort_keys=True, indent=2)+'\n').encode()
    require(hashlib.sha256(canonical).hexdigest() == PROFILE_SHA256)
    profile = json.loads(canonical)  # Retain an owned snapshot after validation.
    require(profile['baseSha'] == REFERENCE and profile['runtimeSha'] == CANDIDATE)
    require(set(sources) == set(profile['dependencies']))
    require(all(hashlib.sha256(raw.encode()).hexdigest() == profile['dependencies'][name]
                for name, raw in sources.items()))
    workspace = types.ModuleType('abigail_reviewed_workspace')
    exec(compile(sources['deploy-workspace-update.py'], 'reviewed-workspace', 'exec'), workspace.__dict__)
    # Only an isolated module instance receives the exact code transition.
    workspace.BASE_SHA, workspace.RUNTIME_SHA = REFERENCE, CANDIDATE
    workspace.PROVIDER_PAIR = tuple(profile['providerPair'])
    inner = {**profile, 'schema': 'bubblewash-workspace-update/v1',
             'dependencies': {k: v for k, v in profile['dependencies'].items()
                              if k != 'deploy-workspace-update.py'}}
    update = workspace.configure(inner, {k: v for k, v in sources.items()
                                        if k != 'deploy-workspace-update.py'})
    # This source policy replaces only the isolated instance's historical
    # presentation-only comparison. It never changes the original adapters.
    def verify_sources(current, candidate, owner):
        update.stage('source')
        require(update.core.source_manifest(current) == profile['baselineSource'])
        require(update.core.source_manifest(candidate) == profile['candidateSource'])
        # Both exact approved Git trees include the inert example template.
        # Refuse actual UAT configuration; runtime/config UAT flags remain
        # independently excluded by the unchanged workspace primitives.
        require(not os.path.lexists(current / '.env.uat') and
                not os.path.lexists(candidate / '.env.uat'))
        old, old_identity = update.workspace_baseline.source_snapshot(current, owner)
        new, new_identity = update.source_snapshot(candidate, owner)
        require(update.content_commitment(old) == profile['baselineContent'])
        require(update.content_commitment(new) == profile['runtimeContent'])
        require(old.get('.env.uat.example') == UAT_TEMPLATE_SHA and
                old['.env.uat.example'] == new.get('.env.uat.example'))
        require(sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))
                == profile['allowedChanges'])
        for change in profile['approvedApplicationChanges']:
            name = change['path']
            require(old.get(name) == change['referenceSha256'] and
                    new.get(name) == change['candidateSha256'])
        # Full commitments above also bind all UAT/control files. Auth deltas
        # are admitted only at their frozen bytes; unrelated changes still fail.
        require(old['package-lock.json'] == new['package-lock.json'])
        require(all(old[name] == new.get(name) for name in old if name.startswith('db/')))
        return {'old': old_identity, 'new': new_identity}
    update.verify_sources = verify_sources
    original_rehearse = update.core.rehearse
    def schema_checked_rehearse(*args, **kwargs):
        # Never admit a migration/repair callback or an unbounded rehearsal.
        require(len(args) == 7 and args[6] is not None and not kwargs)
        return original_rehearse(*args, prepare_snapshot=require_copy_schema)
    update.core.rehearse = schema_checked_rehearse
    # Explicit review factory only. No host identity is inferred or accepted and
    # neither deploy entrypoint is enabled by constructing this object.
    # Preserve a standalone synthetic activation review factory before installing
    # the concrete lock/rehearsal bindings used by the existing release route.
    activation_review = update.core.activate
    update.review_activation = lambda checker: checked_activation(activation_review, checker)
    bind_release_review(update, read_backup_evidence(backup_raw))
    # The review object must not accidentally expose a deployable entry point.
    update.deploy = entry
    update.entry = entry
    return update


def require_acceptance(raw):
    # Only the exact reviewed scope and identities are accepted.
    # Passing a truthy argument or editing the JSON without re-review/re-pinning
    # cannot enable host execution. Expected identities are not host proof.
    if not isinstance(raw, str) or hashlib.sha256(raw.encode()).hexdigest() != ACCEPTANCE_SHA:
        raise ValueError('Deployment disabled: reviewed acceptance is required')
    value = json.loads(raw)
    if value.get('deploymentAccepted') is not True:
        raise ValueError('Deployment disabled: actual host/schema acceptance binding is pending')
    require(value == {
        'schema': 'bubblewash-abigail-deployment-acceptance/v1',
        'deploymentAccepted': True,
        'actualBaseline': {'runtimeSha': REFERENCE, 'runtimeContentSha256': '0f51faabc32ad704507b5c4f946f067e8c01557831064a395b97e8b2610ac908'},
        'runtimeAcceptance': {'runtimeSha': CANDIDATE, 'runtimeTree': '381f1ab9bd9f5200955c3afc15a920ff047541b3',
                              'ciRun': '41995449420', 'browserRun': '41995449648'},
        'schemaAcceptance': {'expectedBeforeSha256': SCHEMA_BEFORE, 'liveEqualityRequiredDuringExecution': True},
        'hostAcceptance': {'walReadCoordination': True, 'serviceStopStart': True, 'codeOnlyRollback': True,
                           'sampledSchemaDoesNotExcludeOtherWriters': True}})
    return value


def entry(payload=None, **_kwargs):
    if not isinstance(payload, dict) or set(payload) != {'profile','sources','backupRaw','acceptanceRaw'}:
        raise ValueError('Deployment disabled: reviewed acceptance is required')
    require_acceptance(payload['acceptanceRaw'])
    update = prepare_review(payload['profile'], payload['sources'], payload['backupRaw'])
    args = update.arguments()
    context = read_backup_evidence(payload['backupRaw'])['context']
    require(args.sha == CANDIDATE and args.expected_live == REFERENCE and
            args.backup_sha256 == context['backupSha256'] and args.receipt_run == context['receiptRun'] and
            args.store_sha == context['storeSha'] and args.store_id == context['storeId'])
    def interrupted(*_):
        raise RuntimeError('update interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        # Same guarded build/rehearsal/freeze/code-only activation implementation;
        # our lock/rehearsal/schema hooks are installed on its isolated modules.
        update.workspace_pwa.deploy(update, args)
    except BaseException:
        print(json.dumps({'ok': False, 'status': 'review-required', 'stage': update.STAGE,
                          'automaticRetry': False}), flush=True)
        raise SystemExit(1)


def emit():
    acceptance_raw = (ROOT/'ops/abigail-deployment-acceptance.json').read_text()
    require_acceptance(acceptance_raw) # Refuses before producing any host payload.
    require_runner_runs()
    profile, sources = read_inputs()
    backup_raw = (ROOT/'ops/abigail-backup-evidence.json').read_text()
    context = read_backup_evidence(backup_raw)['context']
    for environment, key in (('BACKUP_SHA','backupSha256'), ('RECEIPT_RUN','receiptRun'),
                             ('BACKUP_STORE_SHA','storeSha'), ('BACKUP_STORE_ID','storeId')):
        require(os.environ.get(environment) == context[key])
    prepare_review(profile, sources, backup_raw)
    payload = {'profile': profile, 'sources': sources, 'backupRaw': backup_raw,
               'acceptanceRaw': acceptance_raw}
    wire = {'payload': payload, 'adapter': Path(__file__).read_text()}
    encoded = base64.b64encode(zlib.compress(json.dumps(wire, separators=(',', ':')).encode())).decode()
    print("import base64,json,types,zlib\np=json.loads(zlib.decompress(base64.b64decode(" + repr(encoded) + ")))\n"
          "m=types.ModuleType('abigail_reviewed');m.__file__='/reviewed-control/ops/deploy-abigail-update.py';"
          "exec(compile(p['adapter'],'abigail-reviewed','exec'),m.__dict__);m.entry(p['payload'])")


def require_runner_runs():
    require(os.environ.get('RUNTIME_SHA') == CANDIDATE and
            os.environ.get('CI_RUN') == CI_RUN and os.environ.get('BROWSER_RUN') == BROWSER_RUN)


if __name__ == '__main__':
    # Read-only runner checks are available for the reviewed existing staging
    # workflow. Emission and host entry independently enforce pinned acceptance.
    if sys.argv[1:] == ['--check-runtime']:
        update = prepare_review(*read_inputs())
        require(os.environ.get('RUNTIME_SHA') == CANDIDATE)
        update.verify_checkout(Path('runtime-artifact').resolve(strict=True), CANDIDATE,
                               types.SimpleNamespace(pw_uid=os.getuid()))
        print('{"ok":true,"exactAbigailRuntime":true}')
    elif sys.argv[1:] == ['--check-hosted-runs']:
        update = prepare_review(*read_inputs())
        require_runner_runs()
        update.check_hosted_runs()
    elif sys.argv[1:] == ['--emit']:
        emit()
    else:
        entry()
