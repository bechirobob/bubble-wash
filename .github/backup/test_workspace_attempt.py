"""Synthetic, fixed-path failed-attempt diagnosis; no real host data."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('attempt',ROOT/'scripts/release-preflight.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
exec(compile((ROOT/'scripts/inspect-workspace-attempt.py').read_text(),'attempt-inspection','exec'),m.__dict__)


class AttemptTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.candidate=self.root/'candidate';self.candidate.mkdir()
        (self.candidate/'src').mkdir();(self.candidate/'src/app.ts').write_text('approved source')
        (self.candidate/'package.json').write_text('{}')
        (self.candidate/'.release-sha').write_text(m.ATTEMPT_SHA+'\n')
        self.expected={name:m.hashlib.sha256((self.candidate/name).read_bytes()).hexdigest() for name in ('src/app.ts','package.json')}
        for name,value in [('ATTEMPT_DIR',self.candidate),('ATTEMPT_FROZEN',self.root/'frozen'),('ATTEMPT_EVIDENCE',self.root/'evidence'),('ATTEMPT_CONTENT',m.attempt_commitment(self.expected))]:
            context=patch.object(m,name,value);context.start();self.addCleanup(context.stop)
        context=patch.object(m,'command',return_value='LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success')
        self.command=context.start();self.addCleanup(context.stop)

    def inspect(self):return m.inspect_workspace_attempt(self.expected)

    def test_exact_source_and_honest_missing_transaction_metadata(self):
        result=self.inspect();self.assertFalse(result['inspectionFailed']);self.assertTrue(result['sourceInventoryMatches'])
        self.assertEqual(result['frozenRelease']['directory'],'missing')
        self.assertFalse(result['switchHistoryProven']);self.assertTrue(result['missingUnitsDoNotProveNeverRan'])

    def test_generated_next_config_reports_root_violation_without_contents(self):
        folder=self.candidate/'.config/nextjs-nodejs';folder.mkdir(parents=True);(folder/'SECRET').write_text('DO_NOT_PRINT')
        result=self.inspect();self.assertFalse(result['sourceInventoryMatches'])
        self.assertEqual(result['unexpectedSourceEntries'],[{'path':'.config','kind':'directory'}])
        self.assertEqual(result['nextConfig']['entries']['nextjs-nodejs'],'directory')
        self.assertNotIn('SECRET',json.dumps(result));self.assertNotIn('DO_NOT_PRINT',json.dumps(result))

    def test_changed_tracked_content_outputs_hash_only(self):
        (self.candidate/'src/app.ts').write_text('PRIVATE CONTENT')
        result=self.inspect();row=result['trackedSourceMismatches'][0]
        self.assertEqual(row['path'],'src/app.ts');self.assertEqual(len(row['actualSha256']),64)
        self.assertNotIn('PRIVATE CONTENT',json.dumps(result))

    def test_unknown_source_names_and_contents_are_not_disclosed(self):
        (self.candidate/'src/private-person@example.test').write_text('DO_NOT_READ')
        result=self.inspect();self.assertFalse(result['sourceInventoryMatches'])
        self.assertIn('pathSha256',result['unexpectedSourceEntries'][0])
        self.assertNotIn('private-person',json.dumps(result));self.assertNotIn('DO_NOT_READ',json.dumps(result))

    def test_bad_source_map_or_candidate_pin_fails_before_unit_commands(self):
        self.expected['package.json']='0'*64
        self.assertTrue(self.inspect()['inspectionFailed']);self.command.assert_not_called()
        self.expected['package.json']=m.hashlib.sha256(b'{}').hexdigest()
        (self.candidate/'.release-sha').write_text('b'*40)
        self.assertTrue(self.inspect()['inspectionFailed']);self.command.assert_not_called()

    def test_symlink_source_is_not_followed(self):
        path=self.candidate/'src/app.ts';path.unlink();path.symlink_to(self.root/'secret')
        (self.root/'secret').write_text('DO_NOT_PRINT')
        result=self.inspect();self.assertEqual(result['trackedSourceMismatches'][0]['classification'],'symlink')
        self.assertNotIn('DO_NOT_PRINT',json.dumps(result))

    def test_symlink_candidate_and_config_ancestor_fail_closed(self):
        actual=self.root/'actual';self.candidate.rename(actual);self.candidate.symlink_to(actual)
        self.assertTrue(self.inspect()['inspectionFailed'])
        self.candidate.unlink();actual.rename(self.candidate)
        (self.candidate/'.config').symlink_to(self.root/'secret')
        result=self.inspect();self.assertEqual(result['nextConfig']['directory'],'unavailable-or-unsafe')

    def test_observed_changes_fail_closed(self):
        original=m.attempt_snapshot;calls=0
        def snapshot(*args):
            nonlocal calls
            result,identity=original(*args);calls+=1
            return result,identity if calls==1 else 'changed'
        with patch.object(m,'attempt_snapshot',side_effect=snapshot):self.assertTrue(self.inspect()['inspectionFailed'])

    def test_reads_only_no_database_or_arbitrary_command(self):
        original=os.open
        def checked(path,flags,*args,**kwargs):
            self.assertFalse(flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND))
            return original(path,flags,*args,**kwargs)
        with patch.object(m.os,'open',side_effect=checked),patch.object(m.sqlite3,'connect',side_effect=AssertionError),patch.object(Path,'write_text',side_effect=AssertionError),patch.object(Path,'write_bytes',side_effect=AssertionError):
            self.assertFalse(self.inspect()['inspectionFailed'])
        self.assertEqual(len(self.command.call_args_list),3)
        for call in self.command.call_args_list:
            self.assertEqual(call.args[0][:2],['systemctl','show'])
            self.assertTrue(call.args[0][2].startswith(m.ATTEMPT_UNIT))
            self.assertEqual(call.args[0][-1],'--property=LoadState,ActiveState,SubState,Result')

    def test_excessive_inventory_fails_with_bounded_output(self):
        for index in range(129): (self.candidate/('extra-'+str(index))).touch()
        result=self.inspect();self.assertTrue(result['inspectionFailed'])
        self.assertLess(len(json.dumps(result)),512)

    def test_fixed_workflow_inputs_and_runtime_checkout_after_tests(self):
        workflow=(ROOT/'.github/workflows/release-preflight.yml').read_text()
        self.assertIn('inspect_workspace_attempt:',workflow)
        self.assertIn('ref: '+m.ATTEMPT_SHA,workflow)
        self.assertLess(workflow.index('run: python3 -B -m unittest'),workflow.index('path: inspection-runtime'))
        self.assertIn('stream_workspace_attempt.py | tailscale',workflow)
        self.assertNotIn('stream_workspace_attempt.py ${{',workflow)

class StreamTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('stream_attempt',ROOT/'.github/backup/stream_workspace_attempt.py')
        self.stream=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.stream)

    def test_wrong_commit_or_tree_refused_before_archive(self):
        import subprocess
        for values in ([b'wrong'],[(self.stream.RUNTIME+'\n').encode(),b'wrong']):
            results=[subprocess.CompletedProcess([],0,stdout=value) for value in values]
            with patch.object(self.stream.subprocess,'run',side_effect=results) as run:
                with self.assertRaises(ValueError):self.stream.stream()
                self.assertEqual(run.call_count,len(values))

    def test_archive_stream_uses_hashes_and_never_extracts_files(self):
        import io,tarfile,subprocess,ast
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w') as archive:
            info=tarfile.TarInfo('src/app.ts');data=b'PRIVATE SOURCE CONTENT';info.size=len(data);archive.addfile(info,io.BytesIO(data))
        values=[(self.stream.RUNTIME+'\n').encode(),(self.stream.TREE+'\n').encode(),buffer.getvalue()]
        results=[subprocess.CompletedProcess([],0,stdout=value) for value in values]
        with patch.object(self.stream.subprocess,'run',side_effect=results) as run,patch.object(tarfile.TarFile,'extractall',side_effect=AssertionError),patch.object(Path,'write_text',side_effect=AssertionError):
            source=self.stream.stream()
        self.assertNotIn('PRIVATE SOURCE CONTENT',source);compile(source,'stream','exec')
        assignment=next(node for node in ast.parse(source).body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='_result' for t in node.targets))
        expected=ast.literal_eval(assignment.value.args[0])
        self.assertEqual(expected,{'src/app.ts':m.hashlib.sha256(b'PRIVATE SOURCE CONTENT').hexdigest()})
        self.assertEqual(run.call_args.args[0][-3:],['archive','--format=tar',self.stream.RUNTIME])
        self.assertTrue(source.startswith("__name__ = 'fixed_attempt_diagnosis'"))

if __name__=='__main__':unittest.main()
