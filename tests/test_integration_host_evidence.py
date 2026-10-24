"""Synthetic-only tests. No production connection, service command or DB open."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'ops/integration-release'))
import host_adapter as a
spec = importlib.util.spec_from_file_location('guard', ROOT/'ops/integration-release/vendor/bubblewash-web-a476-baseline/ops/deploy-preserving.py')
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name); self.root=root
        self.runtime=root/'runtime';self.runtime.mkdir();(self.runtime/'deploy.lock').touch()
        self.releases=root/'releases';self.releases.mkdir();self.live=self.releases/'live';self.live.mkdir()
        self.current=root/'current';self.current.symlink_to(self.live)
        self.database=root/'private-database.sqlite';self.database.write_bytes(b'not even SQLite: never opened')
        self.env=root/'env';self.env.write_text('BUBBLEWASH_DATABASE_PATH='+str(self.database)+'\nSECRET=DO_NOT_DISCLOSE\n')
        (self.runtime/'current-release').write_text('sha='+'a'*40+'\npath='+str(self.live)+'\n')
        self.calls=[]
        def run(cmd):
            self.calls.append(cmd)
            if 'busctl' in cmd and cmd[-1] == 'Conditions':
                return 'a(sbbsi) 2 "ConditionPathExists" false false "'+str(a.STATE/'installed-v1')+'" 1 "ConditionPathExists" false true "'+str(a.STATE/'app-hold')+'" 1'
            if 'busctl' in cmd:
                return 'a(sasbttttuii) 1 "/usr/bin/node" 2 "/usr/bin/node" "SECRET_ARG" false 0 0 0 0 0 0 0'
            self.assertIn('show',cmd);self.assertNotIn('list-units',cmd)
            props=dict.fromkeys(a.EVIDENCE_PROPERTIES,'')
            props.update(LoadState='loaded',ActiveState='active',SubState='running',MainPID='1',ControlPID='0',NeedDaemonReload='no',Conditions='SECRET_CONDITION')
            return '\n'.join(k+'='+v for k,v in props.items())
        self.run=run
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        for name,value in dict(RUNTIME=self.runtime,ENV=self.env,CURRENT=self.current,OLD_RELEASES=self.releases,RELEASES=root/'protected-releases',STATE=root/'state').items():
            self.stack.enter_context(patch.object(a,name,value))
        self.stack.enter_context(patch.object(a.os,'geteuid',return_value=0))
        self.stack.enter_context(patch.object(a.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())))
        for name in ('run_plan','load_controller'):
            self.stack.enter_context(patch.object(a,name,side_effect=AssertionError('forbidden release path')))
        self.stack.enter_context(patch.object(a.Host,'inventory',side_effect=AssertionError('forbidden inventory')))
        self.stack.enter_context(patch.object(a.sqlite3,'connect',side_effect=AssertionError('DB must not open')))

    def test_exact_units_no_secrets_no_mutation(self):
        before={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result=a.inspect_host_evidence(g,self.run)
        after={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before,after)
        self.assertEqual(set(result['units']),{m+'/'+u for m,u in a.EVIDENCE_UNITS})
        self.assertEqual(len(self.calls),8)
        self.assertEqual(result['units']['user/bubblewash-local.service']['loadedConditions']['gates'][1], {'name': 'app-hold', 'trigger': False, 'negate': True, 'result': 1})
        rendered=json.dumps(result)
        for secret in ('DO_NOT_DISCLOSE','SECRET_ARG','SECRET_CONDITION',str(self.database)):
            self.assertNotIn(secret,rendered)
        self.assertFalse(result['releaseAcceptance']);self.assertFalse(result['databaseOpened'])
        self.assertFalse(result['paths'][str(a.STATE)]['present'])

    def test_missing_lock_not_created(self):
        (self.runtime/'deploy.lock').unlink()
        with self.assertRaises(FileNotFoundError):a.inspect_host_evidence(g,self.run)
        self.assertFalse((self.runtime/'deploy.lock').exists());self.assertEqual(self.calls,[])

    def test_environment_symlink_refused(self):
        original=self.env.read_bytes();self.env.unlink();target=self.root/'other';target.write_bytes(original);self.env.symlink_to(target)
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)
        self.assertEqual(self.calls,[])

    def test_marker_mismatch_refused(self):
        (self.runtime/'current-release').write_text('sha='+'b'*40+'\npath=/wrong\n')
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)

    def test_writable_config_refused(self):
        self.env.chmod(0o666)
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)

    def test_database_in_release_refused(self):
        self.env.write_text('BUBBLEWASH_DATABASE_PATH='+str(self.live/'db')+'\n');(self.live/'db').touch()
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)

    def test_busy_lock_refused_without_commands(self):
        with g.deployment_lock(self.runtime,os.getuid()):
            with self.assertRaises(BlockingIOError):a.inspect_host_evidence(g,self.run)
        self.assertEqual(self.calls,[])

    def test_extra_property_refused(self):
        def run(cmd):return self.run(cmd)+'\nEnvironment=SECRET_VALUE'
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,run)

    def test_outside_unit_source_refused(self):
        def run(cmd):
            raw=self.run(cmd)
            return raw.replace('FragmentPath=','FragmentPath=/private/secret') if 'show' in cmd else raw
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,run)

    def test_sensitive_dropin_path_is_hash_only(self):
        home=self.root/'home'; source=home/'.config/systemd/user/bubblewash-local.service.d/customer-secret-token.conf'
        source.parent.mkdir(parents=True);source.write_text('[Unit]\nConditionPathExists=/safe\n')
        def run(cmd):
            raw=self.run(cmd)
            if 'show' in cmd and 'bubblewash-local.service' in cmd:
                raw=raw.replace('DropInPaths=', 'DropInPaths='+str(source))
            return raw
        with patch.object(a,'HOME',home):
            result=a.inspect_host_evidence(g,run)
        rendered=json.dumps(result)
        self.assertNotIn('customer-secret-token',rendered)
        self.assertNotIn(str(source),rendered)
        unit=result['units']['user/bubblewash-local.service']
        self.assertEqual(unit['sources'][0]['pathSha256'],a.object_digest(str(source)))
        self.assertEqual(unit['loadedConditions']['gates'][1]['name'],'app-hold')
        self.assertTrue(unit['loadedConditions']['gates'][1]['negate'])

    def test_unknown_conditions_redacted(self):
        host=types.SimpleNamespace(prefix=lambda _:[],run=lambda _: 'a(sbbsi) 1 "ConditionEnvironment" false false "SECRET_VALUE" 1')
        result=a.evidence_conditions(host,'system','bubblewash-maintenance.service')
        self.assertEqual(result['otherCount'],1);self.assertNotIn('SECRET_VALUE',json.dumps(result))

    def test_malformed_condition_refused(self):
        host=types.SimpleNamespace(prefix=lambda _:[],run=lambda _: 'a(sbbsi) 1 "ConditionPathExists" maybe false "/x" 1')
        with self.assertRaises(ValueError):a.evidence_conditions(host,'system','bubblewash-maintenance.service')

    def test_stream_no_plan_no_host_imports(self):
        command=[sys.executable,'-B',str(ROOT/'ops/integration-release/stream_host.py'),'--mode','inspect-host-evidence']
        value=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(value.returncode,0,value.stderr);compile(value.stdout,'stream','exec')
        self.assertIn('inspect_host_evidence',value.stdout)
        initialize=value.stdout.rsplit("try:\n print(json.dumps",1)[0]
        smoke=subprocess.run([sys.executable,'-I','-B','-'], input=initialize+"\nassert callable(sys.modules['host_adapter'].inspect_host_evidence)\nprint('initialized')\n",capture_output=True,text=True)
        self.assertEqual(smoke.returncode,0,smoke.stderr)
        self.assertEqual(smoke.stdout.strip(),'initialized')
        bad=subprocess.run(command+['--plan-id','a'*64],capture_output=True,text=True)
        self.assertNotEqual(bad.returncode,0)

if __name__=='__main__':unittest.main()
