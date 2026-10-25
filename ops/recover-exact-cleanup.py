"""Recovery only for the acknowledged cleanup commit. Never replay deletion or restore DB/config.
Original protected-row hashes were verified before the failed restart but not persisted;
this recovery rechecks bounded current invariants and preserves its fresh whole-DB snapshot.
"""
import argparse
import json
import types
import sys

FINGERPRINT='ca3576e70efdad17273eae8bcd7320026717e6176fa1a62f2969b9e3d8251f17'

def recovery_class(base):
    namespace=dict(base.__dict__,FINGERPRINT=FINGERPRINT)
    source=RECOVERY_CLASS
    exec(compile(source,'recovery-only','exec'),namespace)
    return namespace['RecoveryHost']

RECOVERY_CLASS = r'''
class RecoveryHost(Host):
    def preflight(self):
        checkpoint('owned-app-hold-unchanged')
        self.protected(STATE/'app-hold',0)
        require((STATE/'app-hold').read_bytes()==b'held\n')
        self.held_identity=file_identity(STATE/'app-hold')
        self.host.capture();self.host.quiet();self.stopped=True
        checkpoint('durable-evidence-files')
        for name in ('installed-v1','maintenance-hold','transition.json'):
            path=STATE/name;self.protected(path,0);self.guard_files[path]=(file_identity(path),path.read_bytes())
        checkpoint('installed-sentinel')
        require(self.guard_files[STATE/'installed-v1'][1]==b'bubblewash-release-gate-v1\n')
        checkpoint('maintenance-hold')
        require(self.guard_files[STATE/'maintenance-hold'][1]==b'held\n')
        checkpoint('completed-migration-journal')
        journal=json.loads(self.guard_files[STATE/'transition.json'][1])
        require(journal=={'schema':1,'phase':'CANDIDATE_READY','planHash':JOURNAL,'target':str(STATE/'releases'/'5f256800d65dbe3b69f54e95afa0e8ab30b5e881')})
        checkpoint('current-code-marker')
        marker=RUNTIME/'current-release';self.guards.safe_path(marker,self.owner)
        self.guard_files[marker]=(file_identity(marker),marker.read_bytes())
        require(self.core.parse(marker.read_bytes()).get('sha')==LIVE and self.core.parse(marker.read_bytes()).get('path')==str(self.current))
        checkpoint('environment-file-metadata')
        raw,self.env_id=self.guards.environment_snapshot(ENV,self.owner,None)
        # The app-UID writer must be able to preserve the existing group exactly.
        checkpoint('environment-group-preservation')
        require(self.env_id[1][4]==self.owner.pw_gid)
        checkpoint('environment-cleanup-policy')
        recovery=STATE/'rehearsal-evidence'/('exact-cleanup-'+FINGERPRINT)
        self.protected(recovery,0,True)
        for name in ('env.before','operation.json'):self.protected(recovery/name,0)
        require(json.loads((recovery/'operation.json').read_bytes())=={'fingerprint':FINGERPRINT,'runtimeSha':LIVE,'backupSha256':self.pins['backupSha256']})
        before=(recovery/'env.before').read_bytes()
        _,replacement=self.cleanup.config(before)
        require(raw==replacement)
        self.original=raw;self.values=self.core.parse(raw);self.replacement=raw
        require(not self.cleanup.REMOVE_KEYS.intersection(self.values))
        for name in ('env.before','operation.json'):
            path=recovery/name;self.guard_files[path]=(file_identity(path),path.read_bytes())
        checkpoint('database-configured-path')
        self.dbpath=Path(self.values['BUBBLEWASH_DATABASE_PATH'])
        require(self.dbpath.is_absolute() and not self.dbpath.is_relative_to(STATE) and not self.dbpath.is_relative_to(Path('/home/ubuntu/bubblewash-releases')))
        require(str(self.dbpath)==self.plan['database'])
        checkpoint('database-file-identity')
        self.db_id=self.guards.database_identity(self.dbpath,self.owner)
        require(tuple(self.db_id[:2])==tuple(self.plan['databaseIdentity']))
        checkpoint('legacy-import-absent')
        require(not (self.current/'data/submissions.jsonl').exists())
        self.stable();self.backup(self.values);self.no_alternate_login_sources()
        # Existing maintenance inhibition is preserved, never resumed.
        checkpoint('maintenance-units-inactive')
        for manager,unit in self.controller.core.UNITS:
            if manager=='system':
                p=self.controller.core.parse_properties(self.host.show(manager,unit))
                require(p['ActiveState']=='inactive' and p['SubState']=='dead' and not p.get('Job'))
        return raw

    def committed_snapshot(self):
        self.quiet();require(self.guards.environment_snapshot(ENV,self.owner,None)==(self.original,self.env_id))
        require(self.guards.database_identity(self.dbpath,self.owner)==self.db_id)
        def read():
            with self.database(readonly=True) as db:
                checkpoint('database-inventory-core')
                schema,contents=self.cleanup.database_state(db)
                require(list(db.execute('PRAGMA foreign_key_check'))==[])
                expected={'research_responses':0,'research_notification_outbox':0,
                    'staff_accounts':2,'staff_owner_capabilities':2,'early_access_signups':1,
                    'notification_outbox':1,'submissions':3}
                for table,count in expected.items():
                    require(db.execute('SELECT count(*) FROM "'+table+'"').fetchone()[0]==count)
                require(db.execute("SELECT count(*) FROM staff_accounts WHERE role='admin' AND status IN ('active','invited')").fetchone()[0]==2)
                require(db.execute("SELECT count(*) FROM staff_accounts WHERE role='admin' AND status='active'").fetchone()[0]==1)
                return self.cleanup.digest({'schema':schema,'contents':contents})
        return self.as_app(read)

    def resume(self,raw):
        self.quiet();require(self.guards.environment_snapshot(ENV,self.owner,None)==(raw,self.env_id))
        require(file_identity(STATE/'app-hold')==self.held_identity)
        try:
            (STATE/'app-hold').unlink();fsync_dir(STATE);self.held_identity=None
            self.host.service('user','start',self.controller.core.APP)
            self.stopped=False
            # Bounded liveness wait only; no identity/configuration failure is retried.
            checkpoint('local-health');self.core.health(3000)
            self.effective(self.core.parse(raw));self.stable()
        except BaseException:
            self.emergency_hold_stop();raise
'''

