"""Review-only migration transition. No CLI and no production invocation.

Reuses deployment-era service callbacks and SQLite backup semantics. The live
adapter/approval receipt is deliberately not inferred from a synthetic run.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import stat

APP = 'bubblewash-local.service'
MAINTENANCE = 'bubblewash-maintenance.service'
TIMER = 'bubblewash-maintenance.timer'
UNITS = (('system', TIMER), ('system', MAINTENANCE), ('user', APP))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_release(root, manifest):
    """Pin the entire source/dependency/build set, not just a mutable build ID."""
    root = Path(root)
    require(root.is_dir() and not root.is_symlink() and root.resolve() == root, 'noncanonical release')
    expected = manifest['files']
    actual = set()
    for directory in ('src', 'public', '.next', 'scripts', 'ops'):
        require((root / directory).is_dir() and not (root / directory).is_symlink(), 'release root symlink or missing')
        for path in (root / directory).rglob('*'):
            if directory == '.next' and path.relative_to(root / '.next').parts[0] == 'cache':
                continue
            require(not path.is_symlink(), 'release symlink')
            require(path.is_dir() or stat.S_ISREG(path.stat().st_mode), 'nonregular release object')
            if path.is_file():
                actual.add(str(path.relative_to(root)))
    actual.update(('package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json'))
    for name in ('package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json'):
        require(not (root / name).is_symlink() and stat.S_ISREG((root / name).stat().st_mode), 'invalid runtime configuration file')
    require(actual == set(expected), 'release file set changed')
    require(all(digest(root / name) == value for name, value in expected.items()), 'release hash changed')
    require(digest(root / '.next/BUILD_ID') == manifest['buildIdSha256'], 'build ID changed')


def parse_properties(raw):
    values = {}
    for line in raw.splitlines():
        key, separator, value = line.partition('=')
        require(separator and key not in values, 'invalid service inspection')
        values[key] = value
    return values


def inspect_quiescence(show, cgroups, releases, uid, listeners, captured_identities, proc=Path('/proc')):
    """Read-only evidence. show(manager, unit) must execute the correct manager.

    cgroups are the previously captured, verified cgroup directories, retained
    even after systemd clears ControlGroup on stop. No output contains argv/env.
    """
    for manager, unit in UNITS:
        state = parse_properties(show(manager, unit))
        require(state.get('LoadState') == 'loaded' and state.get('ActiveState') == 'inactive'
                and state.get('SubState') == 'dead', 'unit not fully stopped')
        if unit != TIMER:
            for field in ('MainPID', 'ControlPID'):
                require(state.get(field) == '0', 'unit process remains or is unknown')
        require('Job' in state and state['Job'] == '', 'service job remains or is unknown')
    require(isinstance(cgroups, dict) and len(cgroups) == 2 and all(isinstance(group, Path) for group in cgroups), 'cgroup inventory incomplete')
    for group, identity in cgroups.items():
        require(not group.is_symlink(), 'untrusted cgroup path')
        if not group.exists():
            continue  # A captured systemd cgroup can disappear after all tasks exit.
        require((group.stat().st_dev, group.stat().st_ino) == tuple(identity), 'captured cgroup replaced')
        for path in (group, *group.rglob('*')):
            require(not path.is_symlink(), 'cgroup symlink')
            if path.is_dir():
                values = (path / 'cgroup.procs').read_text().strip()
                require(not values, 'cgroup descendant task remains')
    require(listeners() == '', 'application listener remains or inspection ambiguous')
    require(isinstance(captured_identities, dict), 'pre-stop process identity inventory missing')
    for pid, start_time in captured_identities.items():
        require(str(pid).isdigit() and str(start_time).isdigit(), 'invalid captured process identity')
        require(not (proc / str(pid)).exists(), 'captured process survives or PID was reused')
    release_paths = tuple(str(Path(path).resolve()).encode() for path in releases)
    require(len(release_paths) >= 3, 'release process inventory incomplete')
    for process in proc.iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid != uid:
                continue
            stat = (process / 'stat').read_text()
            if stat.rsplit(')', 1)[1].strip().split()[0] == 'Z':
                continue  # A reaped-pending zombie cannot dispatch.
            command = (process / 'cmdline').read_bytes()
            cwd = os.readlink(process / 'cwd').encode()
            require(not any(cwd == root or cwd.startswith(root + b'/') or root in command for root in release_paths),
                    'release process survives')
        except FileNotFoundError:
            require(not process.exists(), 'process inspection incomplete')
    return True


def accept_readiness(status, headers, body):
    require(status == 200 and isinstance(body, dict) and body.get('ok') is True
            and body.get('service') == 'Bubble Wash operations app'
            and body.get('readiness') == 'ready' and body.get('bookings') == 'paused'
            and body.get('checks') == [] and headers.get('cache-control') == 'no-store',
            'exact authenticated readiness not satisfied')
    return True


def consistent_backup(database, backup):
    """Use standard SQLite backup into a new destination; never restore over DB."""
    database, backup = Path(database), Path(backup)
    require(not any(character in str(path) for path in (database, backup) for character in ('?', '#')), 'unsupported backup path')
    require(not backup.exists() and not backup.is_symlink(), 'backup destination exists')
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    source = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    destination = sqlite3.connect(backup)
    try:
        source.backup(destination)
        require(destination.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'backup integrity failed')
    finally:
        destination.close()
        source.close()
    # Restore-verify into an independent read-only connection, not over live DB.
    with sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True) as restored:
        require(restored.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'reopened backup integrity failed')
    require(database_fingerprint(database) == database_fingerprint(backup), 'restored backup differs from source')


def database_fingerprint(path):
    # Reuse the exact live preserving-release fingerprint, without changing it.
    source = Path(__file__).resolve().parent.parent / 'bubblewash-web-a476-baseline/ops/deploy-preserving.py'
    require(digest(source) == '29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a', 'baseline fingerprint implementation drift')
    spec = importlib.util.spec_from_file_location('pinned_preserving', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.database_fingerprint(path)


def switch_pointer(current, target):
    temporary = current.parent / ('.migration-switch-' + str(os.getpid()))
    require(not temporary.exists() and not temporary.is_symlink(), 'switch path already exists')
    try:
        temporary.symlink_to(target)
        os.replace(temporary, current)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def transition(*, current, old, candidate, fallback, database, backup, manifests,
               service, quiescent, migrate, verify_database, readiness, invariant,
               external_invokers_excluded):
    """Exact stop/migrate/start/fallback order; callbacks are explicit boundaries.

    service(manager, action, unit), readiness(target) must fail on any ambiguity.
    invariant rechecks release lock, unchanged config/backup receipts, and pins.
    migrate uses only the reviewed atomic outbox helper on the existing DB.
    No fallback is attempted unless the committed schema/evidence was verified.
    Maintenance remains stopped, even after success, pending separate acceptance.
    """
    current, old, candidate, fallback = map(Path, (current, old, candidate, fallback))
    database = Path(database)
    require(external_invokers_excluded is True, 'external/direct invokers not excluded')
    require(current.is_symlink() and current.resolve(strict=True) == old, 'live pointer changed')
    require(len({old, candidate, fallback}) == 3, 'fallback must be independent')
    require(database.is_file() and not database.is_symlink() and database.resolve() == database
            and not any(database.is_relative_to(root) for root in (old, candidate, fallback)), 'unstable database path')

    identity = database.stat()
    require(stat.S_ISREG(identity.st_mode) and identity.st_nlink == 1, 'database must be regular single-link file')

    def pinned():
        actual = database.lstat()
        require(stat.S_ISREG(actual.st_mode) and actual.st_nlink == 1
                and (actual.st_dev, actual.st_ino) == (identity.st_dev, identity.st_ino), 'database identity changed')
        require(invariant() is True, 'runtime invariants unproven')
        verify_release(candidate, manifests['candidate'])
        verify_release(fallback, manifests['fallback'])

    def stop_and_prove():
        # Never swallow a stop failure and then start another writer.
        failures = []
        for manager, unit in UNITS:
            try:
                service(manager, 'stop', unit)
            except BaseException as error:
                failures.append(error)
        require(quiescent() is True, 'quiescence unproven')
        if failures:
            raise failures[0]

    pinned()
    stop_and_prove()
    try:
        consistent_backup(database, backup)
        pinned()
        require(quiescent() is True, 'quiescence lost before migration')
        # A failed or uncertain migration/verification leaves all writers stopped.
        require(migrate(database) is True, 'migration outcome unproven')
        require(verify_database(database) is True, 'database acceptance unproven')
        pinned()
        require(quiescent() is True, 'quiescence lost after migration')
    except BaseException:
        stop_and_prove()
        raise
    try:
        switch_pointer(current, candidate)
        service('user', 'start', APP)
        require(readiness(candidate) is True, 'candidate readiness unproven')
        pinned()
        return {'state': 'candidate-ready', 'maintenance': 'stopped', 'databaseRestored': False}
    except BaseException as candidate_failure:
        stop_and_prove()
        if not isinstance(candidate_failure, Exception):
            raise
        # Never restore a stale backup or call the old preserving activate().
        pinned()
        require(verify_database(database) is True, 'fallback database acceptance unproven')
        switch_pointer(current, fallback)
        try:
            service('user', 'start', APP)
            require(readiness(fallback) is True, 'fallback readiness unproven')
            pinned()
        except BaseException:
            stop_and_prove()
            raise
        return {'state': 'fallback-ready', 'candidateFailure': type(candidate_failure).__name__,
                'maintenance': 'stopped', 'databaseRestored': False}
