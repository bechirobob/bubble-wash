import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('fixed_outcome',ROOT/'ops/inspect-backup-schema-outcome.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)

class Metadata(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name);self.scratch=self.root/host.SCRATCH_NAME
        self.enterContext(mock.patch.object(host,'RUN_ROOT',self.root))
        real_stat=os.stat;real_fstat=os.fstat
        def root_owned(info):
            # Synthetic host-root ownership only; actual nofollow traversal,
            # metadata values, inode races and content-access prohibition remain.
            fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns','st_atime_ns')
            return types.SimpleNamespace(**{k:0 if k=='st_uid' else getattr(info,k) for k in fields})
        self.enterContext(mock.patch.object(host.os,'stat',side_effect=lambda *a,**k:root_owned(real_stat(*a,**k))))
        self.enterContext(mock.patch.object(host.os,'fstat',side_effect=lambda *a,**k:root_owned(real_fstat(*a,**k))))
        self.enterContext(mock.patch('builtins.open',side_effect=AssertionError('file content open forbidden')))
        self.enterContext(mock.patch.object(host.os,'read',side_effect=AssertionError('content read forbidden')))
        self.enterContext(mock.patch.object(host.os,'listdir',side_effect=AssertionError('directory enumeration forbidden')))

    def test_absence_does_not_prove_historical_cleanup(self):
        result=host.inspect_fixed_scratch()
        self.assertEqual(result['scratch'],{'exists':False})
        self.assertFalse(result['historicalCleanupProven'])

    def test_present_files_report_metadata_only(self):
        self.scratch.mkdir(mode=0o700)
        path=self.scratch/'snapshot.sqlite';path.write_bytes(b'SYNTHETIC PRIVATE CONTENT');path.chmod(0o600)
        result=host.inspect_fixed_scratch()
        self.assertEqual(result['observation'],'present-metadata-only')
        self.assertEqual(result['files']['snapshot.sqlite']['size'],25)
        self.assertNotIn('SYNTHETIC',json.dumps(result))
        self.assertFalse(result['directoryEmptyVerified'])
        self.assertEqual(set(result['files']),set(host.NAMES))
        self.assertTrue(path.exists())

    def test_scratch_symlink_is_not_followed(self):
        elsewhere=self.root/'elsewhere';elsewhere.mkdir();self.scratch.symlink_to(elsewhere)
        result=host.inspect_fixed_scratch()
        self.assertEqual(result['observation'],'present-unsafe-not-traversed')
        self.assertEqual(result['scratch']['type'],'symlink')
        self.assertNotIn('files',result)

    def test_child_symlink_metadata_not_target(self):
        self.scratch.mkdir(mode=0o700)
        (self.scratch/'snapshot.sqlite').symlink_to('/nonexistent-private-target')
        result=host.inspect_fixed_scratch()
        self.assertEqual(result['files']['snapshot.sqlite']['type'],'symlink')
        self.assertNotIn('nonexistent-private-target',json.dumps(result))

    def test_unknown_entries_are_never_enumerated(self):
        self.scratch.mkdir(mode=0o700);(self.scratch/'unrecognized-private-name').touch()
        result=host.inspect_fixed_scratch()
        self.assertTrue(result['knownPathsOnly']);self.assertFalse(result['directoryEmptyVerified'])
        self.assertNotIn('unrecognized-private-name',json.dumps(result))

    def test_directory_swap_refuses_before_traversal(self):
        self.scratch.mkdir(mode=0o700);elsewhere=self.root/'elsewhere';elsewhere.mkdir()
        real_open=os.open
        def swap(name,flags,*args,**kwargs):
            if name==host.SCRATCH_NAME:
                self.scratch.rename(self.root/'old');self.scratch.symlink_to(elsewhere)
            return real_open(name,flags,*args,**kwargs)
        with mock.patch.object(host.os,'open',side_effect=swap),self.assertRaises(OSError):host.inspect_fixed_scratch()

class Contract(unittest.TestCase):
    def test_context_is_exact_first_attempt(self):
        context={'controlSha':'a'*40,'runId':'1','runAttempt':'1'};host.validate(context)
        for change in ({'path':'/etc/passwd'},{'runId':host.FAILED_RUN},{'runAttempt':'2'}):
            with self.assertRaises(ValueError):host.validate({**context,**change})

    def test_workflow_modes_are_mutually_exclusive(self):
        text=(ROOT/'.github/workflows/backup-schema-attestation.yml').read_text()
        self.assertIn("&& !inputs.inspect_outcome &&",text)
        self.assertIn("&& inputs.inspect_outcome &&",text)
        self.assertNotIn('BACKUP_STORE_TOKEN',text[text.index('  outcome:'):])
        self.assertNotIn('stream-backup-schema.py',text[text.index('  outcome:'):])

    def test_failure_preserves_uncertainty_without_exception_text(self):
        output=io.StringIO()
        with mock.patch.object(host,'inspect',side_effect=ValueError('private')),contextlib.redirect_stdout(output),self.assertRaises(SystemExit):host.main({})
        self.assertNotIn('private',output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['cleanupStatus'],'unknown')

    def test_launcher_refuses_wrong_mode_target_and_dependency(self):
        spec=importlib.util.spec_from_file_location('outcome_stream',ROOT/'ops/stream-backup-schema-outcome.py')
        stream=importlib.util.module_from_spec(spec);spec.loader.exec_module(stream)
        env={**stream.FAILED_INPUTS,'INSPECT_OUTCOME':'true','GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','SOURCE_SHA':'a'*40,'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'3','GITHUB_RUN_ATTEMPT':'1'}
        with mock.patch.object(stream.subprocess,'check_output',side_effect=['a'*40,b'']):compile(stream.prepare(env),'fixed-source','exec')
        with self.assertRaises(ValueError):stream.prepare({**env,'INSPECT_OUTCOME':'false'})
        with self.assertRaises(ValueError):stream.prepare({**env,'RECEIPT_RUN':'9'})
        with mock.patch.object(stream,'CORE_SHA256','0'*64),mock.patch.object(stream.subprocess,'check_output',side_effect=['a'*40,b'']),self.assertRaises(ValueError):stream.prepare(env)

if __name__=='__main__':unittest.main()
