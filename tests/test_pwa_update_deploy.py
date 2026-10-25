import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
# This overlay test can run before copying the reviewed files into the repository.
BASE=ROOT if (ROOT/'ops/deploy-survey-update.py').exists() else ROOT.parent/'bubblewash-separate-apps'
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
pwa=load('pwa',ROOT/'ops/deploy-pwa-update.py')
old=load('reused_code_only_tests',BASE/'tests/test_survey_update_deploy.py')
sources={name:(BASE/'ops'/name).read_text() for name in pwa.DEPENDENCIES}
pins={**old.PINS,'schema':'bubblewash-pwa-update/v1','baseSha':pwa.BASE_SHA,
      'dependencies':{name:hashlib.sha256(raw.encode()).hexdigest() for name,raw in sources.items()}}
old.adapter=pwa.configure(pins,sources);old.core=old.adapter.core;old.guards=old.adapter.guards;old.PINS=pins

class ReusedTransition(unittest.TestCase):
    run_update=old.Update.run_update
    def setUp(self):
        old.Update.setUp(self)
        self.values['NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED']='false'
        self.raw += b'NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false\n'
        self.env.write_bytes(self.raw)
        state=self.root/'state';(state/'releases').mkdir(parents=True)
        moved=state/'releases'/pwa.BASE_SHA;self.old.rename(moved);self.old=moved
        self.pointer.unlink();self.pointer.symlink_to(self.old)
        self.marker.write_text(f"sha={pwa.BASE_SHA}\npath={self.old}\n")
        self.old_marker=self.marker.read_bytes()
        self.stack.enter_context(mock.patch.object(pwa,'STATE',state))
        def freeze(update,build,sha,owner):
            self.assertEqual(build,self.new)
            target=state/'releases'/sha;build.rename(target);self.new=target
            return target
        self.freeze=self.stack.enter_context(mock.patch.object(pwa,'freeze_candidate',side_effect=freeze))
    test_code_only_success=old.Update.test_success_changes_only_code_marker_preserves_complete_open_config_and_db
    test_code_rollback_preserves_late_data=old.Update.test_failed_candidate_health_rolls_back_only_code_retaining_late_responses
    test_uncertain_marker=old.Update.test_uncertain_marker_ack_rolls_code_back_without_repeating_update
    test_new_response_allowed=old.Update.test_new_legitimate_live_response_during_rehearsal_does_not_require_live_row_equality
    test_schema_drift_refuses=old.Update.test_copy_preservation_failure_refuses_before_service_stop
    test_environment_drift_refuses=old.Update.test_config_drift_after_copy_refuses_switch_and_does_not_overwrite
    test_receipt_refuses=old.Update.test_initial_stale_receipt_is_labeled_backup_before_build
    test_source_drift_refuses=old.Update.test_source_drift_after_copy_refuses_switch
    test_critical_writer_refuses=old.Update.test_source_guard_rejects_unknown_changed_writer_even_with_matching_disk_hash
    test_database_inode_refuses=old.Update.test_replaced_db_inode_refuses_without_restoring_data
    test_controller_never_opens_database=old.Update.test_no_live_sqlite_connection_or_fingerprint_is_called_by_controller
    def test_current_must_be_exact_completed_upgrade_root(self):
        moved=self.old.with_name('other-release');self.old.rename(moved)
        self.pointer.unlink();self.pointer.symlink_to(moved)
        self.marker.write_text(f"sha={pwa.BASE_SHA}\npath={moved}\n")
        with self.assertRaises(ValueError):self.run_update()
        self.ctl.assert_not_called();self.command.assert_not_called()
    def test_original_transition_is_preserved_except_exact_root_and_label(self):
        import inspect
        original=sources['deploy-survey-update.py']
        original=original[original.index('    require(os.geteuid()',original.index('def deploy(args):')):original.index('\ndef verify_hosted_run')].strip()
        actual=inspect.getsource(pwa.deploy)
        actual=actual[actual.index('    require(os.geteuid()'):].strip()
        expected=original.replace('current.parent == candidate.parent',"current == STATE / 'releases' / BASE_SHA").replace("'bubblewash-survey-update-'","'bubblewash-pwa-update-'")
        expected=expected.replace('            guards.migrate_as_app(owner, write_as_app)','            guards.migrate_as_app(owner, write_as_app)\n            identities()')
        expected=expected.replace('        sources = verify_sources(current, candidate, owner)\n        rehearse_both','        verify_sources(current, candidate, owner)\n        candidate = freeze_candidate(update, candidate, args.sha, owner)\n        sources = verify_sources(current, candidate, owner)\n        rehearse_both')
        self.assertEqual(actual,expected)
    def test_survey_flags_preserved_not_reactivated(self):
        values={**self.values,'BUBBLEWASH_RESEARCH_OPEN':'false','BUBBLEWASH_RESEARCH_EMAIL_ENABLED':'false'}
        pwa.configuration(values)
        for key in ('BUBBLEWASH_STAFF_AUTH_DISABLED','BUBBLEWASH_BOOKINGS_DISABLED','BUBBLEWASH_DISABLE_DEMO_LOGIN','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED'):
            with self.assertRaises(ValueError):pwa.configuration({**values,key:'true' if values[key]=='false' else 'false'})

