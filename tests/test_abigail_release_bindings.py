import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('adapter',ROOT/'ops/deploy-abigail-update.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)

class Bindings(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.old=self.root/'old';self.new=self.root/'new';self.old.mkdir();self.new.mkdir()
        self.link=self.root/'current';self.link.symlink_to(self.old);self.owner=object()
        self.env=self.root/'environment';self.db=self.root/'database';self.status=self.root/'status';self.receipt=self.root/'receipt';self.marker=self.root/'current-release';self.archive=self.root/'archive'
        self.evidence=a.read_backup_evidence();self.archive.write_bytes(b'a'*self.evidence['archiveSize']);self.db.write_bytes(b'fixture');self.status.write_text('{}')
        self.values={'BUBBLEWASH_DATABASE_PATH':str(self.db),'BUBBLEWASH_BACKUP_STATUS_PATH':str(self.status),'BUBBLEWASH_BACKUP_OFFSITE_DIR':str(self.root)}
        self.env.write_text(json.dumps(self.values));self.receipt.write_text(json.dumps({'sha256':self.evidence['context']['backupSha256'],'size':self.evidence['archiveSize'],'filename':'archive'}));self.write_marker(self.old)
        self.verify_lock=mock.Mock();self.rehearsals=mock.Mock();self.original=a.prepare_review(*a.read_inputs())
        @contextlib.contextmanager
        def lock(*_):yield self.verify_lock
        self.core=types.SimpleNamespace(deployment_lock=lock,activate=self.original.review_activation(lambda:None),CURRENT=self.link,RUNTIME=self.root,ENV=self.env,RECEIPT=self.receipt,parse=json.loads,digest=mock.Mock(return_value=self.evidence['context']['backupSha256']),verify_receipt=mock.Mock())
        self.guards=types.SimpleNamespace(environment_snapshot=lambda *_:(self.env.read_bytes(),'env-id'),database_identity=mock.Mock(return_value=('database-id',)),inspect_read=lambda path,*_:path.read_bytes(),safe_path=mock.Mock())
        self.update=types.SimpleNamespace(core=self.core,guards=self.guards,verify_sources=mock.Mock(return_value={'old':'old-id','new':'new-id'}),rehearse_both=self.rehearsals)
        a.bind_release_review(self.update,self.evidence)
        self.schema=mock.patch.object(a,'require_live_schema');self.check=self.schema.start();self.addCleanup(self.schema.stop)
        self.service=mock.Mock()

    def write_marker(self,target):
        self.marker.write_text(json.dumps({'sha':a.REFERENCE if target==self.old else a.CANDIDATE,'release':target.name,'path':str(target)}))

    def rehearse(self):self.update.rehearse_both(self.old,self.new,self.values,self.db,self.status,self.owner,'fixture')
    def activate(self):self.core.activate(self.link,self.new,self.service,self.write_marker)

    def test_no_switch_outside_lock_or_before_rehearsal(self):
        with self.assertRaises(ValueError):self.activate()
        with self.core.deployment_lock(None,None),self.assertRaises(ValueError):self.activate()
        self.service.assert_not_called()

    def test_success_binds_original_sequence_and_consumes_attempt(self):
        with self.core.deployment_lock(None,None):
            self.rehearse();self.activate()
            with self.assertRaises(ValueError):self.activate()
        self.assertEqual(self.link.resolve(),self.new);self.assertEqual(self.check.call_count,2);self.rehearsals.assert_called_once()
        for call in self.check.call_args_list:self.assertEqual(call.args,(self.update,self.db,self.owner))
        with self.assertRaises(ValueError):self.activate()

    def test_failed_rehearsal_never_unlocks_switch(self):
        self.rehearsals.side_effect=RuntimeError('fixture failed')
        with self.core.deployment_lock(None,None):
            with self.assertRaises(RuntimeError):self.rehearse()
            with self.assertRaises(ValueError):self.activate()
        self.service.assert_not_called()

    def test_changed_environment_database_source_archive_marker_refused(self):
        changes=[lambda:self.env.write_text('{}'),lambda:setattr(self.guards.database_identity,'return_value',('changed',)),lambda:setattr(self.update.verify_sources,'return_value',{}),lambda:setattr(self.core.digest,'return_value','0'*64),lambda:self.marker.write_text('{}'),lambda:self.status.write_text('{"extra":true}')]
        # Each instance gets an independent lock/binding; no retry on one state.
        for change in changes:
            with self.subTest(change=changes.index(change)):
                self.setUp()
                with self.core.deployment_lock(None,None):
                    self.rehearse();change()
                    with self.assertRaises(ValueError):self.activate()
                self.service.assert_not_called()

    def test_schema_failure_after_switch_restores_bound_marker(self):
        self.check.side_effect=[None,ValueError('schema'),ValueError('schema')]
        with self.core.deployment_lock(None,None):
            self.rehearse()
            with self.assertRaises(ValueError):self.activate()
        self.assertEqual(self.link.resolve(),self.old);self.assertEqual(json.loads(self.marker.read_bytes())['sha'],a.REFERENCE)

    def test_pointer_change_during_schema_observation_is_refused(self):
        def drift(*_):self.link.unlink();self.link.symlink_to(self.new)
        self.check.side_effect=drift
        with self.core.deployment_lock(None,None):
            self.rehearse()
            with self.assertRaises(ValueError):self.activate()
        self.service.assert_not_called()

    def test_request_values_cannot_substitute_unverified_database(self):
        with self.core.deployment_lock(None,None),self.assertRaises(ValueError):
            self.update.rehearse_both(self.old,self.new,{**self.values,'BUBBLEWASH_DATABASE_PATH':'/other'},self.db,self.status,self.owner,'fixture')
        self.rehearsals.assert_not_called()

if __name__=='__main__':unittest.main()
