import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('preflight', Path(__file__).resolve().parents[2] / 'scripts/release-preflight.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name); self.current = self.home / 'current'; self.proc = self.home / 'proc'; self.env = self.home / 'env'
        (self.home / 'bubblewash-runtime').mkdir()
        self.sha = 'a' * 40
        (self.home / 'bubblewash-runtime/current-release').write_text(f'sha={self.sha}\npath={self.current}\n')
        for name in m.RESTORE_FILES:
            path = self.current / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('fixture-build' if name == '.next/BUILD_ID' else 'reviewable source')
        self.flags = {'BUBBLEWASH_STAFF_AUTH_DISABLED':'true', 'BUBBLEWASH_BOOKINGS_DISABLED':'false'}
        for pid in (100, 101):
            folder = self.proc / str(pid); folder.mkdir(parents=True)
            (folder / 'cwd').symlink_to(self.current); (folder / 'exe').symlink_to(self.home / 'node')
            (folder / 'cgroup').write_text('0::/service')
            (folder / 'stat').write_text(f'{pid} (node) S ' + ' '.join(['1'] * 30))
            (folder / 'environ').write_bytes(b'\0'.join(f'{k}={v}'.encode() for k,v in {**self.flags,'NODE_ENV':'production','SECRET':'DO_NOT_PRINT','BUBBLEWASH_ADMIN_EMAIL':'DO_NOT_PRINT@example.test'}.items()))
        for name,value in [('HOME',self.home),('CURRENT',self.current),('PROC',self.proc),('ENV_FILE',self.env)]:
            context=patch.object(m,name,value); context.start(); self.addCleanup(context.stop)
        self.properties=f'LoadState=loaded\nActiveState=active\nMainPID=100\nWorkingDirectory={self.current}\nEnvironmentFiles={self.env} (ignore_errors=no)'
        self.command = patch.object(m,'command',side_effect=lambda args: 'users:(("node",pid=101,fd=3))' if args[0]=='ss' else self.properties).start(); self.addCleanup(patch.stopall)
        patch.object(m.pwd,'getpwnam',return_value=type('P',(),{'pw_uid':1000})()).start()
    def inspect(self): return m.release_login_inspection(self.flags)
    def test_complete_report_and_runtime_not_config_mode(self):
        result=self.inspect()
        self.assertEqual(result['releaseMarker']['sha'],self.sha)
        self.assertEqual(result['buildId'],'fixture-build')
        self.assertEqual(len(result['restorationSourceFingerprint']),64)
        self.assertTrue(all(result['sourceFileSha256'].values()))
        self.assertFalse(result['configuredFlags']['productionMode'])
        self.assertTrue(result['runtime']['listenerFlags']['productionMode'])
        self.assertTrue(result['runtime']['listenerSameServiceCgroup'])
        self.assertTrue(result['runtime']['listenerStableDuringRead'])
        self.assertFalse(result['sourceToBuildProven'])
    def test_no_secrets_identities_or_private_paths_output(self):
        rendered=json.dumps(self.inspect())
        for forbidden in ('DO_NOT_PRINT','@example.test',str(self.home),'SECRET'):
            self.assertNotIn(forbidden,rendered)
    def test_no_writes_and_no_http_commands(self):
        with patch.object(Path,'write_bytes',side_effect=AssertionError),patch.object(Path,'write_text',side_effect=AssertionError): self.inspect()
        for call in self.command.call_args_list: self.assertIn(call.args[0][0],('runuser','ss'))
    def test_missing_marker_does_not_hide_runtime(self):
        (self.home/'bubblewash-runtime/current-release').unlink()
        result=self.inspect(); self.assertFalse(result['releaseMarker']['inspectionSupported']); self.assertTrue(result['runtime']['serviceActive'])
    def test_invalid_sha_not_printed(self):
        (self.home/'bubblewash-runtime/current-release').write_text('sha=DO_NOT_PRINT\npath=/wrong\n')
        result=self.inspect(); self.assertFalse(result['releaseMarker']['shaValid']); self.assertNotIn('sha',result['releaseMarker'])
    def test_missing_source_no_combined_hash(self):
        (self.current/m.RESTORE_FILES[0]).unlink()
        self.assertNotIn('restorationSourceFingerprint',self.inspect())
    def test_wrong_cgroup_flagged(self):
        (self.proc/'101/cgroup').write_text('0::/other')
        self.assertFalse(self.inspect()['runtime']['listenerSameServiceCgroup'])
    def test_missing_listener_is_not_runtime_proof(self):
        self.command.side_effect=lambda args: '' if args[0]=='ss' else self.properties
        result=self.inspect(); self.assertFalse(result['runtime']['uniqueListener']); self.assertNotIn('listenerFlags',result['runtime'])
    def test_unsupported_flag_is_not_echoed(self):
        self.flags['BUBBLEWASH_BOOKINGS_DISABLED']='DO_NOT_PRINT'
        result=self.inspect(); self.assertEqual(result['configuredFlags']['BUBBLEWASH_BOOKINGS_DISABLED'],'other'); self.assertNotIn('DO_NOT_PRINT',json.dumps(result))
    def test_process_identity_ignores_counter_changes(self):
        path=self.proc/'100/stat'; before=m.process_identity(100); parts=path.read_text().split();parts[-1]='999';path.write_text(' '.join(parts));self.assertEqual(m.process_identity(100),before)

if __name__ == '__main__': unittest.main()
