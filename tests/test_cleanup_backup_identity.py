"""Real frozen receipt verifier plus bounded non-secret release receipt fixture."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
from test_exact_cleanup_host import m as wrapper
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('preserving',ROOT/'ops/deploy-preserving.py')
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)

class BackupIdentityTests(unittest.TestCase):
    def setUp(self):
        self.receipt=json.loads((ROOT/'tests/fixtures/cleanup-backup-receipt.json').read_text())
        # Status is synthetic matching metadata; do not claim this fixture is a host status observation.
        self.status=dict(ok=True,filename=self.receipt['filename'],sha256=self.receipt['sha256'],createdAt='2026-10-25T14:30:39.335Z',restoreVerifiedAt='2026-10-25T14:30:46Z',offsiteStoredAt='2026-10-25T14:30:48Z')
        self.now=dt.datetime.fromisoformat('2026-10-25T15:40:00+00:00').timestamp()
    def verify(self,store_id,receipt=None):
        helper.verify_receipt(receipt or self.receipt,self.status,self.now,'40202547347',self.receipt['storageSha'],store_id)
    def test_actual_receipt_reproduces_original_type_refusal(self):
        with self.assertRaisesRegex(ValueError,'backup receipt identity mismatch'):self.verify('1403152795')
        self.verify(1403152795)
    def test_conversion_is_exact_and_not_permissive_coercion(self):
        self.assertEqual(wrapper.backup_store_id('1403152795'),1403152795)
        for value in (1403152795,True,None,'01403152795','+1403152795',' 1403152795','1403152795 ','1403152796','1.403152795e9'):
            with self.subTest(value=value),self.assertRaises(ValueError):wrapper.backup_store_id(value)
    def test_wrong_receipt_repository_identity_still_rejected(self):
        for value in ('1403152795',1403152796,None):
            receipt=dict(self.receipt,storageRepositoryId=value)
            with self.subTest(value=value),self.assertRaises(ValueError):self.verify(wrapper.backup_store_id('1403152795'),receipt)
    def test_actual_host_backup_call_uses_frozen_verifier(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);receipt_path=root/'receipt';receipt_path.write_text(json.dumps(self.receipt));status=root/'status';status.write_text(json.dumps(self.status));archive=root/self.receipt['filename'];archive.write_bytes(b'x'*self.receipt['size'])
            host=object.__new__(wrapper.Host);host.owner=object();host.pins=dict(backupSha256=self.receipt['sha256'],receiptRun='40202547347',storeSha=self.receipt['storageSha'],storeId='1403152795')
            host.core=types.SimpleNamespace(RECEIPT=receipt_path,verify_receipt=helper.verify_receipt,digest=lambda p:self.receipt['sha256'])
            host.guards=types.SimpleNamespace(safe_path=lambda *a:None,inspect_read=lambda p,*a:p.read_bytes())
            with mock.patch.object(wrapper.time,'time',return_value=self.now):host.backup(dict(BUBBLEWASH_BACKUP_STATUS_PATH=str(status),BUBBLEWASH_BACKUP_OFFSITE_DIR=str(root)))
