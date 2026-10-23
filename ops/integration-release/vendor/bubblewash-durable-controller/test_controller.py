import datetime as dt
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import controller as c


def manifest(root):
    names=[]
    for directory in ('src','public','.next','scripts','ops'):
        names += [str(p.relative_to(root)) for p in (root/directory).rglob('*') if p.is_file()]
    names += ['package.json','package-lock.json','next.config.mjs','tsconfig.json']
    return {'files':{p:c.core.digest(root/p) for p in names},'buildIdSha256':c.core.digest(root/'.next/BUILD_ID')}


class DurableTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='bubblewash-durable-');self.root=Path(self.temp.name)
        self.old,self.candidate,self.fallback=[self.root/name for name in ('old','candidate','fallback')]
        for release in (self.old,self.candidate,self.fallback):
            for directory in ('src/lib','public','.next','scripts','ops'):(release/directory).mkdir(parents=True)
            for name in ('src/lib/auth.ts','src/lib/admin-mfa.ts','src/lib/staff-accounts.ts','public/logo.svg','.next/BUILD_ID','package.json','package-lock.json','next.config.mjs','tsconfig.json'):(release/name).write_text('owner-aware-fixture' if name.startswith('src/') else release.name+name)
        self.current=self.root/'current';self.current.symlink_to(self.old)
        self.marker=self.root/'current-release';self.marker.write_text(f"sha={'a'*40}\nrelease={self.old.name}\npath={self.old}\n")
        self.db=self.root/'db.sqlite'
        with sqlite3.connect(self.db) as db:db.execute('CREATE TABLE orders(id INTEGER PRIMARY KEY, value TEXT)');db.execute("INSERT INTO orders VALUES(1,'old')")
        state_dir=self.root/'state';state_dir.mkdir(mode=0o755);(state_dir/'installed-v1').write_bytes(b'bubblewash-release-gate-v1\n')
        self.state=c.DurableState(state_dir,os.getuid())
        contract={'reviewed':True,'evidenceSha256':'a'*64,'files':{p:c.core.digest(self.candidate/p) for p in ('src/lib/auth.ts','src/lib/admin-mfa.ts','src/lib/staff-accounts.ts')}}
        self.plan={'candidate':str(self.candidate),'fallback':str(self.fallback),'old':str(self.old),'current':str(self.current),'marker':str(self.marker),'database':str(self.db),'databaseIdentity':list(c.file_identity(self.db)[:2]),'snapshot':str(self.root/'snapshot.sqlite'),'manifests':{'candidate':manifest(self.candidate),'fallback':manifest(self.fallback)},'ownerContract':contract,'externalInvokersExcluded':True,'releaseShas':{'candidate':'c'*40,'fallback':'f'*40},'controllerPins':{str(Path(c.__file__).resolve()):c.core.digest(c.__file__),str(Path(c.core.__file__).resolve()):c.core.digest(c.core.__file__)}}
        self.plan['oldSha']='a'*40
        for key in ('candidate','fallback'):self.plan['manifests'][key]['releaseSha']=self.plan['releaseShas'][key]
        self.events=[]
        self.control=self.make_controller()
    def tearDown(self):self.temp.cleanup()
    def service(self,manager,action,unit):
        self.events.append((manager,action,unit,self.current.resolve().name))
        if action=='start':
            self.assertFalse(self.state.app_hold.exists())
            self.assertTrue(self.state.maintenance_hold.exists())
            self.assertIn(self.current.resolve(),(self.candidate,self.fallback))
    def migrate(self,path):
        with sqlite3.connect(path) as db:db.execute('ALTER TABLE orders ADD COLUMN migrated TEXT')
        return True
    def verify(self,path):
        with sqlite3.connect(path) as db:return len(db.execute('PRAGMA table_info(orders)').fetchall())==3
    def make_controller(self,hook=lambda _:None):
        guard=lambda:True
        guard.database_path=self.db;guard.marker_path=self.marker
        return c.Controller(self.plan,self.state,guard,self.service,lambda:True,self.migrate,self.verify,lambda _:True,lambda:True,hook)
    def test_systemd_reader_correct_manager_and_strict_wire_parser(self):
        commands=[]
        def run(args):
            commands.append(args)
            return {'Conditions':'a(sbbsi) 1 "ConditionPathExists" false true "/safe hold" 0',
                    'NeedDaemonReload':'b false','DropInPaths':'as 1 "/safe/dropin.conf"'}[args[-1]]
        reader=c.SystemdReader(1000,run)
        self.assertEqual(reader('user',c.core.APP)['Conditions'][0],['ConditionPathExists',False,True,'/safe hold',0])
        self.assertEqual(commands[0][:4],['runuser','-u','ubuntu','--'])
        self.assertIn('/org/freedesktop/systemd1/unit/bubblewash_2dlocal_2eservice',commands[0])
        commands.clear();reader('system',c.core.TIMER)
        self.assertEqual(commands[0][:2],['busctl','--system'])
        with self.assertRaises(ValueError):c.SystemdReader(1000,lambda _: 'a(sbbsi) 2 missing')('user',c.core.APP)
    def test_initial_marker_mismatch_rejected(self):
        self.marker.write_text('wrong')
        with self.assertRaises(ValueError):self.control.execute()
        self.assertEqual(self.events,[])
    def test_manifest_release_identity_mismatch_rejected(self):
        self.plan['manifests']['fallback']['releaseSha']='b'*40
        self.control=self.make_controller()
        with self.assertRaises(ValueError):self.control.execute()
        self.assertEqual(self.events,[])
    def test_loaded_manager_gates_and_adversarial_properties(self):
        sources={};properties={}
        for manager,unit in c.core.UNITS:
            source=self.root/(manager+'-'+unit+'.conf');source.write_text('[Unit] synthetic fixture')
            sources[(manager,unit)]={str(source):c.core.digest(source)}
            hold=self.state.app_hold if unit==c.core.APP else self.state.maintenance_hold
            properties[(manager,unit)]={'NeedDaemonReload':False,'DropInPaths':[str(source)],'Conditions':[
                ['ConditionPathExists',False,False,str(self.state.sentinel),0],
                ['ConditionPathExists',False,True,str(hold),0]]}
        verifier=c.LoadedGates(self.state,lambda manager,unit:properties[(manager,unit)],sources)
        self.assertTrue(verifier())
        target=properties[c.core.UNITS[0]]
        for field,bad in [('NeedDaemonReload',True),('DropInPaths',[]),('Conditions',[]),
                          ('Conditions',[['ConditionPathExists',True,False,str(self.state.sentinel),1]])]:
            original=target[field];target[field]=bad
            with self.assertRaises(ValueError):verifier()
            target[field]=original
        Path(next(iter(sources[c.core.UNITS[0]]))).write_text('changed')
        with self.assertRaises(ValueError):verifier()
    def test_success_leaves_maintenance_inhibited_and_owner_aware_pointer(self):
        self.assertEqual(self.control.execute(),'candidate-ready');self.assertFalse(self.state.app_hold.exists());self.assertTrue(self.state.maintenance_hold.exists())
        self.assertEqual(self.state.read()['phase'],'CANDIDATE_READY');self.assertEqual(self.current.resolve(),self.candidate)
    def test_post_write_failure_falls_back_without_restore(self):
        def readiness(target):
            if target==self.candidate:
                with sqlite3.connect(self.db) as db:db.execute("INSERT INTO orders VALUES(2,'new','keep')")
                raise ValueError('candidate bad')
            return True
        self.control.readiness=readiness;self.assertEqual(self.control.execute(),'fallback-ready')
        with sqlite3.connect(self.db) as db:self.assertEqual(db.execute('SELECT count(*) FROM orders').fetchone()[0],2)
        self.assertTrue(self.state.maintenance_hold.exists())
    def test_mutated_plan_rejected(self):
        self.plan['candidate']=str(self.old)
        with self.assertRaises(ValueError):self.control.execute()
        self.assertEqual(self.events,[])
    def test_guarded_database_mismatch_rejected(self):
        self.control.guard.database_path=self.root/'wrong.sqlite'
        with self.assertRaises(ValueError):self.control.execute()
    def test_helper_pin_mismatch_rejected(self):
        self.plan['controllerPins'][str(Path(c.__file__).resolve())]='a'*64
        self.control=self.make_controller()
        with self.assertRaises(ValueError):self.control.execute()
    def test_unknown_migration_stays_held(self):
        self.control.migrate=lambda _:False
        with self.assertRaises(ValueError):self.control.execute()
        self.assertTrue(self.state.app_hold.exists());self.assertTrue(self.state.maintenance_hold.exists())
        with self.assertRaises(ValueError):self.control.recover()
        self.assertTrue(self.state.app_hold.exists())
    def test_owner_unaware_fallback_rejected_before_migration(self):
        self.plan['ownerContract']['files']['src/lib/auth.ts']='b'*64
        with self.assertRaises(ValueError):self.control.execute()
        self.assertEqual(self.events,[])
    def test_removed_sentinel_blocks_standard_systemd_condition(self):
        self.state.sentinel.unlink()
        result=subprocess.run(['systemd-analyze','--user','condition','ConditionPathExists='+str(self.state.sentinel),'ConditionPathExists=!'+str(self.state.app_hold)],capture_output=True,env={**os.environ,'XDG_RUNTIME_DIR':str(self.root)})
        self.assertNotEqual(result.returncode,0)
        with self.assertRaises((ValueError,FileNotFoundError)):self.control.execute()
    def test_actual_systemd_condition_hold_semantics(self):
        def allowed(hold):
            return subprocess.run(['systemd-analyze','--user','condition','ConditionPathExists='+str(self.state.sentinel),'ConditionPathExists=!'+str(hold)],capture_output=True,env={**os.environ,'XDG_RUNTIME_DIR':str(self.root)}).returncode==0
        self.assertTrue(allowed(self.state.app_hold));self.state.hold();self.assertFalse(allowed(self.state.app_hold));self.assertFalse(allowed(self.state.maintenance_hold))
        self.state.record('TARGET_SELECTED',self.control.plan_hash,self.candidate);self.state.allow_app()
        self.assertTrue(allowed(self.state.app_hold));self.assertFalse(allowed(self.state.maintenance_hold))
    def test_journal_plan_mismatch_never_releases_hold(self):
        self.control.execute();self.plan['externalInvokersExcluded']=False
        recovering=self.make_controller()
        with self.assertRaises(ValueError):recovering.recover()
        self.assertTrue(self.state.app_hold.exists())
    def test_existing_journal_requires_recovery_not_new_transaction(self):
        self.control.execute()
        with self.assertRaises(ValueError):self.control.execute()
    def test_symlink_hold_rejected(self):
        self.state.app_hold.symlink_to(self.marker)
        with self.assertRaises(ValueError):self.control.execute()
    def test_fallback_readiness_failure_reholds_on_every_error(self):
        self.control.readiness=lambda _:False
        with self.assertRaises(ValueError):self.control.execute()
        self.assertTrue(self.state.app_hold.exists());self.assertTrue(self.state.maintenance_hold.exists())
    def test_process_death_each_durable_boundary_and_recovery(self):
        phases=['HOLDS_DURABLE','STOPPED','BACKED_UP','MIGRATING','DB_COMMITTED','MIGRATED','POINTER_DURABLE','MARKER_DURABLE','TARGET_SELECTED','APP_HOLD_RELEASED','APP_STARTED','CANDIDATE_READY']
        for phase in phases:
            with self.subTest(phase=phase):
                fixture=DurableTests();fixture.setUp()
                try:
                    def crash():
                        control=fixture.make_controller(lambda step:os._exit(91) if step==phase else None)
                        control.execute();os._exit(0)
                    worker=multiprocessing.get_context('fork').Process(target=crash);worker.start();worker.join(10)
                    self.assertEqual(worker.exitcode,91)
                    self.assertTrue(fixture.state.maintenance_hold.exists())
                    if not fixture.state.app_hold.exists():self.assertNotEqual(fixture.current.resolve(),fixture.old)
                    # Fresh controller starts after abrupt process death.
                    recovery=fixture.make_controller()
                    if phase in ('HOLDS_DURABLE','STOPPED','BACKED_UP','MIGRATING'):
                        with self.assertRaises((ValueError,FileNotFoundError)):recovery.recover()
                        self.assertTrue(fixture.state.app_hold.exists())
                    else:
                        self.assertEqual(recovery.recover(),'fallback-ready')
                        self.assertEqual(fixture.current.resolve(),fixture.fallback)
                        self.assertTrue(fixture.state.maintenance_hold.exists())
                        self.assertFalse(any(e[1]=='start' and e[3]=='old' for e in fixture.events))
                finally:fixture.tearDown()


class ExistingHostGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='bubblewash-existing-guards-');self.root=Path(self.temp.name)
        self.runtime=self.root/'runtime';self.runtime.mkdir();(self.runtime/'deploy.lock').write_text('')
        self.archive=self.root/'bubblewash-2026-10-23T00:00:00.000Z.sqlite.enc';self.archive.write_bytes(b'synthetic encrypted archive fixture')
        now=dt.datetime.now(dt.timezone.utc).isoformat();digest=c.core.digest(self.archive)
        receipt={'schema':'becore-encrypted-backup-release/v2','repository':'bechirobob/bubble-wash','storageRepository':'bechirobob/becore-backups','storage':'private-github-release','storageSha':'a'*40,'storageRepositoryId':123,'runId':'456','encrypted':True,'restoreTested':True,'downloadVerified':True,'automaticExpiry':False,'retentionDays':None,'filename':self.archive.name,'sha256':digest,'sourceSha':'b'*40,'size':self.archive.stat().st_size,'verifiedAt':now}
        self.receipt=self.root/'receipt.json';self.receipt.write_text(json.dumps(receipt))
        self.status=self.root/'status.json';self.status.write_text(json.dumps({'ok':True,'filename':self.archive.name,'sha256':digest,'createdAt':now,'restoreVerifiedAt':now,'offsiteStoredAt':now}))
        self.env=self.root/'env';self.db=self.root/'data.sqlite';self.db.write_bytes(b'synthetic')
        self.env.write_text(f'BUBBLEWASH_BACKUP_OFFSITE_DIR={self.root}\nBUBBLEWASH_BACKUP_STATUS_PATH={self.status}\nBUBBLEWASH_DATABASE_PATH={self.db}\n')
        self.expected={'envSha256':c.core.digest(self.env),'receiptSha256':c.core.digest(self.receipt),'archiveSha256':digest,'receiptRun':'456','storeSha':'a'*40,'storeId':123,'database':str(self.db)}
    def tearDown(self):self.temp.cleanup()
    def host(self):return c.HostGuards(self.runtime,self.env,self.receipt,self.expected,os.getuid())
    def test_exact_existing_lock_receipt_config_guards_accept_fixture(self):
        with self.host().locked() as verify:self.assertTrue(verify())
    def test_config_mutation_blocks(self):
        with self.host().locked() as verify:
            self.env.write_text(self.env.read_text()+'CHANGED=true\n')
            with self.assertRaises(ValueError):verify()
    def test_lock_inode_substitution_blocks(self):
        with self.host().locked() as verify:
            (self.runtime/'deploy.lock').rename(self.runtime/'old-lock');(self.runtime/'deploy.lock').write_text('')
            with self.assertRaises(ValueError):verify()
    def test_archive_change_blocks(self):
        with self.host().locked() as verify:
            self.archive.write_bytes(b'changed')
            with self.assertRaises(ValueError):verify()
    def test_expired_status_blocks(self):
        status=json.loads(self.status.read_text());status['createdAt']='2000-01-01T00:00:00Z';self.status.write_text(json.dumps(status))
        with self.assertRaises(ValueError):
            with self.host().locked():pass

if __name__=='__main__':unittest.main()
