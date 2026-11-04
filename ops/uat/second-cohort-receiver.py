"""Second-cohort receiver, loaded only by the exact-source administrative caller."""
import base64
import json
import os
import resource
import sys


def dependencies():
    return (sys.modules['uat_restore_preflight'], sys.modules['uat_restore_collector'],
            sys.modules['uat_restore_transport'])


def node_request(bundle, request):
    p, c, t = dependencies()
    source = bundle['scripts/uat-second-cohort.mjs']
    for before, after in {
        "'../src/lib/uat-accounts.ts'": "'file:///opt/bubblewash-uat/app/src/lib/uat-accounts.ts'",
        "'../src/lib/uat-environment.ts'": "'file:///opt/bubblewash-uat/app/src/lib/uat-environment.ts'",
        "'./uat-sealed-handover.mjs'": "'file:///opt/bubblewash-uat/app/scripts/uat-sealed-handover.mjs'",
    }.items():
        t.require(source.count(before) == 1)
        source = source.replace(before, after)
    operator = bundle['scripts/uat-second-cohort-operator.mjs']
    replacements = {
        "'./uat-second-cohort.mjs'": repr('data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()),
        "'../src/lib/uat-environment.ts'": "'file:///opt/bubblewash-uat/app/src/lib/uat-environment.ts'",
        "import('better-sqlite3')": "import('file:///opt/bubblewash-uat/app/node_modules/better-sqlite3/lib/index.js')",
    }
    for before, after in replacements.items():
        t.require(operator.count(before) == 1)
        operator = operator.replace(before, after)
    operator += '\nawait runOperator();\n'
    script = "await import('data:text/javascript;base64," + base64.b64encode(operator.encode()).decode() + "')"
    # Use the existing sandbox property parser unchanged, including no-connect.
    h = sys.modules['uat_handoff_host']
    properties = h.sandbox_properties(c.read(p.UNIT, 16384).decode())
    command = ['/usr/bin/systemd-run', '--unit=bubblewash-uat-second-cohort', '--wait', '--pipe',
               '--quiet', '--collect', *properties, '--property', 'RuntimeMaxSec=120s',
               '/usr/bin/node', '--conditions=react-server', '--experimental-strip-types',
               '--input-type=module', '--eval', script]
    return json.loads(t.exchange(command, json.dumps(request).encode(), timeout=120))


def execute(bundle, request):
    p, c, t = dependencies()
    t.require(os.geteuid() == 0 and type(request) is dict)
    mode = request.get('action')
    t.require(mode in ('inspect', 'issue', 'retrieve'))
    fields = {'action'} if mode == 'inspect' else {'action', 'approved', 'ready', 'operationId',
        'publicKey'} | ({'notBefore', 'approvedUntil', 'expectedStateSha256'} if mode == 'issue' else
        ({'expectedStateSha256'} if 'expectedStateSha256' in request else set()))
    t.require(set(request) == fields)
    pins = json.loads(bundle['ops/uat/restoration-runtime-pins.json'])
    # eligible=False skips ONLY old-password restoration eligibility, never any
    # runtime, process, storage, environment, sandbox, or timestamp checks.
    first = c.collect(pins, eligible=False, private=True)
    result = node_request(bundle, dict(request, expectedDatabaseIdentity=first['private']['database']))
    after = c.collect(pins, eligible=False, private=True)
    t.require(after['private'] == first['private'])
    return result


def main(bundle):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError()
        result = execute(bundle, json.loads(raw))
        # Private pipe only; runner must validate and store, never log this output.
        print(json.dumps(result, sort_keys=True))
    except BaseException:
        print('{"ok":false,"automaticRetry":false,"state":"uncertain-stop"}')
        raise SystemExit(1)
