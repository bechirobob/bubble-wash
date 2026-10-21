import unittest
from unittest.mock import Mock

from check_store import check_store


class StorePreflightTests(unittest.TestCase):
    def setUp(self):
        self.env = {'GH_TOKEN': 'synthetic-secret-not-a-credential',
                    'BACKUP_STORE_SHA': 'a' * 40, 'BACKUP_STORE_ID': '123'}
        self.api = Mock()
        self.api.api.side_effect = [
            {'private': True, 'visibility': 'private',
             'full_name': 'bechirobob/becore-backups', 'id': 123},
            {'sha': 'a' * 40}]
        self.factory = Mock(return_value=self.api)

    def test_valid_store_only_reads_identity_and_commit(self):
        check_store(self.env, self.factory)
        self.assertEqual(self.api.api.call_args_list[0].args, ())
        self.assertEqual(self.api.api.call_args_list[1].args, ('git/commits/' + 'a' * 40,))
        self.assertEqual(self.api.api.call_count, 2)

    def test_missing_token_reports_job_scope_without_commands(self):
        for value in ('', '   '):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'BACKUP_STORE_TOKEN is unavailable to this job'):
                check_store(dict(self.env, GH_TOKEN=value), self.factory)
        self.factory.assert_not_called()

    def test_reports_all_missing_names(self):
        with self.assertRaises(RuntimeError) as error:
            check_store({}, self.factory)
        for name in ('BACKUP_STORE_TOKEN', 'BACKUP_STORE_SHA', 'BACKUP_STORE_ID'):
            self.assertIn(name, str(error.exception))
        self.factory.assert_not_called()

    def test_invalid_config_never_echoes_values(self):
        env = dict(self.env, BACKUP_STORE_SHA='secret-looking-invalid-value')
        with self.assertRaises(RuntimeError) as error:
            check_store(env, self.factory)
        for value in env.values():
            self.assertNotIn(value, str(error.exception))
        self.factory.assert_not_called()

    def test_public_repository_stops_before_commit(self):
        self.api.api.side_effect = [{'private': False, 'visibility': 'public',
                                    'full_name': 'bechirobob/becore-backups', 'id': 123}]
        with self.assertRaisesRegex(RuntimeError, 'private'):
            check_store(self.env, self.factory)
        self.assertEqual(self.api.api.call_count, 1)

    def test_wrong_commit_fails(self):
        self.api.api.side_effect = [
            {'private': True, 'visibility': 'private', 'full_name': 'bechirobob/becore-backups', 'id': 123},
            {'sha': 'b' * 40}]
        with self.assertRaisesRegex(RuntimeError, 'commit mismatch'):
            check_store(self.env, self.factory)
