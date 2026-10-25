import importlib.util
import json
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('staff_host',Path(__file__).resolve().parents[1]/'ops/inspect-staff-host.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Tests(unittest.TestCase):
    def test_only_known_hosts_and_loopback_targets_leave_host(self):
        result=m.summarise({'srv0':{'routes':[
            {'match':[{'host':['bubblewash.co','www.bubblewash.co']}], 'handle':[{'handler':'subroute','routes':[{'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:3000'}]}]}]}]},
            {'match':[{'host':['private-other.example']}], 'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'SECRET'}]}]},
            {'match':[{'host':['staff.bubblewash.co']}], 'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'PRIVATE-IP'}], 'headers':{'request':{'set':{'Authorization':['SECRET'], 'Host':['PRIVATE']}}}}]}
        ]}})
        self.assertTrue(result['staffRoutePresent']);self.assertEqual(len(result['routes']),2)
        self.assertEqual(result['routes'][0]['targets'],['127.0.0.1:3000'])
        self.assertEqual(result['routes'][1]['targets'],['OTHER'])
        self.assertTrue(result['routes'][1]['hostHeaderOverride'])
        self.assertNotIn('SECRET',json.dumps(result));self.assertNotIn('PRIVATE',json.dumps(result))
    def test_missing_staff_route_is_not_assumed(self):
        self.assertFalse(m.summarise({})['staffRoutePresent'])
    def test_reader_has_no_write_route_or_shell(self):
        source=Path(m.__file__).read_text()
        self.assertNotIn('shell=True',source);self.assertNotIn('POST',source)
        self.assertIn("['systemctl','show','caddy.service'",source)
        self.assertIn('http://127.0.0.1:2019/config/apps/http/servers',source)
    def test_persistent_simple_block_without_other_config_disclosure(self):
        props='ExecStart={ argv[]=/usr/bin/caddy run --config /etc/caddy/Caddyfile ; }\nExecReload={ argv[]=/usr/bin/caddy reload --config /etc/caddy/Caddyfile ; }'
        raw=b'private.example {\n basic_auth SECRET\n}\nbubblewash.co {\n reverse_proxy 127.0.0.1:3000\n}\n'
        result=m.persistent_summary(props,raw)
        self.assertEqual(result['status'],'simple-exact-block')
        self.assertEqual(result['upstream'],'127.0.0.1:3000');self.assertTrue(result['reloadUsesSamePath'])
        self.assertNotIn('SECRET',json.dumps(result));self.assertNotIn('private.example',json.dumps(result))
    def test_persistent_rejects_ambiguous_or_complex_block_without_disclosure(self):
        props='ExecStart=caddy run --config /etc/caddy/Caddyfile ;'
        for raw in (b'bubblewash.co {\n basic_auth SECRET\n}\n',b'bubblewash.co { reverse_proxy localhost:3000 }',b'bubblewash.co {\n reverse_proxy localhost:3000\n}\nbubblewash.co {\n reverse_proxy localhost:3000\n}'):
            result=m.persistent_summary(props,raw)
            self.assertEqual(result['status'],'non-simple-block-needs-review');self.assertNotIn('SECRET',json.dumps(result))
        self.assertEqual(m.persistent_summary('ExecStart=caddy --config /private/SECRET')['status'],'unsupported-config-source')
if __name__=='__main__':unittest.main()
