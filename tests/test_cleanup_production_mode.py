"""Config omission is permitted only alongside the unchanged real runtime guard."""
import contextlib
from pathlib import Path
import types
import unittest
from unittest import mock
from test_cleanup_backup_identity import helper
from test_exact_cleanup_host import m as wrapper, Fake, Core, F
import test_test_data_cleanup_core as core_tests
cleanup=core_tests.m

class ProductionModeTests(unittest.TestCase):
    def fixture(self):
        fixture=core_tests.CleanupTests();self.addCleanup(fixture.doCleanups)
        return fixture.fixture()[1]
    @contextlib.contextmanager
    def runtime(self,mode):
        target=Path('/synthetic-release')
        props=f'LoadState=loaded\nActiveState=active\nMainPID=10\nWorkingDirectory={target}\nEnvironmentFiles={helper.ENV} (ignore_errors=no)\n'
        values={'BUBBLEWASH_DISABLE_DEMO_LOGIN':'true'}
        effective=dict(values)
        if mode is not None:effective['NODE_ENV']=mode
        raw=b'\0'.join((k+'='+v).encode() for k,v in effective.items())
        original=Path.resolve
        def resolve(path,*a,**kw):
            if str(path) in ('/proc/10/cwd','/proc/11/cwd'):return target
            return original(path,*a,**kw)
        def read(path):
            if str(path) in ('/proc/10/environ','/proc/11/environ'):return raw
            if str(path) in ('/proc/10/cgroup','/proc/11/cgroup'):return b'synthetic-unit'
            raise AssertionError('Unexpected path')
        with mock.patch.object(helper,'ctl',return_value=props),mock.patch.object(helper,'network_command',return_value='pid=11'),mock.patch.object(helper,'command',return_value='pid=11'),mock.patch.object(helper,'health'),mock.patch.object(helper,'public_health'),mock.patch.object(Path,'resolve',resolve),mock.patch.object(Path,'read_bytes',read):
            yield target,values
    def effective(self,mode):
        with self.runtime(mode) as (target,values):
            host=object.__new__(wrapper.Host);host.core=helper;host.current=target
            host.cleanup=types.SimpleNamespace(REMOVE_KEYS=set())
            host.effective(values)
    def test_absent_file_setting_preserves_absence_and_actual_production_passes(self):
        raw=self.fixture().replace(b'NODE_ENV=production\n',b'')
        values,replacement=cleanup.config(raw)
        self.assertNotIn('NODE_ENV',values);self.assertNotIn(b'NODE_ENV',replacement)
        self.effective('production')
    def test_absent_file_setting_does_not_allow_missing_or_nonproduction_runtime(self):
        cleanup.config(self.fixture().replace(b'NODE_ENV=production\n',b''))
        for mode in (None,'','development','test'):
            with self.subTest(mode=mode),self.assertRaisesRegex(ValueError,'unsafe effective production mode'):self.effective(mode)
    def test_explicit_nonproduction_file_refused_even_if_process_is_production(self):
        for mode in (b'',b'development',b'test'):
            with self.subTest(mode=mode),self.assertRaises(cleanup.Refused):
                cleanup.config(self.fixture().replace(b'NODE_ENV=production',b'NODE_ENV='+mode))
        self.effective('production')
    def test_runtime_refusal_prevents_plan_hold_stop_and_mutation(self):
        host=Fake()
        def preflight():
            host.events.append('preflight');self.effective('development');return host.raw
        host.preflight=preflight
        with self.assertRaisesRegex(ValueError,'unsafe effective production mode'):
            wrapper.run_cleanup(host,Core(),F,'EXACT',True)
        self.assertEqual(host.events,['lock','preflight'])

if __name__=='__main__':unittest.main()
