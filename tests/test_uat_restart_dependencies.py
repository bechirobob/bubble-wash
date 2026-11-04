"""Synthetic implicit-dependency checks; no host commands or filesystem reads."""
import importlib.util
import json
from pathlib import Path
import shlex
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('restart_dependency_review',ROOT/'ops/uat/single-restart.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
MOUNTS='1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / /tmp rw - tmpfs tmpfs rw\n'

class Dependencies(unittest.TestCase):
    def row(self,name='tmp.mount',**changes):
        value={'Id':name,'LoadState':'loaded','ActiveState':'active','SubState':'mounted' if name.endswith('.mount') else 'active','NeedDaemonReload':'no','DropInPaths':'','FragmentPath':'/usr/lib/systemd/system/'+name,'SourcePath':''}
        if name.endswith('.mount'):value['Where']='/' if name=='-.mount' else '/tmp'
        value.update(changes);return value
    def check(self,row,job='(uo) 0 "/"',mounts=MOUNTS,identity=(1,2,3,4)):
        raw='\n'.join(k+'='+v for k,v in row.items())
        with mock.patch.object(s.c,'command',side_effect=[raw,job]) as command,mock.patch.object(s.c,'read',return_value=mounts.encode()) as read,mock.patch.object(s.c,'trusted',return_value=identity) as trusted:
            result=s.dependency_state(row['Id'])
            self.assertTrue(all(call.args[0][0] in ('/usr/bin/systemctl','/usr/bin/busctl') for call in command.call_args_list))
            return result,read,trusted
    def test_exact_active_root_and_tmp_mounts(self):
        for name,where in (('-.mount','/'),('tmp.mount','/tmp')):
            value,read,_=self.check(self.row(name,SourcePath='/proc/self/mountinfo'))
            self.assertEqual(value['Where'],where);self.assertIn('mountIdentity',value)
            read.assert_called_once_with('/proc/1/mountinfo',1048576)
    def test_masked_and_missing_tmp_are_inert_only(self):
        for state,fragment in (('masked','/dev/null'),('not-found','')):
            row=self.row(LoadState=state,ActiveState='inactive',SubState='dead',FragmentPath=fragment,Where='')
            value,read,trusted=self.check(row)
            self.assertEqual(value,row);read.assert_not_called();trusted.assert_not_called()
            for changes in ({'ActiveState':'active'},{'SubState':'mounted'},{'FragmentPath':'/usr/lib/systemd/system/tmp.mount'},{'SourcePath':'/etc/fstab'}):
                with self.subTest(state=state,changes=changes),self.assertRaises(ValueError):self.check(dict(row,**changes))
    def test_inactive_loadable_mount_and_nonloadable_required_mount_rejected(self):
        for row in (self.row(ActiveState='inactive',SubState='dead'),self.row('-.mount',LoadState='masked',ActiveState='inactive',SubState='dead',FragmentPath='/dev/null')):
            with self.assertRaises(ValueError):self.check(row)
    def test_strict_property_and_job_schema(self):
        for changes in ({'Unexpected':'canary'},{'NeedDaemonReload':'yes'},{'DropInPaths':'/private/canary'},{'Where':'/var/tmp'}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.check(self.row(**changes))
        for job in ('(uo) 1 "/org/freedesktop/systemd1/job/1"','(uo) 0 "/wrong"','u 0','(uo) 0 "/" canary'):
            with self.subTest(job=job),self.assertRaises(ValueError):self.check(self.row(),job=job)
        raw='\n'.join(k+'='+v for k,v in self.row().items())+'\nId=tmp.mount'
        with mock.patch.object(s.c,'command',return_value=raw),self.assertRaises(ValueError):s.dependency_state('tmp.mount')
    def test_covering_duplicate_or_automount_is_not_exact_mount(self):
        for mounts in (MOUNTS.splitlines()[0]+'\n',MOUNTS+MOUNTS.splitlines()[1]+'\n',MOUNTS.replace('tmpfs tmpfs','autofs autofs')):
            with self.assertRaises(ValueError):self.check(self.row(),mounts=mounts)
    def test_private_dependency_evidence_changes_on_identity_change(self):
        first,_,_=self.check(self.row(),identity=(1,2,3,4))
        changed,_,_=self.check(self.row(),identity=(1,5,3,4))
        self.assertNotEqual(first,changed)
        mount_changed,_,_=self.check(self.row(),mounts=MOUNTS.replace('2 1 0:2','3 1 0:3'))
        self.assertNotEqual(first,mount_changed)
    def test_allowlist_and_duplicates_rejected_before_dependency_inspection(self):
        for required,wanted in (('sysinit.target system.slice other.mount',''),('sysinit.target system.slice system.slice',''),('sysinit.target system.slice','tmp.mount tmp.mount'),('sysinit.target system.slice','other.service')):
            rows={**{k:'' for k in s.EMPTY},**s.FIXED,'Requires':required,'Wants':wanted,'Conflicts':'shutdown.target'}
            with mock.patch.object(s.c,'command',return_value='\n'.join(k+'='+v for k,v in rows.items())),mock.patch.object(s,'dependency_state') as dep,self.assertRaises(ValueError):
                try:s.loaded_unit()
                finally:dep.assert_not_called()
    def test_dependency_failure_receipt_does_not_disclose_metadata(self):
        request={'operationId':'e01f1a5d-3297-4c22-b246-7bdb509289ca','restartApproved':True,'quietWindowCoordinated':True}
        with mock.patch.object(s.os,'geteuid',return_value=0),mock.patch.object(s.c,'collect_restart_isolation',return_value={}),mock.patch.object(s,'loaded_unit',side_effect=ValueError('/private/canary')),mock.patch.object(s.t,'exchange') as transport:
            result=s.execute({'ops/uat/restoration-runtime-pins.json':'{}'},request)
            self.assertEqual(result,s.receipt('precheck-failed'));transport.assert_not_called()
            self.assertNotIn('canary',json.dumps(result))

if __name__=='__main__':unittest.main()
