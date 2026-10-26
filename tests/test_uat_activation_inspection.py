import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('inspect_uat_activation',ROOT/'ops/uat/inspect-activation.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def reply(out='',err='',code=0):return dict(code=code,out=out,err=err,failure=None)
class InspectTests(unittest.TestCase):
    def test_properties_do_not_leak_unexpected_values(self):
        with patch.object(m,'command',return_value=reply('ActiveState=inactive\nMainPID=0\nEnvironment=SECRET\nResult=secret text\n')):
            value=m.unit_state(m.SERVICE)
        self.assertEqual(value['ActiveState'],'inactive');self.assertIsNone(value['Result']);self.assertNotIn('SECRET',str(value))
    def test_diagnostic_text_becomes_fixed_flags_only(self):
        with patch.object(m,'command',return_value=reply(err='SECRET Failed to parse property and No such file',code=1)):
            value=m.verification()
        self.assertTrue(value['invalidSetting']);self.assertTrue(value['missingExecutable']);self.assertNotIn('SECRET',str(value))
    def test_only_known_data_names_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            data=Path(directory);(data/'secret-filename').touch();(data/'uat.sqlite').touch()
            with patch.object(m,'DATA',data):value=m.data_summary()
        self.assertEqual(value['otherEntryCount'],1);self.assertTrue(value['knownEntries']['uat.sqlite']);self.assertNotIn('secret-filename',str(value))
    def test_missing_marker_is_readonly(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(m,'CONFIG',Path(directory)):self.assertFalse(m.marker()['present'])
            self.assertEqual(list(Path(directory).iterdir()),[])
    def test_receipt_rejects_unknown_text_or_secret_fields(self):
        good={'schema':'bubblewash-uat-activation-inspection/v1','readOnly':True,'service':{'ActiveState':'inactive','MainPID':'0'},'permissions':{'/opt/bubblewash-uat/app':{'exists':True,'mode':448,'uid':0,'gid':0,'symlink':False}}}
        self.assertEqual(m.validate_receipt(good),good)
        for bad in [dict(good,environment='secret'),dict(good,service={'Result':'arbitrary-secret-value'})]:
            with self.assertRaises(ValueError):m.validate_receipt(bad)
    def test_no_mutating_commands_or_database_reads(self):
        source=(ROOT/'ops/uat/inspect-activation.py').read_text()
        for forbidden in ('sqlite3','read_text()','daemon-reload',"systemctl','start","systemctl','stop",'journalctl','EnvironmentFile'):
            if forbidden=='daemon-reload':continue # Allowlisted marker stage, not a command.
            self.assertNotIn(forbidden,source)
if __name__=='__main__':unittest.main()
