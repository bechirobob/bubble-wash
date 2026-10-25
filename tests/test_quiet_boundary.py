"""Terminal app quiescence boundary regressions."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
REFERENCE=ROOT
sys.dont_write_bytecode=True
sys.path.insert(0,str(REFERENCE/'ops/integration-release'))
import contracts as k
spec=importlib.util.spec_from_file_location('quiet_overlay_adapter',ROOT/'ops/integration-release/host_adapter.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)

class QuietTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        self.c=k.load_controller();self.h=a.Host.__new__(a.Host);h=self.h
        h.c=self.c;h.uid=os.getuid();h.proc=self.root/'proc';h.proc.mkdir()
        h.groups={};h.empty_groups=set();h.captured={};h.scan_roots=[self.root/'old']
        self.props={}
        for manager,unit in self.c.core.UNITS:
            self.props[(manager,unit)]={'LoadState':'loaded','ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlPID':'0','Job':'','ControlGroup':'/'+manager+'/'+unit}
            if unit!=self.c.core.TIMER:
                group=self.root/manager/unit;group.mkdir(parents=True);(group/'cgroup.procs').write_text('')
                h.groups[group]=(group.stat().st_dev,group.stat().st_ino)
        self.app=self.props[('user',self.c.core.APP)]
        self.app.update(ActiveState='failed',SubState='failed')
        h.show=lambda m,u:'\n'.join(f'{key}={value}' for key,value in self.props[(m,u)].items())
        h.run=lambda *args,**kwargs:''
    def test_exact_terminal_app_pairs(self):
        for active,sub in [('inactive','dead'),('failed','failed')]:
            self.app.update(ActiveState=active,SubState=sub);self.assertTrue(self.h.quiet())
    def test_all_other_app_pairs_refused(self):
        for active,sub in [('failed','dead'),('failed',''),('inactive','failed'),('active','running'),('activating','start'),('deactivating','stop'),('reloading','reload')]:
            with self.subTest(active=active,sub=sub):
                self.app.update(ActiveState=active,SubState=sub)
                with self.assertRaises(ValueError):self.h.quiet()
    def test_maintenance_and_timer_stay_strict(self):
        for key,props in self.props.items():
            if key[0]=='system':
                props.update(ActiveState='failed',SubState='failed')
                with self.assertRaises(ValueError):self.h.quiet()
                props.update(ActiveState='inactive',SubState='dead')
    def test_loaded_job_and_writer_pids_still_required(self):
        for key,value in [('LoadState','not-found'),('Job','17'),('MainPID','123'),('ControlPID','456')]:
            original=self.app[key];self.app[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.h.quiet()
            self.app[key]=original
    def test_direct_and_nested_cgroup_tasks_refused(self):
        group=next(iter(self.h.groups))
        for path in [group,group/'nested']:
            path.mkdir(exist_ok=True);(path/'cgroup.procs').write_text('123')
            with self.assertRaises(ValueError):self.h.quiet()
            (path/'cgroup.procs').write_text('')
    def test_replaced_group_and_incomplete_inventory_refused(self):
        group=next(iter(self.h.groups));original=self.h.groups[group]
        self.h.groups[group]=(original[0],original[1]+1)
        with self.assertRaises(ValueError):self.h.quiet()
        del self.h.groups[group]
        with self.assertRaises(ValueError):self.h.quiet()
    def test_listener_captured_and_release_processes_refused(self):
        self.h.run=lambda *a,**k:'LISTEN'
        with self.assertRaises(ValueError):self.h.quiet()
        self.h.run=lambda *a,**k:''
        (self.h.proc/'123').mkdir();self.h.captured={'123':'99'}
        with self.assertRaises(ValueError):self.h.quiet()
        self.h.captured={};(self.h.proc/'123').rmdir()
        with patch.object(a,'release_processes',return_value={'123':'99'}),self.assertRaises(ValueError):self.h.quiet()
    def test_observed_empty_group_cannot_become_nonempty(self):
        group=next(g for g in self.h.groups if g.name==self.c.core.APP)
        del self.h.groups[group];self.h.empty_groups.add(('user',self.c.core.APP))
        with self.assertRaises(ValueError):self.h.quiet()
        self.app['ControlGroup']='';self.assertTrue(self.h.quiet())
    def test_capture_still_refuses_failed_empty_group(self):
        self.h.cgroup=self.root;self.h.plan={'units':{m+'/'+u:{'cgroup':''} for m,u in self.c.core.UNITS}}
        self.app['ControlGroup']=''
        with self.assertRaises(ValueError):self.h.capture()
    def controller_fixture(self):
        c=self.c.Controller.__new__(self.c.Controller);old=self.root/'old';old.mkdir()
        current=self.root/'current';current.symlink_to(old);marker=self.root/'marker'
        marker.write_text(f"sha={'a'*40}\nrelease=old\npath={old}\n")
        c.plan={'old':str(old),'current':str(current),'marker':str(marker),'oldSha':'a'*40}
        c.pins=lambda:None;c.quiescent=self.h.quiet;c.hook=lambda stage:None
        self.events=[];self.holds=False
        def hold():self.holds=True
        c.state=types.SimpleNamespace(journal=self.root/'journal',hold=hold)
        c.service=lambda m,action,u:self.events.append((m,action,u))
        c.phase=lambda name:self.events.append(name)
        return c
    def test_successful_stop_reaches_stopped_only_after_quiet(self):
        c=self.controller_fixture()
        class Boundary(Exception):pass
        def phase(name):
            self.assertTrue(self.holds);self.assertTrue(self.h.quiet());self.assertEqual(name,'STOPPED');raise Boundary()
        c.phase=phase
        with patch.object(self.c.core,'consistent_backup') as backup,self.assertRaises(Boundary):c.execute()
        backup.assert_not_called();self.assertEqual(len(self.events),3)
    def test_stop_error_remains_fatal_with_holds_no_phase_or_backup(self):
        c=self.controller_fixture()
        def service(*args):self.events.append(args);raise OSError('synthetic stop failure')
        c.service=service
        with patch.object(self.c.core,'consistent_backup') as backup,self.assertRaises(OSError):c.execute()
        backup.assert_not_called();self.assertTrue(self.holds);self.assertEqual(len(self.events),3);self.assertFalse(c.state.journal.exists())
    def test_rejected_quiescence_never_records_stopped(self):
        c=self.controller_fixture();self.app['MainPID']='123'
        with patch.object(self.c.core,'consistent_backup') as backup,self.assertRaises(ValueError):c.execute()
        backup.assert_not_called();self.assertTrue(self.holds);self.assertEqual(len(self.events),3);self.assertFalse(c.state.journal.exists())

if __name__=='__main__':unittest.main()
