import ast
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import shutil
import stat
import subprocess
import tempfile
import time
import types
import unittest
from unittest import mock
import zlib

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

core = load('preserving', ROOT / 'ops/deploy-preserving.py')
guards = load('guards', ROOT / 'ops/deploy-survey-only.py')
guards.core = core
guards.pins = json.loads((ROOT / 'ops/survey-only-source-pins.json').read_bytes())
adapter = load('update', ROOT / 'ops/deploy-survey-update.py')
adapter.core = core; adapter.guards = guards
PINS = json.loads((ROOT / 'ops/survey-update-source-pins.json').read_bytes())
adapter.pins = PINS


class Update(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='update-test-', dir=ROOT)))
        self.home = self.root / 'home'; self.home.mkdir()
        releases = self.home / 'bubblewash-releases'; releases.mkdir()
        self.old = releases / 'existing-401d'; self.old.mkdir()
        self.sha = 'c' * 40
        self.new = releases / ('20261024T080000Z-' + self.sha[:12]); self.new.mkdir()
        names = (*PINS['criticalFiles'], 'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json', 'src/components/results.tsx')
        for release in (self.old, self.new):
            for name in names:
                path = release / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('synthetic immutable source\n')
        (self.new / 'src/components/results.tsx').write_text('reviewed synthetic new view\n')
        def files(release):
            return {path.relative_to(release).as_posix(): core.digest(path) for path in sorted(release.rglob('*')) if path.is_file()}
        self.pins = {**PINS, 'runtimeSha': self.sha,
                     'baselineContent': adapter.content_commitment(files(self.old)), 'runtimeContent': adapter.content_commitment(files(self.new)),
                     'sourceScope': {'rootFiles': sorted(n for n in files(self.old) if '/' not in n),
                                     'directories': sorted({n.split('/')[0] for n in files(self.old) if '/' in n})},
                     'baselineSource': core.source_manifest(self.old), 'candidateSource': core.source_manifest(self.new),
                     'allowedChanges': ['src/components/results.tsx']}
        (self.old / '.next').mkdir(); (self.old / '.next/BUILD_ID').write_text('existing')
        (self.old / '.release-sha').write_text(PINS['baseSha'] + '\n'); (self.new / '.release-sha').write_text(self.sha + '\n')
        self.pointer = self.home / 'current'; self.pointer.symlink_to(self.old)
        self.runtime = self.home / 'runtime'; self.runtime.mkdir()
        self.marker = self.runtime / 'current-release'; self.marker.write_text(f"sha={PINS['baseSha']}\npath={self.old}\n")
        self.old_marker = self.marker.read_bytes()
        self.db = self.root / 'existing.sqlite'
        with sqlite3.connect(self.db) as db:
            db.executescript("CREATE TABLE owners(id INTEGER PRIMARY KEY,password TEXT);INSERT INTO owners VALUES(1,'unchanged');CREATE TABLE responses(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO responses VALUES(9,'retained response');PRAGMA user_version=4;")
        self.db.chmod(0o600); self.db_before = self.db.read_bytes()
        self.status = self.root / 'backup-status'; self.archive = self.root / 'bubblewash-2026-10-24T07:00:00Z.sqlite.enc'
        self.archive.write_bytes(b'synthetic encrypted archive placeholder')
        digest = core.digest(self.archive); stamp = core.dt.datetime.now(core.dt.timezone.utc).isoformat()
        self.receipt = self.root / 'receipt'
        self.receipt_value = {'schema':'becore-encrypted-backup-release/v2','repository':'bechirobob/bubble-wash',
            'storageRepository':'bechirobob/becore-backups','storage':'private-github-release','storageSha':'b'*40,
            'storageRepositoryId':7,'runId':'4','encrypted':True,'restoreTested':True,'downloadVerified':True,
            'automaticExpiry':False,'retentionDays':None,'filename':self.archive.name,'sha256':digest,
            'sourceSha':'d'*40,'size':self.archive.stat().st_size,'verifiedAt':stamp}
        self.receipt.write_text(json.dumps(self.receipt_value))
        self.status.write_text(json.dumps({'ok':True,'filename':self.archive.name,'sha256':digest,
            'createdAt':stamp,'restoreVerifiedAt':stamp,'offsiteStoredAt':stamp}))
        parent = self.home / '.config' / 'bubblewash'; parent.mkdir(parents=True)
        self.env = parent / 'env'
        self.values = {'NODE_ENV':'production','BUBBLEWASH_STAFF_AUTH_DISABLED':'false','BUBBLEWASH_BOOKINGS_DISABLED':'true',
            'BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','BUBBLEWASH_RESEARCH_OPEN':'true','BUBBLEWASH_RESEARCH_EMAIL_ENABLED':'true',
            'BUBBLEWASH_RESEARCH_RESEND_KEY':'synthetic-secret-never-logged','UNRELATED':'exact-value',
            'BUBBLEWASH_DATABASE_PATH':str(self.db),'BUBBLEWASH_BACKUP_STATUS_PATH':str(self.status),
            'BUBBLEWASH_BACKUP_OFFSITE_DIR':str(self.root)}
        self.raw = ''.join(k+'='+v+'\n' for k,v in self.values.items()).encode(); self.env.write_bytes(self.raw); self.env.chmod(0o600)
        self.owner = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.args = types.SimpleNamespace(candidate=str(self.new),sha=self.sha,expected_live=PINS['baseSha'],
            backup_sha256=digest,receipt_run='4',store_sha='b'*40,store_id='7')
        for name,value in [('HOME',self.home),('CURRENT',self.pointer),('RUNTIME',self.runtime),('ENV',self.env),('RECEIPT',self.receipt)]:
            self.stack.enter_context(mock.patch.object(core,name,value))
        self.stack.enter_context(mock.patch.object(adapter,'pins',self.pins))
        self.stack.enter_context(mock.patch.object(adapter.os,'geteuid',return_value=0))
        self.stack.enter_context(mock.patch.object(adapter.pwd,'getpwnam',return_value=self.owner))
        self.locked = False
        @contextlib.contextmanager
        def lock(*_):
            self.locked = True
            try: yield lambda: self.assertTrue(self.locked)
            finally: self.locked = False
        self.stack.enter_context(mock.patch.object(core,'deployment_lock',lock))
        self.ctl = self.stack.enter_context(mock.patch.object(core,'ctl'))
        self.health = self.stack.enter_context(mock.patch.object(core,'health'))
        self.public = self.stack.enter_context(mock.patch.object(core,'public_health'))
        self.runtime_flags = self.stack.enter_context(mock.patch.object(guards,'runtime_flags'))
        self.command = self.stack.enter_context(mock.patch.object(core,'command'))
        self.rehearse = self.stack.enter_context(mock.patch.object(core,'rehearse'))
        self.drop = self.stack.enter_context(mock.patch.object(guards,'migrate_as_app',side_effect=lambda owner,fn:fn()))
        self.forbidden = [self.stack.enter_context(mock.patch.object(guards,name,side_effect=AssertionError('forbidden operation')))
                          for name in ('add_research_schema','migration_service','replace_environment','activate_flags','marked_test_accepted','closed')]
        self.stack.enter_context(mock.patch.object(core,'main',side_effect=AssertionError('historical main reached')))
        self.stack.enter_context(mock.patch.object(guards,'main',side_effect=AssertionError('historical main reached')))
        adapter.STAGE = 'binding'

    def run_update(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output): adapter.deploy(self.args)
        self.assertNotIn('synthetic-secret',output.getvalue()); self.assertNotIn(str(self.root),output.getvalue())
        for operation in self.forbidden: operation.assert_not_called()
        return output.getvalue()

    def test_success_changes_only_code_marker_preserves_complete_open_config_and_db(self):
        output = self.run_update()
        self.assertTrue(json.loads(output)['codeOnly']); self.assertEqual(self.pointer.resolve(),self.new)
        self.assertEqual(core.parse(self.marker.read_bytes())['sha'],self.sha)
        self.assertEqual(self.env.read_bytes(),self.raw); self.assertEqual(self.db.read_bytes(),self.db_before)
        self.assertEqual(self.ctl.call_args_list,[mock.call('stop',core.UNIT),mock.call('start',core.UNIT)])
        self.assertTrue(all(call.args[1:]==(self.values,True) for call in self.runtime_flags.call_args_list))
        self.assertEqual(self.rehearse.call_count,2)
        self.assertEqual([call.args[0] for call in self.rehearse.call_args_list],[self.old,self.new])
        self.assertTrue(all(len(call.args)==7 and not call.kwargs for call in self.rehearse.call_args_list))

    def test_build_has_no_production_environment_database_or_secrets(self):
        self.run_update(); args = self.command.call_args.args[0]
        self.assertIn('--property=User=ubuntu',args); self.assertIn('--property=ProtectHome=tmpfs',args)
        self.assertIn('--property=NoNewPrivileges=true',args)
        self.assertFalse(any('EnvironmentFile=' in value or str(self.db) in value or 'synthetic-secret' in value for value in args))

    def test_failed_candidate_health_rolls_back_only_code_retaining_late_responses(self):
        def health(*_):
            if self.pointer.resolve()==self.new:
                with sqlite3.connect(self.db) as db: db.execute("INSERT INTO responses VALUES(10,'late legitimate response')")
                raise ValueError('candidate unhealthy')
        self.health.side_effect=health
        with self.assertRaises(ValueError):self.run_update()
        self.assertEqual(self.pointer.resolve(),self.old);self.assertEqual(self.marker.read_bytes(),self.old_marker)
        self.assertEqual(self.env.read_bytes(),self.raw)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT id,value FROM responses ORDER BY id').fetchall(),[(9,'retained response'),(10,'late legitimate response')])
            self.assertEqual(db.execute('PRAGMA user_version').fetchone(),(4,))
        self.assertEqual(self.ctl.call_args_list,[mock.call('stop',core.UNIT),mock.call('start',core.UNIT),mock.call('stop',core.UNIT),mock.call('restart',core.UNIT)])

    def test_uncertain_marker_ack_rolls_code_back_without_repeating_update(self):
        calls=0
        def marker(owner, operation):
            nonlocal calls
            calls+=1; operation()
            if calls==1:raise RuntimeError('marker may have committed')
        self.drop.side_effect=marker
        with self.assertRaises(RuntimeError):self.run_update()
        self.assertEqual(self.pointer.resolve(),self.old);self.assertEqual(self.marker.read_bytes(),self.old_marker)
        self.assertEqual(self.db.read_bytes(),self.db_before);self.assertEqual(self.env.read_bytes(),self.raw)
        self.assertEqual(self.command.call_count,1);self.assertEqual(self.rehearse.call_count,2)
        self.assertEqual(self.ctl.call_args_list,[mock.call('stop',core.UNIT),mock.call('start',core.UNIT),mock.call('stop',core.UNIT),mock.call('restart',core.UNIT)])

    def test_wrong_live_marker_refuses_all_preparation(self):
        self.marker.write_text('sha='+'f'*40+'\npath='+str(self.old)+'\n')
        with self.assertRaises(ValueError):self.run_update()
        self.command.assert_not_called();self.rehearse.assert_not_called();self.ctl.assert_not_called()

    def test_new_legitimate_live_response_during_rehearsal_does_not_require_live_row_equality(self):
        calls=0
        def rehearsal(*args):
            nonlocal calls
            calls+=1
            snapshot=self.root/('copy'+str(calls)+'.sqlite')
            with sqlite3.connect(self.db.as_uri()+'?mode=ro',uri=True) as source,sqlite3.connect(snapshot) as target:source.backup(target)
            before=core.database_fingerprint(snapshot)
            if calls==1:
                with sqlite3.connect(self.db) as db:db.execute("INSERT INTO responses VALUES(11,'new response during preparation')")
            self.assertEqual(core.database_fingerprint(snapshot),before)
        self.rehearse.side_effect=rehearsal
        self.run_update()
        with sqlite3.connect(self.db) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM responses').fetchone(),(2,))
        self.assertEqual(self.env.read_bytes(),self.raw)

    def test_copy_preservation_failure_refuses_before_service_stop(self):
        self.rehearse.side_effect=ValueError('copy changed')
        with self.assertRaises(ValueError):self.run_update()
        self.ctl.assert_not_called();self.assertEqual(self.db.read_bytes(),self.db_before)

    def test_config_drift_after_copy_refuses_switch_and_does_not_overwrite(self):
        drift=self.raw+b'UNKNOWN=do-not-overwrite\n'
        self.rehearse.side_effect=lambda *_:self.env.write_bytes(drift)
        with self.assertRaises(ValueError):self.run_update()
        self.ctl.assert_not_called();self.assertEqual(self.env.read_bytes(),drift)

    def test_receipt_replacement_refuses_before_service_stop(self):
        def drift(*_):self.receipt.write_text(json.dumps({**self.receipt_value,'sha256':'f'*64}))
        self.rehearse.side_effect=drift
        with self.assertRaises(ValueError):self.run_update()
        self.ctl.assert_not_called();self.assertEqual(adapter.STAGE,'backup')

    def test_initial_stale_receipt_is_labeled_backup_before_build(self):
        self.args.backup_sha256='f'*64
        with self.assertRaises(ValueError):self.run_update()
        self.command.assert_not_called();self.ctl.assert_not_called();self.assertEqual(adapter.STAGE,'backup')

    def test_source_drift_after_copy_refuses_switch(self):
        self.rehearse.side_effect=lambda *_:(self.old/'package.json').write_text('drift')
        with self.assertRaises(ValueError):self.run_update()
        self.ctl.assert_not_called()

    def test_new_untracked_source_refuses_switch(self):
        self.rehearse.side_effect=lambda *_:(self.new/'src'/'unexpected.ts').write_text('drift')
        with self.assertRaises(ValueError):self.run_update()
        self.ctl.assert_not_called()

    def test_replaced_db_inode_refuses_without_restoring_data(self):
        def drift(*_):
            replacement=self.root/'replacement.sqlite';replacement.write_bytes(self.db_before);replacement.chmod(0o600);os.replace(replacement,self.db)
        self.rehearse.side_effect=drift
        with self.assertRaises(ValueError):self.run_update()
        self.ctl.assert_not_called()

    def test_build_failure_never_stops_production_and_has_distinct_stage(self):
        self.command.side_effect=ValueError('captured build error')
        with self.assertRaises(ValueError):self.run_update()
        self.ctl.assert_not_called();self.assertEqual(adapter.STAGE,'build')

    def test_flags_must_remain_open_and_bookings_paused(self):
        for key in ('BUBBLEWASH_RESEARCH_OPEN','BUBBLEWASH_RESEARCH_EMAIL_ENABLED','BUBBLEWASH_BOOKINGS_DISABLED'):
            with self.assertRaises(ValueError):adapter.open_configuration({**self.values,key:'false'})
        with self.assertRaises(ValueError):adapter.open_configuration({**self.values,'BUBBLEWASH_STAFF_AUTH_DISABLED':'true'})
        adapter.open_configuration(self.values)

    def test_symlink_candidate_or_wrong_marker_refuses_before_build(self):
        (self.new/'.release-sha').write_text('f'*40)
        with self.assertRaises(ValueError):self.run_update()
        self.command.assert_not_called();self.ctl.assert_not_called()

    def test_source_guard_rejects_unknown_changed_writer_even_with_matching_disk_hash(self):
        name=PINS['criticalFiles'][0];(self.new/name).write_text('changed writer')
        files,_=adapter.source_snapshot(self.new,self.owner)
        self.pins['runtimeContent']=adapter.content_commitment(files);self.pins['candidateSource']=core.source_manifest(self.new)
        self.pins['allowedChanges'].append(name);self.pins['allowedChanges'].sort()
        with self.assertRaises(ValueError):self.run_update()
        self.command.assert_not_called();self.ctl.assert_not_called()

    def test_no_live_sqlite_connection_or_fingerprint_is_called_by_controller(self):
        with mock.patch.object(core.sqlite3,'connect',side_effect=AssertionError('live SQLite open')),mock.patch.object(core,'database_fingerprint',side_effect=AssertionError('live fingerprint')):
            self.run_update()

    def test_failure_output_is_fixed_redacted_and_no_automatic_retry(self):
        with mock.patch.object(adapter,'arguments',return_value=self.args),mock.patch.object(adapter,'deploy',side_effect=ValueError('secret /private/path')),contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(SystemExit):adapter.entry()
        result=json.loads(output.getvalue());self.assertFalse(result['automaticRetry']);self.assertNotIn('secret',output.getvalue())


    def test_full_commitment_rejects_mutation_missing_extra_rename_and_type_changes(self):
        target = self.new / 'db/proposed/research-v1.sql'
        raw = target.read_bytes()
        for change in ('content', 'missing', 'extra-file', 'rename', 'symlink', 'directory', 'empty-directory', 'hardlink'):
            with self.subTest(change=change):
                extra = target.with_name('unexpected')
                try:
                    if change == 'content': target.write_bytes(raw + b'drift')
                    elif change == 'missing': target.unlink()
                    elif change == 'extra-file': extra.write_bytes(b'extra')
                    elif change == 'rename': target.rename(extra)
                    elif change == 'symlink': target.unlink(); target.symlink_to(self.old/'db/proposed/research-v1.sql')
                    elif change == 'directory': target.unlink(); target.mkdir()
                    elif change == 'empty-directory': extra.mkdir()
                    elif change == 'hardlink': os.link(target, extra)
                    with self.assertRaises((ValueError, OSError)):
                        adapter.verify_sources(self.old, self.new, self.owner)
                finally:
                    for path in (target, extra):
                        if path.is_symlink() or path.is_file(): path.unlink()
                        elif path.is_dir(): path.rmdir()
                    target.write_bytes(raw)

    def test_file_and_directory_owner_mode_guards_are_retained(self):
        for target in (self.new/'package.json', self.new/'db', self.new/'db/proposed'):
            original=target.stat().st_mode & 0o7777
            for bit in (0o020,0o002):
                target.chmod(original|bit)
                try:
                    with self.assertRaises(ValueError):adapter.verify_sources(self.old,self.new,self.owner)
                finally:target.chmod(original)
        real=os.stat
        target='package.json'
        def wrong_owner(name,*args,**kwargs):
            info=real(name,*args,**kwargs)
            if name==target and kwargs.get('dir_fd') is not None:
                return types.SimpleNamespace(**{field:(999999 if field=='st_uid' else getattr(info,field)) for field in (*guards.IDENTITY,'st_size','st_mtime_ns','st_ctime_ns')})
            return info
        with mock.patch.object(adapter.os,'stat',side_effect=wrong_owner):
            with self.assertRaises(ValueError):adapter.source_snapshot(self.new,self.owner)

    def test_symlink_source_directory_refuses_without_following_it(self):
        source=self.new/'db'; saved=self.root/'saved-db';source.rename(saved);source.symlink_to(saved,target_is_directory=True)
        with self.assertRaises((ValueError,OSError)):adapter.source_snapshot(self.new,self.owner)

    def test_descriptor_read_replacement_and_directory_rename_are_refused(self):
        target=self.new/'package.json'; raw=target.read_bytes(); inode=target.stat().st_ino; real=adapter.os.read
        changed=False
        def read(fd,size):
            nonlocal changed
            value=real(fd,size)
            if not changed and os.fstat(fd).st_ino==inode:
                changed=True
                replacement=target.with_name('replacement');replacement.write_bytes(raw);os.replace(replacement,target)
            return value
        with mock.patch.object(adapter.os,'read',side_effect=read):
            with self.assertRaises(ValueError):adapter.source_snapshot(self.new,self.owner)
        directory=self.new/'db';changed=False;inode=(directory/'proposed/research-v1.sql').stat().st_ino
        def rename(fd,size):
            nonlocal changed
            value=real(fd,size)
            if not changed and os.fstat(fd).st_ino==inode:
                changed=True;directory.rename(self.new/'renamed-db');shutil.copytree(self.new/'renamed-db',directory)
            return value
        with mock.patch.object(adapter.os,'read',side_effect=rename):
            with self.assertRaises(ValueError):adapter.source_snapshot(self.new,self.owner)

    def test_late_extra_source_entry_is_not_hidden_by_finished_directory_scan(self):
        real=adapter.os.read;changed=False;inode=(self.new/'src/components/results.tsx').stat().st_ino
        def read(fd,size):
            nonlocal changed
            value=real(fd,size)
            if value and not changed and os.fstat(fd).st_ino==inode:
                changed=True;(self.new/'db'/'late.txt').write_text('late')
            return value
        with mock.patch.object(adapter.os,'read',side_effect=read):
            with self.assertRaises(ValueError):adapter.verify_sources(self.old,self.new,self.owner)

    def test_root_exclusions_stay_unread_and_generated_changes_do_not_change_commitment(self):
        before,_=adapter.source_snapshot(self.new,self.owner)
        (self.new/'private-untracked').write_bytes(b'private-not-source')
        (self.new/'node_modules').mkdir();(self.new/'node_modules'/'unread').symlink_to('/not/a/source')
        after,_=adapter.source_snapshot(self.new,self.owner)
        self.assertEqual(before,after)
        self.assertEqual(adapter.content_commitment(before),self.pins['runtimeContent'])

    def test_compact_snapshot_matches_all_original_pinned_files_and_existing_src_manifest(self):
        for release,key in ((self.old,'baselineContent'),(self.new,'runtimeContent')):
            files,identities=adapter.source_snapshot(release,self.owner)
            expected={path.relative_to(release).as_posix():core.digest(path) for path in release.rglob('*')
                      if path.is_file() and path.name!='.release-sha' and '.next' not in path.parts}
            self.assertEqual(files,expected);self.assertEqual(adapter.content_commitment(files),self.pins[key])
            self.assertEqual({name[2:] for name in identities if name.startswith('f/')},set(expected))
            src=[(name[4:],digest) for name,digest in sorted(files.items()) if name.startswith('src/')]
            self.assertEqual(hashlib.sha256(json.dumps(src,separators=(',',':')).encode()).hexdigest(),core.source_manifest(release)['src'])

    def test_canonical_commitment_is_order_independent_but_binds_paths_and_content(self):
        first={'src/a':'a'*64,'package.json':'b'*64}
        self.assertEqual(adapter.content_commitment(first),adapter.content_commitment(dict(reversed(list(first.items())))))
        self.assertNotEqual(adapter.content_commitment(first),adapter.content_commitment({'src/b':'a'*64,'package.json':'b'*64}))
        self.assertNotEqual(adapter.content_commitment(first),adapter.content_commitment({**first,'src/a':'c'*64}))


    def test_checkout_binds_exact_commit_tree_all_tracked_paths_and_executable_modes(self):
        checkout=self.root/'checkout';checkout.mkdir()
        for name in ('README.md','src/code.ts'):
            path=checkout/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('pinned '+name)
        def git(*args):return subprocess.check_output(['git','-C',str(checkout),*args],stderr=subprocess.DEVNULL).decode().strip()
        git('init');git('config','user.email','fixture@example.test');git('config','user.name','Fixture')
        git('add','.');git('commit','-m','synthetic fixture')
        self.pins['sourceScope']={'rootFiles':['README.md'],'directories':['src']}
        self.pins['runtimeSha']=git('rev-parse','HEAD');self.pins['runtimeTree']=git('rev-parse','HEAD^{tree}')
        files,_=adapter.source_snapshot(checkout,self.owner);self.pins['runtimeContent']=adapter.content_commitment(files)
        adapter.verify_checkout(checkout,self.pins['runtimeSha'],self.owner)
        with self.assertRaises(ValueError):adapter.verify_checkout(checkout,'f'*40,self.owner)
        tree=self.pins['runtimeTree'];self.pins['runtimeTree']='f'*40
        with self.assertRaises(ValueError):adapter.verify_checkout(checkout,self.pins['runtimeSha'],self.owner)
        self.pins['runtimeTree']=tree
        path=checkout/'README.md';path.chmod(0o755)
        with self.assertRaises(ValueError):adapter.verify_checkout(checkout,self.pins['runtimeSha'],self.owner)
        path.chmod(0o644);path.write_text('wrong bytes')
        with self.assertRaises(ValueError):adapter.verify_checkout(checkout,self.pins['runtimeSha'],self.owner)

    def test_checkout_tracked_extra_root_file_cannot_hide_in_host_root_exclusion(self):
        checkout=self.root/'checkout';checkout.mkdir();(checkout/'README.md').write_text('pinned')
        def git(*args):return subprocess.check_output(['git','-C',str(checkout),*args],stderr=subprocess.DEVNULL).decode().strip()
        git('init');git('config','user.email','fixture@example.test');git('config','user.name','Fixture')
        (checkout/'unexpected.txt').write_text('tracked outside scope');git('add','.');git('commit','-m','fixture')
        self.pins['sourceScope']={'rootFiles':['README.md'],'directories':[]}
        self.pins['runtimeSha']=git('rev-parse','HEAD');self.pins['runtimeTree']=git('rev-parse','HEAD^{tree}')
        files,_=adapter.source_snapshot(checkout,self.owner);self.pins['runtimeContent']=adapter.content_commitment(files)
        with self.assertRaises(ValueError):adapter.verify_checkout(checkout,self.pins['runtimeSha'],self.owner)


    def test_only_proven_tooling_generated_subtree_is_excluded(self):
        tooling=self.new/'tooling/next-eslint-glob';tooling.mkdir(parents=True)
        (tooling/'package.json').write_text('tracked dependency definition')
        self.pins['sourceScope']['directories'].append('tooling')
        self.pins['sourceScope']['excludedSubtrees']=['tooling/next-eslint-glob/node_modules']
        before,_=adapter.source_snapshot(self.new,self.owner)
        generated=tooling/'node_modules';generated.mkdir();(generated/'unread').symlink_to('/not/source')
        after,_=adapter.source_snapshot(self.new,self.owner)
        self.assertEqual(before,after)
        (tooling/'unexpected.js').write_text('unknown source')
        def checked():
            changed,_=adapter.source_snapshot(self.new,self.owner)
            adapter.require(adapter.content_commitment(before)==adapter.content_commitment(changed))
        with self.assertRaises(ValueError):checked()
        (tooling/'unexpected.js').unlink()
        (tooling/'package.json').write_text('mutated tracked wrapper')
        with self.assertRaises(ValueError):checked()


