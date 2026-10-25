#!/usr/bin/env python3
"""Pinned PWA-only release, reusing the existing code-only deploy adapter.

No schema operations, network configuration, unit installation, gate changes,
credentials, database restore or maintenance actions are introduced.
"""
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import types
import zlib

STATE = Path('/var/lib/bubblewash-release')
# Durable controller projection identity, not the materialized plan-file digest.
JOURNAL_PLAN = 'fa82c3eac9f920f86a04f45a64ec3a9259b567585fdd74ac30b06b7d7062dd65'
# The completed migration journal is historical evidence, not the live code pointer.
JOURNAL_TARGET_SHA = '5f256800d65dbe3b69f54e95afa0e8ab30b5e881'
BASE_SHA = '2af475865afe881bceac21bf641af76afda588ba'
DEPENDENCIES = ('deploy-preserving.py', 'deploy-survey-only.py', 'deploy-survey-update.py', 'survey-only-source-pins.json',
                'inactive-staging/prepare_pair.py', 'inactive-staging/stage_artifact.py')


def require(value):
    if not value: raise ValueError('PWA code-only release refused')


def release_state_snapshot(state=None, owner_uid=0):
    """Bind completed integration evidence and existing holds without changing any."""
    state = STATE if state is None else state
    require(state.resolve(strict=True) == state)
    directory = state.lstat()
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == owner_uid and stat.S_IMODE(directory.st_mode) == 0o755)
    result = {'directory': (directory.st_dev, directory.st_ino, directory.st_mode, directory.st_uid)}
    require(not os.path.lexists(state / 'app-hold'))
    for name in ('installed-v1', 'maintenance-hold', 'transition.json'):
        path = state / name
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == owner_uid and info.st_nlink == 1 and
                    not info.st_mode & 0o022 and info.st_size <= 65536)
            raw = stream.read(65537)
            fields = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
            identity = lambda value: tuple(getattr(value, field) for field in fields)
            require(len(raw) == info.st_size and identity(info) == identity(os.fstat(stream.fileno())) == identity(path.lstat()))
        if name == 'installed-v1': require(raw == b'bubblewash-release-gate-v1\n')
        if name == 'maintenance-hold': require(raw == b'held\n')
        if name == 'transition.json':
            journal = json.loads(raw)
            require(journal.get('schema') == 1 and journal.get('phase') == 'CANDIDATE_READY' and
                    journal.get('planHash') == JOURNAL_PLAN and isinstance(journal.get('target'), str) and
                    Path(journal['target']).is_absolute())
            result['journalTarget'] = journal['target']
        result[name] = (identity(info), hashlib.sha256(raw).hexdigest())
    return result


def bind_release_state(original, current):
    """Independently bind immutable migration evidence and this release baseline."""
    require(original['journalTarget'] == str(STATE / 'releases' / JOURNAL_TARGET_SHA))
    require(current == STATE / 'releases' / BASE_SHA)


def release_state_unchanged(original):
    if os.geteuid() == 0:
        require(release_state_snapshot() == original)
        return
    # The existing marker writer drops to ubuntu. It must not read the private
    # root journal or gain new access. Bind its unchanged inode/ctime/metadata;
    # full bytes are checked by the root parent before and after that callback.
    directory=STATE.lstat()
    require((directory.st_dev,directory.st_ino,directory.st_mode,directory.st_uid)==original['directory'])
    require(not os.path.lexists(STATE/'app-hold'))
    fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
    for name in ('installed-v1','maintenance-hold','transition.json'):
        info=(STATE/name).lstat()
        require(tuple(getattr(info,key) for key in fields)==original[name][0])


def configuration(values):
    require(values.get('BUBBLEWASH_STAFF_AUTH_DISABLED') == 'false' and
            values.get('BUBBLEWASH_BOOKINGS_DISABLED') == 'true' and
            values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN') == 'true' and
            values.get('NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED') == 'false' and
            values.get('NODE_ENV') in (None, 'production'))
    # The reused adapter binds every environment byte. Survey/email flags and
    # owner MFA are preserved, not switched by this presentation-only release.


def freeze_candidate(update, build, sha, owner):
    """Reuse only the prior reviewed archive/staging primitives, never migration."""
    prepare, stager = update.prepare, update.stager
    stager.protected_directory(STATE/'rehearsal-evidence',0)
    stager.protected_directory(STATE/'releases',0)
    private=STATE/'rehearsal-evidence'/('pwa-'+sha)
    private.mkdir(mode=0o700)  # Never reuse a partial or uncertain freeze.
    files,_=update.source_snapshot(build,owner)
    target,_=prepare.freeze(build,sha,private,owner.pw_uid,stager,
                            types.SimpleNamespace(digest=update.core.digest),files)
    require(target==STATE/'releases'/sha)
    stager.protected_directory(target,0)
    return target


