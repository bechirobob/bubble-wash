"""Local-only integration for the existing authorized Tailscale SSH route.

No enabled CLI/workflow. Returns confidential state/ciphertext, never logs it.
Publication and live invocation require separate specific authorization.
"""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys

# User-approved one-operation recipient; historical first issuance is unchanged.
SECOND_OPERATION_ID = 'ba2a58a3-d37f-4a20-985c-1f7fcbbf2aef'
SECOND_RECIPIENT = 'dc87a41bd34beee0dd64bb165ae968ea266b84ac9b86fe8d642e5ffbdcb6c154'
HISTORICAL_RECIPIENT = 'a479abb3611e11c65eb89e1a437577873e26798161e284572e0bf29ccdc8b4c9'

FILES = ('ops/uat/restoration-transport.py', 'ops/uat/restoration-preflight.py',
         'ops/uat/restoration-collector.py', 'ops/uat/restoration-runtime-pins.json',
         'ops/uat/handoff-host.py', 'ops/uat/second-cohort-receiver.py',
         'scripts/uat-second-cohort.mjs', 'scripts/uat-second-cohort-operator.mjs')


def require(value):
    if not value:
        raise ValueError('Second cohort administrative route refused')


def recipient_fingerprint(pem):
    require(type(pem) is str and len(pem) <= 4096 and pem.startswith('-----BEGIN PUBLIC KEY-----\n')
            and pem.endswith('-----END PUBLIC KEY-----\n'))
    encoded = ''.join(pem.splitlines()[1:-1])
    der = base64.b64decode(encoded, validate=True)
    require(300 < len(der) < 1024 and base64.b64encode(der).decode() == encoded)
    return hashlib.sha256(der).hexdigest()


def bind_second_recipient(module):
    # Only a separately loaded module instance may receive the new recipient.
    # The historical module source and any first-issuance instance stay intact.
    require(module.__name__ == 'uat_second_private_handoff' and module.RECIPIENT == HISTORICAL_RECIPIENT)
    module.RECIPIENT = SECOND_RECIPIENT


def source_bundle(root, revision):
    require(re.fullmatch('[a-f0-9]{40}', revision))
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() == revision)
    result = {}
    control = Path(root) / 'ops/uat/second-cohort-transport.py'
    require(control.is_file() and not control.is_symlink() and subprocess.check_output(['git', 'show', revision + ':ops/uat/second-cohort-transport.py'], cwd=root) == control.read_bytes())
    for name in FILES:
        path = Path(root) / name
        require(path.is_file() and not path.is_symlink())
        raw = path.read_bytes()
        require(0 < len(raw) <= 65536 and subprocess.check_output(['git', 'show', revision + ':' + name], cwd=root) == raw)
        result[name] = raw.decode()
    return result


def remote_command(bundle):
    require(set(bundle) == set(FILES))
    bootstrap = """import json,sys,types
bundle=json.loads(BUNDLE)
for name,path in [('uat_restore_transport','ops/uat/restoration-transport.py'),('uat_restore_preflight','ops/uat/restoration-preflight.py'),('uat_restore_collector','ops/uat/restoration-collector.py'),('uat_handoff_host','ops/uat/handoff-host.py'),('uat_second_receiver','ops/uat/second-cohort-receiver.py')]:
 module=types.ModuleType(name);module.__file__='/reviewed/'+path;sys.modules[name]=module
 exec(compile(bundle[path],path,'exec'),module.__dict__)
sys.modules['uat_second_receiver'].main(bundle)
""".replace('BUNDLE', repr(json.dumps(bundle)))
    encoded = base64.b64encode(bootstrap.encode()).decode()
    require(len(encoded) < 120000)
    code = "import base64;exec(compile(base64.b64decode(" + repr(encoded) + "),'reviewed-uat-second','exec'))"
    return ['/usr/local/bin/tailscale', 'ssh', 'root@hermes', 'python3 -I -B -c ' + shlex.quote(code)]


