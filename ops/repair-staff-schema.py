#!/usr/bin/env python3
"""Separately authorized, single-table additive repair. Never activates a release."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import sqlite3
import stat
import subprocess
import sys
import time


class RepairRejected(Exception):
    """Only fixed enum reasons, never SQL, values, paths or exceptions."""


def require(condition, code):
    if not condition:
        raise RepairRejected(code)


def schema(connection):
    return connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()


def fingerprint(connection, excluded=()):
    """Same complete row identity semantics as the unchanged deployment guard."""
    require(connection.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'INTEGRITY_FAILED')
    objects = [row for row in schema(connection) if row[1] not in excluded]
    metadata = (connection.execute('PRAGMA user_version').fetchone(), connection.execute('PRAGMA application_id').fetchone())
    digest = hashlib.sha256(repr((objects, metadata)).encode())
    tables = {row[1]: row for row in connection.execute('PRAGMA main.table_list') if row[0] == 'main'}
    for kind, name, _, _ in objects:
        if kind != 'table':
            continue
        table = tables.get(name)
        require(table is not None and table[2] == 'table' and table[4] in (0, 1), 'UNSUPPORTED_TABLE')
        quoted = '"' + name.replace('"', '""') + '"'
        columns = connection.execute('PRAGMA main.table_xinfo(' + quoted + ')').fetchall()
        require(columns and len(columns) == table[3], 'UNSUPPORTED_COLUMNS')
        selection = '*'
        if table[4] == 0:
            names = {column[1].casefold() for column in columns}
            alias = next((name for name in ('rowid', '_rowid_', 'oid') if name not in names), None)
            require(alias is not None, 'ROWID_UNAVAILABLE')
            selection = '"' + alias + '", *'
        rows = sorted(repr(row) for row in connection.execute('SELECT ' + selection + ' FROM ' + quoted))
        digest.update(name.encode() + b'\0' + '\n'.join(rows).encode())
    return digest.hexdigest()


def reference_objects(core_ddl, staff_ddl):
    with closing(sqlite3.connect(':memory:')) as reference:
        reference.executescript(core_ddl)
        before = schema(reference)
        reference.execute(staff_ddl)
        after = schema(reference)
    added = [row for row in after if row not in before]
    require(len(added) == 2 and {row[0] for row in added} == {'table', 'index'} and
            {row[2] for row in added} == {'staff_accounts'} and
            any(row[0] == 'table' and row[1] == 'staff_accounts' for row in added) and
            any(row[0] == 'index' and row[1] == 'sqlite_autoindex_staff_accounts_1' and row[3] is None for row in added),
            'REFERENCE_INVALID')
    return before, added


def repair_transaction(connection, core_ddl, staff_ddl, verify_identity=lambda: None, commit_pending=lambda: None):
    """Caller must separately establish exact code/DB identity and backup proof."""
    required, added = reference_objects(core_ddl, staff_ddl)
    require(not connection.in_transaction, 'TRANSACTION_ALREADY_OPEN')
    connection.execute('BEGIN IMMEDIATE')
    try:
        verify_identity()  # Under the SQLite write lock, before any DDL.
        before_schema = schema(connection)
        # Every preexisting required core object must already match exactly;
        # unrelated legacy objects are preserved, never normalized or removed.
        require(all(row in before_schema for row in required), 'CORE_SCHEMA_MISMATCH')
        collision = [row for row in before_schema if row[1].casefold() in
                     ('staff_accounts', 'sqlite_autoindex_staff_accounts_1')]
        if collision:
            require(sorted(collision) == sorted(added), 'EXISTING_STAFF_SCHEMA_MISMATCH')
            require(connection.execute('SELECT count(*) FROM staff_accounts').fetchone() == (0,), 'STAFF_TABLE_NOT_EMPTY')
            verify_identity()
            connection.rollback()
            return 'ALREADY_EXACT_EMPTY'
        before = fingerprint(connection)
        version = connection.execute('PRAGMA schema_version').fetchone()[0]
        require(0 <= version < 2147483647, 'SCHEMA_VERSION_UNSUPPORTED')
        # execute(), not executescript(): Python executescript would commit the
        # pending transaction. This is the sole persistent SQL statement.
        connection.execute(staff_ddl)
        require(schema(connection) == sorted(before_schema + added), 'UNEXPECTED_SCHEMA_CHANGE')
        require(connection.execute('SELECT count(*) FROM staff_accounts').fetchone() == (0,), 'STAFF_TABLE_NOT_EMPTY')
        require(connection.execute('PRAGMA schema_version').fetchone()[0] == version + 1, 'UNEXPECTED_SCHEMA_VERSION')
        require(fingerprint(connection, tuple(row[1] for row in added)) == before, 'EXISTING_DATA_CHANGED')
        verify_identity()  # A failed identity/receipt/lock guard still rolls back DDL.
        commit_pending()
        verify_identity()
        connection.commit()
        return 'CREATED_EMPTY'
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise


def reference_ddl(candidate, pins):
    """Read only two exact reviewed source blobs, never evaluate JavaScript."""
    result = []
    for relative, initializer, receiver in (
            ('src/lib/data-store.ts', 'initializeDatabaseSchema', 'db'),
            ('src/lib/staff-accounts.ts', 'initializeStaffAccountsSchema', 'database')):
        descriptor = os.open(candidate / relative, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as handle:
            require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode), 'SOURCE_PIN_FAILED')
            raw = handle.read(131073)
        require(len(raw) <= 131072 and hashlib.sha256(raw).hexdigest() == pins[relative], 'SOURCE_PIN_FAILED')
        pattern = r'function ' + initializer + r'\([^)]*\) \{\s*' + receiver + r'\.exec\(`([\s\S]*?)`\);\s*\}'
        found = re.findall(pattern, raw.decode())
        require(len(found) == 1 and '${' not in found[0], 'SOURCE_PIN_FAILED')
        result.append(found[0])
    return result


class DatabaseBinding:
    """Pin canonical identities; root and the existing app UID are trusted.

    All SQLite writes run permanently as that app UID, never root. The existing
    app UID already has database write authority; this is not a defense against
    malicious same-UID SQL or root. Other directory writers are refused.
    No mode, ownership, mount, service or file is changed by this validator.
    """
    def __init__(self, path, app_uid, copy_mode=False):
        self.path = path
        self.app_uid = app_uid
        self.copy_mode = copy_mode
        self.descriptors = []
        self.directories = []
        self.files = []
        try:
            require(path.is_absolute() and len(path.parts) <= 32, 'UNSAFE_DATABASE_PATH')
            descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.descriptors.append(descriptor)
            self.directories.append((None, '/', descriptor, os.fstat(descriptor)))
            for name in path.parts[1:-1]:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                self.descriptors.append(child)
                self.directories.append((descriptor, name, child, os.fstat(child)))
                descriptor = child
            for suffix in (('',) if copy_mode else ('', '-wal', '-shm')):
                name = path.name + suffix
                try:
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
                except FileNotFoundError:
                    self.files.append((descriptor, name, None, None))
                    continue
                self.descriptors.append(child)
                self.files.append((descriptor, name, child, os.fstat(child)))
            self.verify()
        except BaseException:
            self.close()
            raise

    def close(self):
        while self.descriptors:
            os.close(self.descriptors.pop())

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def verify(self):
        for parent, name, descriptor, original in self.directories + self.files:
            if descriptor is None:
                try:
                    os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                raise RepairRejected('DATABASE_IDENTITY_CHANGED')
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            pinned = os.fstat(descriptor)
            identity = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid, item.st_nlink)
            require(identity(current) == identity(pinned) == identity(original), 'DATABASE_IDENTITY_CHANGED')
        if self.copy_mode:
            return
        # Reject any rollback journal: this runner supports only the observed WAL
        # deployment and never changes journal mode or performs crash recovery.
        try:
            os.stat(self.path.name + '-journal', dir_fd=self.directories[-1][2], follow_symlinks=False)
        except FileNotFoundError:
            return
        raise RepairRejected('UNEXPECTED_JOURNAL')

    def flags(self):
        directory_stats = [item[3] for item in self.directories]
        file_stats = [item[3] for item in self.files]
        regular = all(item is not None and stat.S_ISREG(item.st_mode) for item in file_stats)
        single = regular and all(item.st_nlink == 1 for item in file_stats)
        owners = regular and all(item.st_uid in (0, self.app_uid) for item in file_stats)
        modes = regular and all(not item.st_mode & 0o022 for item in file_stats)
        root_only = all(item.st_uid == 0 for item in directory_stats)
        directory_owners = all(item.st_uid in (0, self.app_uid) for item in directory_stats)
        directory_modes = all(not item.st_mode & 0o022 for item in directory_stats)
        wal = regular and os.pread(self.files[0][2], 100, 0)[18:20] == b'\x02\x02'
        return {'directoryOwnersTrusted': directory_owners, 'directoriesRootOwned': root_only,
                'directoryModesSafe': directory_modes, 'databaseFilesRegular': regular,
                'databaseFilesSingleLink': single, 'databaseFileOwnersTrusted': owners,
                'databaseFileModesSafe': modes, 'walModeExisting': wal,
                'repairPathTrusted': all((directory_owners, directory_modes, single, owners, modes, self.copy_mode or wal))}

    def require_trusted(self):
        self.verify()
        require(self.flags()['repairPathTrusted'], 'UNTRUSTED_DATABASE_PATH')


REPAIR_CODES = frozenset(('INTEGRITY_FAILED', 'UNSUPPORTED_TABLE', 'UNSUPPORTED_COLUMNS', 'ROWID_UNAVAILABLE',
    'REFERENCE_INVALID', 'TRANSACTION_ALREADY_OPEN', 'CORE_SCHEMA_MISMATCH', 'EXISTING_STAFF_SCHEMA_MISMATCH',
    'STAFF_TABLE_NOT_EMPTY', 'SCHEMA_VERSION_UNSUPPORTED', 'UNEXPECTED_SCHEMA_CHANGE', 'UNEXPECTED_SCHEMA_VERSION',
    'EXISTING_DATA_CHANGED', 'SOURCE_PIN_FAILED', 'UNSAFE_DATABASE_PATH', 'DATABASE_IDENTITY_CHANGED',
    'UNEXPECTED_JOURNAL', 'UNTRUSTED_DATABASE_PATH', 'COPY_IDENTITY_CHANGED', 'COPY_PROOF_FAILED', 'INVALID_OPERATION', 'WORKER_PROTOCOL', 'WORKER_FAILED',
    'WORKER_PRIVILEGES', 'WORKER_TIMEOUT', 'WORKER_SQLITE_FAILED'))


def worker_main():
    """Unprivileged transaction worker: fixed bounded protocol, no raw errors."""
    try:
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
        signal.alarm(60)
        raw = sys.stdin.buffer.readline(65537)
        require(len(raw) <= 65536 and raw.endswith(b'\n'), 'WORKER_PROTOCOL')
        payload = json.loads(raw)
        uid, gid = payload['uid'], payload['gid']
        require(type(uid) is int and uid > 0 and type(gid) is int and gid > 0 and
                os.getresuid() == (uid, uid, uid) and os.getresgid() == (gid, gid, gid) and
                os.getgroups() == [], 'WORKER_PRIVILEGES')
        with DatabaseBinding(Path(payload['path']), uid, payload['copy']) as binding:
            binding.require_trusted()
            require([[item[3].st_dev, item[3].st_ino] if item[3] else None for item in binding.files] == payload['files'] and
                    [[item[3].st_dev, item[3].st_ino] for item in binding.directories] == payload['directories'], 'DATABASE_IDENTITY_CHANGED')
            with closing(sqlite3.connect(Path(payload['path']).as_uri() + '?mode=rw', uri=True, timeout=3)) as connection:
                def authorize_commit():
                    print('PRECOMMIT', flush=True)
                    require(sys.stdin.buffer.readline(16) == b'COMMIT\n', 'WORKER_PROTOCOL')
                outcome = repair_transaction(connection, payload['core'], payload['staff'], binding.require_trusted, authorize_commit)
            print(outcome, flush=True)
        return 0
    except BaseException as error:
        code = (error.args[0] if isinstance(error, RepairRejected) and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in REPAIR_CODES
                else 'WORKER_TIMEOUT' if isinstance(error, TimeoutError) else
                'WORKER_SQLITE_FAILED' if isinstance(error, sqlite3.Error) else 'WORKER_FAILED')
        print('ERROR:' + code, flush=True)
        return 1
    finally:
        signal.alarm(0)


def worker_transaction(owner, binding, core, staff, verify_existing, report=None):
    """Parent's only write is a fixed commit acknowledgement, never SQL."""
    payload = {'uid': owner.pw_uid, 'gid': owner.pw_gid, 'path': str(binding.path), 'copy': binding.copy_mode,
               'files': [[item[3].st_dev, item[3].st_ino] if item[3] else None for item in binding.files],
               'directories': [[item[3].st_dev, item[3].st_ino] for item in binding.directories],
               'core': core, 'staff': staff}
    raw = (json.dumps(payload) + '\n').encode()
    require(len(raw) <= 65536, 'WORKER_PROTOCOL')
    # The checked-out public source is embedded by the workflow, never loaded
    # from the app-writable host filesystem. No credentials in argv or env.
    program = "__name__ = 'repair_worker'\n" + REPAIR_SOURCE + "\nsys.exit(worker_main())\n"
    if binding.copy_mode and report is not None:
        report.safe_to_remove = False
    process = subprocess.Popen(['/usr/bin/python3', '-I', '-B', '-c', program],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        cwd='/', env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, close_fds=True,
        user=owner.pw_uid, group=owner.pw_gid, extra_groups=[])
    deadline = time.monotonic() + 65
    try:
        process.stdin.write(raw); process.stdin.flush()
        acknowledged = False
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            for _ in range(2):
                line = b''
                while not line.endswith(b'\n'):
                    require(bool(selector.select(max(0, deadline - time.monotonic()))), 'WORKER_TIMEOUT')
                    byte = os.read(process.stdout.fileno(), 1)
                    require(bool(byte) and len(line) < 127, 'WORKER_PROTOCOL')
                    line += byte
                if line == b'PRECOMMIT\n':
                    require(not acknowledged, 'WORKER_PROTOCOL')
                    binding.require_trusted()
                    verify_existing()  # Child still holds BEGIN IMMEDIATE.
                    if report is not None and not binding.copy_mode:
                        report.outcome = 'COMMIT_UNCERTAIN'
                    acknowledged = True
                    process.stdin.write(b'COMMIT\n'); process.stdin.flush()
                    continue
                if line.startswith(b'ERROR:'):
                    code = line[6:-1].decode('ascii')
                    raise RepairRejected(code if code in REPAIR_CODES else 'WORKER_FAILED')
                require(line in (b'CREATED_EMPTY\n', b'ALREADY_EXACT_EMPTY\n'), 'WORKER_PROTOCOL')
                outcome = line[:-1].decode('ascii')
                require((outcome == 'CREATED_EMPTY') == acknowledged, 'WORKER_PROTOCOL')
                require(process.wait(timeout=max(0.001, deadline - time.monotonic())) == 0, 'WORKER_FAILED')
                return outcome
        raise RepairRejected('WORKER_PROTOCOL')
    finally:
        try:
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            if process.poll() is None:
                # No default commit on EOF, timeout, cancellation or parent failure.
                process.kill()
            process.wait(timeout=5)
            if binding.copy_mode and report is not None:
                report.safe_to_remove = True  # Reaped worker cannot use the copy.
        finally:
            process.stdout.close()


