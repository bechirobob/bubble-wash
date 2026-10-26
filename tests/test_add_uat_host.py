import contextlib
import hashlib
import json
import tempfile
from unittest import mock
import copy
import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('uat',ROOT/'ops/add-uat-host.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Delta(unittest.TestCase):
    def setUp(self):
        self.before={'apps':{'http':{'servers':{'srv0':{'listen':[':443'],'routes':[{'match':[{'host':['bubblewash.co']}],'handle':[{'handler':'existing'}]}]}}}}}
        self.route={'match':[{'host':[m.HOST]}],'handle':[{'handler':'subroute','routes':[{'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:3108'}]}]}]}],'terminal':True}
        self.after=copy.deepcopy(self.before);self.after['apps']['http']['servers']['srv0']['routes'].insert(0,self.route)
    def test_only_exact_new_disjoint_host_route(self):m.verify_delta(self.before,self.after)
    def test_unrelated_route_listener_tls_header_changes_refused(self):
        for key,value in [('listen',[':80']),('tls_connection_policies',[{}]),('unrelated',True)]:
            after=copy.deepcopy(self.after);after['apps']['http']['servers']['srv0'][key]=value
            with self.assertRaises(ValueError):m.verify_delta(self.before,after)
        after=copy.deepcopy(self.after);after['apps']['http']['servers']['srv0']['routes'][0]['handle'][0]['routes'][0]['handle'][0]['headers']={'request':{'set':{'Host':['bubblewash.co']}}}
        with self.assertRaises(ValueError):m.verify_delta(self.before,after)
    def test_missing_duplicate_and_wildcard_refused(self):
        with self.assertRaises(ValueError):m.verify_delta(self.before,self.before)
        self.after['apps']['http']['servers']['srv0']['routes'].append(copy.deepcopy(self.route))
        with self.assertRaises(ValueError):m.verify_delta(self.before,self.after)
        self.route['match'][0]['host']=['*.bubblewash.co']
        with self.assertRaises(ValueError):m.verify_delta(self.before,self.after)
    def test_no_application_or_database_switch(self):
        source=(ROOT/'ops/add-uat-host.py').read_text()
        for word in ('sqlite3','systemctl','app-hold','maintenance-hold','bubblewash-pilot','chmod(0o777'):
            self.assertNotIn(word,source)
class Transition(Delta):
    def setUp(self):
        super().setUp()
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.config=root/'Caddyfile';self.original=b'import unrelated/*.caddy\n';self.config.write_bytes(self.original)
        self.backup=root/'backup';self.backup.mkdir()
        self.state=copy.deepcopy(self.before);self.failure=None
        self.stack.enter_context(mock.patch.object(m,'CONFIG',self.config))
        self.jsondir=root/'json';self.jsondir.mkdir()
        self.stack.enter_context(mock.patch.object(m,'JSON_CONFIG_DIR',self.jsondir))
        self.stack.enter_context(mock.patch.object(m,'EXPECTED',hashlib.sha256(self.original).hexdigest()))
        self.stack.enter_context(mock.patch.object(m.os,'geteuid',return_value=0))
        self.stack.enter_context(mock.patch.object(m,'protected',side_effect=lambda p,*args:self.config.stat()))
        self.stack.enter_context(mock.patch.object(m.tempfile,'mkdtemp',return_value=str(self.backup)))
        self.stack.enter_context(mock.patch.object(m,'adapt',side_effect=lambda raw:self.after if raw.endswith(m.BLOCK) else self.before))
        self.stack.enter_context(mock.patch.object(m,'active',side_effect=lambda:self.state))
        def run(args,raw=None):
            if args[0]=='adapt':return json.dumps(self.after if self.config.read_bytes().endswith(m.BLOCK) else self.before).encode()
            if args[0]=='reload':
                if self.failure=='before':raise ValueError('synthetic reload refusal')
                self.state=copy.deepcopy(self.after if self.failure!='unknown' else {'unknown':'state'})
                if self.failure in ('after','unknown'):raise ValueError('synthetic acknowledgement loss')
            return b''
        self.runner=self.stack.enter_context(mock.patch.object(m,'run',side_effect=run))
    def test_verified_success_persists_source_and_recovery_copy(self):
        m.main(check_only=False);self.assertEqual(self.config.read_bytes(),self.original+m.BLOCK)
        self.assertEqual((self.backup/'Caddyfile.before').read_bytes(),self.original)
        self.assertEqual(self.state,self.after)
    def test_known_baseline_reload_failure_restores_only_pending_file(self):
        self.failure='before'
        with self.assertRaises(ValueError):m.main(check_only=False)
        self.assertEqual(self.config.read_bytes(),self.original);self.assertEqual(self.state,self.before)
    def test_lost_ack_confirmed_applied_is_not_retried(self):
        self.failure='after';m.main(check_only=False)
        self.assertEqual(sum(c.args[0][0]=='reload' for c in self.runner.call_args_list),1)
    def test_unknown_active_state_is_not_overwritten_or_retried(self):
        self.failure='unknown'
        with self.assertRaises(ValueError):m.main(check_only=False)
        self.assertEqual(self.state,{'unknown':'state'})
        self.assertEqual(sum(c.args[0][0]=='reload' for c in self.runner.call_args_list),1)
        self.assertEqual(self.config.read_bytes(),self.original+m.BLOCK)

