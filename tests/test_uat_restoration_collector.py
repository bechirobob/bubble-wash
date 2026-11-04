import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
p=load('uat_restore_preflight','ops/uat/restoration-preflight.py')
c=load('uat_restore_collector','ops/uat/restoration-collector.py')
fixture=load('uat_preflight_fixture','tests/test_uat_restoration_preflight.py')


def raw_properties():
    f=fixture.Service();f.setUp();values=dict(f.props,NeedDaemonReload=False)
    values['SystemCallFilter']='~connect';del values['SystemCallFilterDeny']
    values['EnvironmentFiles']=p.ENVIRONMENT+' (ignore_errors=no)'
    values['BindPaths']=p.DATA+'/cache:'+p.APP+'/.next/cache:rbind'
    result={}
    for key,value in values.items():
        result[key]=('yes' if value else 'no') if type(value) is bool else ' '.join(value) if type(value) is list else str(value)
    return result


class Serialization(unittest.TestCase):
    def test_supported_systemd_serialization(self):
        values=raw_properties();normal=c.normalize('\n'.join(k+'='+v for k,v in values.items()))
        f=fixture.Service();f.setUp();self.assertTrue(p.verify_service(normal,f.proc,1001,1001)['effectiveSandboxVerified'])
    def test_unknown_missing_ambiguous_or_reloaded_properties_fail(self):
        baseline=raw_properties()
        for key,value in [('EnvironmentFiles',p.ENVIRONMENT+' (ignore_errors=yes)'),('BindPaths','/other:/other'),('SystemCallFilter','connect'),('SystemCallErrorNumber','0'),('NeedDaemonReload','yes'),('PrivateTmp','disconnected')]:
            raw=dict(baseline,**{key:value})
            with self.subTest(key=key),self.assertRaises(ValueError):c.normalize('\n'.join(k+'='+v for k,v in raw.items()))
        raw='\n'.join(k+'='+v for k,v in baseline.items())
        with self.assertRaises(ValueError):c.normalize(raw+'\nMainPID=456')
    def test_process_stat_comm_with_spaces_is_parsed(self):
        fields=['S']+['0']*18+['999']
        with mock.patch.object(c,'read',return_value=('123 (next server with ) spaces) '+' '.join(fields)).encode()):
            self.assertEqual(c.start(123),999)


class Collector(unittest.TestCase):
    def setup_context(self,stack):
        from types import SimpleNamespace
        stack.enter_context(mock.patch.object(c.os,'geteuid',return_value=0))
        stack.enter_context(mock.patch.object(c.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1001,pw_gid=1001,pw_dir=p.DATA,pw_shell='/usr/sbin/nologin')))
        stack.enter_context(mock.patch.object(c,'show',return_value={'MainPID':123}))
        stack.enter_context(mock.patch.object(c,'process_evidence',return_value=({'pid':123},100)))
        self.trusted=stack.enter_context(mock.patch.object(c,'trusted',return_value=(1,2,1,1)))
        stack.enter_context(mock.patch.object(c.os.path,'lexists',return_value=False))
        stack.enter_context(mock.patch.object(c.os.path,'exists',return_value=False))
        stack.enter_context(mock.patch.object(c,'read',side_effect=lambda path,*args:b'btime 100\n' if str(path)=='/proc/stat' else b'synthetic'))
        stack.enter_context(mock.patch.object(c.os,'sysconf',return_value=100))
        stack.enter_context(mock.patch.object(c,'start',return_value=100))
        stack.enter_context(mock.patch.object(c,'production_inventory',return_value=['/production/app','/production/data','/production/config']))
        for name,value in [('verify_runtime',{'runtimeRevision':'a'*40}),('verify_environment',{'providerCredentialsAbsent':True}),('verify_service',{'effectiveSandboxVerified':True}),('verify_storage_isolation',{'mountBackingsIndependent':True}),('inspect_accounts',{'originalRoleCount':4})]:
            stack.enter_context(mock.patch.object(p,name,return_value=value))
    def test_private_identity_never_in_public_result(self):
        import contextlib
        with contextlib.ExitStack() as stack:
            self.setup_context(stack)
            pins={'runtimeRevision':'a'*40,'runtimeFiles':{},'unitSha256':'b'*64}
            result=c.collect(pins,private=True)
            self.assertEqual(result['private']['database'],{'device':'1','inode':'2'})
            self.assertNotIn('database',result['public'])
            self.assertEqual(c.collect(pins),result['public'])
    def test_changed_inode_or_recent_config_refused(self):
        import contextlib
        for recent in (False,True):
            with self.subTest(recent=recent),contextlib.ExitStack() as stack:
                self.setup_context(stack);seen=0
                def trusted(path,*args,**kwargs):
                    nonlocal seen
                    if str(path)==p.DATABASE:
                        seen+=1
                        return (1,2 if seen==1 or recent else 3,1,1)
                    return (1,2,1000000000000 if recent else 1,1)
                self.trusted.side_effect=trusted
                with self.assertRaises(ValueError):c.collect({'runtimeRevision':'a'*40,'runtimeFiles':{},'unitSha256':'b'*64})
    def test_timestamp_failure_stops_before_config_contents_or_accounts(self):
        import contextlib
        with contextlib.ExitStack() as stack:
            self.setup_context(stack)
            self.trusted.return_value=(1,2,1000000000000,1)
            with self.assertRaises(c.p.TimestampGuardFailure):
                c.collect({'runtimeRevision':'a'*40,'runtimeFiles':{},'unitSha256':'b'*64})
            c.production_inventory.assert_not_called()
            p.verify_runtime.assert_not_called()
            p.verify_environment.assert_not_called()
            p.inspect_accounts.assert_not_called()

    def test_environment_diagnostic_is_inspect_only_and_never_admits_failure(self):
        import contextlib
        for diagnostic in (False,True):
            with self.subTest(diagnostic=diagnostic),contextlib.ExitStack() as stack:
                self.setup_context(stack)
                self.trusted.side_effect=lambda path,*args,**kwargs:(1,2,1000000000000,1) if str(path)==p.ENVIRONMENT else (1,2,1,1)
                evidence=stack.enter_context(mock.patch.object(c,'environment_timestamp_evidence',return_value={'state':'unavailable'}))
                with self.assertRaises(c.p.TimestampGuardFailure) as captured:
                    c.collect({'runtimeRevision':'a'*40,'runtimeFiles':{},'unitSha256':'b'*64},timestamp_diagnostic=diagnostic)
                self.assertEqual(evidence.call_count,int(diagnostic))
                self.assertEqual(hasattr(captured.exception,'environment_evidence'),diagnostic)
                c.production_inventory.assert_not_called();p.verify_runtime.assert_not_called()
                self.assertEqual(p.verify_environment.call_count,int(diagnostic));p.inspect_accounts.assert_not_called()


if __name__=='__main__':unittest.main()
