"""Synthetic filesystem and fake manager tests only. Never contacts a host."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gate', HERE/'install_hold_gate.py')
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.uid = os.getuid(); self.calls = []
        self.loaded = {'system': False, 'user': False}; self.pending = False
        self.bad_condition = False; self.fail_reload = False
        self.facts = {'schema': 'bubblewash-bounded-host-evidence/v1',
            'releaseAcceptance': False, 'databaseOpened': False, 'binding': {}, 'units': {}}
        for manager, unit in g.UNITS:
            self.facts['units'][manager+'/'+unit] = {
                'ActiveState': 'inactive' if unit == 'bubblewash-maintenance.service' else 'active',
                'SubState': 'running' if unit == g.APP else 'dead' if unit.endswith('.service') else 'waiting',
                'sources': [{'pathSha256': g.object_sha(g.FRAGMENTS[unit]), 'sha256': ''}]}
        self.account = types.SimpleNamespace(pw_name='ubuntu', pw_uid=self.uid, pw_dir='/home/ubuntu')
        self.i = g.Installer(root=self.root, owner=self.uid, run=self.fake_run,
                             facts=self.facts, accounts=[self.account])
        for path in ('/var/lib', '/etc/systemd/system', '/etc/systemd/user', '/home/ubuntu/.config/systemd/user',
                     '/home/ubuntu/.config/bubblewash', '/home/ubuntu/bubblewash-runtime',
                     '/home/ubuntu/bubblewash-releases/live', '/run/user/'+str(self.uid),
                     '/proc/sys/kernel/random'):
            self.i.path(path).mkdir(parents=True, exist_ok=True)
        self.write('/run/user/'+str(self.uid)+'/bus', b'fixture')
        self.write('/home/ubuntu/bubblewash-runtime/deploy.lock', b'')
        self.write('/home/ubuntu/.config/bubblewash/env', b'DO_NOT_READ_CREDENTIALS')
        marker = b'sha='+b'a'*40+b'\npath=/home/ubuntu/bubblewash-releases/live\n'
        self.write('/home/ubuntu/bubblewash-runtime/current-release', marker)
        self.i.path('/home/ubuntu/bubblewash-pilot').symlink_to(self.i.path('/home/ubuntu/bubblewash-releases/live'))
        self.facts['binding']['currentPathSha256'] = g.object_sha('/home/ubuntu/bubblewash-releases/live')
        self.facts['binding']['markerSha256'] = g.sha(marker)
        self.write('/proc/sys/kernel/random/boot_id', b'11111111-1111-4111-8111-111111111111\n')
        self.rows = {}
        for manager, unit in g.UNITS:
            raw = ('[Unit]\nDescription=fixture '+unit+'\n').encode()
            self.write(g.FRAGMENTS[unit], raw)
            expected = self.facts['units'][manager+'/'+unit]
            expected['sources'][0]['sha256'] = g.sha(raw)
            row = dict.fromkeys(g.COMMON + (g.SERVICE if unit.endswith('.service') else ()), '')
            row.update(Id=unit, Names=unit, LoadState='loaded', ActiveState=expected['ActiveState'],
                       SubState=expected['SubState'], FragmentPath=g.FRAGMENTS[unit], NeedDaemonReload='no', Transient='no')
            if unit.endswith('.service'):
                pid = 123 if unit == g.APP else 0
                row.update(MainPID=str(pid), ControlPID='0', ControlGroup='/fixture/'+unit,
                           WorkingDirectory='/home/ubuntu/bubblewash-pilot', EnvironmentFiles='/private/env',
                           User='' if unit == g.APP else 'ubuntu', Group='' if unit == g.APP else 'ubuntu')
                expected['MainPID'] = pid
                for key in ('ControlGroup', 'WorkingDirectory', 'EnvironmentFiles', 'User', 'Group'):
                    expected[key+'Sha256'] = g.object_sha(row[key])
                expected['execStartSha256'] = g.object_sha([{'path': '/usr/bin/node', 'argv': ['/usr/bin/node', 'PRIVATE_ARG'], 'ignoreFailure': False}])
            self.rows[unit] = row
        self.i.path('/proc/123').mkdir()
        self.write('/proc/123/stat', b'123 (synthetic node) S '+b'0 '*18+b'100 0\n')
        self.i.evidence_sha256 = g.object_sha(self.facts)

    def write(self, path, raw):
        self.i.path(path).write_bytes(raw); self.i.path(path).chmod(0o600)

    def fake_run(self, args):
        self.calls.append(args)
        manager = 'user' if '--user' in args else 'system'
        if 'daemon-reload' in args:
            if self.fail_reload:
                raise ValueError('injected reload failure')
            self.loaded[manager] = self.i.exists(g.DROPINS[g.APP if manager == 'user' else g.UNITS[0][1]])
            return ''
        if 'list-units' in args:
            units = [u for m,u in g.UNITS if m == manager]+['unrelated.service', '-.mount']
            return '\n'.join(u+' loaded active running fixture' for u in units)
        if '--property=UnitPath' in args:
            user = args[args.index('-u')+1]
            return '/etc/systemd/user /home/'+user+'/.config/systemd/user\n'
        if '--property=LoadState,FragmentPath,DropInPaths' in args:
            return 'LoadState=not-found\nFragmentPath=\nDropInPaths='+\
                (g.DROPINS[g.APP] if self.i.exists(g.DROPINS[g.APP]) else '')
        if '--property=Id,NeedDaemonReload' in args:
            self.assertIn('--', args)
            ids = args[args.index('--')+1:]
            if manager == 'user':
                ids = args[args.index('--', args.index('systemctl'))+1:]
            return '\n\n'.join('Id='+u+'\nNeedDaemonReload='+('yes' if self.pending and u == 'unrelated.service' else 'no') for u in ids)
        if 'busctl' in args:
            if args[-1] == 'ExecStart':
                return 'a(sasbttttuii) 1 "/usr/bin/node" 2 "/usr/bin/node" "PRIVATE_ARG" false 0 0 0 0 0 0 0'
            if not self.loaded[manager]:
                return 'a(sbbsi) 0'
            hold = 'app-hold' if manager == 'user' else 'maintenance-hold'
            negate = 'false' if self.bad_condition else 'true'
            return ('a(sbbsi) 2 "ConditionPathExists" false false "'+g.STATE+'/installed-v1" 1 '
                    '"ConditionPathExists" false '+negate+' "'+g.STATE+'/'+hold+'" 1')
        unit = next((part for part in args if part in self.rows), None)
        if unit:
            row = self.rows[unit].copy()
            row['DropInPaths'] = g.DROPINS[unit] if self.loaded[manager] else ''
            return '\n'.join(key+'='+value for key,value in row.items())
        raise AssertionError('unexpected fake command '+repr(args))

    def test_inspection_readonly_and_no_private_content_reads(self):
        original = self.i.read
        def checked(path, *args, **kwargs):
            self.assertNotEqual(path, '/home/ubuntu/.config/bubblewash/env')
            self.assertNotIn('sqlite', path)
            return original(path, *args, **kwargs)
        with patch.object(self.i, 'read', side_effect=checked):
            with self.i.lock():
                self.i.preflight()
        self.assertFalse(self.i.exists(g.STATE))
        self.assertFalse(any('daemon-reload' in c for c in self.calls))

    def test_install_exact_modes_loaded_conditions_no_restart(self):
        before = self.i.snapshot(False)
        result = self.i.install()
        self.assertTrue(result['installed'])
        self.assertEqual(before, self.i.snapshot(True))
        self.assertEqual(self.i.path(g.STATE+'/installed-v1').read_bytes(), g.SENTINEL)
        for path in (g.STATE, *[str(Path(p).parent) for p in g.DROPINS.values()]):
            self.assertEqual(stat.S_IMODE(self.i.path(path).stat().st_mode), 0o755)
        for path in (g.STATE+'/installed-v1', *g.DROPINS.values()):
            self.assertEqual(stat.S_IMODE(self.i.path(path).stat().st_mode), 0o644)
            self.assertEqual(self.i.path(path).stat().st_nlink, 1)
        self.assertEqual(stat.S_IMODE(self.i.path(g.STATE+'/gate-installation.json').stat().st_mode), 0o600)
        self.assertFalse(self.i.exists(g.STATE+'/app-hold'))
        self.assertFalse(self.i.exists(g.STATE+'/maintenance-hold'))
        self.assertEqual(sum('daemon-reload' in c for c in self.calls), 2)
        for word in ('restart', 'start', 'stop', 'enable', 'disable', 'reload-or-restart'):
            self.assertFalse(any(word in c for c in self.calls))

    def test_reversal_archives_all_bytes_no_restart(self):
        self.i.install(); self.calls.clear()
        raw = self.i.path(g.STATE+'/gate-installation.json').read_bytes()
        result = self.i.reverse()
        self.assertTrue(result['reversed']); self.assertFalse(self.i.exists(g.STATE))
        recovery = self.i.path(result['recoveryPath'])
        self.assertEqual((recovery/'release-state/gate-installation.json').read_bytes(), raw)
        for _, unit in g.UNITS:
            self.assertEqual((recovery/(unit+'.d')/Path(g.DROPINS[unit]).name).read_bytes(), self.i.payload(unit))
            self.assertFalse(self.i.exists(str(Path(g.DROPINS[unit]).parent)))
        self.assertFalse(any('start' in c or 'stop' in c or 'restart' in c for c in self.calls))

    def test_state_collision_is_noop(self):
        self.i.path(g.STATE).mkdir(); self.write(g.STATE+'/unrelated', b'preserve')
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.i.install()
        self.assertEqual(self.i.path(g.STATE+'/unrelated').read_bytes(), b'preserve')
        self.assertFalse(any('daemon-reload' in c for c in self.calls))

    def test_empty_dropin_directory_collision_is_noop(self):
        target = str(Path(g.DROPINS[g.APP]).parent); self.i.path(target).mkdir()
        with self.assertRaisesRegex(ValueError, 'collision|same-name'):
            self.i.install()
        self.assertFalse(self.i.exists(g.STATE))

    def test_symlink_collision_is_noop(self):
        self.i.path(g.STATE).symlink_to(self.i.path('/var/lib/not-created'))
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.i.install()
        self.assertFalse(self.i.exists('/var/lib/not-created'))

    def test_writable_parent_refused_without_chmod(self):
        target = self.i.path('/etc/systemd/user'); target.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'ancestry'):
            self.i.install()
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o777)
        self.assertFalse(self.i.exists(g.STATE))

    def test_unrelated_pending_reload_refused(self):
        self.pending = True
        with self.assertRaisesRegex(ValueError, 'unrelated pending'):
            self.i.install()
        self.assertFalse(self.i.exists(g.STATE))

    def test_same_name_other_account_source_refused(self):
        self.i.accounts.append(types.SimpleNamespace(pw_name='other', pw_uid=self.uid+1, pw_dir='/home/other'))
        path = self.i.path('/home/other/.config/systemd/user'); path.mkdir(parents=True)
        (path/g.APP).write_text('[Service]\nExecStart=/unrelated\n')
        with self.assertRaisesRegex(ValueError, 'same-name'):
            self.i.install()
        self.assertFalse(self.i.exists(g.STATE))

    def test_changed_unit_source_refused(self):
        self.write(g.FRAGMENTS[g.APP], b'changed')
        with self.assertRaisesRegex(ValueError, 'source changed'):
            self.i.install()
        self.assertFalse(self.i.exists(g.STATE))

    def test_source_alias_refused(self):
        self.rows[g.APP]['Names'] += ' unrelated.service'
        with self.assertRaisesRegex(ValueError, 'unit identity'):
            self.i.install()
        self.assertFalse(self.i.exists(g.STATE))

    def test_wrong_loaded_negation_is_not_success(self):
        self.bad_condition = True
        with self.assertRaisesRegex(ValueError, 'Conditions'):
            self.i.install()
        self.assertTrue(self.i.exists(g.STATE+'/installed-v1'))
        self.assertFalse(any('restart' in c for c in self.calls))

    def test_reload_failure_leaves_sentinel_no_automatic_rollback(self):
        self.fail_reload = True
        with self.assertRaisesRegex(ValueError, 'injected'):
            self.i.install()
        self.assertTrue(self.i.exists(g.STATE+'/installed-v1'))
        for path in g.DROPINS.values():
            self.assertTrue(self.i.exists(path))

    def test_no_clobber_publish_collision(self):
        target = '/var/lib/collision'; self.write(target, b'original')
        with self.assertRaises(FileExistsError):
            self.i.publish(target, b'new bytes', 0o644)
        self.assertEqual(self.i.path(target).read_bytes(), b'original')
        self.assertTrue(list(self.i.path('/var/lib').glob('.gate-staged-*')))

    def test_partial_publication_no_reload_no_resume(self):
        original = self.i.publish; count = [0]
        def fail(path, raw, mode):
            count[0] += 1
            if count[0] == 4:
                raise OSError('synthetic disk full')
            original(path, raw, mode)
        with patch.object(self.i, 'publish', side_effect=fail):
            with self.assertRaises(OSError):
                self.i.install()
        self.assertFalse(any('daemon-reload' in c for c in self.calls))
        self.assertTrue(self.i.exists(g.STATE+'/installed-v1'))
        with self.assertRaises(ValueError):
            self.i.install()

    def test_holds_or_transition_forbid_reversal(self):
        self.i.install()
        for name in ('app-hold', 'maintenance-hold', 'transition.json', 'packages'):
            self.write(g.STATE+'/'+name, b'preserve')
            self.calls.clear()
            with self.assertRaisesRegex(ValueError, 'reversal forbidden'):
                self.i.reverse()
            self.assertEqual(self.i.path(g.STATE+'/'+name).read_bytes(), b'preserve')
            self.assertFalse(any('daemon-reload' in c for c in self.calls))
            self.i.path(g.STATE+'/'+name).unlink()

    def test_changed_process_forbids_reversal(self):
        self.i.install(); self.write('/proc/123/stat', b'123 (synthetic node) S '+b'0 '*18+b'101 0\n')
        with self.assertRaisesRegex(ValueError, 'process changed'):
            self.i.reverse()
        self.assertTrue(self.i.exists(g.STATE+'/installed-v1'))

    def test_reversal_reload_failure_retains_sentinel_and_archive(self):
        self.i.install(); self.fail_reload = True
        with self.assertRaisesRegex(ValueError, 'injected'):
            self.i.reverse()
        self.assertTrue(self.i.exists(g.STATE+'/installed-v1'))
        self.assertTrue(self.i.exists(self.i.recovery))
        self.assertEqual(len(list(self.i.path(self.i.recovery).iterdir())), 3)

    def test_gate_truth_table_from_exact_payload_bytes(self):
        for _, unit in g.UNITS:
            lines = self.i.payload(unit).decode().splitlines()
            self.assertEqual(lines[0], '[Unit]')
            paths = [line.split('=', 1)[1] for line in lines[1:]]
            hold = g.STATE+('/app-hold' if unit == g.APP else '/maintenance-hold')
            self.assertEqual(paths, [g.STATE+'/installed-v1', '!'+hold])
            def permits(existing):
                return all((path[1:] not in existing) if path.startswith('!') else path in existing for path in paths)
            self.assertFalse(permits(set()))
            self.assertTrue(permits({g.STATE+'/installed-v1'}))
            self.assertFalse(permits({g.STATE+'/installed-v1', hold}))
            other = g.STATE+('/maintenance-hold' if unit == g.APP else '/app-hold')
            self.assertTrue(permits({g.STATE+'/installed-v1', other}))

    def test_repeated_install_refuses_existing_owned_bytes(self):
        self.i.install(); self.calls.clear()
        with self.assertRaises(ValueError):
            self.i.install()
        self.assertFalse(any('daemon-reload' in c for c in self.calls))

    def test_extra_installed_file_forbids_reversal(self):
        self.i.install()
        path = str(Path(g.DROPINS[g.APP]).parent)+'/unrelated.conf'
        self.write(path, b'preserve')
        with self.assertRaisesRegex(ValueError, 'directory changed'):
            self.i.reverse()
        self.assertEqual(self.i.path(path).read_bytes(), b'preserve')

    def test_config_metadata_drift_forbids_reversal_without_reading_content(self):
        self.i.install()
        self.write('/home/ubuntu/.config/bubblewash/env', b'NEW_CREDENTIALS_NEVER_READ')
        with self.assertRaisesRegex(ValueError, 'binding or process changed'):
            self.i.reverse()
        self.assertTrue(self.i.exists(g.STATE+'/installed-v1'))

    def test_diagnostics_never_stringify_errors(self):
        for error in (ValueError('SECRET_CONFIG /private/path'), json.JSONDecodeError('SECRET', 'PRIVATE', 0),
                      FileNotFoundError('/private/path'), subprocess.TimeoutExpired(['SECRET_ARG'], 1)):
            raw = json.dumps(g.diagnostic(error, 'PREFLIGHT', 'install'))
            self.assertNotIn('SECRET', raw); self.assertNotIn('PRIVATE', raw); self.assertNotIn('/private', raw)
        self.assertEqual(g.diagnostic(ValueError('secret'), 'SECRET_STAGE', 'inspect')['stage'], 'INITIALIZE')

    def test_separate_filesystem_refused_before_install(self):
        original = self.i.metadata
        def different(path):
            result = original(path)
            if path == '/etc/systemd/user':
                result[0] += 1
            return result
        with patch.object(self.i, 'metadata', side_effect=different):
            with self.assertRaisesRegex(ValueError, 'target filesystem'):
                self.i.install()
        self.assertFalse(self.i.exists(g.STATE))

    def test_empty_other_user_manager_does_not_block_complete_reversal(self):
        account = types.SimpleNamespace(pw_name='other', pw_uid=self.uid+1, pw_dir='/home/other')
        self.i.accounts.append(account)
        path = '/run/user/'+str(account.pw_uid)
        self.i.path(path).mkdir(); self.write(path+'/bus', b'fixture')
        self.i.install()
        self.assertTrue(self.i.reverse()['reversed'])

    def test_evidence_recheck_occurs_under_existing_lock_before_writes(self):
        checks = []
        def check(unchanged):
            unchanged(); checks.append(True)
            with self.assertRaises(BlockingIOError):
                with self.i.lock():
                    pass
            self.assertFalse(self.i.exists(g.STATE))
        self.i.install(evidence_check=check)
        self.assertEqual(checks, [True])

    def test_evidence_recheck_refusal_prevents_all_install_writes(self):
        def check(unchanged):
            unchanged(); raise ValueError('fixture evidence drift')
        with self.assertRaisesRegex(ValueError, 'evidence drift'):
            self.i.install(evidence_check=check)
        self.assertFalse(self.i.exists(g.STATE))
        self.assertFalse(any('daemon-reload' in c for c in self.calls))

    def test_saved_canonical_evidence_tamper_refuses_reversal(self):
        self.i.install()
        path = g.STATE+'/gate-installation.json'
        receipt = json.loads(self.i.path(path).read_bytes())
        receipt['baselineEvidence']['binding']['extra'] = 'tampered'
        self.write(path, g.canonical(receipt))
        with self.assertRaisesRegex(ValueError, 'receipt changed'):
            self.i.reverse()

    def test_proc_style_zero_size_read_and_unexpected_owner(self):
        target = self.i.path('/proc/sys/kernel/random/boot_id')
        real_fstat = os.fstat; real_stat = Path.stat
        def info(value, wrong_owner=False):
            fields = {field:getattr(value, field) for field in g.META}
            fields['st_size'] = 0
            if wrong_owner: fields['st_uid'] += 1
            return types.SimpleNamespace(**fields)
        for wrong_owner in (False, True):
            def fstat(fd): return info(real_fstat(fd), wrong_owner)
            def pstat(path, *args, **kwargs):
                value = real_stat(path, *args, **kwargs)
                return info(value, wrong_owner) if path == target else value
            with patch.object(os, 'fstat', side_effect=fstat), patch.object(Path, 'stat', pstat):
                if wrong_owner:
                    with self.assertRaisesRegex(ValueError, 'unsafe input'): self.i.boot_id()
                else:
                    self.assertEqual(self.i.boot_id(), '11111111-1111-4111-8111-111111111111')

    def test_empty_boot_identity_refused_before_writes(self):
        self.write('/proc/sys/kernel/random/boot_id', b'')
        with self.assertRaisesRegex(ValueError, 'invalid boot identity'):
            self.i.install()
        self.assertFalse(self.i.exists(g.STATE))

    def test_regular_file_short_reads_loop_but_truncation_refuses(self):
        original = os.read
        target = '/home/ubuntu/bubblewash-runtime/current-release'
        with patch.object(os, 'read', side_effect=lambda fd,n: original(fd,min(n,3))):
            self.assertEqual(self.i.read(target, owner=self.uid), self.i.path(target).read_bytes())
        calls = []
        def premature(fd, n):
            calls.append(True)
            return original(fd, 3) if len(calls) == 1 else b''
        with patch.object(os, 'read', side_effect=premature):
            with self.assertRaisesRegex(ValueError, 'input changed'):
                self.i.read(target, owner=self.uid)
        self.assertFalse(self.i.exists(g.STATE))

    def test_busy_or_missing_lock_does_not_create(self):
        with self.i.lock():
            with self.assertRaises(BlockingIOError):
                self.i.install()
        self.i.path('/home/ubuntu/bubblewash-runtime/deploy.lock').unlink()
        with self.assertRaises(FileNotFoundError):
            self.i.install()
        self.assertFalse(self.i.exists('/home/ubuntu/bubblewash-runtime/deploy.lock'))
        self.assertFalse(self.i.exists(g.STATE))


if __name__ == '__main__':
    unittest.main(verbosity=2)