class GroupProof(Delta):
    def setUp(self):
        super().setUp()
        self.before['apps']['http']['servers']['srv0']['routes'][0]['handle']=[{'handler':'subroute','routes':[{'group':'group0','handle':[{'handler':'a'}]},{'group':'group0','handle':[{'handler':'b'}]},{'group':'group1'}]}]
        self.after=copy.deepcopy(self.before);self.after['apps']['http']['servers']['srv0']['routes'].insert(0,self.route)
    def groups(self,config,after=True):return config['apps']['http']['servers']['srv0']['routes'][1 if after else 0]['handle'][0]['routes']
    def reject(self,after):
        with self.assertRaises(ValueError):m.verify_delta(self.before,after)
    def test_bijective_rename_preserves_occurrences_and_input(self):
        for route in self.groups(self.after):route['group']={'group0':'group2','group1':'group3'}[route['group']]
        saved=copy.deepcopy(self.after);self.assertEqual(m.verify_delta(self.before,self.after),2);self.assertEqual(self.after,saved)
    def test_bijective_swap_accepted(self):
        for route in self.groups(self.after):route['group']={'group0':'group1','group1':'group0'}[route['group']]
        self.assertEqual(m.verify_delta(self.before,self.after),2)
    def test_unrecognized_handler_routes_group_remains_exact(self):
        self.before['opaque']={'handler':'unknown','routes':[{'group':'group0'}]}
        self.after['opaque']={'handler':'unknown','routes':[{'group':'group2'}]}
        self.reject(self.after)
    def test_group_split_merge_and_unchanged_collision_refused(self):
        for names in [('group2','group3','group1'),('group2','group2','group2'),('group1','group1','group1')]:
            a=copy.deepcopy(self.after)
            for route,name in zip(self.groups(a),names):route['group']=name
            self.reject(a)
    def test_group_added_removed_custom_or_empty_refused(self):
        for value in ('custom','',None):
            a=copy.deepcopy(self.after);self.groups(a)[0]['group']=value;self.reject(a)
        a=copy.deepcopy(self.after);del self.groups(a)[0]['group'];self.reject(a)
        a=copy.deepcopy(self.after);a['apps']['http']['servers']['srv0']['routes'][1]['group']='group9';self.reject(a)
    def test_order_change_and_other_scalar_refused(self):
        a=copy.deepcopy(self.after);self.groups(a).reverse();self.reject(a)
        a=copy.deepcopy(self.after);self.groups(a)[0]['handle'][0]['handler']='different';self.reject(a)
    def test_opaque_reference_and_lookalike_group_refused(self):
        for opaque in ({'header':'group0'},{'group0':'value'},{'routes':[{'group':'group0'}]}):
            before=copy.deepcopy(self.before);before['opaque']=opaque;a=copy.deepcopy(before);a['apps']['http']['servers']['srv0']['routes'].insert(0,self.route)
            for route in self.groups(a)[:2]:route['group']='group2'
            with self.assertRaises(ValueError):m.verify_delta(before,a)
        a=copy.deepcopy(self.after);self.groups(a)[0]['handle'][0]['routes']=[{'group':'group2'}];self.reject(a)
    def test_same_generated_groups_in_another_server_register_collision(self):
        self.before['apps']['http']['servers']['srv1']={'routes':[{'group':'group2'}]};self.after['apps']['http']['servers']['srv1']={'routes':[{'group':'group2'}]}
        for route in self.groups(self.after)[:2]:route['group']='group2'
        self.reject(self.after)

