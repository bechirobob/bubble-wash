import types
import time
import unittest
from unittest.mock import Mock,patch
from pathlib import Path
import live_host_adapter as h
from uat_update_engine import Contract,Evidence,Refused

class HostBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.contract=Contract('uat-review-operation-0001','a'*40,'b'*40,'c'*64,'d'*64,'e'*64,'f'*64,100000000)
        self.r=types.SimpleNamespace(c=Mock(),p=Mock(),t=types.SimpleNamespace(exchange=Mock()),loaded_unit=Mock(return_value={}),quiet_sample=Mock(),health=Mock())
        self.original={'runtimeRevision':'a'*40,'runtimeFiles':{n:'1'*64 for n in h.PIN_NAMES},'unitSha256':'2'*64}
        self.candidate={**self.original,'runtimeRevision':'b'*40}
        self.a=h.HostAdapter(self.r,self.original,self.candidate,Mock(),execution_deadline=time.monotonic()+600)
        self.old=Evidence('a'*40,'d'*64,'e'*64,'f'*64,100000000,True,True,True,True)
        self.new=Evidence('b'*40,'d'*64,'e'*64,'f'*64,100000000,True,True,True,True)
        self.a.before={'pid':1,'startTicks':2,'database':{'inode':'3'},'productionPaths':['fixed-private-path']}
        self.a.baseline={'synthetic':True}
    def test_constructor_is_side_effect_free(self):
        self.r.c.assert_not_called();self.r.t.exchange.assert_not_called()
    def test_exact_pins_required(self):
        h.pins(self.original,'a'*40)
        for bad in ({},dict(self.original,extra=True),dict(self.original,runtimeRevision='b'*40),dict(self.original,runtimeFiles={})):
            with self.assertRaises(Refused):h.pins(bad,'a'*40)
    def test_stopped_state_refuses_lingering_process_or_group(self):
        raw='ActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nControlGroup=\n'
        h.stopped_properties(raw)
        for bad in (raw.replace('MainPID=0','MainPID=5'),raw.replace('ControlGroup=','ControlGroup=/a'),raw+'Other=value\n',raw+'MainPID=0\n'):
            with self.assertRaises(Refused):h.stopped_properties(bad)
    def test_stop_one_fixed_command_and_never_retries(self):
        self.a._private=Mock();self.a._evidence=Mock(return_value=self.old)
        self.r.c.collect_restart_isolation.return_value=self.a.before
        self.a.stop(self.contract)
        self.assertEqual(self.r.t.exchange.call_args.args[0],['/usr/bin/systemctl','--job-mode=fail','stop','bubblewash-uat.service'])
        self.r.t.exchange.assert_called_once()
        self.r.t.exchange.reset_mock();self.r.t.exchange.side_effect=TimeoutError()
        with self.assertRaises(TimeoutError):self.a.stop(self.contract)
        self.r.t.exchange.assert_called_once()
    def test_start_requires_switch_and_unchanged_config(self):
        with self.assertRaises(Refused):self.a.start(self.contract)
        self.r.t.exchange.assert_not_called()
        self.a.switched=True;self.a._stopped=Mock();self.a._config=Mock(return_value='x')
        with self.assertRaises(Refused):self.a.start(self.contract)
        self.r.t.exchange.assert_not_called()
        self.a._config.return_value='d'*64;self.a.start(self.contract)
        self.assertEqual(self.r.t.exchange.call_args.args[0],['/usr/bin/systemctl','--job-mode=fail','start','bubblewash-uat.service'])
    def test_postcheck_uses_candidate_pins_and_new_process(self):
        self.a.switched=True;self.a._evidence=Mock(return_value=self.new)
        self.r.c.collect_restart_isolation.return_value={**self.a.before,'pid':4,'startTicks':5}
        self.assertEqual(self.a.postverify(self.contract),self.new)
        self.r.c.collect_restart_isolation.assert_called_with(self.candidate,before_restart=False)
        self.r.t.exchange.assert_not_called()
    def test_postcheck_old_process_fails_without_restart(self):
        self.a.switched=True;self.r.c.collect_restart_isolation.return_value=self.a.before
        with patch.object(h.time,'monotonic',side_effect=[0,31]):
            with self.assertRaises(Refused):self.a.postverify(self.contract)
        self.r.t.exchange.assert_not_called()
    def test_unapproved_database_path_refused(self):
        with patch.object(h.sqlite3,'connect') as db:
            with self.assertRaises(Refused):h.database_commitments(Path('/var/lib/production.sqlite'))
            db.assert_not_called()

if __name__=='__main__':unittest.main()