def run_action(deploy, operation, candidate, values, db, status_path, owner, unit, report, verify_existing):
    report.stage = 'PATH_INSPECT'
    with DatabaseBinding(db, owner.pw_uid) as binding:
        report.path_flags = binding.flags()
        if operation == 'inspect':
            verify_existing()
            binding.verify()
            return
        binding.require_trusted()
        core, staff = reference_ddl(candidate, {key: pair[1] for key, pair in deploy.REVIEWED_READER_TRANSITIONS.items()})

        def prepare(snapshot):
            def verify_copy():
                directory = snapshot.parent.lstat()
                metadata = snapshot.lstat()
                require(stat.S_ISDIR(directory.st_mode) and (directory.st_dev, directory.st_ino) == report.directory_identity and
                        stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and
                        (metadata.st_dev, metadata.st_ino) == report.snapshot_identity, 'COPY_IDENTITY_CHANGED')
            verify_copy()
            with DatabaseBinding(snapshot, owner.pw_uid, copy_mode=True) as copied:
                copied.require_trusted()
                worker_transaction(owner, copied, core, staff, verify_copy, report)
        # The exact copied DB is repaired by the app UID before any probe starts.
        # All existing namespace, route and complete before/after fingerprint
        # gates then run without any mutation exemption.
        deploy.rehearse(candidate, values, db, status_path, owner, unit, report, prepare_snapshot=prepare)
        require(report.failure is None and report.cleanup and report.safe_to_remove, 'COPY_PROOF_FAILED')
        report.copy_passed = True
        report.stage = 'LIVE_PRECHECK'
        verify_existing()
        binding.require_trusted()
        report.stage = 'LIVE_TRANSACTION'
        report.outcome = 'NOT_COMMITTED'
        report.outcome = worker_transaction(owner, binding, core, staff, verify_existing, report)
        report.stage = 'LIVE_POSTCHECK'
        verify_existing()
        binding.verify()