class Contract(unittest.TestCase):
    def test_exact_immutable_dependencies_and_original_historical_pins(self):
        for name,digest in PINS['dependencies'].items():self.assertEqual(hashlib.sha256((ROOT/'ops'/name).read_bytes()).hexdigest(),digest)
        self.assertEqual(PINS['baseSha'],'0b1f77e2157bf9df95d58385bbe4a693e8f378c7')
        self.assertEqual(PINS['runtimeTree'],'b89ead47951ed69824a4e0a727fb597605e2c46d')
        self.assertEqual(PINS['runtimeSha'],'4170cc99a6903fdb08d9dc2624a96d6457fd7ab5')
        self.assertEqual(PINS['baselineContent']['files'],319);self.assertEqual(PINS['runtimeContent']['files'],320);self.assertEqual(len(PINS['allowedChanges']),8)
        self.assertEqual(len(PINS['sourceScope']['rootFiles']),10);self.assertEqual(len(PINS['sourceScope']['directories']),9)
        self.assertNotIn('baselineFiles',PINS);self.assertNotIn('runtimeFiles',PINS)
        self.assertEqual(PINS['sourceScope']['excludedSubtrees'],['tooling/next-eslint-glob/node_modules'])
        self.assertLess((ROOT/'ops/survey-update-source-pins.json').stat().st_size,6500)
        self.assertEqual(guards.pins['baseSha'],'5dc997db0393e1cf88dde29859b7e1c4550ee4ee')

    def test_emitted_bootstrap_compiles_and_does_not_replace_historical_guards(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:adapter.emit()
        ast.parse(output.getvalue())
        literal=output.getvalue().split('base64.b64decode(',1)[1].split(')))',1)[0]
        payload=json.loads(zlib.decompress(base64.b64decode(ast.literal_eval(literal))))
        self.assertEqual(payload['guardPins'],guards.pins);self.assertEqual(payload['pins'],PINS)
        self.assertEqual(hashlib.sha256(payload['core'].encode()).hexdigest(),PINS['dependencies']['deploy-preserving.py'])
        self.assertNotIn('LIVE_SOURCE_SHA256 =',payload['adapter']);self.assertNotIn('core.main(',payload['adapter'])

    def test_hosted_evidence_accepts_only_exact_successful_runtime_checkout(self):
        run={'head_sha':'a'*40,'path':'.github/workflows/browser-regression.yml','event':'workflow_dispatch','status':'completed',
             'conclusion':'success','run_attempt':1,'head_repository':{'full_name':'bechirobob/bubble-wash'},'repository':{'full_name':'bechirobob/bubble-wash'}}
        adapter.verify_hosted_run(run,'a'*40,run['path'])
        adapter.verify_hosted_run({**run,'event':'push'},'a'*40,run['path'])
        for key,value in [('head_sha','b'*40),('path','unreviewed.yml'),('event','pull_request'),('status','in_progress'),('conclusion','failure'),('run_attempt',2),('head_repository',{'full_name':'attacker/fork'}),('repository',{'full_name':'other/repo'})]:
            with self.assertRaises(ValueError):adapter.verify_hosted_run({**run,key:value},'a'*40,run['path'])

    def test_workflow_has_no_automatic_deploy_and_uses_nonprivileged_staging(self):
        text=(ROOT/'.github/workflows/survey-update-deploy.yml').read_text()
        self.assertIn('workflow_dispatch:',text);self.assertNotIn('pull_request:',text);self.assertNotIn('\n  push:',text)
        self.assertIn('"$GITHUB_RUN_ATTEMPT" == 1',text);self.assertIn('environment: backup-storage',text)
        self.assertIn('/usr/sbin/runuser -u ubuntu -- /bin/sh',text);self.assertIn('umask 077',text)
        self.assertNotIn('chown -R',text);self.assertNotIn('--mode activate',text)
        self.assertLess(text.index('--check-hosted-runs'),text.index('Connect through existing approved'))
        self.assertIn('--check-runtime',text);self.assertIn("HEAD^{tree}",(ROOT/'ops/deploy-survey-update.py').read_text())


if __name__=='__main__':unittest.main()
