import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import time
import types
import unittest
import contextlib
from unittest import mock

MODULE = Path(__file__).resolve().parents[1]/'ops/inactive-staging/prepare_pair.py'
spec = importlib.util.spec_from_file_location('prepare_pair_tested', MODULE)
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)


class PreparationTests(unittest.TestCase):
    def test_normal_backup_checks_cannot_generate_runner_bytecode(self):
        workflow = (MODULE.parents[2]/'.github/workflows/nightly-backup.yml').read_text()
        self.assertIn("run: PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s .github/backup -p 'test_*.py' -v", workflow)
        self.assertLess(workflow.index('Verify encrypted backup transport before host access'), workflow.index('Connect to the production tailnet'))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.uid = os.getuid()

    def tearDown(self):
        self.tmp.cleanup()

    def source(self):
        root = self.root/'source'; root.mkdir()
        for name in p.ROOT_FILES:
            (root/name).write_text(name+'\n')
        (root/'src').mkdir(); (root/'src/a.ts').write_text('export const a = 1;\n')
        return root

    def database(self, name='database.sqlite'):
        path = self.root/name
        with sqlite3.connect(path) as db:
            db.executescript('CREATE TABLE original(value BLOB); INSERT INTO original(rowid,value) VALUES(77,X\'0001\');')
        return path

    def test_exact_content_changes_tree(self):
        root = self.source(); original = p.git_tree(p.source_files(root, self.uid))
        (root/'src/a.ts').write_text('export const a = 2;\n')
        self.assertNotEqual(original, p.git_tree(p.source_files(root, self.uid)))

    def test_extra_tracked_root_file_scope_is_explicit(self):
        root = self.source(); first = p.git_tree(p.source_files(root, self.uid))
        (root/'src/unknown.ts').write_text('extra')
        self.assertNotEqual(first, p.git_tree(p.source_files(root, self.uid)))

    def test_missing_root_file_refuses(self):
        root = self.source(); (root/'package.json').unlink()
        with self.assertRaises(FileNotFoundError): p.source_files(root, self.uid)

    def test_rename_changes_tree(self):
        root = self.source(); first = p.git_tree(p.source_files(root, self.uid))
        (root/'src/a.ts').rename(root/'src/b.ts')
        self.assertNotEqual(first, p.git_tree(p.source_files(root, self.uid)))

    def test_executable_mode_changes_tree(self):
        root = self.source(); first = p.git_tree(p.source_files(root, self.uid))
        (root/'src/a.ts').chmod(0o755)
        self.assertNotEqual(first, p.git_tree(p.source_files(root, self.uid)))

    def test_symlink_regular_file_refused(self):
        root = self.source(); (root/'src/a.ts').unlink(); (root/'src/a.ts').symlink_to(root/'README.md')
        with self.assertRaises(OSError): p.source_files(root, self.uid)

    def test_symlink_directory_refused(self):
        root = self.source(); (root/'src/linked').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): p.source_files(root, self.uid)

    def test_hardlink_refused(self):
        root = self.source(); os.link(root/'src/a.ts', root/'src/b.ts')
        with self.assertRaises(ValueError): p.source_files(root, self.uid)

    def test_group_write_refused(self):
        root = self.source(); (root/'src/a.ts').chmod(0o664)
        with self.assertRaises(ValueError): p.source_files(root, self.uid)

    def test_renamed_ancestor_refused_after_read(self):
        root = self.source()
        with self.assertRaises((FileNotFoundError, ValueError)):
            with p.anchored_file(root, 'src/a.ts', (self.uid,)) as (fd, _):
                os.read(fd, 64); (root/'src').rename(root/'moved'); (root/'src').mkdir()

    def test_atime_does_not_count_as_content_drift(self):
        root = self.source(); path = root/'src/a.ts'
        with p.anchored_file(root, 'src/a.ts', (self.uid,)) as (fd, _):
            os.read(fd, 64)
        self.assertEqual(p.file_row(root, 'src/a.ts', (self.uid,))['size'], path.stat().st_size)

    def test_only_exact_generated_subtree_excluded_from_git_reconstruction(self):
        root = self.source(); tooling=root/'tooling/next-eslint-glob'; tooling.mkdir(parents=True)
        (tooling/'index.js').write_text('tracked wrapper')
        initial=p.git_tree(p.source_files(root,self.uid))
        (tooling/'node_modules').mkdir(); (tooling/'node_modules/generated.js').write_text('generated')
        self.assertEqual(initial,p.git_tree(p.source_files(root,self.uid)))
        (tooling/'neighbor.js').write_text('unknown')
        self.assertNotEqual(initial,p.git_tree(p.source_files(root,self.uid)))

    def test_readonly_snapshot_preserves_rows_rowids_and_source_bytes(self):
        source=self.database(); before=source.read_bytes(); dest=self.root/'copy.sqlite'
        p.private_copy(source,dest,time.monotonic()+10)
        self.assertEqual(source.read_bytes(),before)
        self.assertEqual(stat.S_IMODE(dest.stat().st_mode),0o600)
        with sqlite3.connect(dest) as db: self.assertEqual(db.execute('select rowid,value from original').fetchall(),[(77,b'\x00\x01')])

    def test_snapshot_never_reuses_destination(self):
        source=self.database(); dest=self.root/'copy.sqlite'; dest.write_bytes(b'held')
        with self.assertRaises(FileExistsError): p.private_copy(source,dest,time.monotonic()+10)
        self.assertEqual(dest.read_bytes(),b'held')

    def test_missing_source_does_not_create_database(self):
        source=self.root/'missing'; dest=self.root/'copy'
        with self.assertRaises(FileNotFoundError):p.private_copy(source,dest,time.monotonic()+10)
        self.assertFalse(source.exists()); self.assertFalse(dest.exists())

    def test_snapshot_timeout_never_retries(self):
        source=self.database(); before=source.read_bytes(); dest=self.root/'copy'
        with self.assertRaises(ValueError):p.private_copy(source,dest,time.monotonic()-1)
        self.assertEqual(source.read_bytes(),before)
        self.assertTrue(dest.exists())  # retained partial, never automatically reused

    def test_wal_source_requires_existing_sidecars(self):
        source=self.database(); raw=bytearray(source.read_bytes());raw[18:20]=b'\x02\x02';source.write_bytes(raw)
        with self.assertRaises(FileNotFoundError):p.private_copy(source,self.root/'copy',time.monotonic()+10)

    def test_build_has_no_production_environment_or_db(self):
        args=p.build_arguments(Path('/fixed/build'),'/usr/bin/node','bubblewash-prepare-123-1-candidate-build')
        joined=' '.join(args)
        self.assertNotIn('EnvironmentFile',joined); self.assertNotIn('DATABASE',joined)
        self.assertIn('--property=User=ubuntu',args);self.assertIn('--property=ProtectHome=tmpfs',args)
        self.assertIn('HOME=/tmp',args);self.assertIn('--property=KillMode=control-group',args)

    def test_production_install_is_separate_and_omits_dev(self):
        args=p.build_arguments(Path('/fixed/production'),'/usr/bin/node','unit',Path('/fixed/build'))
        self.assertIn('--property=BindReadOnlyPaths=/fixed/build',args)
        self.assertIn('npm ci --omit=dev',args[-3]);self.assertNotIn('npm prune',' '.join(args))

    def dependency_map(self):
        return {name:{'sha256':'a'*64,'mode':0o644} for name in ('next/package.json','better-sqlite3/package.json')}

    def test_dependency_image_normalizes_only_modes_and_preserves_every_hash(self):
        original=self.dependency_map()
        original['qrcode/lib/core/version.js']={'sha256':'b'*64,'mode':0o754}
        original['qrcode/lib/core/error-correction-code.js']={'sha256':'c'*64,'mode':0o754}
        original['.bin/next']={'link':'../next/package.json'}
        before=json.dumps(original,sort_keys=True)
        image,changes=p.canonical_dependency_image(original)
        self.assertEqual(len(changes),2);self.assertEqual(json.dumps(original,sort_keys=True),before)
        self.assertEqual(image['.bin/next'],original['.bin/next'])
        for name,row in changes.items():
            self.assertEqual((row['beforeMode'],row['afterMode']),(0o754,0o755))
            self.assertEqual(image[name]['sha256'],original[name]['sha256'])
        self.assertEqual(p.canonical_dependency_image(image),(image,{}))

    def test_dependency_image_refuses_special_or_write_risk_modes(self):
        for mode in (0o4755,0o2755,0o1755,0o664,0o775,0o777,-1,True):
            with self.subTest(mode=mode):
                files=self.dependency_map();files['unsafe']={'sha256':'b'*64,'mode':mode}
                with self.assertRaises(ValueError):p.canonical_dependency_image(files)

    def test_dependency_image_refuses_escape_link_and_unknown_shape(self):
        for name,row in [('../escape',{'sha256':'b'*64,'mode':0o644}),('link',{'link':'../../outside'}),('link',{'link':'/fixed'}),('special',{'type':'fifo'}),('bad',{'sha256':'bad','mode':0o644})]:
            with self.subTest(name=name,row=row):
                files=self.dependency_map();files[name]=row
                with self.assertRaises(ValueError):p.canonical_dependency_image(files)

    def test_pinned_report_only_checks_expected_runtime_stages(self):
        class Report:
            def __init__(self):self.stage='PREFLIGHT';self.failure=None;self.cleanup=True;self.safe_to_remove=True
            def fail(self,error):self.failure=str(error)
        core=types.SimpleNamespace(RehearsalReport=Report)
        with mock.patch.object(p,'probe_node_identity',return_value=('pid-start','node')) as check:
            report=p.pinned_rehearsal_report(core,None,self.root,{},'fixed')
            for stage in ('SNAPSHOT','PROBE_START','HEALTH'):report.stage=stage
            check.assert_not_called()
            report.stage='RUNTIME_BEFORE';self.assertEqual(check.call_count,1)
            report.stage='ROUTE_HOME';self.assertEqual(check.call_count,1)
            report.stage='RUNTIME_AFTER';self.assertEqual(check.call_count,2)
            report.stage='PROBE_STOP';report.fail(ValueError('preserved'))
            self.assertEqual(report.failure,'preserved');self.assertEqual(report.stage,'PROBE_STOP')
            self.assertEqual(report.node_stages,['RUNTIME_BEFORE','RUNTIME_AFTER'])

    def test_pinned_report_rejects_missing_repeated_or_changed_runtime_identity(self):
        class Report:
            def __init__(self):self.stage='PREFLIGHT'
        core=types.SimpleNamespace(RehearsalReport=Report)
        for stages,observations in [(['RUNTIME_AFTER'],[('pid','node')]),(['RUNTIME_BEFORE','RUNTIME_BEFORE'],[('pid','node')]),(['RUNTIME_BEFORE','RUNTIME_AFTER'],[('old-pid','node'),('new-pid','node')]),(['RUNTIME_BEFORE','RUNTIME_AFTER'],[('pid','old-node'),('pid','new-node')])]:
            with self.subTest(stages=stages,observations=observations),mock.patch.object(p,'probe_node_identity',side_effect=observations):
                report=p.pinned_rehearsal_report(core,None,self.root,{},'fixed')
                with self.assertRaises(ValueError):
                    for stage in stages:report.stage=stage

    def test_probe_identity_binds_main_listener_start_and_executable(self):
        proc=self.root/'proc';proc.mkdir();target=self.root/'runtime';target.mkdir();node=self.root/'node';node.write_bytes(b'node')
        for pid in ('23','24'):
            row=proc/pid;row.mkdir();(row/'cwd').symlink_to(target);(row/'exe').symlink_to(node);(row/'cgroup').write_bytes(b'fixed-cgroup')
        starts={'23':'100','24':'101'}
        adapter=types.SimpleNamespace(protected=lambda *a,**kw:('node-inode',),digest=lambda path:p.sha(Path(path).read_bytes()),process_identity=lambda pid,path:starts[pid])
        core=types.SimpleNamespace(verify_private_network=lambda *a:23,network_command=lambda *a:'LISTEN pid=24,fd=2')
        pin={'path':str(node),'sha256':p.sha(node.read_bytes())}
        first=p.probe_node_identity(core,adapter,target,pin,'fixed',proc)
        self.assertEqual(first[0],(('23','100'),('24','101')))
        starts['24']='102';self.assertNotEqual(p.probe_node_identity(core,adapter,target,pin,'fixed',proc),first)
        alternate=self.root/'alternate';alternate.write_bytes(b'node');(proc/'24/exe').unlink();(proc/'24/exe').symlink_to(alternate)
        with self.assertRaises(ValueError):p.probe_node_identity(core,adapter,target,pin,'fixed',proc)
        (proc/'24/exe').unlink();(proc/'24/exe').symlink_to(node)
        adapter.process_identity=mock.Mock(side_effect=['100','101','changed','changed'])
        with self.assertRaises(ValueError):p.probe_node_identity(core,adapter,target,pin,'fixed',proc)

    def test_actual_historical_rehearsal_stops_probe_when_node_hook_refuses(self):
        control=Path(os.environ.get('BUBBLEWASH_TEST_CONTROL_SOURCE',str(MODULE.parents[2])))
        file=control/'ops/deploy-preserving.py'
        self.assertEqual(p.sha(file.read_bytes()),'29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a')
        spec=importlib.util.spec_from_file_location('actual_preserving_cleanup',file)
        core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
        candidate=self.root/'candidate';(candidate/'.next').mkdir(parents=True);(candidate/'.next/BUILD_ID').write_text('synthetic')
        source=self.database('source.sqlite');before=source.read_bytes();owner=types.SimpleNamespace(pw_uid=self.uid,pw_gid=os.getgid())
        @contextlib.contextmanager
        def directory(*args):
            with tempfile.TemporaryDirectory(dir=self.root) as tmp:yield tmp
        for fail_after in (False,True):
            commands=[]
            report=p.pinned_rehearsal_report(core,None,candidate,{},'fixed-probe.service')
            observations=[('fixed-pid','fixed-node'),ValueError('node drift')] if fail_after else [ValueError('node drift')]
            with self.subTest(after=fail_after),mock.patch.object(core,'rehearsal_directory',side_effect=directory),\
                 mock.patch.object(core,'probe_state',side_effect=[{'LoadState':'not-found','ActiveState':'inactive','MainPID':'0'},{'LoadState':'not-found','ActiveState':'inactive','MainPID':'0'}]),\
                 mock.patch.object(core,'command',side_effect=lambda args,**kw:commands.append(args) or ''),\
                 mock.patch.object(core,'verify_private_network',return_value=42),mock.patch.object(core,'health'),\
                 mock.patch.object(core,'check_runtime'),mock.patch.object(core,'network_command',return_value=''),\
                 mock.patch.object(p,'probe_node_identity',side_effect=observations):
                try:
                    with self.assertRaises(ValueError):core.rehearse(candidate,{},source,self.root/'status',owner,'fixed',report)
                finally:p.signal.setitimer(p.signal.ITIMER_REAL,0)
            self.assertTrue(any(command[:2]==['systemctl','stop'] for command in commands))
            self.assertEqual(sum(command[0]=='systemd-run' for command in commands),1)
            self.assertTrue(report.safe_to_remove);self.assertTrue(report.cleanup);self.assertIsNotNone(report.failure)
            self.assertEqual(report.failure['stage'],'RUNTIME_AFTER' if fail_after else 'RUNTIME_BEFORE')
            self.assertEqual(source.read_bytes(),before)

    def rehearsal(self, failure=None):
        preimage=self.database('preimage.sqlite'); candidate=self.root/'candidate'; fallback=self.root/'fallback'
        calls=[]; checks=[]
        class Host:
            command=staticmethod(lambda *a,**kw:'')
            def migrate(self,copy):
                checks.append(('migrate',Path(self.plan['snapshot']),copy))
                if failure=='migration':raise ValueError('private data must never escape')
                with sqlite3.connect(copy) as db: db.execute('create table feature(id integer)')
                return True
            def feature(self,copy,mode):return '{}'
            def acknowledgement(self,*args):return None
        adapter=types.SimpleNamespace(Host=Host,verify_completion_data=lambda *args:checks.append(('proof',*args)))
        class Report:
            def __init__(self):self.stage='PREFLIGHT';self.failure=None;self.cleanup=True;self.safe_to_remove=True
        core=types.SimpleNamespace(RUNTIME=self.root,database_fingerprint=lambda path:p.sha(Path(path).read_bytes()),
            RehearsalDeadline=TimeoutError,RehearsalReport=Report)
        patched=mock.patch.object(p,'probe_node_identity',return_value=('fixed-processes','fixed-node'))
        patched.start();self.addCleanup(patched.stop)
        def rehearse(target,values,source,status,owner,unit,report,prepare_snapshot):
            calls.append((target,source,unit)); directory=self.root/('release-rehearsal-'+str(len(calls)));directory.mkdir()
            copy=directory/'rehearsal.sqlite';p.private_copy(source,copy,time.monotonic()+10)
            prepare_snapshot(copy)
            report.stage='RUNTIME_BEFORE'
            if failure=='probe':raise ValueError('probe failed')
            if failure=='cleanup':report.safe_to_remove=False
            report.stage='RUNTIME_AFTER'
        core.rehearse=rehearse
        return core,adapter,candidate,fallback,preimage,calls,checks

    def test_two_probes_use_same_immutable_preimage(self):
        core,a,c,f,preimage,calls,checks=self.rehearsal();before=preimage.read_bytes(); stages=[]
        out=p.rehearse_pair(core,a,c,f,preimage,{},self.root/'status',None,{'path':'/usr/bin/node'},'123-1',lambda:None,stages.append)
        self.assertEqual([x[1] for x in calls],[preimage,preimage]);self.assertEqual(preimage.read_bytes(),before)
        self.assertEqual(stages,['REHEARSE_CANDIDATE','REHEARSE_FALLBACK'])
        self.assertEqual(len([x for x in checks if x[0]=='migrate']),2);self.assertIn('fallbackRehearsalSeconds',out)

    def test_migration_failure_never_runs_second_probe(self):
        core,a,c,f,preimage,calls,_=self.rehearsal('migration')
        with self.assertRaises(ValueError):p.rehearse_pair(core,a,c,f,preimage,{},self.root/'status',None,{},'123-1',lambda:None)
        self.assertEqual(len(calls),1)

    def test_uncertain_probe_or_cleanup_never_retries(self):
        for failure in ('probe','cleanup'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                old=self.root;self.root=Path(tmp)
                try:
                    core,a,c,f,preimage,calls,_=self.rehearsal(failure)
                    with self.assertRaises(ValueError):p.rehearse_pair(core,a,c,f,preimage,{},self.root/'status',None,{},'123-1',lambda:None)
                    self.assertEqual(len(calls),1)
                finally:self.root=old

    def test_binding_failure_prevents_all_probes(self):
        core,a,c,f,preimage,calls,_=self.rehearsal()
        with self.assertRaises(ValueError):p.rehearse_pair(core,a,c,f,preimage,{},self.root/'status',None,{},'123-1',lambda:(_ for _ in ()).throw(ValueError()))
        self.assertEqual(calls,[])

    def test_prototype_has_no_live_switch_hold_restore_or_controller_constructor(self):
        source=MODULE.read_text()
        for forbidden in ('core.activate(', 'DurableState(', 'run_plan(', 'set_hold(', 'os.replace(', 'restore_database('):
            self.assertNotIn(forbidden,source)
        self.assertIn('prepare_snapshot=prepare',source)
        self.assertIn("core.rehearse(target, values, preimage",source)

    @contextlib.contextmanager
    def orchestration(self, failure=None):
        work=self.root/'releases'; work.mkdir(); current=work/'live';current.mkdir()
        runtime=self.root/'runtime';runtime.mkdir(); current_link=self.root/'current';current_link.symlink_to(current)
        (current/'.release-sha').write_text(p.LIVE)
        marker=runtime/'current-release';marker.write_text(json.dumps({'sha':p.LIVE,'path':str(current)}))
        database=self.database(); private=self.root/'private';private.mkdir()
        archive=self.root/'archive';archive.write_bytes(b'archive')
        env=self.root/'env';env.write_text(json.dumps({'BUBBLEWASH_DATABASE_PATH':str(database),
            'BUBBLEWASH_BACKUP_STATUS_PATH':str(self.root/'status'),'BUBBLEWASH_BACKUP_OFFSITE_DIR':str(self.root)}))
        receipt=self.root/'receipt';receipt.write_text(json.dumps({'sha256':'a'*64,'filename':'archive','size':7}))
        (self.root/'status').write_text('{}')
        for label,(commit,_) in p.PAIR.items():
            for kind in ('build','runtime'):
                path=work/('prepare-'+kind+'-123-1-'+commit);path.mkdir();(path/'.release-sha').write_text(commit)
        controls=self.root/'controls';controls.mkdir();(controls/'source-contracts.json').write_text('{}\n')
        calls=[];state={'config':False,'source':False}
        def source(path,*args):
            label=next((key for key,(commit,_) in p.PAIR.items() if commit in str(path)),'live')
            return {'which':label,'changed':state['source']}
        def tree(row):return 'different' if row['changed'] else p.LIVE_TREE if row['which']=='live' else p.PAIR[row['which']][1]
        def digest(path):return 'b'*64 if str(path)=='/usr/bin/node' else p.sha(Path(path).read_bytes())
        def command(args,**kwargs):
            calls.append(('command',args))
            if failure=='build':raise TimeoutError()
            root=Path(next(x.split('=',2)[2] for x in args if x.startswith('--property=WorkingDirectory=')))
            (root/'.next').mkdir(exist_ok=True);(root/'.next/BUILD_ID').write_text('build')
            if failure=='config':state['config']=True
            if failure=='source':state['source']=True
            if failure=='contract':(controls/'source-contracts.json').write_text('{}  \n')
        def environment(*args):return (env.read_bytes()+(b' ' if state['config'] else b''),('same',))
        def freeze(root,commit,*args):
            calls.append(('freeze',commit));target=self.root/commit;target.mkdir();return target,'c'*64
        def probes(*args):
            calls.append(('probes',args[4]));self.assertEqual(Path(args[4]),private/'preimage.sqlite')
            if failure=='probe':raise ValueError('must remain private')
            return {'candidateRehearsalSeconds':1,'fallbackRehearsalSeconds':1}
        core=types.SimpleNamespace(CURRENT=current_link,RUNTIME=runtime,ENV=env,RECEIPT=receipt,
            deployment_lock=lambda *_:contextlib.nullcontext(lambda:None),parse=json.loads,
            command=command,health=lambda *_:None,verify_receipt=lambda *_:None)
        guards=types.SimpleNamespace(inspect_read=lambda path,*_:Path(path).read_bytes(),
            environment_snapshot=environment,database_identity=lambda *_:('db',),file_identity=lambda *_:('archive',),
            runtime_flags=lambda *_:None,safe_path=lambda path,*_:Path(path).stat())
        scanner=types.SimpleNamespace(source_snapshot=lambda *_:({'original':1},('identity',)),
            content_commitment=lambda _: 'commitment',pins={'runtimeContent':'commitment','runtimeSha':p.LIVE},
            open_configuration=lambda _:None)
        contracts=types.SimpleNamespace(digest=digest,verify_source=lambda *_:None,
            dependency_manifest=lambda *_:{name:{'sha256':'a'*64,'mode':0o644} for name in ('next/package.json','better-sqlite3/package.json')},runtime_manifest=lambda path,commit:{'sha':commit})
        adapter=types.SimpleNamespace(HERE=controls, protected=lambda *_ ,**kw:None, admit_production_configuration=lambda values:p.require(values.get("NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED") != "true"), require_no_runtime_cache=lambda *_:None)
        request={'runId':'123','runAttempt':1,'candidateSha':p.PAIR['candidate'][0],'fallbackSha':p.PAIR['fallback'][0],
            'backupSha256':'a'*64,'receiptRun':'456','storeSha':'d'*40,'storeId':100,'node':{'path':'/usr/bin/node','sha256':'b'*64}}
        owner=types.SimpleNamespace(pw_uid=self.uid,pw_gid=os.getgid())
        with mock.patch.object(p,'WORK',work),mock.patch.object(p.os,'geteuid',return_value=0),\
             mock.patch.object(p.pwd,'getpwnam',return_value=owner),mock.patch.object(p,'source_files',side_effect=source),\
             mock.patch.object(p,'git_tree',side_effect=tree),mock.patch.object(p,'reserve_directories',return_value=private) as reserve,\
             mock.patch.object(p,'freeze',side_effect=freeze),mock.patch.object(p,'rehearse_pair',side_effect=probes):
            yield request,dict(core=core,guards=guards,scanner=scanner,contracts=contracts,adapter=adapter,
                               stager=None,contract={}),calls,reserve

    def test_automation_enabled_refuses_before_build_or_snapshot(self):
        with self.orchestration() as (request, modules, calls, reserve):
            modules['adapter'].admit_production_configuration = lambda _: (_ for _ in ()).throw(ValueError())
            out = p.prepare_pair(request, **modules)
            self.assertFalse(out['ok']); self.assertEqual(out['stage'], 'BINDING')
            self.assertEqual(calls, []); reserve.assert_not_called()

    def test_existing_runtime_cache_refuses_before_private_snapshot(self):
        with self.orchestration() as (request, modules, calls, _):
            modules['adapter'].require_no_runtime_cache = lambda _: (_ for _ in ()).throw(ValueError())
            out = p.prepare_pair(request, **modules)
            self.assertFalse(out['ok']); self.assertEqual(out['stage'], 'FREEZE_CANDIDATE')
            self.assertFalse(any(row[0] == 'probes' for row in calls))
            self.assertFalse((self.root/'private/preimage.sqlite').exists())

    def test_directory_modes_and_private_preimage_location(self):
        state=self.root/'state';state.mkdir()
        stager=types.SimpleNamespace(protected_directory=lambda path,owner:self.assertFalse(path.is_symlink()))
        with mock.patch.object(p,'STATE',state):
            p.ensure_staging_roots(stager)
            self.assertEqual(list((state/'rehearsal-evidence').iterdir()), [])
            result=p.reserve_directories(stager,'123-1')
            self.assertEqual(result,state/'rehearsal-evidence/123-1')
            for name,mode in [('plans',0o700),('packages',0o755),('releases',0o755),('rehearsal-evidence',0o700)]:
                self.assertEqual(stat.S_IMODE((state/name).stat().st_mode),mode)
            self.assertEqual(stat.S_IMODE(result.stat().st_mode),0o700)
            with self.assertRaises(FileExistsError):p.reserve_directories(stager,'123-1')
            (state/'plans').chmod(0o755)
            with self.assertRaises(ValueError):p.reserve_directories(stager,'124-1')
            self.assertEqual(stat.S_IMODE((state/'plans').stat().st_mode),0o755)  # No implicit permission repair.

    def test_full_orchestration_builds_both_and_probes_only_private_preimage(self):
        with self.orchestration() as (request,modules,calls,reserve):
            out=p.prepare_pair(request,**modules)
            self.assertTrue(out['ok']);self.assertFalse(out['productionChanged'])
            self.assertEqual(len([x for x in calls if x[0]=='command']),4)
            self.assertEqual(len([x for x in calls if x[0]=='freeze']),2)
            self.assertEqual(len([x for x in calls if x[0]=='probes']),1)
            self.assertEqual(reserve.call_count,1)
            receipt=json.loads((self.root/'private/evidence.json').read_bytes())
            self.assertEqual(receipt['sourceContractSha256'],p.sha((self.root/'controls/source-contracts.json').read_bytes()))
            self.assertNotEqual(receipt['sourceContractSha256'],p.sha(p.canonical({})))

    def test_config_or_source_drift_aborts_before_freeze(self):
        for failure in ('config','source','contract'):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as tmp:
                old=self.root;self.root=Path(tmp)
                try:
                    with self.orchestration(failure) as (request,modules,calls,_):
                        out=p.prepare_pair(request,**modules)
                        self.assertFalse(out['ok']);self.assertTrue(out['inspectBeforeRetry'])
                        self.assertFalse(any(x[0] in ('freeze','probes') for x in calls))
                finally:self.root=old

    def test_uncertain_build_aborts_without_second_attempt(self):
        with self.orchestration('build') as (request,modules,calls,_):
            out=p.prepare_pair(request,**modules)
            self.assertFalse(out['ok']);self.assertEqual(out['stage'],'BUILD_CANDIDATE')
            self.assertEqual(len(calls),1);self.assertFalse(out['automaticRetry'])

    def test_rehearsal_failure_does_not_claim_acceptance(self):
        with self.orchestration('probe') as (request,modules,calls,_):
            out=p.prepare_pair(request,**modules)
            self.assertFalse(out['ok']);self.assertNotIn('must remain private',json.dumps(out))
            self.assertFalse((self.root/'private/evidence.json').exists())

    def test_second_workflow_attempt_is_refused_before_work(self):
        with self.orchestration() as (request,modules,calls,reserve):
            request['runAttempt']=2
            with self.assertRaises(ValueError):p.prepare_pair(request,**modules)
            self.assertEqual(calls,[]);reserve.assert_not_called()

    def retained_fixture(self, modules):
        payload=b'synthetic retained preimage'
        pins={'operation':p.RETAINED_OPERATION,'preimage':{'sha256':p.sha(payload),'size':len(payload)},
              'pair':{label:{'manifestSha256':'c'*64,'archiveSha256':'d'*64,'archiveSize':10240} for label in p.PAIR}}
        proofs={label:{'sha':commit,'tree':tree,'artifactManifestSha256':'c'*64,
                 'runtime':modules['contracts'].runtime_manifest(None,commit),
                 'dependencies':modules['contracts'].dependency_manifest(None)} for label,(commit,tree) in p.PAIR.items()}
        def copy(destination,*args):destination.write_bytes(payload)
        return pins,{'pins':pins,'pair':proofs},copy

    def test_retained_resume_skips_all_builds_freezes_and_live_snapshot(self):
        with self.orchestration() as (request,modules,calls,reserve):
            pins,observed,copy=self.retained_fixture(modules);request['retainedPins']=pins
            with mock.patch.object(p,'inspect_retained',return_value=observed) as inspect, \
                 mock.patch.object(p,'copy_retained_preimage',side_effect=copy), \
                 mock.patch.object(p,'private_copy') as live_copy:
                out=p.prepare_pair(request,**modules)
            self.assertTrue(out['ok']);live_copy.assert_not_called()
            self.assertEqual([x[0] for x in calls],['probes']);self.assertEqual(inspect.call_count,2)
            evidence=json.loads((self.root/'private/evidence.json').read_bytes())
            self.assertEqual(evidence['retainedFrom'],pins)

    def test_retained_pin_mismatch_never_probes_or_copies(self):
        with self.orchestration() as (request,modules,calls,reserve):
            pins,observed,copy=self.retained_fixture(modules)
            request['retainedPins']=json.loads(json.dumps(pins));request['retainedPins']['preimage']['sha256']='f'*64
            with mock.patch.object(p,'inspect_retained',return_value=observed), mock.patch.object(p,'copy_retained_preimage') as copier:
                out=p.prepare_pair(request,**modules)
            self.assertFalse(out['ok']);self.assertTrue(out['auditPersisted']);copier.assert_not_called()
            self.assertEqual(calls,[]);self.assertFalse((self.root/'private/evidence.json').exists())

    def test_retained_probe_failure_keeps_new_audit_without_success(self):
        with self.orchestration('probe') as (request,modules,calls,reserve):
            pins,observed,copy=self.retained_fixture(modules);request['retainedPins']=pins
            with mock.patch.object(p,'inspect_retained',return_value=observed), mock.patch.object(p,'copy_retained_preimage',side_effect=copy):
                out=p.prepare_pair(request,**modules)
            self.assertFalse(out['ok']);self.assertTrue(out['auditPersisted'])
            raw=(self.root/'private/failure.json').read_text();self.assertNotIn('must remain private',raw)
            self.assertFalse((self.root/'private/evidence.json').exists())


class PrivateCopyLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source=self.root/'source.sqlite';self.destination=self.root/'private.sqlite'

    def live(self,mode='WAL'):
        db=sqlite3.connect(self.source);self.addCleanup(db.close)
        self.assertEqual(db.execute('PRAGMA journal_mode='+mode).fetchone()[0],mode.lower())
        db.executescript("CREATE TABLE original(id INTEGER PRIMARY KEY,value BLOB); INSERT INTO original VALUES(77,X'0001'); PRAGMA user_version=19;")
        return db

    def test_closed_private_copy_is_standalone_and_original_wal_unchanged(self):
        import gc,hashlib
        live=self.live()
        before={suffix:hashlib.sha256(Path(str(self.source)+suffix).read_bytes()).hexdigest() for suffix in ('','-wal')}
        p.private_copy(self.source,self.destination,time.monotonic()+10);gc.collect()
        self.assertEqual(live.execute('PRAGMA journal_mode').fetchone(),('wal',))
        self.assertEqual(before,{suffix:hashlib.sha256(Path(str(self.source)+suffix).read_bytes()).hexdigest() for suffix in ('','-wal')})
        self.assertEqual(self.destination.read_bytes()[18:20],b'\x01\x01')
        self.assertEqual(self.destination.stat().st_mode & 0o777,0o600)
        self.assertFalse(any(Path(str(self.destination)+suffix).exists() for suffix in ('-wal','-shm','-journal')))
        initial=hashlib.sha256(self.destination.read_bytes()).hexdigest()
        # Exercise the historical admission rule and two subsequent readonly
        # backups, as candidate/fallback rehearsals do. Do not weaken its guard.
        for attempt in range(2):
            header=self.destination.read_bytes()[:100]
            if header[18:20]==b'\x02\x02':
                for suffix in ('-wal','-shm'):
                    sidecar=Path(str(self.destination)+suffix)
                    self.assertTrue(sidecar.is_file() and not sidecar.is_symlink())
            source=sqlite3.connect(self.destination.as_uri()+'?mode=ro',uri=True)
            target=sqlite3.connect(self.root/('probe-'+str(attempt)+'.sqlite'))
            try:
                source.execute('PRAGMA query_only=ON');source.backup(target)
                self.assertEqual(target.execute('PRAGMA quick_check').fetchall(),[('ok',)])
                self.assertEqual(target.execute('PRAGMA user_version').fetchone(),(19,))
                self.assertEqual(target.execute('SELECT rowid,* FROM original').fetchall(),[(77,77,b'\x00\x01')])
            finally:target.close();source.close()
            gc.collect();self.assertEqual(hashlib.sha256(self.destination.read_bytes()).hexdigest(),initial)

    def test_delete_source_remains_delete(self):
        live=self.live('DELETE');p.private_copy(self.source,self.destination,time.monotonic()+10)
        self.assertEqual(live.execute('PRAGMA journal_mode').fetchone(),('delete',))
        self.assertEqual(self.destination.read_bytes()[18:20],b'\x01\x01')

    def test_existing_destination_never_overwritten(self):
        self.live();self.destination.write_bytes(b'keep')
        with self.assertRaises(FileExistsError):p.private_copy(self.source,self.destination,time.monotonic()+10)
        self.assertEqual(self.destination.read_bytes(),b'keep')

    def test_wal_source_without_sidecars_still_refused(self):
        live=self.live();live.close()
        self.assertEqual(self.source.read_bytes()[18:20],b'\x02\x02')
        with self.assertRaises(FileNotFoundError):p.private_copy(self.source,self.destination,time.monotonic()+10)
        self.assertFalse(self.destination.exists())

    def test_failed_normalization_is_not_success_and_keeps_private_attempt(self):
        live=self.live();connect=sqlite3.connect
        # sqlite backup requires a real Connection target; intercept execute on
        # a Connection subclass rather than replacing the SQLite object.
        class RefusingConnection(sqlite3.Connection):
            def execute(self,sql,*args,**kwargs):
                if sql=='PRAGMA journal_mode=DELETE':return types.SimpleNamespace(fetchone=lambda:('wal',))
                return super().execute(sql,*args,**kwargs)
        def factory(database,*args,**kwargs):
            if Path(database)==self.destination:kwargs['factory']=RefusingConnection
            return connect(database,*args,**kwargs)
        with mock.patch.object(p.sqlite3,'connect',side_effect=factory):
            with self.assertRaises(ValueError):p.private_copy(self.source,self.destination,time.monotonic()+10)
        self.assertTrue(self.destination.exists())
        self.assertEqual(live.execute('PRAGMA journal_mode').fetchone(),('wal',))

    def test_elapsed_backup_deadline_still_refuses(self):
        self.live()
        with self.assertRaises(ValueError):p.private_copy(self.source,self.destination,time.monotonic()-1)
        self.assertTrue(self.destination.exists())

if __name__=='__main__':unittest.main()
