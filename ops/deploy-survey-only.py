#!/usr/bin/env python3
"""One exact additive survey transition. Controls are never the runtime artifact.

Imported preserving primitives retain their historical guards unchanged. This
entrypoint does not call core.main or replace any core transition constants.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import signal
import sqlite3
import stat
import sys
import tempfile
import time
import zlib

core = None
pins = None
FLAGS = ('BUBBLEWASH_RESEARCH_OPEN', 'BUBBLEWASH_RESEARCH_EMAIL_ENABLED')
TABLES = frozenset(('research_responses', 'research_notification_outbox'))
OBJECTS = frozenset((*TABLES, 'research_response_created',
                     'sqlite_autoindex_research_responses_1', 'sqlite_autoindex_research_responses_2',
                     'sqlite_autoindex_research_notification_outbox_1'))
IDENTITY = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink')
STAGES = frozenset(('source', 'config', 'database', 'backup', 'rehearsal', 'migration', 'switch', 'activation'))
STAGE = 'source'


def stage(value):
    global STAGE
    require(value in STAGES)
    STAGE = value


def require(value):
    if not value:
        raise ValueError('survey release guard failed')


def closed(values):
    require(all(values.get(key) in (None, 'false') for key in FLAGS))


def schema(connection):
    return connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()


def fingerprint(connection, selected):
    """Same hidden-rowid preservation as preserving.py, inside the write transaction."""
    metadata = (connection.execute('PRAGMA user_version').fetchone(),
                connection.execute('PRAGMA application_id').fetchone())
    result = hashlib.sha256(repr((selected, metadata)).encode())
    tables = {row[1]: row for row in connection.execute('PRAGMA main.table_list') if row[0] == 'main'}
    for kind, name, _, _ in selected:
        if kind != 'table':
            continue
        table = tables.get(name)
        require(table and table[2] == 'table' and table[4] in (0, 1))
        quoted = '"' + name.replace('"', '""') + '"'
        columns = connection.execute('PRAGMA main.table_xinfo(' + quoted + ')').fetchall()
        require(columns and len(columns) == table[3])
        selection = '*'
        if table[4] == 0:
            names = {column[1].casefold() for column in columns}
            alias = next((name for name in ('rowid', '_rowid_', 'oid') if name not in names), None)
            require(alias is not None)
            selection = '"' + alias + '", *'
        rows = sorted(repr(row) for row in connection.execute('SELECT ' + selection + ' FROM ' + quoted))
        result.update(name.encode() + b'\0' + '\n'.join(rows).encode())
    return result.hexdigest()


def approved_schema(sql, expected_hash):
    require(hashlib.sha256(sql).hexdigest() == expected_hash and len(sql) < 16384)
    # Exact pinned SQL has three statements and no semicolons inside literals.
    statements = [part.strip() for part in sql.decode().split(';') if part.strip()]
    require(len(statements) == 3)
    with sqlite3.connect(':memory:') as reference:
        for statement in statements:
            reference.execute(statement)
        expected = schema(reference)
        require({row[1] for row in expected} == OBJECTS and
                {row[1] for row in expected if row[0] == 'table'} == TABLES and
                all(row[0] in ('table', 'index') and row[2] in TABLES for row in expected))
    return statements, expected


def add_research_schema(path, sql, expected_hash, before_commit=lambda: None):
    """Existing DB only; all old rows/schema are checked in one atomic transaction.

    Exact already-applied schema is a no-op, including its existing response rows.
    Never initializes application stores, drops tables, or restores a database.
    """
    statements, expected = approved_schema(sql, expected_hash)
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path and path.is_file())
    connection = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=5, isolation_level=None)
    try:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA trusted_schema=OFF')
        connection.execute('BEGIN IMMEDIATE')
        require(connection.execute('PRAGMA quick_check').fetchall() == [('ok',)])
        old = schema(connection)
        present = [row for row in old if row[1] in OBJECTS or row[2] in TABLES or row[1].startswith('research_')]
        require(not present or present == expected)
        before = fingerprint(connection, old)
        if not present:
            # Deliberately not executescript: that API implicitly commits.
            for statement in statements:
                connection.execute(statement)
        after = schema(connection)
        new = [row for row in after if row[1] in OBJECTS or row[2] in TABLES or row[1].startswith('research_')]
        require(new == expected)
        retained = after if present else [row for row in after if row[1] not in OBJECTS]
        require(retained == old and fingerprint(connection, retained) == before)
        require(connection.execute('PRAGMA quick_check').fetchall() == [('ok',)] and
                connection.execute('PRAGMA foreign_key_check').fetchall() == [])
        before_commit()  # Source/config/DB inode and shared-lock guards, still in transaction.
        connection.execute('COMMIT')
        return 'retained' if present else 'added'
    except BaseException:
        if connection.in_transaction:
            connection.execute('ROLLBACK')
        raise
    finally:
        connection.close()


def safe_path(path, owner, directory=False):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path)
    for item in (*reversed(path.parents), path):
        info = item.lstat()
        require(info.st_uid in (0, owner.pw_uid) and not info.st_mode & 0o022)
        if item != path or directory:
            require(stat.S_ISDIR(info.st_mode))
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    return path.stat()


def file_identity(path, owner, digest=None):
    info = safe_path(path, owner)
    if digest is not None:
        require(core.digest(path) == digest)
    return tuple(getattr(info, key) for key in (*IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def environment_snapshot(path, owner, expected_hash):
    # Exactly the existing installer's two-parent/descriptor-relative policy.
    stage('config')
    parent = path.parent
    require(parent.resolve(strict=True) == parent)
    parents = []
    for item in (parent, parent.parent):
        info = item.stat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, owner.pw_uid) and not info.st_mode & 0o022)
        parents.append(tuple(getattr(info, key) for key in IDENTITY))
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        require(tuple(getattr(os.fstat(directory), key) for key in IDENTITY) == parents[0])
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == owner.pw_uid and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 65536 and not os.listxattr(fd))
        identity = tuple(getattr(info, key) for key in (*IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
        raw = os.read(fd, 65537)
        require(len(raw) == info.st_size and (expected_hash is None or hashlib.sha256(raw).hexdigest() == expected_hash))
        require(parent.resolve(strict=True) == parent)
        require(parents == [tuple(getattr(item.stat(), key) for key in IDENTITY) for item in (parent, parent.parent)])
        require(tuple(getattr(os.fstat(fd), key) for key in (*IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns')) == identity)
        require(tuple(getattr(os.stat(path.name, dir_fd=directory, follow_symlinks=False), key)
                      for key in (*IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns')) == identity)
        return raw, (parents, identity)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def verify_sources(current, candidate, owner):
    stage('source')
    require(core.source_manifest(current) == pins['baselineSource'] and
            core.source_manifest(candidate) == pins['candidateSource'])
    for relative in core.CRITICAL_FILES:
        require(core.digest(current / relative) == core.digest(candidate / relative))
    result = {}
    # Complete immutable reviewed files, excluding only build outputs/dependencies.
    for label, release, files in (('old', current, pins['baselineFiles']),
                                  ('new', candidate, pins['runtimeFiles'])):
        safe_path(release, owner, True)
        for relative, digest in files.items():
            require(not Path(relative).is_absolute() and '..' not in Path(relative).parts)
            result[label + '/' + relative] = file_identity(release / relative, owner, digest)
    return result


def database_identity(path, owner):
    stage('database')
    info = safe_path(path, owner)
    require(info.st_uid == owner.pw_uid and not info.st_mode & 0o022)
    for suffix in ('-wal', '-shm', '-journal'):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            item = safe_path(sidecar, owner)
            require(item.st_uid == owner.pw_uid and not item.st_mode & 0o022)
    return tuple(getattr(info, key) for key in IDENTITY)


def runtime_flags(target, values, enabled=False):
    stage('config')
    core.check_runtime(target, values)
    main = core.parse(core.ctl('show', core.UNIT, '--property=MainPID').encode()).get('MainPID', '')
    listeners = core.command(['ss', '-ltnp', 'sport = :3000'])
    processes = {main, *re.findall(r'pid=(\d+)', listeners)}
    require(len(processes) in (1, 2) and all(re.fullmatch(r'[1-9][0-9]*', pid) for pid in processes))
    for pid in processes:
        raw = (Path('/proc') / pid / 'environ').read_bytes()
        require(len(raw) <= 131072)
        values = dict(item.decode().split('=', 1) for item in raw.split(b'\0') if b'=' in item)
        if enabled:
            require(all(values.get(key) == 'true' for key in FLAGS))
        else:
            closed(values)


def stopped():
    state = core.parse(core.ctl('show', core.UNIT, '--property=ActiveState,MainPID,ControlPID').encode())
    require(state.get('ActiveState') in ('inactive', 'failed') and
            state.get('MainPID') == '0' and state.get('ControlPID') == '0')
    require(not re.search(r'pid=\d+', core.command(['ss', '-ltnp', 'sport = :3000'])))


def app_operation(owner, operation):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.setgroups([])
    os.setgid(owner.pw_gid)
    os.setuid(owner.pw_uid)
    require(os.getuid() == owner.pw_uid == os.geteuid() and
            os.getgid() == owner.pw_gid == os.getegid() and not os.getgroups())
    operation()


def migrate_as_app(owner, operation, timeout=90):
    """Fork retains the existing flock even if the privileged parent disconnects.

    The child drops groups/GID/UID irreversibly before opening SQLite. A timeout or
    unknown result is not retried; code rollback leaves any committed schema alone.
    """
    read_end, write_end = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(read_end)
        try:
            app_operation(owner, operation)
            os.write(write_end, b'OK')
            os._exit(0)
        except BaseException:
            os._exit(1)
    os.close(write_end)
    reaped = False
    try:
        deadline = time.monotonic() + timeout
        while True:
            found, status = os.waitpid(child, os.WNOHANG)
            if found:
                reaped = True
                require(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 and os.read(read_end, 3) == b'OK')
                return
            if time.monotonic() >= deadline:
                raise TimeoutError()
            time.sleep(0.05)
    finally:
        if not reaped:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
        os.close(read_end)


def migration_service(owner, operation, before_commit, backup):
    attempted = False
    def service(action, name):
        nonlocal attempted
        first = action == 'stop' and not attempted
        if first:
            attempted = True  # No repeat after uncertain stop/transaction outcome.
        stage('migration' if first else 'switch')
        core.ctl(action, name)
        if first:
            stopped()
            before_commit()
            backup()
            stage('migration')
            migrate_as_app(owner, operation)
            before_commit()
    return service


def rehearse_both(current, candidate, values, db, status_path, owner, unit, sql):
    stage('rehearsal')
    def deadline(*_):
        raise core.RehearsalDeadline()
    previous = signal.signal(signal.SIGALRM, deadline)
    try:
        for label, target in (('rollback', current), ('candidate', candidate)):
            report = core.RehearsalReport()
            signal.setitimer(signal.ITIMER_REAL, 300)
            try:
                core.rehearse(target, values, db, status_path, owner, unit + '-' + label, report,
                              prepare_snapshot=lambda copy: add_research_schema(copy, sql, pins['schemaSha256']))
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
    finally:
        signal.signal(signal.SIGALRM, previous)


def activation_bytes(raw):
    values = core.parse(raw)
    closed(values)
    require(re.fullmatch(r're_[A-Za-z0-9_-]{16,200}', values.get('BUBBLEWASH_RESEARCH_RESEND_KEY', '')))
    expiry = values.get('BUBBLEWASH_RESEARCH_CLOSES_AT')
    if expiry is not None:
        require(re.match(r'^\d{4}-\d{2}-\d{2}T', expiry) and
                core.dt.datetime.fromisoformat(expiry.replace('Z', '+00:00')).timestamp() > time.time())
    lines = raw.splitlines(keepends=True)
    found = set()
    for index, line in enumerate(lines):
        match = re.match(rb'^\s*(BUBBLEWASH_RESEARCH_OPEN|BUBBLEWASH_RESEARCH_EMAIL_ENABLED)\s*=', line)
        if match:
            key = match[1].decode()
            require(key not in found)
            found.add(key)
            ending = b'\r\n' if line.endswith(b'\r\n') else b'\n' if line.endswith(b'\n') else b''
            lines[index] = match[1] + b'=true' + ending
    result = b''.join(lines)
    for key in FLAGS:
        if key not in found:
            result += (b'' if not result or result.endswith(b'\n') else b'\n') + key.encode() + b'=true\n'
    updated = core.parse(result)
    require(len(result) <= 65536 and all(updated.get(key) == 'true' for key in FLAGS) and
            {key: value for key, value in updated.items() if key not in FLAGS} ==
            {key: value for key, value in values.items() if key not in FLAGS})
    return result


def replace_environment(path, owner, expected, replacement, guard):
    """App UID only; existing installer descriptor/metadata/atomic replace pattern."""
    require(os.getuid() == owner.pw_uid == os.geteuid() and os.getgid() == owner.pw_gid)
    expected_hash = hashlib.sha256(expected).hexdigest()
    raw, original = environment_snapshot(path, owner, expected_hash)
    require(raw == expected)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix='.survey-flags-', dir=path.parent)
        with os.fdopen(fd, 'wb') as handle:
            # Same app UID; preserve existing GID without ever elevating privilege.
            os.fchown(handle.fileno(), owner.pw_uid, original[1][4])
            os.fchmod(handle.fileno(), 0o600)
            handle.write(replacement)
            handle.flush()
            os.fsync(handle.fileno())
        guard()
        require(environment_snapshot(path, owner, expected_hash) == (expected, original))
        os.replace(Path(temporary).name, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        temporary = None
        os.fsync(directory)
        require(environment_snapshot(path, owner, hashlib.sha256(replacement).hexdigest())[0] == replacement)
        guard()
    finally:
        if temporary is not None:
            os.unlink(Path(temporary).name, dir_fd=directory)
        os.close(directory)


def marked_test_accepted(db, sql, expected_hash):
    _, expected = approved_schema(sql, expected_hash)
    connection = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=5, isolation_level=None)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        present = [row for row in schema(connection) if row[1] in OBJECTS or row[2] in TABLES or row[1].startswith('research_')]
        require(present == expected and connection.execute('PRAGMA quick_check').fetchall() == [('ok',)] and
                connection.execute('PRAGMA foreign_key_check').fetchall() == [])
        rows = connection.execute('''SELECT r.payload,r.payload_hash,o.state,o.attempts,o.recipient,
                   o.provider_message_id,o.sent_at,o.last_error_kind,o.lease_token,o.lease_until
                   FROM research_responses r JOIN research_notification_outbox o ON o.response_id=r.id
                   WHERE r.submission_key=?''', ('20b2f9aa-77dd-4c7a-8efe-b23f176c77f1',)).fetchall()
        require(len(rows) == 1)
        row = rows[0]
        require(isinstance(row[0], str) and len(row[0].encode()) <= 65536 and
                hashlib.sha256(row[0].encode()).hexdigest() == row[1] and row[2:5] == ('sent', 1, 'operator-test-only') and
                isinstance(row[5], str) and 0 < len(row[5]) <= 200 and row[6] and row[7:] == (None, None, None))
        payload = json.loads(row[0])
        require(payload.get('adultEligible') is True and payload.get('instrument') == 'consumer' and
                payload.get('reference') == 'operator-test-v1' and
                payload.get('identity', {}).get('email') == 'synthetic-test@example.invalid')
    finally:
        connection.close()


def verify_hosted_run(run, control_sha, runtime_sha):
    require(run.get('head_sha') == control_sha and run.get('event') == 'workflow_dispatch' and
            run.get('path') == '.github/workflows/survey-only-deploy.yml' and
            run.get('head_repository', {}).get('full_name') == 'bechirobob/bubble-wash' and
            run.get('repository', {}).get('full_name') == 'bechirobob/bubble-wash' and
            run.get('head_branch') == 'main' and run.get('status') == 'completed' and
            run.get('conclusion') == 'success' and run.get('run_attempt') == 1 and
            run.get('display_title') in ('Survey-only verify ' + runtime_sha, 'Survey-only deploy ' + runtime_sha))


def check_hosted_run():
    import urllib.request
    run_id = os.environ.get('VERIFICATION_RUN', '')
    control_sha = os.environ.get('GITHUB_SHA', '')
    runtime_sha = os.environ.get('RUNTIME_SHA', '')
    require(re.fullmatch(r'[1-9][0-9]*', run_id) and all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (control_sha, runtime_sha)))
    request = urllib.request.Request('https://api.github.com/repos/bechirobob/bubble-wash/actions/runs/' + run_id,
        headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'bubblewash-survey-release-gate'})
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read(262145)
    require(len(raw) <= 262144)
    verify_hosted_run(json.loads(raw), control_sha, runtime_sha)
    print('{"ok":true,"exactHostedVerification":true}')


def activate_flags(args):
    require(os.geteuid() == 0 and re.fullmatch(r'[a-f0-9]{40}', args.sha))
    owner = pwd.getpwnam('ubuntu')
    with core.deployment_lock(core.RUNTIME, owner.pw_uid) as lock_unchanged:
        require(core.CURRENT.is_symlink())
        current = core.CURRENT.resolve(strict=True)
        marker_path = core.RUNTIME / 'current-release'
        marker_raw = marker_path.read_bytes()
        marker = core.parse(marker_raw)
        require(marker.get('sha') == args.sha and marker.get('path') == str(current))
        raw, env_identity = environment_snapshot(core.ENV, owner, None)
        config_hash = hashlib.sha256(raw).hexdigest()
        values = core.parse(raw)
        closed(values)
        replacement = activation_bytes(raw)
        enabled = core.parse(replacement)
        require(values.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'false' and
                values.get('BUBBLEWASH_BOOKINGS_DISABLED') == 'true' and
                values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true' and values.get('NODE_ENV') in (None, 'production'))
        db = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
        require(str(db) == values.get('BUBBLEWASH_DATABASE_PATH') and not db.is_relative_to(current))
        db_identity = database_identity(db, owner)
        def source_identity():
            stage('source')
            require(core.source_manifest(current) == pins['candidateSource'])
            return {name: file_identity(current / name, owner, digest) for name, digest in pins['runtimeFiles'].items()}
        sources = source_identity()
        sql = (current / 'db/proposed/research-v1.sql').read_bytes()
        receipt_raw = core.RECEIPT.read_bytes()
        receipt = json.loads(receipt_raw)
        status_path = Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH', ''))
        archive = Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR', '')) / receipt['filename']
        require(status_path.is_absolute() and archive.is_absolute() and receipt.get('sha256') == args.backup_sha256)
        def backup():
            stage('backup')
            require(core.RECEIPT.read_bytes() == receipt_raw and not archive.is_symlink() and archive.is_file() and
                    archive.stat().st_size == receipt['size'] and core.digest(archive) == args.backup_sha256)
            core.verify_receipt(receipt, json.loads(status_path.read_bytes()), time.time(), args.receipt_run, args.store_sha, int(args.store_id))
        def bound():
            lock_unchanged()
            require(core.CURRENT.resolve(strict=True) == current and marker_path.read_bytes() == marker_raw and
                    source_identity() == sources and database_identity(db, owner) == db_identity)
        def prepare_and_replace():
            bound()
            require(environment_snapshot(core.ENV, owner, config_hash) == (raw, env_identity))
            marked_test_accepted(db, sql, pins['schemaSha256'])
            replace_environment(core.ENV, owner, raw, replacement, bound)
        backup()
        runtime_flags(current, values, False)
        core.health(3000)
        stage('activation')
        restart_attempted = False
        try:
            migrate_as_app(owner, prepare_and_replace)
            bound()
            require(environment_snapshot(core.ENV, owner, hashlib.sha256(replacement).hexdigest())[0] == replacement)
            stage('activation')
            restart_attempted = True
            core.ctl('restart', core.UNIT)
            core.health(3000)
            runtime_flags(current, enabled, True)
            core.public_health()
            bound()
            backup()
            require(environment_snapshot(core.ENV, owner, hashlib.sha256(replacement).hexdigest())[0] == replacement)
        except BaseException:
            # Determine exact resulting config before rollback. Never overwrite drift.
            bound()
            try:
                state = environment_snapshot(core.ENV, owner, hashlib.sha256(replacement).hexdigest())[0]
            except ValueError:
                state = environment_snapshot(core.ENV, owner, config_hash)[0]
            require(state in (raw, replacement))
            if state == replacement:
                migrate_as_app(owner, lambda: replace_environment(core.ENV, owner, replacement, raw, bound))
            if state == replacement or restart_attempted:
                core.ctl('restart', core.UNIT)
            core.health(3000)
            runtime_flags(current, values, False)
            core.public_health()
            require(environment_snapshot(core.ENV, owner, config_hash)[0] == raw)
            print('{"ok":false,"activationRolledBack":true,"databaseRestored":false}', flush=True)
            raise
        print('{"ok":true,"collectionOpen":true,"emailEnabled":true,"fixedRecipient":true}', flush=True)


class InspectTimeout(BaseException):
    pass


class InspectRefusal(Exception):
    def __init__(self, code, scope='none', depth=None, index=None):
        self.result = {'guard': code, 'scope': scope, 'ancestorDepth': depth, 'fileIndex': index}


def inspect_require(value, code, scope='none', depth=None, index=None):
    if not value:
        raise InspectRefusal(code, scope, depth, index)


def inspect_path(path, owner, scope, directory=False, index=None):
    try:
        inspect_require(path.is_absolute() and path.resolve(strict=True) == path, 'PATH_CANONICAL', scope, index=index)
        for depth, item in enumerate((*reversed(path.parents), path)):
            info = item.lstat()
            inspect_require(info.st_uid in (0, owner.pw_uid), 'ANCESTOR_OWNER', scope, depth, index)
            inspect_require(not info.st_mode & 0o022, 'ANCESTOR_MODE', scope, depth, index)
            if item != path or directory:
                inspect_require(stat.S_ISDIR(info.st_mode), 'ANCESTOR_TYPE', scope, depth, index)
            else:
                inspect_require(stat.S_ISREG(info.st_mode), 'FILE_TYPE', scope, index=index)
                inspect_require(info.st_nlink == 1, 'FILE_LINKS', scope, index=index)
        return path.stat()
    except (OSError, ValueError):
        raise InspectRefusal('PATH_UNAVAILABLE', scope, index=index) from None


def inspect_source(release, owner, scope):
    expected = pins['baselineSource' if scope == 'baseline' else 'candidateSource']
    files = pins['baselineFiles' if scope == 'baseline' else 'runtimeFiles']
    inspect_path(release, owner, scope, True)
    # Fixed map index, never an arbitrary filename or host path, leaves the host.
    for index, (relative, digest) in enumerate(files.items()):
        inspect_require(not Path(relative).is_absolute() and '..' not in Path(relative).parts, 'PIN_PATH', scope, index=index)
        path = release / relative
        info = inspect_path(path, owner, scope, index=index)
        inspect_require(info.st_size <= 8 * 1024 * 1024, 'FILE_BOUND', scope, index=index)
        inspect_require(core.digest(path) == digest, 'FILE_HASH', scope, index=index)
    try:
        actual = core.source_manifest(release)
    except (OSError, ValueError):
        raise InspectRefusal('SOURCE_MANIFEST_UNREADABLE', scope) from None
    inspect_require(actual == expected, 'SOURCE_MANIFEST_MISMATCH', scope)


def inspect_read(path, owner, scope, limit=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        inspect_require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                        info.st_uid in (0, owner.pw_uid) and not info.st_mode & 0o022, 'METADATA_FILE', scope)
        inspect_require(info.st_size <= limit, 'METADATA_BOUND', scope)
        raw = os.read(fd, limit + 1)
        after = os.fstat(fd)
        inspect_require(len(raw) == info.st_size and all(getattr(after, key) == getattr(info, key)
                        for key in (*IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns')), 'METADATA_CHANGED', scope)
        return raw
    finally:
        os.close(fd)


def inspect_binding(candidate, runtime_sha, owner):
    inspect_require(candidate.parent == core.HOME / 'bubblewash-releases' and
                    re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + runtime_sha[:12], candidate.name), 'CANDIDATE_PATH', 'candidate')
    inspect_require(core.CURRENT.is_symlink(), 'CURRENT_LINK', 'current')
    current = core.CURRENT.resolve(strict=True)
    marker_raw = inspect_read(core.RUNTIME / 'current-release', owner, 'current')
    inspect_require(len(marker_raw) <= 65536, 'CURRENT_MARKER_BOUND', 'current')
    marker = core.parse(marker_raw)
    # Claims are independently followed by exact source-map validation below.
    claim = (inspect_read(current / '.release-sha', owner, 'current', 128).decode().strip()
             if current.parent == core.HOME / 'bubblewash-releases' else '')
    pointer = 'candidate' if current == candidate and claim == runtime_sha else 'baseline' if current != candidate and claim == pins['baseSha'] else 'other'
    marked = 'candidate' if marker.get('sha') == runtime_sha else 'baseline' if marker.get('sha') == pins['baseSha'] else 'other'
    binding = {'pointerClaim': pointer, 'markerClaim': marked,
               'markerPathMatchesPointer': marker.get('path') == str(current)}
    return current, marker_raw, binding


def inspect_database_path(owner):
    # Approved descriptor-bound config read. Select only the nonsecret DB path;
    # do not parse/look up any key or retain/transmit unrelated values.
    raw, identity = environment_snapshot(core.ENV, owner, None)
    selected = [line for line in raw.decode().splitlines()
                if re.match(r'^\s*BUBBLEWASH_DATABASE_PATH\s*=', line)]
    digest = hashlib.sha256(raw).hexdigest()
    del raw
    inspect_require(len(selected) == 1, 'DATABASE_CONFIG_BINDING', 'database')
    values = core.parse(selected[0].encode())
    path = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
    return path, digest, identity


def inspect_schema(path, owner):
    database_identity(path, owner)
    with path.open('rb') as handle:
        header = handle.read(100)
    inspect_require(len(header) == 100 and header.startswith(b'SQLite format 3\x00'), 'DATABASE_FORMAT', 'database')
    # Read-only SQLite never writes a WAL; require existing coordination files so
    # it cannot initialize missing WAL/SHM sidecars. Never use immutable=1 on WAL.
    if header[18:20] == b'\x02\x02' or Path(str(path) + '-wal').exists():
        inspect_require(all(Path(str(path) + suffix).is_file() and not Path(str(path) + suffix).is_symlink()
                            for suffix in ('-wal', '-shm')), 'DATABASE_WAL_UNAVAILABLE', 'database')
    inspect_require(not Path(str(path) + '-journal').exists(), 'DATABASE_JOURNAL_ACTIVE', 'database')
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5, isolation_level=None)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        present = [row for row in schema(connection) if row[1] in OBJECTS or row[2] in TABLES or row[1].startswith('research_')]
        _, expected = approved_schema(pins['schemaSql'].encode(), pins['schemaSha256'])
        return 'absent' if not present else 'complete' if present == expected else 'partial'
    finally:
        connection.close()


def inspect_release(args):
    result = {'schema': 'bubblewash-survey-inspection/v1', 'readOnly': True,
              'binding': {'pointerClaim': 'unavailable', 'markerClaim': 'unavailable', 'markerPathMatchesPointer': None},
              'source': {'baseline': 'unavailable', 'candidate': 'unavailable', 'criticalBytes': 'unavailable'},
              'researchSchema': 'unavailable', 'receipt': 'unavailable', 'failures': []}
    def attempt(operation, fallback, code, scope):
        try:
            return operation()
        except InspectRefusal as error:
            result['failures'].append(error.result)
        except Exception:
            result['failures'].append({'guard': code, 'scope': scope, 'ancestorDepth': None, 'fileIndex': None})
        return fallback
    def body(owner, lock_unchanged):
        candidate = Path(args.candidate)
        binding = attempt(lambda: inspect_binding(candidate, args.sha, owner), None, 'CURRENT_MARKER_UNREADABLE', 'current')
        current = marker_raw = None
        if binding:
            current, marker_raw, result['binding'] = binding
            if result['binding']['pointerClaim'] not in ('baseline', 'candidate'):
                result['failures'].append({'guard': 'CURRENT_RELEASE_IDENTITY', 'scope': 'current', 'ancestorDepth': None, 'fileIndex': None})
            if result['binding']['pointerClaim'] != result['binding']['markerClaim'] or not result['binding']['markerPathMatchesPointer']:
                result['failures'].append({'guard': 'CURRENT_MARKER_MISMATCH', 'scope': 'current', 'ancestorDepth': None, 'fileIndex': None})
        def candidate_source():
            inspect_require(candidate.parent == core.HOME / 'bubblewash-releases' and
                            re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + args.sha[:12], candidate.name), 'CANDIDATE_PATH', 'candidate')
            inspect_require(candidate.resolve(strict=True) == candidate and candidate.is_dir(), 'CANDIDATE_CANONICAL', 'candidate')
            inspect_require(inspect_read(candidate / '.release-sha', owner, 'candidate', 128).decode().strip() == args.sha, 'CANDIDATE_MARKER', 'candidate')
            inspect_source(candidate, owner, 'candidate')
            return 'pass'
        result['source']['candidate'] = attempt(candidate_source, 'refused', 'SOURCE_UNREADABLE', 'candidate')
        if current is not None and result['binding']['pointerClaim'] == 'baseline':
            def baseline_source():
                inspect_source(current, owner, 'baseline')
                return 'pass'
            result['source']['baseline'] = attempt(baseline_source, 'refused', 'SOURCE_UNREADABLE', 'baseline')
            if result['source']['baseline'] == result['source']['candidate'] == 'pass':
                def critical():
                    inspect_require(all(core.digest(current / p) == core.digest(candidate / p) for p in core.CRITICAL_FILES), 'CRITICAL_BYTES', 'critical')
                    # Final reuse of the exact deployment source guard, not a substitute.
                    verify_sources(current, candidate, owner)
                    return 'pass'
                result['source']['criticalBytes'] = attempt(critical, 'refused', 'SOURCE_GUARD', 'critical')
        elif current == candidate:
            result['source']['baseline'] = 'not-current'
            result['source']['criticalBytes'] = 'not-comparable'
        config = attempt(lambda: inspect_database_path(owner), None, 'DATABASE_CONFIG_UNREADABLE', 'database')
        if config:
            database, config_hash, config_identity = config
            result['researchSchema'] = attempt(lambda: inspect_schema(database, owner), 'unavailable', 'SCHEMA_READ_FAILED', 'database')
            def config_stable():
                repeated, identity = environment_snapshot(core.ENV, owner, config_hash)
                del repeated
                inspect_require(identity == config_identity, 'CONFIG_CHANGED', 'database')
            attempt(config_stable, None, 'CONFIG_CHANGED', 'database')
        def receipt():
            raw = inspect_read(core.RECEIPT, owner, 'backup')
            inspect_require(len(raw) <= 65536, 'RECEIPT_BOUND', 'backup')
            value = json.loads(raw)
            inspect_require(value.get('sha256') == args.backup_sha256 and str(value.get('runId')) == args.receipt_run and
                            value.get('storageSha') == args.store_sha and value.get('storageRepositoryId') == int(args.store_id),
                            'RECEIPT_PIN', 'backup')
            return 'matches-input-pins'
        result['receipt'] = attempt(receipt, 'refused', 'RECEIPT_LOAD', 'backup')
        def stable():
            lock_unchanged()
            if current is not None:
                inspect_require(core.CURRENT.resolve(strict=True) == current and
                                inspect_read(core.RUNTIME / 'current-release', owner, 'current') == marker_raw, 'CURRENT_CHANGED', 'current')
        attempt(stable, None, 'LOCK_CHANGED', 'current')
    require(os.geteuid() == 0 and args.expected_live == pins['baseSha'] and
            re.fullmatch(r'[a-f0-9]{40}', args.sha) and re.fullmatch(r'[a-f0-9]{40}', args.store_sha) and
            re.fullmatch(r'[a-f0-9]{64}', args.backup_sha256) and re.fullmatch(r'[1-9][0-9]*', args.receipt_run) and
            re.fullmatch(r'[1-9][0-9]*', args.store_id))
    owner = pwd.getpwnam('ubuntu')
    def locked():
        with core.deployment_lock(core.RUNTIME, owner.pw_uid) as lock_unchanged:
            # Unlike deploy, inspection needs no privileged action after this.
            app_operation(owner, lambda: body(owner, lock_unchanged))
    previous = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(InspectTimeout()))
    signal.setitimer(signal.ITIMER_REAL, 90)
    try:
        attempt(locked, None, 'LOCK_OR_DROP', 'current')
    except InspectTimeout:
        result['failures'].append({'guard': 'INSPECTION_TIMEOUT', 'scope': 'none', 'ancestorDepth': None, 'fileIndex': None})
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    result['ok'] = not result['failures']
    print(json.dumps(result, separators=(',', ':')), flush=True)
    return result


NORMALIZE_COUNTS = (267, 79)


def normalize_baseline_sources(current, owner, bound, result):
    """Only the pinned legacy source nodes. No recursive chmod or source execution."""
    files = pins['baselineFiles']
    directories = sorted({str(parent) for name in files for parent in Path(name).parents
                          if str(parent) != '.'}, key=lambda name: (len(Path(name).parts), name))
    inspect_require((len(files), len(directories)) == NORMALIZE_COUNTS, 'NORMALIZE_SCOPE', 'baseline')
    inspect_require(all(not Path(name).is_absolute() and '..' not in Path(name).parts and
                        str(Path(name)) == name for name in files), 'PIN_PATH', 'baseline')
    # These ancestors, including release root, are validated but never modified.
    root_info = safe_path(current, owner, True)
    root_fd = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    records = {}
    fields = (*IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    metadata = lambda info: tuple(getattr(info, key) for key in fields)
    root_identity = metadata(root_info)
    def same_record(record):
        fd, parent, name, identity, _digest, _directory = record
        inspect_require(metadata(os.fstat(fd)) == identity and
                        metadata(os.stat(name, dir_fd=parent, follow_symlinks=False)) == identity,
                        'NORMALIZE_IDENTITY_CHANGED', 'baseline')
    def read_hash(record):
        fd, _parent, _name, identity, _digest, directory = record
        inspect_require(not directory and os.fstat(fd).st_size <= 8 * 1024 * 1024,
                        'FILE_BOUND', 'baseline')
        same_record(record)
        os.lseek(fd, 0, os.SEEK_SET)
        digest = hashlib.sha256(); size = 0
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            size += len(block)
            inspect_require(size <= 8 * 1024 * 1024, 'FILE_BOUND', 'baseline')
            digest.update(block)
        same_record(record)
        inspect_require(size == identity[len(IDENTITY)], 'NORMALIZE_IDENTITY_CHANGED', 'baseline')
        return digest.hexdigest()
    def stable():
        bound()
        inspect_require(metadata(os.fstat(root_fd)) == root_identity and
                        metadata(current.lstat()) == root_identity and
                        current.resolve(strict=True) == current, 'NORMALIZE_ROOT_CHANGED', 'baseline')
        safe_path(current, owner, True)
        for record in records.values():
            same_record(record)
    def content():
        actual = {name: read_hash(records[name]) for name in files}
        inspect_require(actual == files, 'FILE_HASH', 'baseline')
        # Check only names in pinned source directories; never open/traverse extras.
        for name in directories:
            if name == 'src' or name.startswith('src/'):
                expected = {Path(item).name for item in (*files, *directories)
                            if str(Path(item).parent) == name}
                inspect_require(set(os.listdir(records[name][0])) == expected,
                                'SOURCE_MANIFEST_MISMATCH', 'baseline')
        rows = sorted((name[4:], digest) for name, digest in actual.items() if name.startswith('src/'))
        manifest = {'src': hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()}
        manifest.update({name: actual[name] for name in ('package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json')})
        inspect_require(manifest == pins['baselineSource'], 'SOURCE_MANIFEST_MISMATCH', 'baseline')
        inspect_require(all(actual[name] == pins['runtimeFiles'][name] for name in core.CRITICAL_FILES),
                        'CRITICAL_BYTES', 'critical')
    try:
        inspect_require(metadata(os.fstat(root_fd)) == root_identity, 'NORMALIZE_ROOT_CHANGED', 'baseline')
        for name, directory in [(name, True) for name in directories] + [(name, False) for name in files]:
            relative = Path(name); parent_name = str(relative.parent)
            parent = root_fd if parent_name == '.' else records[parent_name][0]
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if directory else 0)
            fd = os.open(relative.name, flags, dir_fd=parent)
            try:
                info = os.fstat(fd)
                inspect_require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
                                'NORMALIZE_TYPE_LINK', 'baseline')
                inspect_require(info.st_uid in (0, owner.pw_uid) and
                                (not info.st_mode & 0o022 or info.st_uid == owner.pw_uid),
                                'NORMALIZE_OWNER', 'baseline')
                # No set-ID/sticky/ACL semantics are silently changed by fchmod.
                inspect_require(not info.st_mode & 0o7000 and not os.listxattr(fd), 'NORMALIZE_METADATA', 'baseline')
                record = [fd, parent, relative.name, metadata(info), files.get(name), directory]
                same_record(record)
                records[name] = record
            except BaseException:
                os.close(fd)
                raise
        stable()
        content()
        stable()
        content()
        counts = {'files': {}, 'directories': {}}
        for record in records.values():
            mode = format(stat.S_IMODE(record[3][2]), '04o')
            kind = 'directories' if record[5] else 'files'
            counts[kind][mode] = counts[kind].get(mode, 0) + 1
        result.update(prevalidated=True, observedModes=counts,
                      eligibleFiles=len(files), eligibleDirectories=len(directories),
                      needsChange=sum(bool(record[3][2] & 0o022) for record in records.values()))
        # Emit actual bounded mode counts only after the entire source is verified,
        # before the first change. No path, file content, key or account is emitted.
        print(json.dumps({'schema': result['schema'], 'phase': 'prevalidated',
                          **{key: result[key] for key in ('eligibleFiles', 'eligibleDirectories', 'observedModes', 'needsChange')}},
                         separators=(',', ':')), flush=True)
        if not result['applyRequested']:
            result['status'] = 'validated-no-change'
            return
        stable()
        for record in records.values():
            if not record[3][2] & 0o022:
                continue
            stable()
            old = record[3]
            target = stat.S_IMODE(old[2]) & ~0o022
            result['attemptedChanges'] += 1
            os.fchmod(record[0], target)
            after = os.fstat(record[0])
            inspect_require(stat.S_IMODE(after.st_mode) == target and
                            all(getattr(after, key) == old[fields.index(key)] for key in
                                ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns')),
                            'NORMALIZE_POST_CHANGE', 'baseline')
            record[3] = metadata(after)
            same_record(record)
            result['changed'] += 1
        stable()
        content()
        # Reapply the unchanged strict path/hash policy after normalization.
        for name, digest in files.items():
            file_identity(current / name, owner, digest)
        stable()
        result['status'] = 'normalized' if result['changed'] else 'already-safe'
    finally:
        for record in reversed(list(records.values())):
            os.close(record[0])
        os.close(root_fd)


def baseline_binding(owner):
    inspect_require(core.CURRENT.is_symlink(), 'CURRENT_LINK', 'current')
    current = core.CURRENT.resolve(strict=True)
    inspect_require(current.parent == core.HOME / 'bubblewash-releases', 'CURRENT_RELEASE_IDENTITY', 'current')
    marker = inspect_read(core.RUNTIME / 'current-release', owner, 'current')
    parsed = core.parse(marker)
    inspect_require(parsed.get('sha') == pins['baseSha'] and parsed.get('path') == str(current) and
                    inspect_read(current / '.release-sha', owner, 'current', 128).decode().strip() == pins['baseSha'],
                    'CURRENT_RELEASE_IDENTITY', 'current')
    return current, marker


def normalize_release(args):
    result = {'schema': 'bubblewash-baseline-normalization/v1', 'applyRequested': bool(args.apply_normalization),
              'prevalidated': False, 'attemptedChanges': 0, 'changed': 0, 'automaticRetry': False,
              'status': 'refused', 'guard': None, 'ok': False}
    def body(owner, lock_unchanged):
        current, marker = baseline_binding(owner)
        def bound():
            lock_unchanged()
            inspect_require(baseline_binding(owner) == (current, marker), 'CURRENT_CHANGED', 'current')
        normalize_baseline_sources(current, owner, bound, result)
    require(os.geteuid() == 0 and args.expected_live == pins['baseSha'] and re.fullmatch(r'[a-f0-9]{40}', args.sha))
    owner = pwd.getpwnam('ubuntu')
    previous = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(InspectTimeout()))
    signal.setitimer(signal.ITIMER_REAL, 90)
    try:
        with core.deployment_lock(core.RUNTIME, owner.pw_uid) as lock_unchanged:
            app_operation(owner, lambda: body(owner, lock_unchanged))
        result['ok'] = True
    except BaseException as error:
        result['guard'] = error.result['guard'] if isinstance(error, InspectRefusal) else ('NORMALIZE_TIMEOUT' if isinstance(error, InspectTimeout) else 'NORMALIZE_REFUSED')
        result['status'] = 'partial-or-uncertain' if result['attemptedChanges'] else 'refused-no-change'
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    print(json.dumps(result, separators=(',', ':')), flush=True)
    return result


RESTART_ADDITIONS = frozenset(('BUBBLEWASH_RESEARCH_RESEND_KEY', 'BUBBLEWASH_RESEARCH_EMAIL_ENABLED'))


def closed_restart_values(expected, observed):
    """Only these two already-installed inactive additions may still be absent."""
    closed(expected)
    closed(observed)
    require(re.fullmatch(r're_[A-Za-z0-9_-]{16,200}', expected.get('BUBBLEWASH_RESEARCH_RESEND_KEY', '')) and
            expected.get('BUBBLEWASH_RESEARCH_EMAIL_ENABLED') == 'false')
    require(all(observed.get(key) == value for key, value in expected.items() if key not in RESTART_ADDITIONS))
    require(all(key not in observed or observed[key] == expected[key] for key in RESTART_ADDITIONS))


def closed_restart_runtime(current, values):
    # Core service/listener/source/cgroup policy is unchanged. The two permitted
    # inactive additions are checked individually below, never simply ignored.
    legacy = {key: value for key, value in values.items() if key not in RESTART_ADDITIONS}
    core.check_runtime(current, legacy)
    main = core.parse(core.ctl('show', core.UNIT, '--property=MainPID').encode()).get('MainPID', '')
    listeners = core.command(['ss', '-H', '-ltnp', 'sport = :3000'])
    listening = set(re.findall(r'pid=(\d+)', listeners))
    processes = {main, *listening}
    require(len(listening) == 1 and len(processes) in (1, 2) and
            all(re.fullmatch(r'[1-9][0-9]*', pid) for pid in processes))
    identities = []
    for pid in sorted(processes):
        with (Path('/proc') / pid / 'environ').open('rb') as handle:
            raw = handle.read(131073)
        require(len(raw) <= 131072)
        observed = dict(item.decode().split('=', 1) for item in raw.split(b'\0') if b'=' in item)
        closed_restart_values(values, observed)
        identities.append((pid, hashlib.sha256(raw).hexdigest()))
    core.check_runtime(current, legacy)
    return tuple(identities)


def restart_closed(args):
    result = {'schema': 'bubblewash-closed-restart/v1', 'ok': False, 'stage': 'binding',
              'restartAttempted': False, 'automaticRetry': False, 'status': 'refused-no-restart'}
    require(os.geteuid() == 0 and args.expected_live == pins['baseSha'] and re.fullmatch(r'[a-f0-9]{40}', args.sha))
    owner = pwd.getpwnam('ubuntu')
    previous = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(InspectTimeout()))
    signal.setitimer(signal.ITIMER_REAL, 180)
    try:
        with core.deployment_lock(core.RUNTIME, owner.pw_uid) as lock_unchanged:
            current, marker = baseline_binding(owner)
            result['stage'] = 'source'
            inspect_source(current, owner, 'baseline')
            def source():
                require(core.source_manifest(current) == pins['baselineSource'])
                return {name: file_identity(current / name, owner, digest) for name, digest in pins['baselineFiles'].items()}
            sources = source()
            result['stage'] = 'config'
            raw, identity = environment_snapshot(core.ENV, owner, None)
            digest = hashlib.sha256(raw).hexdigest()
            values = core.parse(raw)
            closed(values)
            require(values.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'false' and
                    values.get('BUBBLEWASH_BOOKINGS_DISABLED') == 'true' and
                    values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true' and values.get('NODE_ENV') in (None, 'production'))
            def bound():
                lock_unchanged()
                require(baseline_binding(owner) == (current, marker) and source() == sources and
                        environment_snapshot(core.ENV, owner, digest) == (raw, identity))
            result['stage'] = 'runtime-preflight'
            processes = closed_restart_runtime(current, values)
            result['stage'] = 'health-before'
            core.health(3000)
            result['stage'] = 'binding-before'
            bound()
            require(closed_restart_runtime(current, values) == processes)
            bound()
            result['stage'] = 'restart'
            result['restartAttempted'] = True  # An uncertain command is never repeated.
            core.ctl('restart', core.UNIT)
            result['stage'] = 'health-after'
            core.health(3000)
            result['stage'] = 'runtime-verification'
            runtime_flags(current, values, False)  # Full unchanged equality, no projection.
            result['stage'] = 'public-health'
            core.public_health()
            result['stage'] = 'binding-after'
            bound()
            result.update(ok=True, status='restarted-closed', stage='complete')
    except BaseException:
        result['status'] = 'restart-unconfirmed' if result['restartAttempted'] else 'refused-no-restart'
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    print(json.dumps(result, separators=(',', ':')), flush=True)
    return result


def main(args):
    if args.mode == 'restart-closed':
        return restart_closed(args)
    if args.mode == 'normalize-baseline':
        return normalize_release(args)
    if args.mode == 'inspect':
        return inspect_release(args)
    if args.mode == 'activate':
        return activate_flags(args)
    require(os.geteuid() == 0 and args.expected_live == pins['baseSha'])
    require(all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (args.sha, args.expected_live, args.store_sha)))
    require(re.fullmatch(r'[a-f0-9]{64}', args.backup_sha256))
    require(re.fullmatch(r'[1-9][0-9]*', args.receipt_run) and re.fullmatch(r'[1-9][0-9]*', args.store_id))
    owner = pwd.getpwnam('ubuntu')
    with core.deployment_lock(core.RUNTIME, owner.pw_uid) as lock_unchanged:
        candidate = Path(args.candidate)
        require(candidate.parent == core.HOME / 'bubblewash-releases' and
                re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + args.sha[:12], candidate.name))
        require((candidate / '.release-sha').read_text().strip() == args.sha and core.CURRENT.is_symlink())
        current = core.CURRENT.resolve(strict=True)
        require(current != candidate and (current / '.next/BUILD_ID').is_file())
        marker_path = core.RUNTIME / 'current-release'
        old_marker = marker_path.read_bytes()
        marker = core.parse(old_marker)
        require(marker.get('sha') == pins['baseSha'] and marker.get('path') == str(current))
        raw, env_identity = environment_snapshot(core.ENV, owner, None)
        config_hash = hashlib.sha256(raw).hexdigest()
        values = core.parse(raw)
        closed(values)
        require(values.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'false' and
                values.get('BUBBLEWASH_BOOKINGS_DISABLED') == 'true' and
                values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true' and values.get('NODE_ENV') in (None, 'production'))
        db = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
        require(str(db) == values.get('BUBBLEWASH_DATABASE_PATH') and
                not db.is_relative_to(current) and not db.is_relative_to(candidate))
        db_identity = database_identity(db, owner)
        require(not (current / 'data/submissions.jsonl').exists() and not (candidate / 'data/submissions.jsonl').exists())
        sources = verify_sources(current, candidate, owner)
        sql = (candidate / 'db/proposed/research-v1.sql').read_bytes()
        approved_schema(sql, pins['schemaSha256'])
        receipt_raw = core.RECEIPT.read_bytes()
        receipt = json.loads(receipt_raw)
        require(receipt.get('sha256') == args.backup_sha256)
        status_path = Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH', ''))
        archive = Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR', '')) / receipt['filename']
        require(status_path.is_absolute() and archive.is_absolute())

        def identities():
            lock_unchanged()
            require(verify_sources(current, candidate, owner) == sources and
                    environment_snapshot(core.ENV, owner, config_hash) == (raw, env_identity) and
                    database_identity(db, owner) == db_identity)

        def backup():
            stage('backup')
            require(core.RECEIPT.read_bytes() == receipt_raw and not archive.is_symlink() and archive.is_file() and
                    archive.stat().st_size == receipt['size'] and core.digest(archive) == args.backup_sha256)
            core.verify_receipt(receipt, json.loads(status_path.read_bytes()), time.time(),
                                args.receipt_run, args.store_sha, int(args.store_id))

        def before_commit():
            identities()
            require(core.CURRENT.resolve(strict=True) == current and marker_path.read_bytes() == old_marker)

        backup()
        runtime_flags(current, values)
        core.health(3000)
        unit = 'bubblewash-survey-' + candidate.name
        core.command(['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--unit=' + unit + '-build',
                      '--property=User=ubuntu', '--property=Group=ubuntu', '--property=WorkingDirectory=' + str(candidate),
                      '--property=RuntimeMaxSec=900', '--property=ProtectSystem=strict', '--property=ProtectHome=tmpfs',
                      '--property=BindPaths=' + str(candidate), '--property=ReadWritePaths=' + str(candidate),
                      '--property=PrivateTmp=true', '--property=NoNewPrivileges=true',
                      '/usr/bin/env', 'HOME=' + str(candidate), 'NEXT_TELEMETRY_DISABLED=1', '/bin/bash', '-c',
                      'npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund'], timeout=930)
        # npm may rewrite identical lock bytes; re-pin metadata after isolated build.
        sources = verify_sources(current, candidate, owner)
        rehearse_both(current, candidate, values, db, status_path, owner, unit, sql)
        identities()
        backup()
        before_commit()
        runtime_flags(current, values)
        service = migration_service(owner,
            lambda: add_research_schema(db, sql, pins['schemaSha256'], before_commit), before_commit, backup)

        def write_marker(content):
            def write_as_app():
                identities()
                with tempfile.NamedTemporaryFile(dir=core.RUNTIME, prefix='.release-marker-', delete=False) as handle:
                    handle.write(content)
                    os.fchmod(handle.fileno(), 0o600)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(handle.name, marker_path)
            migrate_as_app(owner, write_as_app)

        def validate(target):
            require(target in (current, candidate))
            core.health(3000)
            runtime_flags(target, values)
            core.public_health()
            identities()
            backup()
            write_marker((f'sha={args.sha}\nrelease={candidate.name}\npath={candidate}\n'.encode()
                          if target == candidate else old_marker))

        stage('switch')
        core.activate(core.CURRENT, candidate, service, validate)
        print(json.dumps({'ok': True, 'schemaPreserved': True, 'collectionOpen': False,
                          'emailEnabled': False, 'rollbackDatabaseRestore': False}), flush=True)


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=('deploy', 'activate', 'inspect', 'normalize-baseline', 'restart-closed'), default='deploy')
    parser.add_argument('--candidate')
    parser.add_argument('--apply-normalization', action='store_true')
    for key in ('sha', 'expected-live', 'backup-sha256', 'receipt-run', 'store-sha',
                'store-id'):
        parser.add_argument('--' + key, required=True)
    return parser.parse_args()


def entry():
    def interrupted(*_):
        raise RuntimeError('release interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        args = arguments()
        result = main(args)
    except BaseException:
        print(json.dumps({'ok': False, 'status': 'review-required', 'stage': STAGE, 'automaticRetry': False}), flush=True)
        raise SystemExit(1)
    if args.mode in ('normalize-baseline', 'restart-closed') and not result['ok']:
        raise SystemExit(1)


def emit():
    """Serialize only public reviewed controls; no host settings or credentials."""
    here = Path(__file__).resolve().parent
    source = (here / 'deploy-preserving.py').read_bytes()
    public_pins = json.loads((here / 'survey-only-source-pins.json').read_bytes())
    require(hashlib.sha256(source).hexdigest() == public_pins['preservingSha256'])
    own = Path(__file__).read_bytes()
    payload = json.dumps({'core': source.decode(), 'adapter': own.decode(), 'pins': public_pins}, separators=(',', ':')).encode()
    encoded = base64.b64encode(zlib.compress(payload)).decode()
    print("import base64,json,types,zlib\np=json.loads(zlib.decompress(base64.b64decode(" + repr(encoded) + ")))\n"
          "c=types.ModuleType('preserving_reviewed'); exec(compile(p['core'],'preserving-reviewed','exec'),c.__dict__)\n"
          "a=types.ModuleType('survey_reviewed'); exec(compile(p['adapter'],'survey-reviewed','exec'),a.__dict__)\n"
          "a.core=c; a.pins=p['pins']; a.entry()")


if __name__ == '__main__':
    if sys.argv[1:] == ['--emit']:
        emit()
    elif sys.argv[1:] == ['--check-hosted-run']:
        check_hosted_run()
    else:
        raise SystemExit('Use the reviewed control-workflow emitter; never execute runtime repository controls.')