class CheckOnly(Transition):
    def test_default_check_only_no_validation_backup_replace_reload(self):
        with mock.patch.object(m,'run_json') as run_json,mock.patch.object(m,'replace') as replace,mock.patch.object(m.tempfile,'mkdtemp') as backup:
            m.main()
        run_json.assert_not_called();replace.assert_not_called();backup.assert_not_called()
        self.assertEqual(self.config.read_bytes(),self.original);self.assertEqual(self.state,self.before)

class FileCompatibility(unittest.TestCase):
    def setUp(self):
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.configdir=self.root/'caddy';self.configdir.mkdir()
        self.jsondir=self.root/'json';self.jsondir.mkdir()
        self.config=self.configdir/'Caddyfile';self.config.write_bytes(b'original')
        self.stack.enter_context(mock.patch.object(m,'CONFIG',self.config))
        self.stack.enter_context(mock.patch.object(m,'JSON_CONFIG_DIR',self.jsondir))
        self.stack.enter_context(mock.patch.object(m,'protected',side_effect=lambda p,*args:p.stat()))
        self.calls=[]
    def old_cli(self,args,**kwargs):
        self.assertNotIn('-',args);self.assertIsNone(kwargs.get('input'))
        path=Path(args[args.index('--config')+1]);self.assertTrue(path.is_file())
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        raw=path.read_bytes();self.calls.append((args,path,raw))
        if args[1]=='adapt':
            self.assertEqual(path.parent,self.configdir)
            self.assertEqual(kwargs['cwd'],self.configdir)
            self.assertEqual(args[-2:],['--adapter','caddyfile'])
            output=b'{"adapted":true}'
        else:
            self.assertEqual(path.parent,self.jsondir);self.assertEqual(path.suffix,'.json')
            self.assertNotIn('--adapter',args);json.loads(raw);output=b'OK'
        return mock.Mock(returncode=0,stdout=output)
    def test_file_only_cli_all_three_commands_and_cleanup(self):
        with mock.patch.object(m.subprocess,'run',side_effect=self.old_cli):
            self.assertEqual(m.adapt(b'new input'),{'adapted':True})
            m.run_json('validate',b'{"apps":{}}');m.run_json('reload',b'{"apps":{}}')
        self.assertEqual([a[0][1] for a in self.calls],['adapt','validate','reload'])
        self.assertTrue(all(not path.exists() for _,path,_ in self.calls))
        self.assertEqual(list(self.configdir.iterdir()),[self.config]);self.assertEqual(list(self.jsondir.iterdir()),[])
        self.assertEqual(self.config.read_bytes(),b'original')
    def test_glob_self_import_refuses_and_cleans_up(self):
        self.config.write_bytes(b'import *\n')
        def self_import(args,**kwargs):
            path=Path(args[args.index('--config')+1]);self.assertIn(path,list(self.configdir.glob('*')))
            return mock.Mock(returncode=1,stdout=b'',stderr=b'private import-cycle detail')
        with mock.patch.object(m.subprocess,'run',side_effect=self_import):
            with self.assertRaises(ValueError):m.adapt(self.config.read_bytes())
        self.assertEqual(self.config.read_bytes(),b'import *\n');self.assertEqual(list(self.configdir.iterdir()),[self.config])
    def test_timeout_cleans_up_exact_json_file(self):
        with mock.patch.object(m.subprocess,'run',side_effect=m.subprocess.TimeoutExpired('caddy',30)):
            with self.assertRaises(m.subprocess.TimeoutExpired):m.run_json('reload',b'{}')
        self.assertEqual(list(self.jsondir.iterdir()),[])
    def test_no_stdin_config_callsite(self):
        source=(ROOT/'ops/add-uat-host.py').read_text()
        self.assertNotIn("'--config','-'",source)

if __name__=='__main__':unittest.main()
