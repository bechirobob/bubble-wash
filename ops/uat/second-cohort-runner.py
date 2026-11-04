"""Protected-workflow entrypoint. No host work until every external gate is attested."""
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys

GATES = ('ADMIN_ROUTE_APPROVED', 'OPERATION_APPROVED', 'PRIVATE_HANDOVER_APPROVED',
         'RECIPIENT_KEY_VERIFIED', 'PRIVATE_RETRIEVAL_VERIFIED', 'USER_DELIVERY_VERIFIED')


def require(value):
    if not value:
        raise ValueError('Second cohort runner refused')


def pinned_module(root, sha, name, relative):
    path = root / relative
    require(path.is_file() and not path.is_symlink())
    require(subprocess.check_output(['git', 'show', sha + ':' + relative], cwd=root) == path.read_bytes())
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def prepare(root, supplied):
    env = dict(supplied)
    require(all(env.get(key) == 'true' for key in GATES))
    require(env.get('MODE') in ('issue', 'retrieve'))
    require(env.get('GITHUB_REPOSITORY') == 'bechirobob/bubble-wash' and
            env.get('GITHUB_REF') == 'refs/heads/main' and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
            env.get('GITHUB_RUN_ATTEMPT') == '1' and env.get('RUNNER_DEBUG') != '1' and env.get('ACTIONS_STEP_DEBUG') != 'true')
    sha = env.get('SOURCE_SHA', '')
    require(re.fullmatch('[a-f0-9]{40}', sha) and sha == env.get('GITHUB_SHA'))
    require(re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', env.get('UAT_OPERATION_ID', '')))
    # Check entrypoint/workflow as well as transitive control sources. No input
    # selects a filename, command, runtime revision, recipient pin or destination.
    for relative in ('ops/uat/second-cohort-runner.py', '.github/workflows/uat-second-cohort.yml'):
        path = root / relative
        require(path.is_file() and not path.is_symlink() and subprocess.check_output(
            ['git', 'show', sha + ':' + relative], cwd=root) == path.read_bytes())
    pinned_module(root, sha, 'uat_restore_transport', 'ops/uat/restoration-transport.py')
    transport = pinned_module(root, sha, 'uat_second_transport', 'ops/uat/second-cohort-transport.py')
    bundle = transport.source_bundle(root, sha)
    handoff = pinned_module(root, sha, 'uat_second_private_handoff', 'ops/uat/private-handoff.py')
    require(env['UAT_OPERATION_ID'] == transport.SECOND_OPERATION_ID)
    transport.bind_second_recipient(handoff)
    env['RUNTIME_SHA'] = json.loads(bundle['ops/uat/restoration-runtime-pins.json'])['runtimeRevision']
    # These attest separately verified facts; this code cannot verify off-runner
    # private-key custody or user-only delivery and must never claim to do so.
    env['ISSUANCE_APPROVED'] = env['OPERATION_APPROVED']
    env['HANDOVER_READY'] = 'true'
    env['SECOND_COHORT_ISSUANCE_APPROVED'] = 'true' if env['MODE'] == 'issue' else 'false'
    context = handoff.context(env)  # Enforces unchanged fixed recipient and store.
    request = {'action': env['MODE'], 'approved': True, 'ready': True,
               'operationId': env['UAT_OPERATION_ID'], 'publicKey': context['publicKey']}
    transport.authorize(env, request)
    return transport, env, request


def run(root, env):
    transport, prepared, request = prepare(root, env)
    if request['action'] == 'issue':
        # State commitment remains in memory; never a dispatch input or log value.
        snapshot = transport.perform(root, prepared, {'action': 'inspect'})
        request.update(expectedStateSha256=snapshot['stateSha256'], notBefore=snapshot['inspectedAt'],
                       approvedUntil=snapshot['inspectedAt'] + 300000)
    return transport.perform_private_handoff(root, prepared, request)


def main(argv):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        require(argv in ([], ['--check']))
        root = Path(__file__).resolve().parents[2]
        if argv == ['--check']:
            prepare(root, os.environ)
            # Deliberately no handover-ready, custody or retrieval-success claim.
            print('{"ok":true,"localGatesAccepted":true,"hostContacted":false}')
        else:
            # Existing private publisher returns only a validated nonsecret receipt.
            print(json.dumps(run(root, os.environ), sort_keys=True))
    except BaseException:
        # Host issuance or storage may have committed; never infer safe reissue.
        print('{"ok":false,"automaticRetry":false,"state":"uncertain-stop"}')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
