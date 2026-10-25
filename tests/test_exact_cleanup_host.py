import contextlib
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('wrapper',ROOT/'ops/exact-cleanup-host.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
F='f'*64
class DB:
    def __init__(self,h):self.h=h;self.in_transaction=False
    def execute(self,sql):self.h.events.append(sql);self.in_transaction=True
    def commit(self):
        self.h.events.append('commit')
        if self.h.failure=='commit':raise OSError('uncertain commit')
        self.in_transaction=False
class Core:
    CONFIRMATION='EXACT'
    def inspect(self,db,raw):
        if db.h.failure=='preflight':raise ValueError('preflight')
        if db.h.failure=='revalidation' and db.h.events.count('inspect')==1:
            db.h.failure=None;db.h.events.append('inspect');raise ValueError('count changed')
        db.h.events.append('inspect');return {'fingerprint':F,'_secret':'never-output'}
    def public_plan(self,p):return {k:v for k,v in p.items() if not k.startswith('_')}
    def apply_in_transaction(self,db,raw,expected,confirmation):
        assert db.in_transaction
        db.h.events.append('delete-two');return b'new'
class Fake:
    def __init__(self,failure=None):self.failure=failure;self.events=[];self.holding=False;self.raw=b'old'
    @contextlib.contextmanager
    def locked(self):self.events.append('lock');yield
    @contextlib.contextmanager
    def database(self,readonly):
        db=DB(self)
        try:yield db
        finally:
            if db.in_transaction:self.events.append('rollback')
    def preflight(self):self.events.append('preflight');return self.raw
    def recovery_copy(self,*a):self.events.append('recovery-copy')
    def hold(self):self.events.append('hold');self.holding=True
    def stop(self):self.events.append('stop')
    def quiet(self):self.events.append('quiet')
    def unchanged(self,raw):
        self.events.append('unchanged')
        if self.raw!=raw:raise ValueError('drift')
    def snapshot_plan(self,raw):return Core().inspect(DB(self),raw)
    def mutate(self,raw,expected,confirmation):
        with self.database(False) as db:
            db.execute("BEGIN IMMEDIATE");Core().apply_in_transaction(db,raw,expected,confirmation)
            self.install_env(raw,b"new");db.commit();return b"new"
    def emergency_hold_stop(self):self.hold();self.stop();self.quiet()
    def install_env(self,old,new):
        self.events.append('env-install');self.raw=new
        if self.failure=='env':raise OSError('ack lost')
    def verify_committed(self,*a):
        self.events.append('verify-committed')
        if self.failure=='verify':raise ValueError('verify failed')
    def resume(self,raw):
        self.events.append('resume');self.holding=False
        if self.failure=='restart':raise ValueError('restart failed')

class Coordinator(unittest.TestCase):
    def runhost(self,h,apply=True):return m.run_cleanup(h,Core(),F,'EXACT',apply)
    def test_check_only_has_no_stop_hold_backup_write(self):
        h=Fake();out=self.runhost(h,False)
        self.assertTrue(out['checkOnly']);self.assertNotIn('_secret',out)
        for s in ('hold','stop','recovery-copy','env-install','commit','resume'):self.assertNotIn(s,h.events)
    def test_preflight_failure_no_downtime(self):
        h=Fake('preflight')
        with self.assertRaises(ValueError):self.runhost(h)
        self.assertFalse(h.holding);self.assertNotIn('stop',h.events)
    def test_exact_plan_refusal_no_downtime(self):
        h=Fake()
        with self.assertRaises(ValueError):m.run_cleanup(h,Core(),'a'*64,'EXACT',True)
        self.assertNotIn('hold',h.events)
    def test_confirmation_refusal_before_lock(self):
        h=Fake()
        with self.assertRaises(ValueError):m.run_cleanup(h,Core(),F,'WRONG',True)
        self.assertEqual(h.events,[])
    def test_success_order_and_counts(self):
        h=Fake();out=self.runhost(h)
        self.assertEqual(out['syntheticResearchRowsDeleted'],1);self.assertFalse(h.holding)
        for a,b in [('preflight','hold'),('hold','stop'),('stop','delete-two'),('delete-two','env-install'),('env-install','commit'),('commit','verify-committed'),('verify-committed','resume')]:self.assertLess(h.events.index(a),h.events.index(b))
    def test_stopped_pre_mutation_failure_revalidated_before_resume(self):
        h=Fake('revalidation')
        with self.assertRaises(ValueError):self.runhost(h)
        self.assertNotIn('delete-two',h.events);self.assertFalse(h.holding)
        self.assertEqual(h.events[-1],'resume');self.assertEqual(h.events.count('inspect'),3)
    def test_env_uncertainty_keeps_hold_rollsback_db_never_resumes(self):
        h=Fake('env')
        with self.assertRaises(OSError):self.runhost(h)
        self.assertTrue(h.holding);self.assertIn('rollback',h.events);self.assertNotIn('resume',h.events)
    def test_commit_uncertainty_no_blind_restore_or_resume(self):
        h=Fake('commit')
        with self.assertRaises(OSError):self.runhost(h)
        self.assertTrue(h.holding);self.assertNotIn('resume',h.events);self.assertEqual(h.raw,b'new')
    def test_verification_failure_remains_held(self):
        h=Fake('verify')
        with self.assertRaises(ValueError):self.runhost(h)
        self.assertTrue(h.holding);self.assertNotIn('resume',h.events)
    def test_failed_restart_reholds_and_stops(self):
        h=Fake('restart')
        with self.assertRaises(ValueError):self.runhost(h)
        self.assertTrue(h.holding);self.assertEqual(h.events[-3:],['hold','stop','quiet'])

    def test_failed_unchanged_recovery_restart_reholds(self):
        h=Fake('revalidation')
        def resume(raw):h.holding=False;h.events.append('resume');raise ValueError('failed original restart')
        h.resume=resume
        with self.assertRaises(ValueError):self.runhost(h)
        self.assertTrue(h.holding);self.assertEqual(h.events[-3:],['hold','stop','quiet'])

class ConcreteSafety(unittest.TestCase):
    def test_emergency_capture_failure_still_stops_every_known_unit(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);host=m.Host.__new__(m.Host)
            host.state_identity=(state.stat().st_dev,state.stat().st_ino);host.protected=lambda *a:None
            units=[('system','timer'),('system','worker'),('user','app')]
            host.controller=types.SimpleNamespace(core=types.SimpleNamespace(UNITS=units))
            host.host=types.SimpleNamespace(capture=mock.Mock(side_effect=ValueError('capture')),
                service=mock.Mock(),quiet=mock.Mock())
            with mock.patch.object(m,'STATE',state):
                with self.assertRaises(ValueError):host.emergency_hold_stop()
            self.assertEqual((state/'app-hold').read_bytes(),b'held\n')
            self.assertEqual(host.host.service.call_args_list,[mock.call(manager,'stop',unit) for manager,unit in units])
    def test_alternate_environment_sources_refuse_before_stop(self):
        host=m.Host.__new__(m.Host);host.cleanup=types.SimpleNamespace(REMOVE_KEYS={'BUBBLEWASH_DRIVER_EMAIL'})
        for source in ('Environment','PassEnvironment'):
            props={'Environment':'','PassEnvironment':''};props[source]='BUBBLEWASH_DRIVER_EMAIL=private' if source=='Environment' else 'BUBBLEWASH_DRIVER_EMAIL'
            host.core=types.SimpleNamespace(UNIT='app',ctl=lambda *a:'ignored',parse=lambda raw:props)
            with self.assertRaises(ValueError):host.no_alternate_login_sources()
        props={'Environment':'NODE_ENV=production','PassEnvironment':''}
        host.no_alternate_login_sources()

class Files(unittest.TestCase):
    def test_atomic_env_metadata_and_exact_unrelated_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'env';p.write_bytes(b'old');p.chmod(0o600);identity=m.file_identity(p)
            m.atomic_env(p,b'old',b'new',identity)
            self.assertEqual(p.read_bytes(),b'new');self.assertEqual(p.stat().st_mode&0o777,0o600)
            self.assertEqual(list(Path(d).iterdir()),[p])
    def test_atomic_env_drift_refuses_without_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'env';p.write_bytes(b'old');p.chmod(0o600);identity=m.file_identity(p);p.write_bytes(b'drift')
            with self.assertRaises(ValueError):m.atomic_env(p,b'old',b'new',identity)
            self.assertEqual(p.read_bytes(),b'drift')
    def test_source_has_no_journal_write_or_restore(self):
        source=(ROOT/'ops/exact-cleanup-host.py').read_text()
        self.assertNotIn('state.hold(',source);self.assertNotIn('state.record(',source)
        self.assertNotIn('CoordinatedController(',source);self.assertNotIn('shutil.copy',source)

if __name__=='__main__':unittest.main()
