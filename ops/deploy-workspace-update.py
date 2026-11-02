#!/usr/bin/env python3
"""One exact workspace release; reuse historical build/rehearsal/code rollback."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
import types
import zlib

BASE_SHA = 'f7305933b15a285bbd393a2057bf5d27e4b9985c'
RUNTIME_SHA = '1406b0e217ed02709ebe1c423aecb42c6be5b0aa'
DEPENDENCIES = ('deploy-pwa-update.py', 'deploy-preserving.py', 'deploy-survey-only.py',
                'deploy-survey-update.py', 'survey-only-source-pins.json',
                'inactive-staging/prepare_pair.py', 'inactive-staging/stage_artifact.py')
PROVIDER = 'src/lib/research/provider.ts'
PROVIDER_PAIR = ('995aebd96ebcad76bbfb2128ce599d4168329905259344eac92c2f67e2529c15',
                 '22bbf607e2cb466cd6809c668d8a7c06877236526647bfd171691ce50e0f23b1')
CRITICAL = ('src/lib/data-store.ts', 'src/lib/operational-store.ts', 'src/lib/availability-store.ts',
            'src/app/api/health/route.ts', 'src/lib/research/store.ts',
            'db/proposed/research-v1.sql', 'src/lib/staff-accounts.ts')
NODE_CHECK = "if(process.versions.node.split('.')[0]!=='22')throw Error('Node 22 required');console.log(JSON.stringify({node:process.versions.node}))"
NATIVE_CHECK = "if(require('better-sqlite3/package.json').version!=='12.10.0'||require('sharp').versions.sharp!=='0.35.5')throw Error('native version');const db=new(require('better-sqlite3'))(':memory:');if(db.prepare('select 1 n').get().n!==1)throw Error('sqlite');db.close();require('sharp')({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer().then(b=>{if(!b.length)throw Error('sharp');console.log('Native runtime verified')}).catch(()=>process.exit(1))"


def require(value):
    if not value:
        raise ValueError('Exact workspace release refused')


def module(name, source):
    value = types.ModuleType(name)
    exec(compile(source, name, 'exec'), value.__dict__)
    return value


def configure(pins, sources):
    require(pins['schema'] == 'bubblewash-workspace-update/v1' and
            pins['baseSha'] == BASE_SHA and pins['runtimeSha'] == RUNTIME_SHA)
    require(set(sources) == set(DEPENDENCIES) == set(pins['dependencies']))
    require(all(hashlib.sha256(raw.encode()).hexdigest() == pins['dependencies'][name] for name, raw in sources.items()))
    require(pins['criticalFiles'] == list(CRITICAL) and pins['providerPair'] == list(PROVIDER_PAIR))
    pwa = module('reviewed_pwa', sources['deploy-pwa-update.py'])
    # Only this isolated module instance receives the new, exact live baseline.
    pwa.BASE_SHA = BASE_SHA
    inner = {**pins, 'schema': 'bubblewash-pwa-update/v1',
             'dependencies': {k: v for k, v in pins['dependencies'].items() if k != 'deploy-pwa-update.py'}}
    update = pwa.configure(inner, {k: v for k, v in sources.items() if k != 'deploy-pwa-update.py'})
    baseline = module('reviewed_baseline_snapshot', sources['deploy-survey-update.py'])
    baseline.guards = update.guards
    baseline.pins = {**inner, 'sourceScope': pins['baselineScope']}

    def scoped_snapshot(scanner, scope):
        def snapshot(release, owner):
            allowed = set(scope['rootFiles']) | set(scope['directories'])
            generated = {'.git', '.next', 'node_modules', '.npm', 'data',
                         '.release-sha', 'next-env.d.ts', 'tsconfig.tsbuildinfo'}
            require(all(child.name in allowed | generated for child in release.iterdir()))
            return scanner(release, owner)
        return snapshot
    baseline.source_snapshot = scoped_snapshot(baseline.source_snapshot, pins['baselineScope'])
    update.source_snapshot = scoped_snapshot(update.source_snapshot, pins['sourceScope'])
    update.workspace_baseline = baseline

    def verify_sources(current, candidate, owner):
        update.stage('source')
        require(update.core.source_manifest(current) == pins['baselineSource'] and
                update.core.source_manifest(candidate) == pins['candidateSource'])
        require(not os.path.lexists(current / '.env.uat.example'))
        old, old_identity = baseline.source_snapshot(current, owner)
        new, new_identity = update.source_snapshot(candidate, owner)
        require(update.content_commitment(old) == pins['baselineContent'] and
                update.content_commitment(new) == pins['runtimeContent'])
        require(sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k)) == pins['allowedChanges'])
        require(all(k in old and old[k] == new.get(k) for k in CRITICAL))
        require((old.get(PROVIDER), new.get(PROVIDER)) == PROVIDER_PAIR)
        return {'old': old_identity, 'new': new_identity}
    update.verify_sources = verify_sources
    original_configuration = pwa.configuration
    def configuration(values):
        original_configuration(values)
        require('BUBBLEWASH_UAT_ENABLED' not in values)
    pwa.configuration = configuration
    update.open_configuration = configuration

    original_runtime = update.core.check_runtime
    host_node = {}
    def runtime(target, values, unit=None, port=3000, user=True, network_pid=None):
        unit = update.core.UNIT if unit is None else unit
        original_runtime(target, values, unit, port, user, network_pid)
        arguments = ['show', unit, '--property=MainPID']
        output = update.core.ctl(*arguments) if user else update.core.command(['systemctl', *arguments])
        props = update.core.parse(output.encode())
        listeners = set(re.findall(r'pid=(\d+)', update.core.network_command(['ss', '-H', '-ltnp', 'sport = :' + str(port)], network_pid)))
        require(len(listeners) == 1)
        pids = {props.get('MainPID', '')} | listeners
        require(len(pids) in (1, 2) and all(re.fullmatch('[1-9][0-9]*', pid) for pid in pids))
        for pid in pids:
            process = Path('/proc') / pid
            with (process / 'environ').open('rb') as handle:
                raw = handle.read(1048577)
            require(len(raw) <= 1048576 and not any(item.partition(b'=')[0] == b'BUBBLEWASH_UAT_ENABLED' for item in raw.split(b'\0')))
            executable = (process / 'exe').resolve(strict=True)
            info = executable.stat()
            identity = (str(executable), info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            require(executable.name == 'node')
            if not host_node:
                require(port == 3000 and user)
                host_node['identity'] = identity
            require(host_node['identity'] == identity)
        if network_pid is not None:
            # Only synthetic in-memory SQLite/image work inside the already
            # verified private rehearsal network. No app/database imports.
            code = '(function(require){' + NATIVE_CHECK + '})(require("node:module").createRequire(' + json.dumps(str(target / 'package.json')) + '))'
            update.core.network_command(['runuser', '-u', 'ubuntu', '--', host_node['identity'][0], '-e', code], network_pid, timeout=30)
    update.core.check_runtime = runtime

    original_command = update.core.command
    def command(args, *rest, **kwargs):
        if args[0] == 'systemd-run' and any(a.startswith('--unit=') and a.endswith('-build') for a in args):
            require(args[-2] == '-c' and args[-1] == 'npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund')
            require(bool(host_node))
            homes = [arg[5:] for arg in args if arg.startswith('HOME=')]
            require(len(homes) == 1 and Path(homes[0]).is_absolute() and
                    '--property=WorkingDirectory=' + homes[0] in args and
                    not any(arg.startswith('XDG_CONFIG_HOME=') for arg in args))
            # Next initializes its config store even with telemetry disabled.
            # Confine that build-only metadata to the existing cache root;
            # do not admit a new source-root directory or alter the live env.
            position = args.index('HOME=' + homes[0]) + 1
            args = [*args[:position], 'XDG_CONFIG_HOME=' + homes[0] + '/.npm/build-config', *args[position:]]
            path, device, inode, size, mtime = host_node['identity']
            binding = 'const fs=require("node:fs");if(fs.realpathSync(process.execPath)!==' + json.dumps(path) + ')throw Error("Node path drift");const st=fs.statSync(process.execPath,{bigint:true});if(st.dev!==' + str(device) + 'n||st.ino!==' + str(inode) + 'n||st.size!==' + str(size) + 'n||st.mtimeNs!==' + str(mtime) + 'n)throw Error("Node identity drift");'
            args = [*args[:-1], 'node -e ' + shlex.quote(binding + NODE_CHECK) + ' && ' + args[-1] + ' && node -e ' + shlex.quote(binding + NATIVE_CHECK)]
        return original_command(args, *rest, **kwargs)
    update.core.command = command
    update.workspace_pwa = pwa  # Exposed only for local fixture tests.
    return update


def read_inputs():
    here = Path(__file__).resolve().parent
    pins = json.loads((here / 'workspace-update-source-pins.json').read_bytes())
    return pins, {name: (here / name).read_text() for name in DEPENDENCIES}


def entry(pins, sources):
    configure(pins, sources).entry()


def main():
    pins, sources = read_inputs()
    update = configure(pins, sources)
    if sys.argv[1:] == ['--check-runtime']:
        update.verify_checkout(Path('runtime-artifact').resolve(strict=True), os.environ.get('RUNTIME_SHA'),
                               types.SimpleNamespace(pw_uid=os.getuid()))
        print('{"ok":true,"exactWorkspaceRuntime":true}')
    elif sys.argv[1:] == ['--check-hosted-runs']:
        require(os.environ.get('RUNTIME_SHA') == RUNTIME_SHA)
        update.check_hosted_runs()
    elif sys.argv[1:] == ['--emit']:
        payload = {'pins': pins, 'sources': sources, 'adapter': Path(__file__).read_text()}
        encoded = base64.b64encode(zlib.compress(json.dumps(payload, separators=(',', ':')).encode())).decode()
        print("import base64,json,types,zlib\np=json.loads(zlib.decompress(base64.b64decode(" + repr(encoded) + ")))\n"
              "m=types.ModuleType('workspace_code_only');exec(compile(p['adapter'],'workspace-code-only','exec'),m.__dict__);m.entry(p['pins'],p['sources'])")
    else:
        raise SystemExit('Use the reviewed workspace update workflow.')


if __name__ == '__main__':
    main()
