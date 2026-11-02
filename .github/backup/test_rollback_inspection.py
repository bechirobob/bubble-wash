"""Local fixtures only; never execute the host inspector against production."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preflight_rollback', Path(__file__).resolve().parents[2] / 'scripts/release-preflight.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
exec(compile((Path(__file__).resolve().parents[2] / "scripts/release-rollback-inspection.py").read_text(), "release-rollback-inspection.py", "exec"), m.__dict__)


class RollbackInspectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.sha = 'a' * 40
        self.root = self.home / 'releases'; self.target = self.root / self.sha
        self.target.mkdir(parents=True)
        self.current = self.home / 'current'; self.current.symlink_to(self.target)
        self.env = self.home / 'env'; self.env.write_text('BUBBLEWASH_UAT_ENABLED=false\nSECRET=DO_NOT_PRINT\n')
        self.marker = self.home / 'bubblewash-runtime/current-release'; self.marker.parent.mkdir()
        self.marker.write_text(f'sha={self.sha}\npath={self.target}\n')
        for name in m.ROLLBACK_FILES:
            path = self.target / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(self.sha if name == '.release-sha' else 'build-fixture')
        self.proc = self.home / 'proc'
        for pid in (100, 101):
            base = self.proc / str(pid); base.mkdir(parents=True)
            (base/'cwd').symlink_to(self.target); (base/'exe').symlink_to(self.home/'node')
            (base/'stat').write_text(f'{pid} (node) S ' + ' '.join(['1']*30))
            (base/'cgroup').write_text('0::/service')
            (base/'environ').write_bytes(b'BUBBLEWASH_UAT_ENABLED=false\0SECRET=DO_NOT_PRINT\0')
        for name, value in [('HOME',self.home),('ROLLBACK_ROOT',self.root),('CURRENT',self.current),('ENV_FILE',self.env),('PROC',self.proc)]:
            p = patch.object(m,name,value); p.start(); self.addCleanup(p.stop)
        self.properties=f'LoadState=loaded\nActiveState=active\nMainPID=100\nWorkingDirectory={self.current}\nEnvironmentFiles={self.env} (ignore_errors=no)'
        p=patch.object(m,'command',side_effect=lambda args: 'users:(("node",pid=101,fd=3))' if args[0]=='ss' else self.properties)
        self.command=p.start(); self.addCleanup(p.stop)
        p=patch.object(m.pwd,'getpwnam',return_value=type('P',(),{'pw_uid':1000})()); p.start(); self.addCleanup(p.stop)

    def inspect(self, sha=None, target=None):
        return m.rollback_inspection(sha or self.sha, target or str(self.target))

    def failed(self, result):
        self.assertEqual(result, {'readOnly':True,'inspectionFailed':True})

    def test_exact_hashes_and_only_named_classifications(self):
        result=self.inspect(); self.assertFalse(result['inspectionFailed'])
        self.assertEqual(result['uat']['configured'],'false')
        self.assertTrue(result['uat']['exactValuesMatch'])
        self.assertEqual(set(result['rollbackRelease']['files']),set(m.ROLLBACK_FILES))
        self.assertEqual(result['rollbackRelease']['files']['.release-sha']['sha256'],hashlib.sha256(self.sha.encode()).hexdigest())
        self.assertNotIn('DO_NOT_PRINT',json.dumps(result)); self.assertNotIn('SECRET',json.dumps(result))
        self.assertFalse(result['rollbackRelease']['fullTreeVerified'])

    def test_absent_true_and_unknown_are_not_conflated(self):
        for raw, expected in [(b'', 'absent'), (b'BUBBLEWASH_UAT_ENABLED=true\0','true'), (b'BUBBLEWASH_UAT_ENABLED=DO_NOT_PRINT\0','other')]:
            (self.proc/'101/environ').write_bytes(raw)
            result=self.inspect(); self.assertEqual(result['uat']['listener'],expected)
            self.assertFalse(result['uat']['exactValuesMatch']); self.assertNotIn('DO_NOT_PRINT',json.dumps(result))

    def test_invalid_pin_and_paths_fail_before_commands(self):
        for sha,path in [('b'*40,str(self.target)),('bad',str(self.target)),(self.sha,str(self.target)+'/../'+self.sha),(self.sha,'/etc')]:
            self.failed(self.inspect(sha,path))
        self.command.assert_not_called()

    def test_marker_mismatch(self):
        self.marker.write_text(f'sha={"b"*40}\npath={self.target}\n'); self.failed(self.inspect())

    def test_release_marker_mismatch(self):
        (self.target/'.release-sha').write_text('b'*40); self.failed(self.inspect())

    def test_symlink_file_rejected(self):
        path=self.target/'package.json'; path.unlink(); path.symlink_to(self.env); self.failed(self.inspect())

    def test_symlink_ancestor_rejected(self):
        modules=self.target/'node_modules'; modules.rename(self.home/'modules'); modules.symlink_to(self.home/'modules'); self.failed(self.inspect())

    def test_missing_binary_and_duplicate_flag_rejected(self):
        (self.proc/'101/environ').write_bytes(b'BUBBLEWASH_UAT_ENABLED=false\0BUBBLEWASH_UAT_ENABLED=false\0')
        self.failed(self.inspect())
        (self.target/'node_modules/next/dist/bin/next').unlink(); self.failed(self.inspect())

    def test_wrong_service_binding(self):
        (self.proc/'101/cgroup').write_text('0::/other'); self.failed(self.inspect())

    def test_unstable_files_fail(self):
        original=m.retained_read; counts={}
        def read(fd,name,limit):
            raw=original(fd,name,limit); counts[name]=counts.get(name,0)+1
            return raw+b'changed' if name=='package.json' and counts[name]>1 else raw
        with patch.object(m,'retained_read',side_effect=read): self.failed(self.inspect())

    def test_no_write_database_network_or_unexpected_command(self):
        original=os.open
        def guarded(path,flags,*args,**kwargs):
            self.assertFalse(flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND))
            return original(path,flags,*args,**kwargs)
        with patch.object(m.os,'open',side_effect=guarded), patch.object(m.sqlite3,'connect',side_effect=AssertionError), patch.object(Path,'write_text',side_effect=AssertionError), patch.object(Path,'write_bytes',side_effect=AssertionError):
            self.assertFalse(self.inspect()['inspectionFailed'])
        self.assertEqual([c.args[0][0] for c in self.command.call_args_list],['runuser','ss'])
        self.assertIn('show',self.command.call_args_list[0].args[0])

    def test_stream_pins_and_no_aggregate_invocation(self):
        spec = importlib.util.spec_from_file_location('stream', Path(__file__).with_name('stream_rollback_preflight.py'))
        stream = importlib.util.module_from_spec(spec); spec.loader.exec_module(stream)
        path = '/var/lib/bubblewash-release/releases/' + self.sha
        source = stream.stream(self.sha, path)
        compile(source, '<inspection-stream>', 'exec')
        self.assertTrue(source.startswith("__name__ = 'pinned_rollback_preflight'"))
        self.assertIn(f"_result = rollback_inspection({self.sha!r}, {path!r})", source)
        for sha, invalid in [('bad', path), (self.sha, path+'/../escape'), (self.sha, '/etc'), (self.sha, path+"';write()")]:
            with self.assertRaises(ValueError): stream.stream(sha, invalid)

    def test_changed_runtime_environment_fails_closed(self):
        original = m.bounded_bytes; count = 0
        def read(path, limit):
            nonlocal count
            raw = original(path,limit)
            if path == self.proc/'101/environ':
                count += 1
                if count > 1: return b'BUBBLEWASH_UAT_ENABLED=true\0'
            return raw
        with patch.object(m,'bounded_bytes',side_effect=read): self.failed(self.inspect())

if __name__ == '__main__': unittest.main()
