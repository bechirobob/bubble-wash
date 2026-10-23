"""Adversarial local-only adapter coverage. No host service commands run here."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT/'ops/integration-release'))
import contracts as k
import host_adapter as a
import select_source as selector


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='integration-adapter-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('src/lib/auth.ts', 'scripts/run.mjs', 'ops/old.py', 'package.json'):
            path = self.root/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(name)
        self.pins = k.content_manifest(self.root, ['package.json'])
        self.profile = {'files': self.pins, 'rootFiles': ['package.json'], 'contentSha256': k.object_digest(self.pins)}
        self.contract = {'schema': 'bubblewash-integration-source/v1', 'baseCommit': k.BASELINE,
                         'profiles': {name: copy.deepcopy(self.profile) for name in k.PROFILE_NAMES}}

    def test_exact_source_positive_and_unknown_profile(self):
        self.assertEqual(k.verify_source(self.root, self.contract, k.PROFILE_NAMES[0]), self.profile)
        with self.assertRaises(ValueError): k.verify_source(self.root, self.contract, 'anything')

    def test_unreviewed_environment_and_root_code_rejected(self):
        for name in ('.env.local', 'unreviewed-loader.mjs'):
            p=self.root/name;p.write_text('unreviewed')
            with self.assertRaises(ValueError):k.verify_source(self.root,self.contract,k.PROFILE_NAMES[0])
            p.unlink()

    def test_source_addition_rejected(self):
        (self.root/'src/extra.ts').write_text('unreviewed')
        with self.assertRaises(ValueError): k.verify_source(self.root, self.contract, k.PROFILE_NAMES[0])

    def test_source_deletion_rejected(self):
        (self.root/'src/lib/auth.ts').unlink()
        with self.assertRaises(ValueError): k.verify_source(self.root, self.contract, k.PROFILE_NAMES[0])

    def test_source_symlink_and_hardlink_rejected(self):
        path = self.root/'src/lib/auth.ts'; path.unlink(); path.symlink_to(self.root/'package.json')
        with self.assertRaises(ValueError): k.content_manifest(self.root, ['package.json'])
        path.unlink(); os.link(self.root/'package.json', path)
        with self.assertRaises(ValueError): k.content_manifest(self.root, ['package.json'])

    def test_manifest_digest_and_base_cannot_drift(self):
        self.contract['profiles'][k.PROFILE_NAMES[0]]['files']['src/lib/auth.ts'] = '0'*64
        with self.assertRaises(ValueError): k.verify_source(self.root, self.contract, k.PROFILE_NAMES[0])
        self.contract['baseCommit'] = 'a'*40
        with self.assertRaises(ValueError): k.verify_source(self.root, self.contract, k.PROFILE_NAMES[0])

    def test_source_root_configs_are_pinned(self):
        (self.root/'package.json').write_text('new dependency')
        with self.assertRaises(ValueError): k.verify_source(self.root, self.contract, k.PROFILE_NAMES[0])

    def test_duplicate_json_rejected(self):
        p=self.root/'ambiguous.json'; p.write_text('{"x":1,"x":2}')
        with self.assertRaises(ValueError): k.read_json(p)

    def test_path_traversal_rejected(self):
        for name in ('../etc', '/etc/passwd', 'src/../file', 'src\\file', './src/file'):
            with self.subTest(name=name), self.assertRaises(ValueError): k.relative(name)

    def test_adapter_changes_do_not_hide_ordinary_ops_changes(self):
        (self.root/'ops/integration-release').mkdir()
        (self.root/'ops/integration-release/self.py').write_text('independently pinned')
        self.assertEqual(k.content_manifest(self.root, ['package.json']), self.pins)
        (self.root/'ops/old.py').write_text('changed historical guard')
        with self.assertRaises(ValueError): k.verify_source(self.root, self.contract, k.PROFILE_NAMES[0])

    def dependencies(self):
        root=self.root/'node_modules'
        for name in ('next/package.json', 'better-sqlite3/package.json', 'better-sqlite3/build/Release/addon.node'):
            p=root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(name.encode())
        return root

    def test_dependencies_pin_native_bytes_mode_and_complete_set(self):
        root=self.dependencies(); before=k.dependency_manifest(root)
        native=root/'better-sqlite3/build/Release/addon.node'; native.write_bytes(b'replaced')
        self.assertNotEqual(before,k.dependency_manifest(root))
        native.write_bytes(b'better-sqlite3/build/Release/addon.node'); native.chmod(0o700)
        self.assertNotEqual(before,k.dependency_manifest(root))
        (root/'new.js').write_text('extra'); self.assertNotEqual(before,k.dependency_manifest(root))

    def test_shared_dependency_symlink_refused(self):
        root=self.dependencies(); link=self.root/'shared'; link.symlink_to(root, target_is_directory=True)
        with self.assertRaises(ValueError): k.dependency_manifest(link)

    def test_internal_bin_link_allowed_escape_and_directory_links_refused(self):
        root=self.dependencies(); (root/'.bin').mkdir(); link=root/'.bin/next'; link.symlink_to('../next/package.json')
        self.assertEqual(k.dependency_manifest(root)['.bin/next'], {'link':'../next/package.json'})
        link.unlink(); link.symlink_to('../../package.json')
        with self.assertRaises(ValueError): k.dependency_manifest(root)
        link.unlink(); link.symlink_to('../next')
        with self.assertRaises(ValueError): k.dependency_manifest(root)

    def test_unmaterialized_commit_never_becomes_a_real_sha(self):
        for value in (None, '', 'content-only', 'a'*39):
            with self.assertRaises(ValueError): k.runtime_manifest(self.root, value)

    def test_adapter_rejects_injected_timestamp_bytecode_before_import(self):
        import importlib._bootstrap_external as external
        fake=self.root/'adapter';fake.mkdir();source=fake/'host_adapter.py';source.write_text('TRUSTED=True\n')
        cached=Path(importlib.util.cache_from_source(str(source)));cached.parent.mkdir()
        cached.write_bytes(external._code_to_timestamp_pyc(compile('raise RuntimeError(\"INJECTED\")',str(source),'exec'),int(source.stat().st_mtime),source.stat().st_size))
        with patch.object(a,'HERE',fake),self.assertRaisesRegex(ValueError,'cache'):
            a.adapter_manifest()
        bootstrap=(ROOT/'ops/integration-release/stream_host.py').read_text()
        self.assertLess(bootstrap.index("'__pycache__' not in p.parts"),bootstrap.index('from host_adapter import main'))

    def test_frozen_vendor_bytes_and_adapter_pin_change(self):
        for name, pin in k.VENDOR.items(): self.assertEqual(k.digest(k.HERE/'vendor'/name), pin)
        control=k.load_controller(); self.assertEqual(control.core.APP, 'bubblewash-local.service')
        pins=a.adapter_manifest(); self.assertIn('host_adapter.py', pins)
        self.assertNotIn('source-contracts.json', pins)


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='integration-host-fixture-'); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.commands=[]
        self.control=k.load_controller()
        self.plan={key:str(self.root/key) for key in ('old','candidate','fallback')}
        self.plan['units']={m+'/'+u:{'cgroup':'/'+m+'/'+u} for m,u in self.control.core.UNITS}
        self.proc=self.root/'proc'; self.proc.mkdir()
        self.cgroups=self.root/'cgroups'; self.cgroups.mkdir()
        with patch.object(a.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())):
            self.host=a.Host(self.plan,self.control,self.run_command,proc=self.proc,cgroup=self.cgroups)

    def run_command(self, args, **kwargs):
        self.commands.append((args,kwargs))
        return ''

    def test_manager_routes_and_no_maintenance_start(self):
        self.host.service('user','start',self.control.core.APP)
        self.assertEqual(self.commands[-1][0][:4],['runuser','-u','ubuntu','--'])
        self.host.service('system','stop',self.control.core.TIMER)
        self.assertEqual(self.commands[-1][0][:2],['systemctl','stop'])
        for m,u in self.control.core.UNITS:
            if u!=self.control.core.APP:
                with self.assertRaises(ValueError):self.host.service(m,'start',u)
        with self.assertRaises(ValueError):self.host.service('system','daemon-reload',self.control.core.APP)

    def test_exec_start_static_binding_survives_runtime_metadata_changes(self):
        expected=[{'path':'/usr/bin/npm','argv':['/usr/bin/npm','run','start'],'ignoreFailure':False}]
        for metadata in ('0 0 0 0 0 0 0', '10 20 30 40 123 1 0', '50 60 0 0 456 0 0'):
            self.host.run=lambda *_a,**_k:'a(sasbttttuii) 1 /usr/bin/npm 3 /usr/bin/npm run start false '+metadata
            self.assertEqual(self.host.exec_start('user',self.control.core.APP),expected)
        self.host.run=lambda *_a,**_k:'a(sasbttttuii) 1 /usr/bin/npm 3 /usr/bin/npm run changed false 0 0 0 0 0 0 0'
        self.assertNotEqual(self.host.exec_start('user',self.control.core.APP),expected)
        for bad in ('a(sasbttttuii) 1 missing', 'a(sasbttttuii) 0', 'wrong 0'):
            self.host.run=lambda *_a,**_k:bad
            with self.assertRaises(ValueError):self.host.exec_start('user',self.control.core.APP)

    def fake_process(self,pid=123,release=None):
        p=self.proc/str(pid);p.mkdir();(p/'cmdline').write_bytes(b'node\x00server')
        (p/'stat').write_text(f'{pid} (node) S '+' '.join(['0']*18+['99']+['0']*20))
        (p/'cwd').symlink_to(release or self.plan['old']);return p

    def test_process_inventory_checks_all_uids_without_logging_argv(self):
        Path(self.plan['old']).mkdir(); self.fake_process()
        self.assertEqual(a.release_processes(self.host.roots,self.proc),{'123':'99'})
        with self.assertRaises(ValueError):self.host.quiet()

    def test_current_alias_and_relative_launcher_are_detected(self):
        cwd=self.root/'home';cwd.mkdir();p=self.fake_process(release=cwd)
        for command in (b'node\x00/home/ubuntu/bubblewash-pilot/scripts/run-maintenance.mjs', b'node\x00bubblewash-pilot/scripts/run-maintenance.mjs'):
            (p/'cmdline').write_bytes(command)
            roots=[Path('/home/ubuntu/bubblewash-pilot'),cwd/'bubblewash-pilot']
            self.assertEqual(a.release_processes(roots,self.proc), {'123':'99'})

    def test_zombie_does_not_count_as_writer(self):
        p=self.fake_process();(p/'stat').write_text('123 (node) Z '+' '.join(['0']*18+['99']+['0']*20))
        self.assertEqual(a.release_processes(self.host.roots,self.proc),{})

    def test_unreadable_process_is_not_assumed_dead(self):
        p=self.proc/'456';p.mkdir();(p/'stat').write_text('456 (node) S '+' '.join(['0']*40))
        with self.assertRaises(ValueError):a.release_processes(self.host.roots,self.proc)

    def test_capture_binds_existing_cgroup_and_pid_start(self):
        group=self.cgroups/'user'/self.control.core.APP;group.mkdir(parents=True);(group/'cgroup.procs').write_text('123')
        Path(self.plan['old']).mkdir();self.fake_process()
        def show(manager,unit):
            return 'ControlGroup=/'+manager+'/'+unit+'\nMainPID=0\nControlPID=0\n'
        self.host.show=show; self.host.capture()
        self.assertEqual(self.host.captured,{'123':'99'});self.assertEqual(len(self.host.groups),2)

    def test_wrong_cgroup_and_absent_active_cgroup_refused(self):
        self.host.show=lambda *_:'ControlGroup=/unrelated\nMainPID=0\nControlPID=0\n'
        with self.assertRaises(ValueError):self.host.capture()
        self.host.show=lambda *_:'ControlGroup=\nMainPID=10\nControlPID=0\n'
        with self.assertRaises(ValueError):self.host.capture()

    def test_listener_evidence_must_be_completely_empty(self):
        for name in ('one','two'):
            group=self.cgroups/name;group.mkdir();(group/'cgroup.procs').write_text('')
            self.host.groups[group]=(group.stat().st_dev,group.stat().st_ino)
        self.host.show=lambda *_:'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=\n'
        self.host.run=lambda *_args,**_kwargs:'LISTEN 0 128 127.0.0.1:3000'
        with self.assertRaises(ValueError):self.host.quiet()
        self.host.run=lambda *_args,**_kwargs:''
        self.assertTrue(self.host.quiet())

    def test_inventory_absence_new_file_and_symlink_fail_closed(self):
        target=self.root/'cron'; before=a.configuration_inventory([str(target)])
        self.assertEqual(before[str(target)],{'absent':True});target.mkdir();(target/'job').write_text('job')
        self.assertNotEqual(before,a.configuration_inventory([str(target)]))
        (target/'alias').symlink_to(target/'job')
        with self.assertRaises(ValueError):a.configuration_inventory([str(target)])

    def test_invoker_boolean_cannot_stand_in_for_receipt(self):
        self.plan['hostAcceptance']={'externalInvokersExcluded':True}
        with self.assertRaises(KeyError):self.host.exclusion()

    def test_pure_migration_runs_fixed_entrypoint_without_production_secret_environment(self):
        node=self.root/'node';node.write_text('runtime')
        self.plan['node']={'path':str(node),'sha256':k.digest(node)}
        def run(args,**kwargs):
            self.commands.append((args,kwargs))
            if 'scripts/migrate-booking-references.mjs' in args:
                return json.dumps({'ok':True,'migration':'permanent-booking-vendor-labels-v1','historicalBackfill':False})
            return json.dumps({'ok':True,'migration':'notification-outbox-exact-additive-v1'})
        self.host.run=run
        with patch.object(a,'protected',return_value=()):self.assertTrue(self.host.migrate(self.root/'db.sqlite'))
        self.assertEqual(len(self.commands),2)
        self.assertIn('scripts/migrate-booking-references.mjs',self.commands[0][0])
        args,kw=self.commands[-1]
        self.assertIn('scripts/migrate-notification-outbox.mjs',args)
        self.assertNotIn('getDatabase',repr(args));self.assertNotIn('RESEND_API_KEY',kw['env'])
        self.assertNotIn('BUBBLEWASH_MAINTENANCE_TOKEN',kw['env'])
        self.assertEqual(kw['env']['BUBBLEWASH_DATABASE_PATH'],str(self.root/'db.sqlite'))
        node.write_text('changed')
        with patch.object(a,'protected',return_value=()),self.assertRaises(ValueError):self.host.migrate(self.root/'db.sqlite')

    def test_verifier_uses_readonly_existing_database_and_no_initializer(self):
        calls=[];self.host.node=lambda target,args,database:(calls.append((target,args,database)) or 'exact-additive-ready')
        self.assertTrue(self.host.verify_database(self.root/'db'))
        source=calls[0][1][-1]
        self.assertIn('readonly:true,fileMustExist:true',source);self.assertIn('query_only=ON',source)
        self.assertNotIn('getDatabase(',source);self.assertNotIn('migrateNotification',source)
        self.assertEqual(calls[0][0],Path(self.plan['fallback']))

    def test_recovery_identity_accepts_fresh_receipts_but_not_new_release_or_config(self):
        vendor=ROOT/'ops/integration-release/vendor/bubblewash-durable-controller'
        sys.path.insert(0,str(vendor))
        import test_controller as frozen_test
        fixture=frozen_test.DurableTests('test_success_leaves_maintenance_inhibited_and_owner_aware_pointer')
        fixture.setUp()
        try:
            plan=copy.deepcopy(fixture.plan)
            plan.update({'schema':'bubblewash-integration-host-plan/v1','state':str(fixture.state.directory),
                'dependencies':{},'gitBindings':{},'sourceContractSha256':'a'*64,'adapterFiles':{},
                'ownerEvidenceSha256':'a'*64,'ownerEvidencePath':str(self.root/'evidence'),
                'node':{'path':'/usr/bin/node','sha256':'b'*64},'units':{},
                'guards':{'envSha256':'c'*64,'database':str(fixture.db),'receiptSha256':'d'*64,'receiptRun':'1','archiveSha256':'e'*64},
                'hostAcceptance':{'inventoryPaths':[],'launcherAliases':[],'exclusionReceipt':'/old-boot','exclusionReceiptSha256':'f'*64}})
            first=a.durable_plan(plan,frozen_test.c)
            fixture.plan=first;fixture.control=fixture.make_controller()
            self.assertEqual(fixture.control.execute(),'candidate-ready')
            refreshed=copy.deepcopy(plan)
            refreshed['guards'].update({'receiptSha256':'1'*64,'receiptRun':'2','archiveSha256':'2'*64})
            refreshed['hostAcceptance'].update({'exclusionReceipt':'/new-boot','exclusionReceiptSha256':'3'*64})
            renewed=a.durable_plan(refreshed,frozen_test.c)
            self.assertEqual(first,renewed)
            fixture.plan=renewed;fixture.control=fixture.make_controller()
            self.assertEqual(fixture.control.recover(),'fallback-ready')
            for section,key in (('guards','envSha256'),('releaseShas','candidate'),('node','sha256')):
                changed=copy.deepcopy(refreshed);changed[section][key]='9'*len(changed[section][key])
                replacement=a.durable_plan(changed,frozen_test.c)
                self.assertNotEqual(first,replacement)
                fixture.plan=replacement;fixture.control=fixture.make_controller()
                with self.assertRaises(ValueError):fixture.control.recover()
                self.assertTrue(fixture.state.app_hold.exists())
                self.assertTrue(fixture.state.maintenance_hold.exists())
        finally:
            fixture.tearDown()

    def test_manual_workflow_is_install_free_and_exact_ci_pair(self):
        text=(ROOT/'.github/workflows/integration-code-deploy.yml').read_text()
        backup=(ROOT/'.github/workflows/backup-transport-checks.yml').read_text()
        self.assertIn("PYTHONDONTWRITEBYTECODE: '1'",backup)
        self.assertLess(backup.index('PYTHONDONTWRITEBYTECODE'),backup.index('    steps:'))
        self.assertIn('default: inspect',text);self.assertIn('group: bubblewash-production',text)
        self.assertIn('TARGET_SHA="$CANDIDATE_SHA" python3 ops/check-release-ci.py',text)
        self.assertIn('TARGET_SHA="$FALLBACK_SHA" python3 ops/check-release-ci.py',text)
        for forbidden in ('daemon-reload','systemctl enable','npm ci','chmod','chown','cron','continue-on-error'):
            self.assertNotIn(forbidden,text)
        self.assertNotIn('secrets.',text.split('      - name: Create no credentials')[0])

if __name__=='__main__':unittest.main()


class CandidateOnlyRootSelectorTests(unittest.TestCase):
    def test_missing_candidate_root_does_not_hide_exact_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'ops').mkdir()
            (root/'ops/deploy-personal-owner.py').write_text('def verify_owner_candidate(root): raise ValueError("not historical")\n')
            def verify(root, contract, profile):
                if profile == k.PROFILE_NAMES[0]: raise FileNotFoundError('candidate-only root')
                return {'exact': True}
            with patch.object(selector, 'read_json', return_value={}), patch.object(selector, 'verify_source', side_effect=verify):
                self.assertEqual(selector.select(root), k.PROFILE_NAMES[1])
                with self.assertRaises(ValueError): selector.select(root, k.PROFILE_NAMES[0])
            with patch.object(selector, 'read_json', return_value={}), patch.object(selector, 'verify_source', side_effect=PermissionError('unreadable')):
                with self.assertRaises(PermissionError): selector.select(root)
            with patch.object(selector, 'read_json', return_value={}), patch.object(selector, 'verify_source', return_value={}):
                with self.assertRaises(ValueError): selector.select(root)