class Holds(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.root.chmod(0o755)
        (self.root/'installed-v1').write_bytes(b'bubblewash-release-gate-v1\n')
        (self.root/'maintenance-hold').write_bytes(b'held\n')
        (self.root/'transition.json').write_text(json.dumps({'schema':1,'phase':'CANDIDATE_READY','planHash':pwa.JOURNAL_PLAN,'target':'/synthetic/current'}))
    def snapshot(self):return pwa.release_state_snapshot(self.root,os.getuid())
    def test_valid_completed_state_is_read_only(self):
        before={p.name:p.read_bytes() for p in self.root.iterdir()}
        self.assertEqual(self.snapshot(),self.snapshot())
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.root.iterdir()})
    def test_app_hold_refused(self):
        (self.root/'app-hold').write_bytes(b'held\n')
        with self.assertRaises(ValueError):self.snapshot()
    def test_partial_or_other_journal_refused(self):
        file=self.root/'transition.json';value=json.loads(file.read_text())
        for change in ({'phase':'MIGRATING'},{'planHash':'f'*64},{'schema':2},{'target':'relative'}):
            file.write_text(json.dumps({**value,**change}))
            with self.assertRaises(ValueError):self.snapshot()
    def test_links_and_mutable_holds_refused(self):
        file=self.root/'maintenance-hold';file.chmod(0o666)
        with self.assertRaises(ValueError):self.snapshot()
        file.chmod(0o644);file.rename(self.root/'old-hold');file.symlink_to(self.root/'old-hold')
        with self.assertRaises((ValueError,OSError)):self.snapshot()
    def test_dropped_uid_checks_metadata_without_opening_private_journal(self):
        original=self.snapshot()
        with mock.patch.object(pwa,'STATE',self.root),mock.patch.object(pwa.os,'geteuid',return_value=123),mock.patch.object(pwa.os,'open',side_effect=AssertionError('must not open root-private journal')):
            pwa.release_state_unchanged(original)
            (self.root/'maintenance-hold').write_bytes(b'other\n')
            with self.assertRaises(ValueError):pwa.release_state_unchanged(original)
    def test_dependency_change_refused(self):
        with self.assertRaises(ValueError):pwa.configure(pins,{**sources,'deploy-preserving.py':sources['deploy-preserving.py']+'\n'})
    def test_scope_is_manual_no_network_or_migration_mutation(self):
        workflow=(ROOT/'.github/workflows/pwa-update-deploy.yml').read_text()
        self.assertIn('workflow_dispatch:',workflow);self.assertNotIn('\n  push:',workflow)
        self.assertIn(pwa.BASE_SHA,workflow);self.assertIn('"$GITHUB_RUN_ATTEMPT" == 1',workflow)
        source=(ROOT/'ops/deploy-pwa-update.py').read_text()
        self.assertNotIn('os.unlink',source);self.assertNotIn('core.main(',source)
        self.assertNotIn('sqlite3.connect',source);self.assertNotIn('caddy',source.lower())
class ImmutableFreeze(unittest.TestCase):
    def test_actual_frozen_archive_stager_retains_source_and_confines_links(self):
        import types
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);state=root/'state';(state/'releases').mkdir(parents=True);(state/'rehearsal-evidence').mkdir()
            build=root/'build';(build/'.next').mkdir(parents=True);(build/'node_modules/pkg').mkdir(parents=True)
            (build/'src').mkdir();(build/'src/app.ts').write_text('exact source')
            (build/'.next/BUILD_ID').write_text('build');(build/'.release-sha').write_text('a'*40+'\n')
            (build/'node_modules/pkg/bin').write_text('runtime code')
            (build/'node_modules/pkg/link').symlink_to('bin')
            update=pwa.configure(pins,sources);real_stage=update.stager.stage
            def fixture_stage(archive,raw,manifest,base,name):
                # Test-only UID substitution; production calls the unchanged
                # stager with its root-owned default and strict parent guard.
                return real_stage(archive,raw,manifest,base,name,uid=os.getuid(),check_parent=lambda p,u:self.assertEqual(p,state/'releases'))
            owner=types.SimpleNamespace(pw_uid=os.getuid())
            with mock.patch.object(pwa,'STATE',state),mock.patch.object(update.prepare,'STATE',state),mock.patch.object(update.stager,'protected_directory'),mock.patch.object(update.stager,'stage',side_effect=fixture_stage),mock.patch.object(update,'source_snapshot',return_value=({'src/app.ts':'bound'},{})):
                target=pwa.freeze_candidate(update,build,'a'*40,owner)
                self.assertEqual(target,state/'releases'/('a'*40))
                self.assertEqual((target/'src/app.ts').read_text(),'exact source')
                self.assertEqual((target/'node_modules/pkg/link').resolve(),target/'node_modules/pkg/bin')
                self.assertEqual((target/'src/app.ts').stat().st_mode & 0o777,0o644)
                with self.assertRaises(FileExistsError):pwa.freeze_candidate(update,build,'a'*40,owner)
    def test_frozen_candidate_failure_cannot_reach_switch(self):
        case=ReusedTransition('test_code_only_success');case.setUp()
        try:
            case.freeze.side_effect=ValueError('freeze refused')
            with self.assertRaises(ValueError):case.run_update()
            case.ctl.assert_not_called();self.assertEqual(case.pointer.resolve(),case.old)
        finally:case.doCleanups()
if __name__=='__main__':unittest.main()