def deploy(update, args):
    # The existing transition, with only the exact post-upgrade baseline root
    # adapted. Frozen source/rehearsal/activation primitives remain shared.
    core, guards, pins = update.core, update.guards, update.pins
    require, stage = update.require, update.stage
    verify_sources, rehearse_both = update.verify_sources, update.rehearse_both
    open_configuration = configuration
    os, pwd, re, time, tempfile = update.os, update.pwd, update.re, update.time, update.tempfile
    require(os.geteuid() == 0 and args.expected_live == pins['baseSha'] and args.sha == pins['runtimeSha'] and
            all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (args.sha, args.expected_live, args.store_sha)) and
            re.fullmatch(r'[a-f0-9]{64}', args.backup_sha256) and
            re.fullmatch(r'[1-9][0-9]*', args.receipt_run) and re.fullmatch(r'[1-9][0-9]*', args.store_id))
    owner = pwd.getpwnam('ubuntu')
    require(owner.pw_uid > 0)
    with core.deployment_lock(core.RUNTIME, owner.pw_uid) as lock_unchanged:
        candidate = Path(args.candidate)
        require(candidate.parent == core.HOME / 'bubblewash-releases' and
                re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + args.sha[:12], candidate.name))
        guards.safe_path(candidate, owner, True)
        require(guards.inspect_read(candidate / '.release-sha', owner, 'candidate', 128).decode().strip() == args.sha)
        require(core.CURRENT.is_symlink())
        current = core.CURRENT.resolve(strict=True)
        require(current != candidate and current == STATE / 'releases' / BASE_SHA and (current / '.next/BUILD_ID').is_file())
        marker_path = core.RUNTIME / 'current-release'
        marker_raw = guards.inspect_read(marker_path, owner, 'current')
        marker = core.parse(marker_raw)
        require(marker.get('sha') == pins['baseSha'] and marker.get('path') == str(current) and
                guards.inspect_read(current / '.release-sha', owner, 'current', 128).decode().strip() == pins['baseSha'])
        sources = verify_sources(current, candidate, owner)
        stage('config')
        raw, env_identity = guards.environment_snapshot(core.ENV, owner, None)
        config_hash = hashlib.sha256(raw).hexdigest()
        values = core.parse(raw)
        open_configuration(values)
        db = Path(values.get('BUBBLEWASH_DATABASE_PATH', ''))
        require(str(db) == values.get('BUBBLEWASH_DATABASE_PATH') and
                not db.is_relative_to(current) and not db.is_relative_to(candidate))
        stage('database')
        db_identity = guards.database_identity(db, owner)
        require(not (current / 'data/submissions.jsonl').exists() and not (candidate / 'data/submissions.jsonl').exists())
        stage('backup')  # Receipt pin failures must not be misreported as source.
        receipt_raw = guards.inspect_read(core.RECEIPT, owner, 'backup')
        receipt = json.loads(receipt_raw)
        require(receipt.get('sha256') == args.backup_sha256)
        status_path = Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH', ''))
        archive = Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR', '')) / receipt['filename']
        require(status_path.is_absolute() and archive.is_absolute())

        def identities():
            lock_unchanged()
            require(verify_sources(current, candidate, owner) == sources)
            stage('config')
            require(guards.environment_snapshot(core.ENV, owner, config_hash) == (raw, env_identity))
            stage('database')
            require(guards.database_identity(db, owner) == db_identity)

        def backup():
            stage('backup')
            require(guards.inspect_read(core.RECEIPT, owner, 'backup') == receipt_raw and
                    not archive.is_symlink() and archive.is_file() and archive.stat().st_size == receipt['size'] and
                    core.digest(archive) == args.backup_sha256)
            core.verify_receipt(receipt, json.loads(status_path.read_bytes()), time.time(),
                                args.receipt_run, args.store_sha, int(args.store_id))

        def baseline_bound():
            identities()
            require(core.CURRENT.resolve(strict=True) == current and
                    guards.inspect_read(marker_path, owner, 'current') == marker_raw)

        backup()
        stage('runtime')
        guards.runtime_flags(current, values, True)
        core.health(3000)
        unit = 'bubblewash-pwa-update-' + candidate.name
        stage('build')
        core.command(['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--unit=' + unit + '-build',
                      '--property=User=ubuntu', '--property=Group=ubuntu', '--property=WorkingDirectory=' + str(candidate),
                      '--property=RuntimeMaxSec=900', '--property=ProtectSystem=strict', '--property=ProtectHome=tmpfs',
                      '--property=BindPaths=' + str(candidate), '--property=ReadWritePaths=' + str(candidate),
                      '--property=PrivateTmp=true', '--property=NoNewPrivileges=true',
                      '/usr/bin/env', 'HOME=' + str(candidate), 'NEXT_TELEMETRY_DISABLED=1', '/bin/bash', '-c',
                      'npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund'], timeout=930)
        verify_sources(current, candidate, owner)
        candidate = freeze_candidate(update, candidate, args.sha, owner)
        sources = verify_sources(current, candidate, owner)
        rehearse_both(current, candidate, values, db, status_path, owner, unit)
        baseline_bound()
        backup()
        stage('runtime')
        guards.runtime_flags(current, values, True)

        def write_marker(content):
            def write_as_app():
                identities()
                with tempfile.NamedTemporaryFile(dir=core.RUNTIME, prefix='.release-marker-', delete=False) as handle:
                    handle.write(content)
                    os.fchmod(handle.fileno(), 0o600)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(handle.name, marker_path)
            guards.migrate_as_app(owner, write_as_app)
            identities()

        def validate(target):
            stage('verification')
            require(target in (current, candidate))
            core.health(3000)
            guards.runtime_flags(target, values, True)
            core.public_health()
            identities()
            backup()
            write_marker((f'sha={args.sha}\nrelease={candidate.name}\npath={candidate}\n'.encode()
                          if target == candidate else marker_raw))

        def service(action, name):
            stage('switch')
            return core.ctl(action, name)

        # No migration_service wrapper. The only production service actions are
        # the existing stop/start and code-only rollback to this exact live tree.
        stage('switch')
        core.activate(core.CURRENT, candidate, service, validate)
        print('{"ok":true,"codeOnly":true,"configurationUnchanged":true,"databaseRestored":false}', flush=True)


