import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
P=Path(__file__).resolve().parents[1]/'ops/integration-release/binding_diagnostic.py'
spec=importlib.util.spec_from_file_location('archive_diag_test',P);d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
class ArchiveDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.parent=self.root/'private';self.parent.mkdir();self.file=self.parent/'encrypted';self.file.write_bytes(b'synthetic ciphertext');self.file.chmod(0o600)
        self.sha=hashlib.sha256(self.file.read_bytes()).hexdigest();self.size=self.file.stat().st_size
    def inspect(self,path=None):return d.inspect_archive(path or self.file,os.getuid(),self.size,self.sha)
    def test_matching_ciphertext_and_no_path_or_bytes(self):
        r=self.inspect();self.assertTrue(r['hashMatch']);self.assertTrue(r['sizeMatch']);self.assertTrue(r['stable']);self.assertNotIn(str(self.root),json.dumps(r));self.assertNotIn('synthetic ciphertext',json.dumps(r))
    def test_missing_leaf(self):
        r=self.inspect(self.parent/'absent');self.assertFalse(r['leaf']['present']);self.assertFalse(r['canonical']);self.assertEqual(r['hashMatch'],'unavailable')
    def test_relative_path_refused(self):self.assertFalse(self.inspect(Path('relative'))['absolute'])
    def test_leaf_symlink_is_not_hashed(self):
        link=self.parent/'link';link.symlink_to(self.file);r=self.inspect(link);self.assertFalse(r['canonical']);self.assertFalse(r['leaf']['regular']);self.assertEqual(r['hashMatch'],'not-run')
    def test_ancestor_symlink_not_followed(self):
        link=self.root/'link';link.symlink_to(self.parent);r=self.inspect(link/'encrypted');self.assertFalse(r['canonical']);self.assertFalse(r['ancestors'][-1]['directory']);self.assertEqual(r['hashMatch'],'not-run')
    def test_directory_leaf(self):self.assertFalse(self.inspect(self.parent)['leaf']['regular'])
    def test_link_count(self):
        os.link(self.file,self.parent/'second');r=self.inspect();self.assertEqual(r['leaf']['links'],2);self.assertEqual(r['hashMatch'],'not-run')
    def test_leaf_write_mode_visible_without_weakening_guard(self):
        self.file.chmod(0o660);r=self.inspect();self.assertFalse(r['leaf']['writeProtected']);self.assertEqual(r['leaf']['mode'],0o660);self.assertTrue(r['hashMatch'])
    def test_ancestor_write_mode_visible_by_depth(self):
        self.parent.chmod(0o770);r=self.inspect();self.assertFalse(r['ancestors'][-1]['writeProtected']);self.assertEqual(r['ancestors'][-1]['mode'],0o770)
    def test_size_and_hash_mismatch_reported_together(self):
        self.file.write_bytes(b'other');r=self.inspect();self.assertFalse(r['sizeMatch']);self.assertFalse(r['hashMatch']);self.assertEqual(r['expectedSize'],self.size)
    def test_hash_mismatch(self):
        self.sha='0'*64;r=self.inspect();self.assertFalse(r['hashMatch']);self.assertTrue(r['stable'])
    def test_unknown_owner_not_hashed(self):
        original=Path.lstat
        def changed(p,*a,**k):
            row=original(p,*a,**k)
            if p!=self.file:return row
            values=list(row);values[4]=123456;return os.stat_result(values)
        with patch.object(Path,'lstat',changed):
            r=self.inspect();self.assertFalse(r['leaf']['ownerAllowed']);self.assertEqual(r['hashMatch'],'not-run')
    def test_permission_error_is_fixed_metadata(self):
        with patch.object(d.os,'open',side_effect=PermissionError('PRIVATE/path')):
            r=self.inspect();self.assertEqual(r['hashMatch'],'unavailable');self.assertNotIn('PRIVATE',json.dumps(r))
    def test_file_change_during_read_not_accepted(self):
        read=d.os.read
        def changed(fd,n):
            raw=read(fd,n)
            if raw:self.file.write_bytes(b'changed ciphertext!!')
            return raw
        with patch.object(d.os,'read',changed):
            r=self.inspect();self.assertFalse(r['stable']);self.assertEqual(r['hashMatch'],'not-run')
    def test_no_mutating_calls(self):
        import ast
        calls=[n.func.attr for n in ast.walk(ast.parse(P.read_text())) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)]
        self.assertFalse(set(calls)&{'mkdir','chmod','chown','unlink','write','write_bytes','write_text','connect'})
if __name__=='__main__':unittest.main()
