import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock, mock_open

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).resolve().parents[1] / 'scripts/php-exposure-inventory.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class InventoryTests(unittest.TestCase):
    def test_packages_allowlist(self):
        raw = 'php8.3-fpm\t8.3.6-0ubuntu0.24.04.5\tinstalled\nsecret\thunter2\tinstalled\nphp8.3-cli\tbad value\tinstalled\nphp8.2-cli\t8.2.35\tconfig-files\nlibapache2-mod-php8.3:amd64\t8.3.36\tinstalled\n'
        self.assertEqual(m.packages(raw), [{'name': 'libapache2-mod-php8.3', 'version': '8.3.36'}, {'name': 'php8.3-fpm', 'version': '8.3.6-0ubuntu0.24.04.5'}])
    def test_services_strip_descriptions(self):
        self.assertEqual(m.services('php8.3-fpm.service loaded active running PRIVATE DESCRIPTION\nprivate.service loaded active running secret'), [{'name': 'php8.3-fpm.service', 'active': True}])
    def test_listener_classes(self):
        raw = '\n'.join(f'LISTEN 0 128 {addr}:9000 0.0.0.0:* users:(("php-fpm8.3",pid=12,fd=3))' for addr in ['127.0.0.1', '[::1]', '0.0.0.0', '[::]', '*'])
        self.assertEqual(m.listeners(raw), {'phpTcpListenerCount': 5, 'phpNonLoopbackTcpListenerCount': 3, 'phpLoopbackTcpListenerCount': 2, 'phpUnknownBindingCount': 0})
    def test_non_php_listener_not_reported(self):
        self.assertEqual(m.listeners('LISTEN 0 128 1.2.3.4:443 *:* users:(("nginx",pid=1,fd=2))')['phpTcpListenerCount'], 0)
    def test_failures_never_become_absence(self):
        with patch.object(m, 'command', side_effect=RuntimeError('SECRET')), patch.object(m.Path, 'glob', return_value=[]):
            result = m.collect()
        self.assertEqual(result['packages'], {'inspected': False})
        self.assertNotIn('SECRET', str(result))
        self.assertFalse(result['limits']['routingVerified'])
        self.assertTrue(result['limits']['noPhpDetectedDoesNotProveAbsence'])
    def test_missing_proc_never_reports_zero_success(self):
        with patch.object(m.Path, 'glob', return_value=[]):
            self.assertEqual(m.processes(), {'inspected': False, 'noProcessEntriesSeen': True})
    def test_process_coverage_and_truncation(self):
        good, long_name, vanished, unreadable = (MagicMock() for _ in range(4))
        good.open = mock_open(read_data='php-fpm8.3\n')
        long_name.open = mock_open(read_data='custom-php-name1\n')
        vanished.open.side_effect = FileNotFoundError()
        unreadable.open.side_effect = PermissionError()
        with patch.object(m.Path, 'glob', return_value=[good, long_name, vanished, unreadable]):
            result = m.processes()
        self.assertEqual(result['phpNamedCount'], 1)
        self.assertEqual(result['possiblyTruncatedNameCount'], 1)
        self.assertEqual(result['vanishedCount'], 1)
        self.assertEqual(result['unreadableCount'], 1)
        self.assertFalse(result['coverageComplete'])
        self.assertFalse(result['executableIdentityVerified'])
    def test_php_process_variants(self):
        for name in ['php', 'php8.3', 'php-fpm', 'php-fpm8.3']:
            self.assertTrue(m.PROCESS.fullmatch(name))
        self.assertFalse(m.PROCESS.fullmatch('php-secret-command'))

if __name__ == '__main__':
    unittest.main()
