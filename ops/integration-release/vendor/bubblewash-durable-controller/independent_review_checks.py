"""Independent local regression checks; disposable fixtures only."""
import os
from pathlib import Path
import unittest

import controller as c
from test_controller import DurableTests, ExistingHostGuardTests


class ReviewChecks(unittest.TestCase):
    def setUp(self):
        self.fixture = DurableTests()
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def test_owner_mismatch_rejected_with_fresh_plan_hash(self):
        f = self.fixture
        f.plan['ownerContract']['files']['src/lib/auth.ts'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'owner-compatible'):
            f.make_controller().execute()
        self.assertEqual(f.events, [])

    def test_old_cannot_be_selected_as_fallback(self):
        f = self.fixture
        f.plan['fallback'] = str(f.old)
        with self.assertRaisesRegex(ValueError, 'independent and canonical'):
            f.make_controller().execute()
        self.assertEqual(f.events, [])

    def test_pointer_drift_before_release_never_starts_old(self):
        f = self.fixture
        events = []
        def hook(phase):
            if phase == 'TARGET_SELECTED':
                c.durable_pointer(f.current, f.old)
        control = f.make_controller(hook)
        control.service = lambda manager, action, unit: events.append((action, f.current.resolve()))
        self.assertEqual(control.execute(), 'fallback-ready')
        self.assertEqual([target for action, target in events if action == 'start'], [f.fallback])

    def test_marker_format_and_metadata_remain_compatible(self):
        f = self.fixture
        os.chmod(f.marker, 0o640)
        original = f.marker.stat()
        self.assertEqual(f.control.execute(), 'candidate-ready')
        result = f.marker.stat()
        self.assertEqual((result.st_mode, result.st_uid, result.st_gid),
                         (original.st_mode, original.st_uid, original.st_gid))
        self.assertEqual(c.guards_module().parse(f.marker.read_bytes()), {
            'sha': f.plan['releaseShas']['candidate'], 'release': f.candidate.name,
            'path': str(f.candidate)})

    def test_replaced_state_directory_fails_closed(self):
        f = self.fixture
        f.state.directory.rename(f.root / 'previous-state')
        f.state.directory.mkdir(mode=0o755)
        f.state.sentinel.write_bytes(b'bubblewash-release-gate-v1\n')
        with self.assertRaisesRegex(ValueError, 'state directory changed'):
            f.control.execute()
        self.assertEqual(f.events, [])

    def test_concrete_host_guards_and_controller_integrate(self):
        f = self.fixture
        host_fixture = ExistingHostGuardTests()
        host_fixture.setUp()
        try:
            new_marker = host_fixture.runtime / 'current-release'
            new_marker.write_bytes(f.marker.read_bytes())
            f.marker = new_marker
            f.plan['marker'] = str(new_marker)
            host_fixture.env.write_text(
                f'BUBBLEWASH_BACKUP_OFFSITE_DIR={host_fixture.root}\n'
                f'BUBBLEWASH_BACKUP_STATUS_PATH={host_fixture.status}\n'
                f'BUBBLEWASH_DATABASE_PATH={f.db}\n')
            host_fixture.expected['database'] = str(f.db)
            host_fixture.expected['envSha256'] = c.core.digest(host_fixture.env)
            with host_fixture.host().locked() as guard:
                control = f.make_controller()
                control.guard = guard
                self.assertEqual(control.execute(), 'candidate-ready')
                self.assertTrue(guard())
            self.assertTrue(f.state.maintenance_hold.exists())
        finally:
            host_fixture.tearDown()

    def test_second_existing_lock_holder_is_rejected(self):
        h = ExistingHostGuardTests()
        h.setUp()
        try:
            with h.host().locked():
                with self.assertRaises(BlockingIOError):
                    with h.host().locked():
                        self.fail('second lock acquired')
        finally:
            h.tearDown()


if __name__ == '__main__':
    unittest.main(verbosity=2)
