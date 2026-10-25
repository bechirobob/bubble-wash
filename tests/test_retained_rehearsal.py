import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
p=load('retained_preparation',ROOT/'ops/inactive-staging/prepare_pair.py')
s=load('retained_stager',ROOT/'ops/inactive-staging/stage_artifact.py')

class RetainedTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.state=Path(self.tmp.name);self.uid=os.getuid()
        self.private=self.state/'rehearsal-evidence'/p.RETAINED_OPERATION
        self.private.mkdir(parents=True,mode=0o700)
        self.pair={}
        for label,char in [('candidate','a'),('fallback','b')]:
            sha=char*40;root=self.state/'releases'/sha;root.mkdir(parents=True,mode=0o755)
            for name in p.ROOT_FILES+ (('playwright.worklists.config.mjs',) if label=='candidate' else ()):
                (root/name).write_text(name)
            (root/'.release-sha').write_text(sha)
            tree=p.git_tree(p.source_files(root,self.uid,label=='candidate'))
            self.pair[label]=(sha,tree)
            self.pack(root,sha)
        (self.private/'preimage.sqlite').write_bytes(b'private synthetic preimage')
        (self.private/'preimage.sqlite').chmod(0o600)
        self.contracts=types.SimpleNamespace(verify_source=lambda *a:None,
            runtime_manifest=lambda root,sha:{'sha':sha},dependency_manifest=lambda path:{'synthetic':'bound'})
        self.adapter=types.SimpleNamespace(require_no_runtime_cache=lambda root:None)
        self.original_anchored=p.anchored_file;self.original_source=p.source_files;self.original_row=p.file_row
        old_lstat=Path.lstat
        def owned(path,*a,**kw):
            info=list(old_lstat(path,*a,**kw));info[4]=0;return os.stat_result(info)
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(p,'STATE',self.state));self.stack.enter_context(patch.object(p,'PAIR',self.pair))
        self.stack.enter_context(patch.object(s,'protected_directory',lambda *a:None))
        self.stack.enter_context(patch.object(Path,'lstat',owned))
        self.stack.enter_context(patch.object(p,'anchored_file',lambda root,name,owners,max_size=512*1024**2:self.original_anchored(root,name,(self.uid,),max_size)))
        self.stack.enter_context(patch.object(p,'source_files',lambda root,owner,candidate=False:self.original_source(root,self.uid,candidate)))

    def pack(self,root,sha):
        rows={}
        archive=self.private/(sha+'.tar')
        with tarfile.open(archive,'w',format=tarfile.USTAR_FORMAT) as tar:
            for path in sorted(root.rglob('*')):
                if path.is_dir() and not path.is_symlink():continue
                name=path.relative_to(root).as_posix()
                if path.is_symlink():
                    info=tarfile.TarInfo(name);info.type=tarfile.SYMTYPE;info.linkname=os.readlink(path);tar.addfile(info)
                    rows[name]={'type':'link','target':os.readlink(path)};continue
                data=path.read_bytes();mode=path.stat().st_mode&0o777
                info=tarfile.TarInfo(name);info.mode=mode;info.size=len(data)
                tar.addfile(info,io.BytesIO(data))
                rows[name]={'type':'file','size':len(data),'mode':mode,'sha256':hashlib.sha256(data).hexdigest()}
        archive.chmod(0o600)
        m={'schema':'bubblewash-inactive-artifact/v1','archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'files':rows}
        path=self.private/(sha+'-manifest.json');path.write_bytes(p.canonical(m));path.chmod(0o600)

    def inspect(self):
        return p.inspect_retained(core=None,contracts=self.contracts,adapter=self.adapter,stager=s,contract={})

    def test_exact_retained_pair_and_preimage_copy(self):
        with tarfile.open(self.private/(self.pair['candidate'][0]+'.tar'), 'r:') as archive:
            self.assertGreater(len(archive.getmembers()), 1)
        result=self.inspect();self.assertEqual(set(result),{'pins','pair'})
        self.assertEqual(result['pins']['operation'],p.RETAINED_OPERATION)
        dest=self.state/'new-preimage.sqlite';before=(self.private/'preimage.sqlite').read_bytes()
        p.copy_retained_preimage(dest,result['pins'],s)
        self.assertEqual(dest.read_bytes(),before);self.assertEqual(dest.stat().st_mode&0o777,0o600)
        self.assertEqual((self.private/'preimage.sqlite').read_bytes(),before)
        with self.assertRaises(FileExistsError):p.copy_retained_preimage(dest,result['pins'],s)

    def test_frozen_extra_or_changed_file_refused(self):
        root=self.state/'releases'/self.pair['candidate'][0]
        (root/'extra').write_text('extra')
        with self.assertRaises(ValueError):self.inspect()
        (root/'extra').unlink();(root/'README.md').write_text('changed')
        with self.assertRaises(ValueError):self.inspect()

    def test_manifest_pinned_file_link_allowed_but_outside_link_refused(self):
        sha=self.pair['candidate'][0];root=self.state/'releases'/sha
        modules=root/'node_modules';modules.mkdir(mode=0o755)
        (modules/'target').write_text('library');(modules/'alias').symlink_to('target')
        self.pack(root,sha)
        self.assertEqual(self.inspect()['pair']['candidate']['sha'],sha)
        (modules/'alias').unlink();(modules/'alias').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):self.inspect()

    def test_archive_or_manifest_corruption_refused(self):
        archive=self.private/(self.pair['candidate'][0]+'.tar')
        with archive.open('ab') as stream:stream.write(b'x')
        with self.assertRaises(ValueError):self.inspect()

    def test_symlink_in_frozen_file_refused(self):
        root=self.state/'releases'/self.pair['candidate'][0]
        (root/'README.md').unlink();(root/'README.md').symlink_to(root/'DESIGN.md')
        with self.assertRaises(ValueError):self.inspect()

    def test_existing_success_evidence_refuses_partial_recovery_route(self):
        (self.private/'evidence.json').write_text('{}')
        with self.assertRaises(ValueError):self.inspect()

    def test_pin_schema_rejects_unknown_or_wrong_run(self):
        pins=self.inspect()['pins']
        for key,value in [('operation','40144518669-1'),('unexpected',True)]:
            bad=dict(pins);bad[key]=value
            with self.assertRaises(ValueError):p.validate_retained_pins(bad)
        pins['preimage']['size']=True
        with self.assertRaises(ValueError):p.validate_retained_pins(pins)

    def test_changed_preimage_rejects_pinned_copy(self):
        pins=self.inspect()['pins'];(self.private/'preimage.sqlite').write_bytes(b'drift')
        with self.assertRaises(ValueError):p.copy_retained_preimage(self.state/'copy',pins,s)
        self.assertFalse((self.state/'copy').exists())

    def test_report_is_exclusive_sanitized_and_has_migration_stage(self):
        report=types.SimpleNamespace(failure={'stage':'COPY_REPAIR','error':'COMMAND_FAILED'},cleanup=True,
                                    safe_to_remove=True,migration_stage='FEATURES')
        out=self.state/'report';out.mkdir()
        with contextlib.redirect_stdout(io.StringIO()) as output:p.save_probe_report(out,'candidate',report)
        result=json.loads(output.getvalue());self.assertEqual(result['migrationStage'],'FEATURES')
        self.assertNotIn('exception',result);self.assertEqual((out/'candidate-probe.json').stat().st_mode&0o777,0o600)
        with self.assertRaises(FileExistsError):p.save_probe_report(out,'candidate',report)
        report.failure['error']='raw private error'
        with self.assertRaises(ValueError):p.save_probe_report(out,'fallback',report)

if __name__=='__main__':unittest.main()
