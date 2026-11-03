#!/usr/bin/env python3
"""One exact customer release using the hash-pinned workspace release primitives."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import types
import zlib

BASE_SHA = '1406b0e217ed02709ebe1c423aecb42c6be5b0aa'
RUNTIME_SHA = '3a8574a49e28d03e1029a3bb0dc239738d66db3f'
DEPENDENCIES = ('deploy-workspace-update.py', 'deploy-pwa-update.py', 'deploy-preserving.py',
                'deploy-survey-only.py', 'deploy-survey-update.py', 'survey-only-source-pins.json',
                'inactive-staging/prepare_pair.py', 'inactive-staging/stage_artifact.py')
PROVIDER_HASH = '22bbf607e2cb466cd6809c668d8a7c06877236526647bfd171691ce50e0f23b1'
PROTECTED_FILES = ('.env.production.example', '.env.uat.example', 'package.json',
                   'package-lock.json', 'next.config.mjs', 'tsconfig.json')
PROTECTED_PREFIXES = ('src/app/api/', 'src/lib/', 'db/')


def require(value):
    if not value:
        raise ValueError('Exact customer release refused')


def configure(pins, sources):
    require(pins['schema'] == 'bubblewash-customer-update/v1' and
            pins['baseSha'] == BASE_SHA and pins['runtimeSha'] == RUNTIME_SHA)
    require(set(sources) == set(DEPENDENCIES) == set(pins['dependencies']))
    require(all(hashlib.sha256(raw.encode()).hexdigest() == pins['dependencies'][name]
                for name, raw in sources.items()))
    require(pins['providerPair'] == [PROVIDER_HASH, PROVIDER_HASH])
    workspace = types.ModuleType('reviewed_customer_workspace')
    exec(compile(sources['deploy-workspace-update.py'], 'reviewed-workspace', 'exec'), workspace.__dict__)
    # Mutate only this isolated module; historical files and contracts stay intact.
    workspace.BASE_SHA, workspace.RUNTIME_SHA = BASE_SHA, RUNTIME_SHA
    workspace.PROVIDER_PAIR = (PROVIDER_HASH, PROVIDER_HASH)
    inner = {**pins, 'schema': 'bubblewash-workspace-update/v1',
             'dependencies': {k: v for k, v in pins['dependencies'].items() if k != 'deploy-workspace-update.py'}}
    update = workspace.configure(inner, {k: v for k, v in sources.items() if k != 'deploy-workspace-update.py'})

    def verify_sources(current, candidate, owner):
        update.stage('source')
        require(update.core.source_manifest(current) == pins['baselineSource'] and
                update.core.source_manifest(candidate) == pins['candidateSource'])
        old, old_identity = update.workspace_baseline.source_snapshot(current, owner)
        new, new_identity = update.source_snapshot(candidate, owner)
        require(update.content_commitment(old) == pins['baselineContent'] and
                update.content_commitment(new) == pins['runtimeContent'])
        require(sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k)) == pins['allowedChanges'])
        # All existing API/auth/data-library files and dependency/config inputs
        # remain equal. The only new library file is in the exact candidate tree.
        require(all(k in old and old[k] == new.get(k) for k in PROTECTED_FILES))
        require(all(old[k] == new.get(k) for k in old if k.startswith(PROTECTED_PREFIXES)))
        require(old.get(workspace.PROVIDER) == new.get(workspace.PROVIDER) == PROVIDER_HASH)
        return {'old': old_identity, 'new': new_identity}

    update.verify_sources = verify_sources
    update.customer_workspace = workspace  # Synthetic tests only.
    return update


def read_inputs():
    here = Path(__file__).resolve().parent
    pins = json.loads((here / 'customer-update-source-pins.json').read_bytes())
    return pins, {name: (here / name).read_text() for name in DEPENDENCIES}


def entry(pins, sources):
    configure(pins, sources).entry()


def main():
    pins, sources = read_inputs()
    update = configure(pins, sources)
    if sys.argv[1:] == ['--check-runtime']:
        update.verify_checkout(Path('runtime-artifact').resolve(strict=True), os.environ.get('RUNTIME_SHA'),
                               types.SimpleNamespace(pw_uid=os.getuid()))
        print('{"ok":true,"exactCustomerRuntime":true}')
    elif sys.argv[1:] == ['--check-hosted-runs']:
        require(os.environ.get('RUNTIME_SHA') == RUNTIME_SHA)
        update.check_hosted_runs()
    elif sys.argv[1:] == ['--emit']:
        payload = {'pins': pins, 'sources': sources, 'adapter': Path(__file__).read_text()}
        encoded = base64.b64encode(zlib.compress(json.dumps(payload, separators=(',', ':')).encode())).decode()
        print("import base64,json,types,zlib\np=json.loads(zlib.decompress(base64.b64decode(" + repr(encoded) + ")))\n"
              "m=types.ModuleType('customer_code_only');exec(compile(p['adapter'],'customer-code-only','exec'),m.__dict__);m.entry(p['pins'],p['sources'])")
    else:
        raise SystemExit('Use the reviewed customer update workflow.')


if __name__ == '__main__':
    main()
