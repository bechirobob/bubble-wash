"""Host-only authenticated backup-copy attestation; never opens live SQLite files."""
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import shutil
import signal
import sqlite3
import stat
import subprocess
import time

MAX_BYTES = 64 * 1024 * 1024
LIVE = '277a3f8df85068f3245ddc30a6c446d10d9bdc39'
NODE_SHA = '81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90'
DDL = 'CREATE TABLE staff_admin_permissions (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), operational_workspaces INTEGER NOT NULL CHECK (operational_workspaces IN (0, 1)), survey_results INTEGER NOT NULL CHECK (survey_results IN (0, 1)))'
DECRYPT = r"""const fs=require('node:fs'),c=require('node:crypto');const p=JSON.parse(fs.readFileSync(0,'utf8'));const b=Buffer.from(p.archive,'base64'),k=Buffer.from(p.key,'base64');if(k.length!==32||b.length<=37||b.length>67108901||b.subarray(0,9).toString()!=='BWBACKUP1')throw Error('refused');const d=c.createDecipheriv('aes-256-gcm',k,b.subarray(9,21));d.setAuthTag(b.subarray(21,37));const plain=Buffer.concat([d.update(b.subarray(37)),d.final()]);process.stdout.write(plain);"""
core = guards = scanner = pins = None


def require(ok):
    if not ok:
        raise ValueError('backup schema attestation refused')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def validate(request):
    require(type(request) is dict and set(request) == {'controlSha', 'runId', 'runAttempt', 'runtimeSha', 'backupSha256', 'receiptRun', 'storeSha', 'storeId'})
    for key in ('controlSha', 'runtimeSha', 'storeSha'):
        require(type(request[key]) is str and re.fullmatch('[a-f0-9]{40}', request[key]))
    for key in ('runId', 'receiptRun'):
        require(type(request[key]) is str and re.fullmatch('[1-9][0-9]{0,19}', request[key]))
    require(request['runtimeSha'] == LIVE and request['runAttempt'] == '1' and request['storeId'] == '1403152795')
    require(type(request['backupSha256']) is str and re.fullmatch('[a-f0-9]{64}', request['backupSha256']))


def validate_marker(marker, current):
    # Match the unchanged release writer, including its directory-name binding.
    require(marker == {'sha': LIVE, 'release': current.name, 'path': str(current)})


def decrypt(archive, key):
    require(37 < len(archive) <= MAX_BYTES + 37)
    require(type(key) is str and base64.b64encode(base64.b64decode(key, validate=True)).decode() == key and len(base64.b64decode(key)) == 32)
    result = subprocess.run(['/usr/bin/node', '-e', DECRYPT], input=canonical({'archive': base64.b64encode(archive).decode(), 'key': key}),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
                            env={'PATH': '/usr/bin:/bin'}, cwd='/', check=False)
    require(result.returncode == 0 and not result.stderr and 100 <= len(result.stdout) <= MAX_BYTES)
    require(result.stdout.startswith(b'SQLite format 3\0'))
    return result.stdout


def bounded_sqlite(db):
    deadline = time.monotonic() + 15
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_BYTES)
    db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 1024 * 1024)


def protected_backup_path(path, values, owner):
    require(path.is_absolute())
    database = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
    require(database.is_absolute() and database.resolve(strict=True) == database)
    forbidden = {str(database) + suffix for suffix in ('', '-wal', '-shm', '-journal')}
    require(str(path) not in forbidden and str(path.resolve(strict=True)) not in forbidden)
    return guards.safe_path(path, owner)


def check_directory(fd, owner):
    info = os.fstat(fd)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, owner.pw_uid) and not info.st_mode & 0o022)


def read_backup(path, values, owner, limit=65536):
    protected_backup_path(path, values, owner)
    directories, bindings = [], []
    leaf = reader = None
    fields = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
    identity = lambda info: tuple(getattr(info, key) for key in fields)
    try:
        directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        directories.append(directory); check_directory(directory, owner)
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            directories.append(child); check_directory(child, owner)
            bindings.append((directory, component, os.fstat(child).st_dev, os.fstat(child).st_ino))
            directory = child
        # Pin metadata before any content open/read. Reopening our held descriptor
        # cannot follow a concurrently replaced ancestor or leaf pathname.
        leaf = os.open(path.name, os.O_PATH | os.O_NOFOLLOW, dir_fd=directory)
        info = os.fstat(leaf)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid in (0, owner.pw_uid) and not info.st_mode & 0o022 and info.st_size <= limit)
        for suffix in ('', '-wal', '-shm', '-journal'):
            try: forbidden = os.stat(values['BUBBLEWASH_DATABASE_PATH'] + suffix, follow_symlinks=False)
            except FileNotFoundError: continue
            require((info.st_dev, info.st_ino) != (forbidden.st_dev, forbidden.st_ino))
        reader = os.open('/proc/self/fd/' + str(leaf), os.O_RDONLY | os.O_NONBLOCK)
        require(identity(os.fstat(reader)) == identity(info))
        chunks, size = [], 0
        while chunk := os.read(reader, min(65536, limit + 1 - size)):
            chunks.append(chunk); size += len(chunk); require(size <= limit)
        require(size == info.st_size and identity(os.fstat(reader)) == identity(info))
        require(identity(os.stat(path.name, dir_fd=directory, follow_symlinks=False)) == identity(info))
        for parent, name, device, inode in bindings:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISDIR(current.st_mode) and (current.st_dev,current.st_ino) == (device,inode))
        return b''.join(chunks)
    finally:
        for fd in (reader, leaf, *reversed(directories)):
            if fd is not None: os.close(fd)