def configure(pins, sources):
    require(pins.get('schema') == 'bubblewash-pwa-update/v1' and pins.get('baseSha') == BASE_SHA)
    require(set(sources) == set(DEPENDENCIES) == set(pins['dependencies']))
    require(all(hashlib.sha256(sources[name].encode()).hexdigest() == pins['dependencies'][name] for name in sources))
    def module(name, filename):
        result = types.ModuleType(name)
        exec(compile(sources[filename], filename, 'exec'), result.__dict__)
        return result
    core = module('pwa_preserving', 'deploy-preserving.py')
    guards = module('pwa_guards', 'deploy-survey-only.py')
    update = module('pwa_update', 'deploy-survey-update.py')
    update.prepare = module('pwa_freeze', 'inactive-staging/prepare_pair.py')
    update.stager = module('pwa_stage', 'inactive-staging/stage_artifact.py')
    guards.core = core
    guards.pins = json.loads(sources['survey-only-source-pins.json'])
    update.core, update.guards, update.pins = core, guards, pins
    update.open_configuration = configuration
    update.deploy = lambda args: deploy(update, args)
    # Exact environment verification is already done by check_runtime. Do not
    # impose historical survey activation flags on today's unchanged config.
    guards.runtime_flags = lambda target, values, enabled=False: core.check_runtime(target, values)
    original_lock = core.deployment_lock
    @contextmanager
    def locked(runtime, uid):
        with original_lock(runtime, uid) as verify_lock:
            original = release_state_snapshot()
            bind_release_state(original, core.CURRENT.resolve(strict=True))
            def unchanged():
                verify_lock()
                release_state_unchanged(original)
            unchanged()
            yield unchanged
    core.deployment_lock = locked
    return update


def read_inputs():
    here = Path(__file__).resolve().parent
    pins = json.loads((here / 'pwa-update-source-pins.json').read_bytes())
    sources = {name: (here / name).read_text() for name in DEPENDENCIES}
    return pins, sources


def entry(pins, sources):
    configure(pins, sources).entry()


def main():
    pins, sources = read_inputs()
    update = configure(pins, sources)
    if sys.argv[1:] == ['--check-runtime']:
        update.verify_checkout(Path('runtime-artifact').resolve(strict=True), os.environ.get('RUNTIME_SHA'),
                               types.SimpleNamespace(pw_uid=os.getuid()))
        print('{"ok":true,"exactPwaRuntime":true}')
    elif sys.argv[1:] == ['--check-hosted-runs']:
        update.check_hosted_runs()
    elif sys.argv[1:] == ['--emit']:
        payload = {'pins': pins, 'sources': sources, 'adapter': Path(__file__).read_text()}
        encoded = base64.b64encode(zlib.compress(json.dumps(payload, separators=(',', ':')).encode())).decode()
        print("import base64,json,types,zlib\np=json.loads(zlib.decompress(base64.b64decode(" + repr(encoded) + ")))\n"
              "m=types.ModuleType('pwa_code_only'); exec(compile(p['adapter'],'pwa-code-only','exec'),m.__dict__); m.entry(p['pins'],p['sources'])")
    else:
        raise SystemExit('Use the reviewed PWA update workflow.')


if __name__ == '__main__': main()