def run_recovery(host,base,activate=False):
    with host.locked():
        base.STAGE='recovery-check'
        raw=host.preflight()
        snapshot=host.committed_snapshot()
        if not activate:return {'ok':True,'recoveryCheckOnly':True,'cleanupReplayed':False,'configurationChanged':False}
        base.STAGE='recovery-start'
        base.require(host.committed_snapshot()==snapshot)
        host.resume(raw)
        return {'ok':True,'serviceRecovered':True,'cleanupReplayed':False,'databaseRestored':False,'configurationChanged':False,'maintenanceResumed':False}

def entry(pins,sources):
    base=None
    try:
        # Pins bind the existing wrapper and its unchanged dependencies as well as this runner.
        if pins['schema']!='bubblewash-cleanup-recovery/v1':raise ValueError('recovery binding refused')
        import hashlib
        if not set(sources)==set(pins['dependencies'])=={'wrapper','cleanup','preserving','guards','update'}:raise ValueError('recovery binding refused')
        if not all(hashlib.sha256(raw.encode()).hexdigest()==pins['dependencies'][name] for name,raw in sources.items()):raise ValueError('recovery binding refused')
        def module(name):
            m=types.ModuleType(name);exec(compile(sources[name],name,'exec'),m.__dict__);return m
        base=module('wrapper');cleanup=module('cleanup')
        modules={name:module(name) for name in ('preserving','guards','update')}
        parser=argparse.ArgumentParser();parser.add_argument('--operation',choices=('recovery-check','recover'),default='recovery-check')
        args=parser.parse_args()
        host=recovery_class(base)(pins,modules,cleanup)
        print(json.dumps(run_recovery(host,base,args.operation=='recover'),sort_keys=True))
    except BaseException:
        check=getattr(base,'CHECKPOINT','initial')
        if check not in getattr(base,'CHECKPOINTS',()):check='initial'
        print(json.dumps({'ok':False,'recoveryOnly':True,'check':check,'inspectBeforeRetry':True,'cleanupReplayed':False,'databaseRestored':False}))
        raise SystemExit(1)