def clean_scratch(scratch):
    signal.alarm(0)
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGALRM})
    try:
        if scratch is not None:
            shutil.rmtree(scratch)
            require(not scratch.exists())
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def schema(db):
    rows = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
    require(0 < len(rows) <= 512 and len(canonical(rows)) <= 1024 * 1024)
    require(all(row[0] in ('table', 'index') and (row[3] is None or not re.search(r'\bVIRTUAL\s+TABLE\b', row[3], re.I)) for row in rows))
    require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)] and not db.execute('PRAGMA foreign_key_check').fetchall())
    return rows


def snapshot_hashes(plain, directory):
    """Only caller-created private scratch; no source database parameter."""
    require(100 <= len(plain) <= MAX_BYTES and plain.startswith(b'SQLite format 3\0'))
    original = directory/'snapshot.sqlite'
    after = directory/'after.sqlite'
    for path in (original, after):
        with path.open('xb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(plain)
    db = sqlite3.connect(original.as_uri()+'?mode=ro&immutable=1', uri=True)
    try:
        bounded_sqlite(db)
        db.execute('PRAGMA trusted_schema=OFF'); db.execute('PRAGMA temp_store=MEMORY'); db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
        before_rows = schema(db)
    finally:
        db.close()
    require(original.read_bytes() == plain and sorted(p.name for p in directory.iterdir()) == ['after.sqlite', 'snapshot.sqlite'])
    # DDL executes only on a second complete, disposable copy, never the original.
    db = sqlite3.connect(after)
    try:
        bounded_sqlite(db)
        db.execute('PRAGMA trusted_schema=OFF'); db.execute('PRAGMA temp_store=MEMORY')
        db.execute('PRAGMA foreign_keys=ON'); db.execute('BEGIN IMMEDIATE')
        require(schema(db) == before_rows)
        existing = [row for row in before_rows if row[1] == 'staff_admin_permissions']
        if existing:
            require(existing == [('table', 'staff_admin_permissions', 'staff_admin_permissions', DDL)])
        else:
            db.execute(DDL)
        after_rows = schema(db)
        require([row for row in after_rows if row[2] == 'staff_admin_permissions'] == [('index', 'sqlite_autoindex_staff_admin_permissions_1', 'staff_admin_permissions', None), ('table', 'staff_admin_permissions', 'staff_admin_permissions', DDL)])
        require([row for row in after_rows if row[2] != 'staff_admin_permissions'] == [row for row in before_rows if row[2] != 'staff_admin_permissions'])
        return hashlib.sha256(canonical(before_rows)).hexdigest(), hashlib.sha256(canonical(after_rows)).hexdigest()
    finally:
        if db.in_transaction: db.rollback()
        db.close()


def diagnostics():
    # Only code-selected labels/statuses; never copy request or exception values.
    return {'phase': 'request', 'configurationRead': 'not-started',
            'decryption': 'not-started', 'scratchCreation': 'not-started',
            'cleanup': 'not-applicable'}


def attest(request, progress=None):
    if progress is None:
        progress = diagnostics()
    validate(request)
    require(os.geteuid() == 0)
    owner = pwd.getpwnam('ubuntu')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    def stop(*_): raise ValueError('attestation interrupted')
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGALRM, stop); signal.alarm(120)
    scratch = None
    try:
        progress['phase'] = 'deployment-lock'
        with core.deployment_lock(core.RUNTIME, owner.pw_uid) as unchanged:
            progress['phase'] = 'release-marker'
            current = core.CURRENT.resolve(strict=True)
            require(core.CURRENT.is_symlink())
            marker_path = core.RUNTIME/'current-release'
            marker_raw = guards.inspect_read(marker_path, owner, 'current')
            marker = core.parse(marker_raw)
            validate_marker(marker, current)
            progress['phase'] = 'runtime-source'
            require(guards.inspect_read(current/'.release-sha', owner, 'current', 128).decode().strip() == LIVE)
            require(pins['runtimeSha'] == LIVE and core.source_manifest(current) == pins['candidateSource'])
            source_files, source_identity = scanner.source_snapshot(current, owner)
            require(scanner.content_commitment(source_files) == pins['runtimeContent'])
            progress['phase'] = 'configuration'
            progress['configurationRead'] = 'started'
            raw, env_identity = guards.environment_snapshot(core.ENV, owner, None)
            progress['configurationRead'] = 'completed'
            values = core.parse(raw)
            require('BUBBLEWASH_UAT_ENABLED' not in values and values.get('NODE_ENV') in (None, 'production'))
            progress['phase'] = 'runtime-process'
            core.check_runtime(current, values)  # Process/config reads only; no health endpoint.
            progress['phase'] = 'backup-receipt'
            protected_backup_path(core.RECEIPT, values, owner)
            receipt_raw = read_backup(core.RECEIPT, values, owner)
            receipt = json.loads(receipt_raw)
            status_path = Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH', ''))
            archive = Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR', ''))/receipt['filename']
            require(status_path.is_absolute() and archive.is_absolute())
            protected_backup_path(status_path, values, owner)
            protected_backup_path(archive, values, owner)
            guards.safe_path(core.RECEIPT, owner)
            status_raw = read_backup(status_path, values, owner)
            core.verify_receipt(receipt, json.loads(status_raw), time.time(), request['receiptRun'], request['storeSha'], int(request['storeId']))
            require(receipt['sha256'] == request['backupSha256'] and 37 < receipt['size'] <= MAX_BYTES + 37)
            progress['phase'] = 'backup-archive'
            archive_bytes = read_backup(archive, values, owner, MAX_BYTES + 37)
            require(len(archive_bytes) == receipt['size'] and hashlib.sha256(archive_bytes).hexdigest() == request['backupSha256'])
            progress['phase'] = 'node-identity'
            node = Path('/usr/bin/node')
            require(node.resolve(strict=True) == node and node.stat().st_uid == 0 and not node.stat().st_mode & 0o022 and core.digest(node) == NODE_SHA)
            # Existing key is used only inside this host process and its private pipe.
            progress['phase'] = 'scratch-guard'
            guards.safe_path(Path('/run'), pwd.getpwuid(0), True)
            require(not list(Path('/run').glob('bubblewash-schema-attestation-*')))
            scratch_path = Path('/run')/('bubblewash-schema-attestation-'+request['runId'])
            progress['phase'] = 'scratch-create'
            progress['scratchCreation'] = 'started'
            progress['cleanup'] = 'unknown'
            scratch_path.mkdir(mode=0o700)
            scratch = scratch_path
            progress['scratchCreation'] = 'completed'
            progress['phase'] = 'decryption'
            progress['decryption'] = 'started'
            plain = decrypt(archive_bytes, values.get('BUBBLEWASH_BACKUP_ENCRYPTION_KEY'))
            progress['decryption'] = 'completed'
            progress['phase'] = 'snapshot-schema'
            before_hash, after_hash = snapshot_hashes(plain, scratch)
            del plain
            progress['phase'] = 'binding-revalidation'
            unchanged()
            require(core.CURRENT.resolve(strict=True) == current and guards.inspect_read(marker_path, owner, 'current') == marker_raw)
            require(guards.environment_snapshot(core.ENV, owner, hashlib.sha256(raw).hexdigest()) == (raw, env_identity))
            require(scanner.source_snapshot(current, owner) == (source_files, source_identity))
            core.check_runtime(current, values)
            protected_backup_path(status_path, values, owner)
            protected_backup_path(archive, values, owner)
            protected_backup_path(core.RECEIPT, values, owner)
            require(read_backup(core.RECEIPT, values, owner) == receipt_raw and read_backup(status_path, values, owner) == status_raw)
            require(read_backup(archive, values, owner, MAX_BYTES + 37) == archive_bytes)
            core.verify_receipt(receipt, json.loads(status_raw), time.time(), request['receiptRun'], request['storeSha'], int(request['storeId']))
            result = {'schema': 'bubblewash-backup-schema-attestation/v1', 'context': request,
                      'snapshotOnly': True, 'liveDatabaseOpened': False, 'liveSchemaVerified': False,
                      'schemaBeforeSha256': before_hash, 'schemaAfterSha256': after_hash,
                      'permissionDdlSha256': hashlib.sha256(DDL.encode()).hexdigest(),
                      'runtimeContentSha256': pins['runtimeContent']['sha256'],
                      'archiveSize': receipt['size'], 'backupCreatedAt': json.loads(status_raw)['createdAt'],
                      'checkedAt': core.dt.datetime.now(core.dt.timezone.utc).isoformat()}
        return result
    finally:
        if scratch is not None:
            progress['cleanup'] = 'started'
        try:
            clean_scratch(scratch)
        except Exception:
            progress['phase'] = 'cleanup'
            raise
        if scratch is not None:
            progress['cleanup'] = 'removed-verified'


def main(request):
    progress = diagnostics()
    try:
        result = attest(request, progress)
    except Exception:
        # Fixed failure only: never serialize SQL, config, keys, filenames or stderr.
        print(json.dumps({'schema': 'bubblewash-backup-schema-attestation/v1',
                          'state': 'blocked-inspect-outcome-before-retry',
                          'diagnostics': progress}, sort_keys=True))
        raise SystemExit(1)
    print(json.dumps({**result, 'scratchRemoved': True}, sort_keys=True))
