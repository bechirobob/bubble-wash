"""Synthetic timestamp guard tests: no host reads, accounts, services or secrets."""
import importlib.util
import itertools
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


p=load('timestamp_preflight','ops/uat/restoration-preflight.py')
with mock.patch.dict(sys.modules,{'uat_restore_preflight':p}):
    c=load('timestamp_collector','ops/uat/restoration-collector.py')
t=load('timestamp_transport','ops/uat/restoration-transport.py')


class Timestamps(unittest.TestCase):
    def objects(self,mtime=50,ctime=50):
        return {**{str(Path(p.APP)/name):(1,2,mtime,ctime) for name in ('SOURCE_REVISION',*p.PIN_FILES)},
            p.UNIT:(1,2,mtime,ctime),p.ENVIRONMENT:(1,2,mtime,ctime)}

    def bundle(self):return {name:(ROOT/name).read_text() for name in t.SOURCE_FILES}

    def receipt(self,error):
        with mock.patch.dict(sys.modules,{'uat_restore_preflight':p}):
            return t.inspection_failure(error,self.bundle(),'host-inspection')

    def test_guard_is_identical_at_and_around_boundary(self):
        for mtime,ctime in itertools.product((-1,0,99,100,101,10**12),repeat=2):
            objects=self.objects(mtime,ctime)
            old_accepts=all(max(info[2:])<=100 for info in objects.values())
            try:c.verify_config_timestamps(objects,100);new_accepts=True
            except p.TimestampGuardFailure:new_accepts=False
            self.assertEqual(new_accepts,old_accepts)

    def test_categories_and_comparisons_are_fixed_and_deduplicated(self):
        with self.assertRaises(p.TimestampGuardFailure) as captured:
            c.verify_config_timestamps(self.objects(101,102),100)
        result=self.receipt(captured.exception)
        expected=[{'category':category,'comparison':comparison}
            for category in sorted(('runtime-revision','runtime-source','service-unit','environment'))
            for comparison in sorted(('mtime-after-process-start','ctime-after-process-start'))]
        self.assertEqual(result['timestampFailures'],expected)
        self.assertEqual(len(result['timestampFailures']),8)
        self.assertFalse(result['ok']);self.assertFalse(result['automaticRetry'])
        serialized=json.dumps(result)
        for private in (p.APP,p.UNIT,p.ENVIRONMENT,'SOURCE_REVISION','started_ns','mtime_ns','inode'):
            self.assertNotIn(private,serialized)
        t.validate_inspection_failure(result,self.bundle(),host_only=True)

    def test_one_changed_metadata_timestamp_reports_no_content_change_claim(self):
        objects=self.objects();objects[p.ENVIRONMENT]=(1,2,50,101)
        with self.assertRaises(p.TimestampGuardFailure) as captured:c.verify_config_timestamps(objects,100)
        self.assertEqual(self.receipt(captured.exception)['timestampFailures'],
            [{'category':'environment','comparison':'ctime-after-process-start'}])

    def test_coarse_start_estimate_can_reject_a_prestart_file_without_relaxing_guard(self):
        # Hypothetical fractional boot time is lost by integer btime. This is
        # evidence of a possible precision issue, not a diagnosis of the host.
        actual_boot=100_800_000_000;uptime_ticks=100;hz=100
        calculated_start=100*10**9+uptime_ticks*10**9//hz
        actual_start=actual_boot+uptime_ticks*10**9//hz
        file_time=actual_start-100_000_000
        self.assertLess(file_time,actual_start)
        with self.assertRaises(p.TimestampGuardFailure):
            c.verify_config_timestamps(self.objects(file_time,file_time),calculated_start)

    def test_unknown_objects_and_malformed_evidence_fail_closed(self):
        objects=self.objects();objects['/private-canary']=(1,2,101,101)
        with self.assertRaises(ValueError):c.verify_config_timestamps(objects,100)
        objects=self.objects();objects[p.UNIT]=(1,2,101)
        with self.assertRaises(ValueError):c.verify_config_timestamps(objects,100)

    def test_details_rejected_outside_host_inspection_and_other_modes(self):
        with self.assertRaises(p.TimestampGuardFailure) as captured:
            c.verify_config_timestamps(self.objects(101,50),100)
        result=self.receipt(captured.exception)
        for stage in ('transport','source-verification','receipt-validation'):
            with self.assertRaises(ValueError):
                t.validate_inspection_failure(dict(result,failureStage=stage),self.bundle())
        for mode in ('restore','receipt'):
            with self.assertRaises(ValueError):
                t.validate_receipt(json.dumps(result).encode(),mode,inspection_bundle=self.bundle())

    def test_unknown_values_fields_duplicates_and_order_are_refused(self):
        with self.assertRaises(p.TimestampGuardFailure) as captured:
            c.verify_config_timestamps(self.objects(101,50),100)
        result=self.receipt(captured.exception);valid=result['timestampFailures']
        invalid=[[],valid*3,valid+valid[:1],list(reversed(valid)),
            [{'category':'private-canary','comparison':'mtime-after-process-start'}],
            [{'category':'environment','comparison':True}],
            [{'category':'environment','comparison':'ctime-after-process-start','time':101}],
            [{'category':'environment','comparison':'private-canary'}]]
        for details in invalid:
            with self.subTest(details=details),self.assertRaises(ValueError):
                t.validate_inspection_failure(dict(result,timestampFailures=details),self.bundle())


if __name__=='__main__':unittest.main()
