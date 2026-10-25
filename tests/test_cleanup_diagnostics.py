import ast
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
from test_exact_cleanup_host import m as wrapper
import test_test_data_cleanup_core as core_tests
core=core_tests.m

ROOT=Path(__file__).resolve().parents[1]
class Normalize(ast.NodeTransformer):
    def visit_Call(self,node):
        if isinstance(node.func,ast.Name) and node.func.id=='backup_store_id':return self.visit(node.args[0])
        return self.generic_visit(node)
    def visit_Expr(self,node):
        if isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name):
            if node.value.func.id=='checkpoint':return None
            if node.value.func.id=='require' and len(node.value.args)==1 and isinstance(node.value.args[0],ast.BoolOp) and isinstance(node.value.args[0].op,ast.And):
                return [ast.Expr(value=ast.Call(func=ast.Name(id='require',ctx=ast.Load()),args=[v],keywords=[])) for v in node.value.args[0].values]
        return self.generic_visit(node)
def logic_hash(path,names):
    tree=ast.parse(path.read_text());selected=[]
    for node in ast.walk(tree):
        if isinstance(node,ast.FunctionDef) and node.name in names:selected.append(node)
    assert len(selected)==len(names)
    result=Normalize().visit(ast.Module(body=sorted(selected,key=lambda n:n.name),type_ignores=[]))
    return hashlib.sha256(ast.dump(result,include_attributes=False).encode()).hexdigest()
CORE_FUNCTIONS={'config','database_state','inspect','public_plan','apply_in_transaction'}
WRAPPER_FUNCTIONS={'preflight','stable','backup','database','no_alternate_login_sources','effective','run_cleanup'}
# Fingerprints of the already-reviewed original source, ignoring diagnostic calls
# and treating conjunction assertions as their equivalent sequential assertions.
CORE_GUARDS='8ac3b2d2edc900d6132205b745c8c09ec05b05fb33f73fb5c34d8ff62254be26'
WRAPPER_GUARDS='829a5e7fb63b28b02a8917f22d2d22ccd6ea2bd3cc256e0a523ce00704c59dec'
class DiagnosticTests(unittest.TestCase):
    def test_all_original_core_conditions_and_mutations_unchanged(self):
        self.assertEqual(logic_hash(ROOT/'ops/test-data-cleanup-core.py',CORE_FUNCTIONS),CORE_GUARDS)
    def test_all_original_host_conditions_and_sequence_unchanged(self):
        self.assertEqual(logic_hash(ROOT/'ops/exact-cleanup-host.py',WRAPPER_FUNCTIONS),WRAPPER_GUARDS)
    def test_no_user_supplied_checkpoint(self):
        with self.assertRaises(ValueError):wrapper.checkpoint('SECRET-private-value')
        with self.assertRaises(core.Refused):core.checkpoint('SECRET-private-value')
    def test_missing_file_mode_distinguished_without_changing_policy(self):
        fixture=core_tests.CleanupTests();self.addCleanup(fixture.doCleanups);db,raw=fixture.fixture()
        with self.assertRaises(core.Refused):core.inspect(db,raw.replace(b'NODE_ENV=production\n',b''))
        self.assertEqual(core.CHECKPOINT,'config-file-production-mode')
    def test_child_failure_keeps_failure_semantics_and_fixed_labels(self):
        host=wrapper.Host.__new__(wrapper.Host);host.cleanup=core;host.owner=None
        host.guards=types.SimpleNamespace(migrate_as_app=lambda owner,fn:fn())
        original=tempfile.TemporaryFile
        with tempfile.TemporaryDirectory() as folder,mock.patch.object(wrapper.tempfile,'TemporaryFile',side_effect=lambda **kw:original(dir=folder)):
            def fail():
                wrapper.checkpoint('database-inventory-core');core.checkpoint('exact-admin-owner-counts')
                raise ValueError('SECRET-private-error-and-path')
            with self.assertRaisesRegex(ValueError,'SECRET-private-error'):host.as_app(fail)
        self.assertEqual(wrapper.CHECKPOINT,'database-inventory-core')
        self.assertEqual(core.CHECKPOINT,'exact-admin-owner-counts')
    def test_entry_never_prints_private_error_or_values(self):
        sources={'cleanup':'CONFIRMATION="fixed"','preserving':'','guards':'','update':''}
        pins={'schema':'bubblewash-exact-cleanup-host/v1','dependencies':{k:wrapper.sha(v.encode()) for k,v in sources.items()}}
        def fail(*args):wrapper.checkpoint('environment-group-preservation');raise ValueError('SECRET-credential /private/path')
        out=io.StringIO()
        with mock.patch.object(sys,'argv',['script']),mock.patch.object(wrapper,'Host',side_effect=fail),contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit):wrapper.entry(pins,sources)
        result=json.loads(out.getvalue());self.assertEqual(result['check'],'environment-group-preservation')
        self.assertNotIn('SECRET',out.getvalue());self.assertNotIn('/private',out.getvalue())

if __name__=='__main__':unittest.main()