def main(deploy):
    class Report(deploy.RehearsalReport):
        def __init__(self):
            super().__init__()
            self.path_flags = None
            self.copy_passed = False
            self.outcome = 'NOT_ATTEMPTED'
        def fail(self, error):
            if self.failure is None and isinstance(error, RepairRejected) and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in REPAIR_CODES:
                self.failure = {'stage': self.stage, 'error': error.args[0]}
            else:
                super().fail(error)
        def emit(self):
            print(json.dumps({'schema': 'bubblewash-staff-schema-repair/v1', 'ok': self.failure is None,
                'operation': operation, 'stage': self.failure['stage'] if self.failure else 'COMPLETE',
                'error': self.failure['error'] if self.failure else 'NONE', 'outcome': self.outcome,
                'copyRehearsalPassed': self.copy_passed, 'cleanup': self.cleanup, 'activationAttempted': False,
                **({'pathChecks': self.path_flags} if self.path_flags is not None else {}),
                **({'readinessDiagnostic': self.readiness} if self.readiness is not None else {}),
                **({'schemaDiagnostic': self.schema} if self.schema is not None else {})}), flush=True)
    operation = 'inspect'
    report = Report()
    try:
        if '--operation' in sys.argv:
            index = sys.argv.index('--operation')
            require(index + 1 < len(sys.argv), 'INVALID_OPERATION')
            requested = sys.argv[index + 1]
            require(requested in ('inspect', 'repair'), 'INVALID_OPERATION')
            operation = requested
            del sys.argv[index:index + 2]
        require(operation in ('inspect', 'repair'), 'INVALID_OPERATION')
        def interrupted(*_):
            deploy.release_interrupted(report)
        def deadline(*_):
            raise deploy.RehearsalDeadline()
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGHUP, interrupted)
        signal.signal(signal.SIGALRM, deadline)
        signal.setitimer(signal.ITIMER_REAL, 300)
        with deploy.deployment_lock(deploy.RUNTIME, deploy.pwd.getpwnam('ubuntu').pw_uid) as lock_unchanged:
            deploy.main(lock_unchanged, report,
                        repair_action=lambda *args: run_action(deploy, operation, *args))
    except BaseException as error:
        report.fail(error)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        report.emit()
    return 1 if report.failure else 0


if __name__ == '__main__':
    # The workflow embeds the exact checked-out engine as this in-memory module;
    # neither script is installed on the host and no package is downloaded.
    sys.exit(main(deploy_preserving))
