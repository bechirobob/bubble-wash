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
s=importlib.util.spec_from_file_location('staff',ROOT/'ops/add-staff-host.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Delta(unittest.TestCase):
    def setUp(self):
        self.before={'apps':{'http':{'servers':{'srv0':{'listen':[':443'],'routes':[{'match':[{'host':['bubblewash.co']}],'handle':[{'handler':'existing'}]}]}}}}}
        self.route={'match':[{'host':[m.HOST]}],'handle':[{'handler':'subroute','routes':[{'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:3000'}]}]}]}],'terminal':True}
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
        source=(ROOT/'ops/add-staff-host.py').read_text()
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
        m.main();self.assertEqual(self.config.read_bytes(),self.original+m.BLOCK)
        self.assertEqual((self.backup/'Caddyfile.before').read_bytes(),self.original)
        self.assertEqual(self.state,self.after)
    def test_known_baseline_reload_failure_restores_only_pending_file(self):
        self.failure='before'
        with self.assertRaises(ValueError):m.main()
        self.assertEqual(self.config.read_bytes(),self.original);self.assertEqual(self.state,self.before)
    def test_lost_ack_confirmed_applied_is_not_retried(self):
        self.failure='after';m.main()
        self.assertEqual(sum(c.args[0][0]=='reload' for c in self.runner.call_args_list),1)
    def test_unknown_active_state_is_not_overwritten_or_retried(self):
        self.failure='unknown'
        with self.assertRaises(ValueError):m.main()
        self.assertEqual(self.state,{'unknown':'state'})
        self.assertEqual(sum(c.args[0][0]=='reload' for c in self.runner.call_args_list),1)
        self.assertEqual(self.config.read_bytes(),self.original+m.BLOCK)
if __name__=='__main__':unittest.main()
