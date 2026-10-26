import importlib.util
import pathlib
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('uat_capacity', ROOT/'ops/inspect-uat-capacity.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class CapacityTests(unittest.TestCase):
    def test_only_fixed_read_only_command_families(self):
        calls=[]
        def bounded(args):
            calls.append(args)
            if args[0].endswith('/ss'):
                return 'LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*\n'
            return 'LoadState=not-found\nActiveState=inactive\n'
        with patch.object(probe,'bounded',bounded):
            result=probe.inspect()
        self.assertEqual(result['tcpListening'],{'3000':True,'3001':False,'3108':False})
        self.assertFalse(result['deploymentApproved'])
        self.assertTrue(result['readOnly'])
        self.assertEqual(calls,[['/usr/bin/ss','-H','-ltn'],['/usr/bin/systemctl','show','bubblewash-uat.service','--property=LoadState,ActiveState,SubState']])
        self.assertNotIn('environment',result)
        self.assertNotIn('database',result)
    def test_unknown_listener_result_is_not_reported_free(self):
        with patch.object(probe,'bounded',lambda _:None):
            self.assertTrue(all(value is None for value in probe.inspect()['tcpListening'].values()))
    def test_no_shell_or_mutating_subprocess(self):
        source=(ROOT/'ops/inspect-uat-capacity.py').read_text()
        for forbidden in ['shell=True','write_text','write_bytes','unlink(','mkdir(','os.system','Environment=','ExecStart=']:
            self.assertNotIn(forbidden,source)

if __name__ == '__main__': unittest.main()
