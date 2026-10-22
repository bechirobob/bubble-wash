"""Appended to reviewed preflight source in SSH stdin; never installed on host."""
import fcntl
import hashlib
import os
import signal


def enrollment_source_matches(release, pins):
    required = {'scripts/invite-additional-owner.mjs', 'src/lib/staff-accounts.ts', 'src/lib/admin-mfa.ts',
                'src/lib/data-store.ts', 'src/lib/passwords.ts', 'src/lib/mfa-encryption.ts', 'src/lib/dispatch-location.ts', 'package-lock.json'}
    if not required.issubset(pins) or pins.get('src/lib/staff-accounts.ts') != 'f82e6cf9aef26d4856422e751edc4ab545329e6b40cc142efe6fd5f726cab478':
        return False
    for relative, digest in pins.items():
        path = release / relative
        if Path(relative).is_absolute() or '..' in Path(relative).parts or path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(release.resolve()):
            return False
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            return False
    return True


def run_private_enrollment(email, expected_live_sha, actor, mode, delivery_approved, pins):
    # This boolean is an explicit workflow dispatch attestation, not permission
    # inferred from the original account grant. Sender/risk approval comes first.
    if mode not in ('check', 'send') or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?', actor):
        return {'ok': False, 'state': 'invalid-private-request', 'accountCreated': False}
    if mode == 'send' and delivery_approved is not True:
        return {'ok': False, 'state': 'delivery-approval-required', 'accountCreated': False}
    if not release_pin_matches(expected_live_sha):
        return {'ok': False, 'state': 'release-pin-mismatch', 'accountCreated': False}
    release = CURRENT.resolve(strict=True)
    if not enrollment_source_matches(release, pins):
        return {'ok': False, 'state': 'owner-source-pin-mismatch', 'accountCreated': False}
    lock_path = HOME / 'bubblewash-runtime/deploy.lock'
    if not lock_path.is_file() or lock_path.is_symlink():
        return {'ok': False, 'state': 'existing-deployment-lock-required', 'accountCreated': False}
    with lock_path.open('r') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'ok': False, 'state': 'deployment-lock-busy', 'accountCreated': False}
        environment_snapshot = bounded_text(ENV_FILE)
        inspection = collect(email, expected_live_sha)
        if bounded_text(ENV_FILE) != environment_snapshot:
            return {'ok':False, 'state':'environment-drift', 'accountCreated':False}
        owner = inspection.get('ownerInspection', {})
        config = inspection.get('configuration', {})
        if not owner.get('completed') or owner.get('duplicatePresent') or not inspection.get('legacyImportAbsent') or not config.get('productionMode') or config.get('staffAuthDisabled') or not config.get('demoDisabled') or not config.get('sqliteConfigured') or not config.get('mfaRequired'):
            return {'ok': False, 'state': 'private-preflight-blocked', 'accountCreated': False,
                    'duplicatePresent': owner.get('duplicatePresent') if owner.get('completed') else None}
        # No env evaluation, shell, NODE_OPTIONS, preload injection, or env files
        # containing private inputs. Existing runtime values stay in process memory.
        configured = parse_env(environment_snapshot)
        env = {k:v for k,v in configured.items() if k.startswith('BUBBLEWASH_') or k in ('NODE_ENV', 'RESEND_API_KEY')}
        env.update({'PATH':'/usr/local/bin:/usr/bin:/bin', 'HOME':'/home/ubuntu', 'NODE_ENV':'production',
                    'BUBBLEWASH_OWNER_EMAIL':email, 'BUBBLEWASH_OWNER_NAME':'Personal Owner',
                    'BUBBLEWASH_OWNER_INVITED_BY':'github-actions:' + actor})
        env.pop('BUBBLEWASH_OWNER_INVITE_CONFIRM', None)
        if mode == 'send':
            if owner.get('configuredSenderCategory') != 'updates@bubblewash.co':
                return {'ok':False, 'state':'approved-public-sender-required', 'accountCreated':False}
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
        # Never forward child stdout/stderr or token/provider/error bodies.
        try:
            value = json.loads(stdout)
        except (ValueError, TypeError):
            value = {}
        if mode == 'check' and value.get('stage') == 'preflight' and isinstance(value.get('ok'), bool):
            return {'ok':value['ok'] and process.returncode == 0, 'state':'check-complete', 'accountCreated':False,
                    'resendConfigured':value.get('resendConfigured') is True,
                    'officialSenderDomain':value.get('officialSenderDomain') is True, 'mfaReady':value.get('mfaReady') is True}
        if mode == 'send' and process.returncode == 0 and value == {'ok':True, 'stage':'invitation-created', 'delivery':'provider-accepted', 'accountActivated':False}:
            return {'ok':True, 'state':'invitation-created-provider-accepted', 'accountActivated':False, 'retryPermitted':False}
        return {'ok':False, 'state':'outcome-uncertain-stop-inspect-privately', 'retryPermitted':False}
