"""Appended to reviewed preflight source in SSH stdin; never installed on host."""
import fcntl
from contextlib import contextmanager
import pwd
import stat
import hashlib
import os
import signal


def require(value, message):
    if not value:
        raise ValueError(message)


@contextmanager
def deployment_lock(runtime, app_uid):
    """Use the existing shared inode, without following links or creating files."""
    require(runtime.resolve(strict=True) == runtime, 'runtime path must be canonical')
    directory = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        directory_stat = os.fstat(directory)
        require(stat.S_ISDIR(directory_stat.st_mode) and directory_stat.st_uid in (0, app_uid) and
                not directory_stat.st_mode & 0o022, 'unsafe runtime directory')
        lock = os.open('deploy.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        lock_stat = os.fstat(lock)
        require(stat.S_ISREG(lock_stat.st_mode) and lock_stat.st_nlink == 1 and
                lock_stat.st_uid in (0, app_uid) and not lock_stat.st_mode & 0o022, 'unsafe existing deployment lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

        def unchanged():
            current_directory = runtime.lstat()
            current_lock = os.stat('deploy.lock', dir_fd=directory, follow_symlinks=False)
            fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink')
            require(runtime.resolve(strict=True) == runtime and
                    all(getattr(current_directory, key) == getattr(directory_stat, key) for key in fields) and
                    all(getattr(current_lock, key) == getattr(lock_stat, key) for key in fields) and
                    os.fstat(lock).st_nlink == 1, 'shared deployment lock identity changed')
        unchanged()
        yield unchanged
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)



def enrollment_source_matches(release, pins):
    required = {'scripts/invite-additional-owner.mjs', 'src/lib/staff-accounts.ts', 'src/lib/admin-mfa.ts',
                'src/lib/auth.ts', 'src/app/api/login/route.ts', 'src/app/api/admin/mfa/enroll/route.ts', 'src/components/LoginPage.tsx',
                'src/lib/data-store.ts', 'src/lib/passwords.ts', 'src/lib/mfa-encryption.ts', 'src/lib/dispatch-location.ts', 'package-lock.json'}
    if not required.issubset(pins) or pins.get('src/lib/staff-accounts.ts') != '2a2b8ad36790308070ab0d0c9451bd959c5ed647900033e3b0153713b74a423c':
        return False
    for relative, digest in pins.items():
        path = release / relative
        if Path(relative).is_absolute() or '..' in Path(relative).parts or path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(release.resolve()):
            return False
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            return False
    return True


def owner_production_proven(configured, inspection):
    # Explicit conflicts never borrow a different process's production setting.
    if 'NODE_ENV' in configured:
        return configured['NODE_ENV'] == 'production'
    if any(flag_state(configured.get(k)) == 'other' for k in LOGIN_FLAGS):
        return False
    proof = inspection.get('staffRestorationInspection', {})
    runtime = proof.get('runtime', {})
    required = ('serviceActive', 'workingDirectoryMatchesCurrent', 'environmentFileMatchesExpected',
                'mainProcessDirectoryMatchesCurrent', 'uniqueListener', 'listenerDirectoryMatchesCurrent',
                'listenerIsNode', 'listenerSameServiceCgroup', 'listenerStableDuringRead', 'mainStableDuringRead')
    if proof.get('currentTargetStableDuringRead') is not True or not all(runtime.get(k) is True for k in required):
        return False
    listener = runtime.get('listenerFlags', {})
    main = runtime.get('mainProcessFlags', {})
    if listener.get('productionMode') is not True or listener.get('productionModePresent') is not True:
        return False
    if main.get('productionModePresent') is True and main.get('productionMode') is not True:
        return False
    return all(listener.get(k) == flag_state(configured.get(k)) and main.get(k) == flag_state(configured.get(k)) for k in LOGIN_FLAGS)


def run_private_enrollment(email, expected_live_sha, actor, mode, delivery_approved, pins, owner_key=""):
    # This boolean is an explicit workflow dispatch attestation, not permission
    # inferred from the original account grant. Sender/risk approval comes first.
    if mode not in ('check', 'send') or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?', actor):
        return {'ok': False, 'state': 'invalid-private-request', 'accountCreated': False}
    if mode == 'send' and delivery_approved is not True:
        return {'ok': False, 'state': 'delivery-approval-required', 'accountCreated': False}
    if not owner_key or len(owner_key) > 4096 or not owner_key.isascii() or any(c.isspace() for c in owner_key):
        return {'ok':False, 'state':'dedicated-owner-transport-required', 'accountCreated':False}
    if not release_pin_matches(expected_live_sha):
        return {'ok': False, 'state': 'release-pin-mismatch', 'accountCreated': False}
    release = CURRENT.resolve(strict=True)
    if not enrollment_source_matches(release, pins):
        return {'ok': False, 'state': 'owner-source-pin-mismatch', 'accountCreated': False}
    with deployment_lock(HOME / 'bubblewash-runtime', pwd.getpwnam('ubuntu').pw_uid) as lock_unchanged:
        lock_unchanged()
        environment_snapshot = bounded_text(ENV_FILE)
        inspection = collect(email, expected_live_sha)
        if bounded_text(ENV_FILE) != environment_snapshot:
            return {'ok':False, 'state':'environment-drift', 'accountCreated':False}
        configured = parse_env(environment_snapshot)
        owner = inspection.get('ownerInspection', {})
        config = inspection.get('configuration', {})
        if not owner.get('completed') or owner.get('duplicatePresent') or not inspection.get('legacyImportAbsent') or not owner_production_proven(configured, inspection) or config.get('staffAuthDisabled') or not config.get('demoDisabled') or not config.get('sqliteConfigured') or not owner.get('personalMfaKeyReady'):
            return {'ok': False, 'state': 'private-preflight-blocked', 'accountCreated': False,
                    'duplicatePresent': owner.get('duplicatePresent') if owner.get('completed') else None}
        # No env evaluation, shell, NODE_OPTIONS, preload injection, or env files
        # containing private inputs. Existing runtime values stay in process memory.
        env = {k:v for k,v in configured.items() if (k.startswith('BUBBLEWASH_') or k == 'NODE_ENV') and k not in ('BUBBLEWASH_EMAIL_FROM', 'BUBBLEWASH_OWNER_RESEND_KEY')}
        env.update({'PATH':'/usr/local/bin:/usr/bin:/bin', 'HOME':'/home/ubuntu', 'NODE_ENV':'production',
                    'BUBBLEWASH_OWNER_RESEND_KEY':owner_key, 'BUBBLEWASH_OWNER_EMAIL':email, 'BUBBLEWASH_OWNER_NAME':'Personal Owner',
                    'BUBBLEWASH_OWNER_INVITED_BY':'github-actions:' + actor})
        env.pop('BUBBLEWASH_OWNER_INVITE_CONFIRM', None)
        if mode == 'send':
            backup = inspection.get('backup', {})
            if not all(backup.get(key) is True for key in ('statusAgeWithin30Hours', 'statusMetadataValid', 'receiptAgeWithin30Hours', 'receiptMetadataValid')):
                return {'ok':False, 'state':'verified-recent-backup-required', 'accountCreated':False}
            env['BUBBLEWASH_OWNER_INVITE_CONFIRM'] = email
        if bounded_text(ENV_FILE) != environment_snapshot:
            return {'ok':False, 'state':'environment-drift', 'accountCreated':False}
        if not release_pin_matches(expected_live_sha) or not enrollment_source_matches(release, pins):
            return {'ok':False, 'state':'release-or-source-drift', 'accountCreated':False}
        command = ['runuser','-u','ubuntu','--','/usr/bin/env','node','--conditions=react-server','--experimental-strip-types',
                   'scripts/invite-additional-owner.mjs', '--' + mode]
        lock_unchanged()
        process = subprocess.Popen(command, cwd=release, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        try:
            stdout, _ = process.communicate(timeout=45)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.communicate()
            return {'ok':False, 'state':'outcome-uncertain-stop-inspect-privately', 'retryPermitted':False}
        lock_unchanged()
        # Never forward child stdout/stderr or token/provider/error bodies.
        try:
            value = json.loads(stdout)
        except (ValueError, TypeError):
            value = {}
        if mode == 'check' and value.get('stage') == 'preflight' and isinstance(value.get('ok'), bool):
            return {'ok':value['ok'] and process.returncode == 0, 'state':'check-complete', 'accountCreated':False, 'transportScope':'private-owner-only',
                    'sharedApplicationResendConfigured': owner.get('resendConfigured') is True,
                    'resendConfigured':value.get('resendConfigured') is True,
                    'officialSenderDomain':value.get('officialSenderDomain') is True, 'mfaReady':value.get('mfaReady') is True}
        if mode == 'send' and process.returncode == 0 and value == {'ok':True, 'stage':'invitation-created', 'delivery':'provider-accepted', 'accountActivated':False}:
            return {'ok':True, 'state':'invitation-created-provider-accepted', 'accountActivated':False, 'retryPermitted':False}
        return {'ok':False, 'state':'outcome-uncertain-stop-inspect-privately', 'retryPermitted':False}
