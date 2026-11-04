"""Regression coverage for isolation-only restart collection, never account admission."""
import contextlib
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('restart_collector_fixture',ROOT/'tests/test_uat_restoration_collector.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
c=f.c;p=f.p
PINS={'runtimeRevision':'a'*40,'runtimeFiles':{},'unitSha256':'b'*64}

class RestartCollector(unittest.TestCase):
    def setup_context(self,stack,category='environment'):
        fixture=f.Collector();fixture.setup_context(stack)
        fixture.trusted.side_effect=lambda path,*a,**kw:(1,2,1000000000000,1) if str(path)==(p.ENVIRONMENT if category=='environment' else p.UNIT) else (1,2,1,1)
        return fixture

    def test_only_precheck_tolerates_environment_history_and_checks_all_isolation(self):
        with contextlib.ExitStack() as stack:
            self.setup_context(stack)
            evidence=c.collect_restart_isolation(PINS,before_restart=True)
            self.assertNotIn('public',evidence);self.assertNotIn('ok',evidence)
            self.assertEqual(evidence['database'],{'device':'1','inode':'2'})
            for name in ('verify_runtime','verify_environment','verify_service','verify_storage_isolation'):
                getattr(p,name).assert_called_once()
            p.inspect_accounts.assert_not_called()
            for operation in (lambda:c.collect(PINS),lambda:c.collect(PINS,eligible=False,private=True),
                              lambda:c.collect_restart_isolation(PINS,before_restart=False)):
                with self.assertRaises(p.TimestampGuardFailure):operation()

    def test_other_history_failure_never_accepted(self):
        with contextlib.ExitStack() as stack:
            self.setup_context(stack,'unit')
            with self.assertRaises(ValueError):c.collect_restart_isolation(PINS,before_restart=True)
            p.verify_runtime.assert_not_called();p.inspect_accounts.assert_not_called()

    def test_each_isolation_failure_still_blocks_precheck(self):
        for name in ('verify_runtime','verify_environment','verify_service','verify_storage_isolation'):
            with self.subTest(name=name),contextlib.ExitStack() as stack:
                self.setup_context(stack);getattr(p,name).side_effect=ValueError('synthetic')
                with self.assertRaises(ValueError):c.collect_restart_isolation(PINS,before_restart=True)
                p.inspect_accounts.assert_not_called()

    def test_changed_pid_or_file_identity_blocks_precheck(self):
        for changed in ('pid','file','database'):
            with self.subTest(changed=changed),contextlib.ExitStack() as stack:
                fixture=self.setup_context(stack)
                if changed=='pid':c.start.return_value=101
                else:
                    original=fixture.trusted.side_effect;seen=0
                    target=p.ENVIRONMENT if changed=='file' else p.DATABASE
                    def trusted(path,*args,**kwargs):
                        nonlocal seen
                        result=original(path,*args,**kwargs)
                        if str(path)==target:
                            seen+=1
                            if seen>1:return (result[0],3,*result[2:])
                        return result
                    fixture.trusted.side_effect=trusted
                with self.assertRaises(ValueError):c.collect_restart_isolation(PINS,before_restart=True)

    def test_postcheck_never_queries_accounts_and_requires_boolean_phase(self):
        with contextlib.ExitStack() as stack:
            fixture=self.setup_context(stack);fixture.trusted.side_effect=None
            fixture.trusted.return_value=(1,2,1,1)
            c.collect_restart_isolation(PINS,before_restart=False)
            p.inspect_accounts.assert_not_called()
            with self.assertRaises(ValueError):c.collect_restart_isolation(PINS,before_restart='false')

if __name__=='__main__':unittest.main()
