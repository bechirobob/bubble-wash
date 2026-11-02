"""Synthetic checks for one pinned transition; historical rollback tests stay intact."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('workspace_release', ROOT/'ops/deploy-workspace-update.py')
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
PINS, SOURCES = w.read_inputs()


class Controls(unittest.TestCase):
    def setUp(self):
        self.update = w.configure(copy.deepcopy(PINS), SOURCES)

    def test_exact_transition_and_provider_pair_cannot_be_changed(self):
        for field,value in [('baseSha','a'*40),('runtimeSha','b'*40),('criticalFiles',[]),('providerPair',['a'*64,'b'*64]),('schema','other')]:
            with self.subTest(field=field), self.assertRaises(ValueError): w.configure({**PINS,field:value},SOURCES)
        with self.assertRaises(ValueError): w.configure(PINS,{**SOURCES,'deploy-preserving.py':SOURCES['deploy-preserving.py']+'\n'})

    def test_historical_source_bytes_unchanged_and_explicit_roots(self):
        historical=json.loads((ROOT/'ops/pwa-update-source-pins.json').read_text())
        for name,digest in historical['dependencies'].items(): self.assertEqual(PINS['dependencies'][name],digest)
        self.assertEqual(self.update.workspace_pwa.JOURNAL_TARGET_SHA,'5f256800d65dbe3b69f54e95afa0e8ab30b5e881')
        self.assertEqual(self.update.workspace_pwa.BASE_SHA,w.BASE_SHA)
        self.assertNotIn('.env.uat.example',PINS['baselineScope']['rootFiles'])
        self.assertIn('.env.uat.example',PINS['sourceScope']['rootFiles'])
        self.assertEqual(set(PINS['sourceScope']['excludedSubtrees']),{'tooling/next-eslint-glob/node_modules','tooling/minimatch-compat/node_modules'})
        self.assertEqual(PINS['runtimeSha'],'1406b0e217ed02709ebe1c423aecb42c6be5b0aa')
        self.assertEqual(PINS['baseSha'],'f7305933b15a285bbd393a2057bf5d27e4b9985c')

    def test_configuration_preserved_and_uat_absence_enforced(self):
        values={'BUBBLEWASH_STAFF_AUTH_DISABLED':'false','BUBBLEWASH_BOOKINGS_DISABLED':'true','BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false','PRIVATE':'not-printed'}
        original=dict(values); self.update.workspace_pwa.configuration(values); self.assertEqual(values,original)
        for value in ('true','false','other',''):
            with self.assertRaises(ValueError): self.update.workspace_pwa.configuration({**values,'BUBBLEWASH_UAT_ENABLED':value})
        with self.assertRaises(ValueError): self.update.workspace_pwa.configuration({**values,'BUBBLEWASH_BOOKINGS_DISABLED':'false'})

    def test_unknown_root_file_is_not_silently_outside_source_scope(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); (root/'.env.production.local').write_text('unexpected')
            with self.assertRaises(ValueError): self.update.source_snapshot(root,types.SimpleNamespace(pw_uid=os.getuid()))

    def test_exact_source_hashes_and_protected_pair(self):
        # Scanner safety has its unchanged historical tests. Here each mutation
        # retains internally consistent content pins to test independent rules.
        with tempfile.TemporaryDirectory() as d:
            oldpath=Path(d)/'old';oldpath.mkdir();newpath=Path(d)/'new';newpath.mkdir()
            old={k:'same' for k in w.CRITICAL};new=dict(old)
            old[w.PROVIDER],new[w.PROVIDER]=w.PROVIDER_PAIR
            pins=self.update.pins
            # The closure owns the same per-control exact pin object except the
            # internal historical schema/dependency projection.
            public=copy.deepcopy(PINS)
            public.update(baselineContent=self.update.content_commitment(old),runtimeContent=self.update.content_commitment(new),allowedChanges=[w.PROVIDER])
            u=w.configure(public,SOURCES)
            with patch.object(u.core,'source_manifest',side_effect=lambda p:public['baselineSource'] if p==oldpath else public['candidateSource']), patch.object(u.workspace_baseline,'source_snapshot',side_effect=lambda *_:(dict(old),{})), patch.object(u,'source_snapshot',side_effect=lambda *_:(dict(new),{})):
                u.verify_sources(oldpath,newpath,None)
                new[w.CRITICAL[0]]='changed'
                public['runtimeContent']=u.content_commitment(new);public['allowedChanges']=sorted([w.PROVIDER,w.CRITICAL[0]])
                with self.assertRaises(ValueError):u.verify_sources(oldpath,newpath,None)
                new[w.CRITICAL[0]]='same';new[w.PROVIDER]='wrong'
                public['runtimeContent']=u.content_commitment(new);public['allowedChanges']=[w.PROVIDER]
                with self.assertRaises(ValueError):u.verify_sources(oldpath,newpath,None)
                new[w.PROVIDER]=w.PROVIDER_PAIR[1]
                public['runtimeContent']=u.content_commitment(new)
                (oldpath/'.env.uat.example').write_text('extra baseline source')
                with self.assertRaises(ValueError):u.verify_sources(oldpath,newpath,None)

    def test_build_cannot_start_before_runtime_binding(self):
        args=['systemd-run','--unit=fixture-build','/bin/bash','-c','npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund']
        with self.assertRaises(ValueError): self.update.core.command(args)

    def test_same_preserving_transition_and_private_copy_rehearsals_reused(self):
        import inspect
        source=inspect.getsource(w.configure)
        self.assertIn('update = pwa.configure(',source)
        self.assertNotIn('update.deploy =',source)
        self.assertNotIn('update.rehearse_both =',source)
        self.assertNotIn('core.activate =',source)
        self.assertIn('baseline.source_snapshot(current, owner)',source)
        self.assertIn('network_pid is not None',source)
        self.assertIn("'runuser', '-u', 'ubuntu'",source)
        self.assertIn('process.execPath',source)
        self.assertIn('st.mtimeNs',source)

    def test_manual_workflow_exact_inputs_and_no_live_configuration_step(self):
        workflow=(ROOT/'.github/workflows/workspace-update-deploy.yml').read_text()
        self.assertIn('workflow_dispatch:',workflow);self.assertNotIn('\n  push:',workflow)
        self.assertIn(w.BASE_SHA,workflow)
        self.assertIn('"$GITHUB_RUN_ATTEMPT" == 1',workflow)
        self.assertIn('python3 -B ops/deploy-workspace-update.py --check-runtime',workflow)
        self.assertIn('python3 -B ops/deploy-workspace-update.py --check-hosted-runs',workflow)
        self.assertNotIn('inspect_owner',workflow)
        self.assertEqual(workflow.count('tailscale/github-action@'),1)

    def test_runtime_gate_requires_correct_successful_first_attempt_runs(self):
        run={'head_sha':w.RUNTIME_SHA,'path':'.github/workflows/browser-regression.yml','event':'push','status':'completed','conclusion':'success','run_attempt':1,'head_repository':{'full_name':'bechirobob/bubble-wash'},'repository':{'full_name':'bechirobob/bubble-wash'}}
        self.update.verify_hosted_run(run,w.RUNTIME_SHA,run['path'])
        for change in ({'head_sha':w.BASE_SHA},{'run_attempt':2},{'conclusion':'failure'},{'event':'pull_request'}):
            with self.assertRaises(ValueError):self.update.verify_hosted_run({**run,**change},w.RUNTIME_SHA,run['path'])

class RuntimeBinding(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.target=self.root/'release';self.target.mkdir()
        self.node=self.root/'node';self.node.write_bytes(b'fixture executable identity')
        self.proc=self.root/'proc'
        for pid in ('100','101'):
            base=self.proc/pid;base.mkdir(parents=True)
            (base/'exe').symlink_to(self.node)
            (base/'environ').write_bytes(b'NODE_ENV=production\0')
        original=w.module
        self.command=Mock(return_value='MainPID=100')
        def module(name,source):
            result=original(name,source)
            if name=='reviewed_pwa':
                configure=result.configure
                def wrapped(*args):
                    u=configure(*args);u.core.check_runtime=Mock();u.core.command=self.command
                    u.core.ctl=Mock(return_value='MainPID=100')
                    u.core.network_command=Mock(return_value='pid=101')
                    return u
                result.configure=wrapped
            return result
        with patch.object(w,'module',side_effect=module):self.u=w.configure(copy.deepcopy(PINS),SOURCES)
        context=patch.object(w,'Path',side_effect=lambda value:self.proc if value=='/proc' else Path(value))
        context.start();self.addCleanup(context.stop)

    def bind(self):self.u.core.check_runtime(self.target,{})

    def test_absent_uat_and_host_node_bind_build_and_native_checks(self):
        self.bind()
        args=['systemd-run','--unit=fixture-build','/bin/bash','-c','npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund']
        self.u.core.command(args)
        built=self.command.call_args.args[0][-1]
        self.assertIn(str(self.node),built);self.assertIn('Node identity drift',built)
        self.assertIn('npm prune --omit=dev',built);self.assertIn('Native runtime verified',built)
        self.u.core.check_runtime(self.target,{},'fixture-probe',3001,False,100)
        call=self.u.core.network_command.call_args
        self.assertEqual(call.args[0][:4],['runuser','-u','ubuntu','--'])
        self.assertEqual(call.args[1],100);self.assertIn('createRequire',call.args[0][-1])
        self.assertNotIn('DATABASE_PATH',call.args[0][-1])

    def test_process_only_uat_and_two_listeners_fail(self):
        (self.proc/'101/environ').write_bytes(b'BUBBLEWASH_UAT_ENABLED=true\0')
        with self.assertRaises(ValueError):self.bind()
        (self.proc/'101/environ').write_bytes(b'')
        self.u.core.network_command.return_value='pid=100 pid=101'
        with self.assertRaises(ValueError):self.bind()

    def test_changed_node_binary_refused_and_rehearsal_cannot_establish_baseline(self):
        with self.assertRaises(ValueError):self.u.core.check_runtime(self.target,{},'probe',3001,False,100)
        self.bind();self.node.write_bytes(b'different executable')
        with self.assertRaises(ValueError):self.bind()


class ExecutableNativePayload(unittest.TestCase):
    def test_both_js_payload_forms_execute_with_strict_module_exports(self):
        import subprocess,shutil
        if not shutil.which('node'):self.skipTest('Node is supplied by hosted runtime checks')
        stub="""const Module=require('node:module');const load=Module._load;Module._load=function(name,...rest){if(name==='better-sqlite3/package.json')return {version:'12.10.0'};if(name==='better-sqlite3')return class{constructor(p){if(p!==':memory:')throw Error('not memory')}prepare(){return {get(){return {n:1}}}}close(){}};if(name==='sharp/package.json')throw Error('package export forbidden');if(name==='sharp'){const sharp=()=>({png(){return this},toBuffer(){return Promise.resolve(Buffer.from('image'))}});sharp.versions={sharp:'0.35.5'};return sharp}return load.call(this,name,...rest)};"""
        forms=[w.NATIVE_CHECK,'(function(require){'+w.NATIVE_CHECK+'})(require("node:module").createRequire('+json.dumps(str(ROOT/'package.json'))+'))']
        for code in forms:
            result=subprocess.run(['node','-e',stub+code],capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('Native runtime verified',result.stdout)

if __name__ == '__main__':unittest.main()