def validate_result(raw, request):
    require(type(raw) is bytes and 0 < len(raw) <= 16384)
    value = json.loads(raw)
    require(type(value) is dict)
    if request['action'] == 'inspect':
        require(set(value) == {'stateSha256', 'inspectedAt'} and re.fullmatch('[a-f0-9]{64}', value['stateSha256'])
                and type(value['inspectedAt']) is int and value['inspectedAt'] > 0)
    else:
        require(set(value) == {'schema', 'recipientSha256', 'wrappedKey', 'iv', 'tag', 'ciphertext'})
        pem = request['publicKey']
        require(pem.startswith('-----BEGIN PUBLIC KEY-----\n') and pem.endswith('-----END PUBLIC KEY-----\n'))
        der = base64.b64decode(''.join(pem.splitlines()[1:-1]), validate=True)
        require(value['schema'] == 'bubblewash-uat-handover/v1' and value['recipientSha256'] == hashlib.sha256(der).hexdigest())
        sizes = {k: len(base64.b64decode(value[k], validate=True)) for k in ('wrappedKey', 'iv', 'tag', 'ciphertext')}
        require(384 <= sizes['wrappedKey'] <= 1024 and sizes['iv'] == 12 and sizes['tag'] == 16 and 128 < sizes['ciphertext'] < 8192)
    return value


def authorize(env, request):
    require(env.get('GITHUB_REPOSITORY') == 'bechirobob/bubble-wash' and env.get('GITHUB_REF') == 'refs/heads/main'
            and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and env.get('GITHUB_RUN_ATTEMPT') == '1'
            and env.get('SOURCE_SHA') == env.get('GITHUB_SHA') and env.get('ADMIN_ROUTE_APPROVED') == 'true'
            and env.get('RUNNER_DEBUG') != '1' and env.get('ACTIONS_STEP_DEBUG') != 'true')
    require(request.get('action') in ('inspect', 'issue', 'retrieve'))
    if request['action'] != 'inspect':
        require(request.get('operationId') == SECOND_OPERATION_ID and
                recipient_fingerprint(request.get('publicKey')) == SECOND_RECIPIENT)
        require(env.get('PRIVATE_HANDOVER_APPROVED') == 'true' and env.get('RECIPIENT_KEY_VERIFIED') == 'true')
    if request['action'] == 'issue':
        require(env.get('SECOND_COHORT_ISSUANCE_APPROVED') == 'true')


def perform(root, env, request):
    authorize(env, request)
    bundle = source_bundle(root, env['SOURCE_SHA'])
    # Reuse the existing bounded confidential pipe and inherited approved route.
    transport = sys.modules['uat_restore_transport']
    raw = transport.exchange(remote_command(bundle), json.dumps(request).encode())
    return validate_result(raw, request)


def perform_private_handoff(root, env, request):
    """Approved runner wrapper: verify the existing private store BEFORE issuance.

    Separate user-approved one-operation recipient only. Historical first-issue
    controls and the existing storage destination remain unchanged.
    """
    authorize(env, request)
    require(request.get('action') in ('issue', 'retrieve'))
    source_bundle(root, env['SOURCE_SHA'])
    modules = []
    for name, relative in [('uat_second_private_handoff', 'ops/uat/private-handoff.py'),
                           ('uat_private_backup', '.github/backup/backup_release.py')]:
        path = Path(root) / relative
        require(path.is_file() and not path.is_symlink())
        require(subprocess.check_output(['git', 'show', env['SOURCE_SHA'] + ':' + relative], cwd=root) == path.read_bytes())
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules.append(module)
    handoff, backup = modules
    bind_second_recipient(handoff)
    context = handoff.context(env)
    require(context['mode'] == request['action'] and context['publicKey'] == request['publicKey'])
    pins = json.loads((Path(root) / 'ops/uat/restoration-runtime-pins.json').read_text())
    require(context['runtimeSha'] == pins['runtimeRevision'])
    api = backup.GitHub(handoff.STORE)
    handoff.private_store(backup, api, env)
    sealed = perform(root, env, request)
    # Existing publisher validates fixed recipient and private store, uploads only
    # ciphertext/checksum, verifies downloads, and emits a nonsecret receipt.
    return handoff.publish(backup, api, env, json.dumps(sealed).encode())


if __name__ == '__main__':
    print('{"ok":false,"entrypointEnabled":false,"automaticRetry":false}')
    raise SystemExit(1)
