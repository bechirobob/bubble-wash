import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value

h = load('survey_host', 'ops/run-research-test.py')
t = load('survey_transport', 'ops/transport-research-test.py')
i = load('survey_installer', 'ops/install-research-email.py')
f = load('survey_facts', 'ops/host-facts/facts.py')
p = load('survey_preflight', 'scripts/release-preflight.py')
OWNER = 'synthetic-owner@example.invalid'
KEY = 're_SYNTHETIC_ONLY_1234567890'
SHA = 'a' * 40


def request():
    return {'ownerEmail': OWNER, 'reviewedSha': SHA, 'runtimeSha': 'e' * 40, 'nodePath': '/usr/bin/node', 'nodeSha256': 'b' * 64,
            'mode': 'check', 'deliveryApproved': False,
            'sourcePins': {name: 'c' * 64 for name in [*t.RUNTIME_FILES, 'src/lib/research/provider.ts', 'src/lib/data-store.ts']}}


def environment():
    return {'GITHUB_REPOSITORY': 'bechirobob/bubble-wash', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
            'GITHUB_SHA': SHA, 'REVIEWED_SHA': SHA, 'RUNTIME_SHA': 'e' * 40, 'GITHUB_RUN_ATTEMPT': '1', 'TEST_MODE': 'check', 'DELIVERY_APPROVED': 'false',
            'VERIFIED_NODE_PATH': '/usr/bin/node', 'VERIFIED_NODE_SHA256': 'b' * 64,
            'HOME': '/home/runner',
            'BUBBLEWASH_OWNER_EMAIL': OWNER, 'GH_TOKEN': 'SYNTHETIC_NOT_FOR_SSH'}


class Protocol(unittest.TestCase):
    def setUp(self):
        mock = patch.object(t, 'runtime_pins', return_value=('e' * 40, request()['sourcePins']))
        mock.start(); self.addCleanup(mock.stop)

    def test_rejects_missing_extra_unsafe_or_unapproved_fields(self):
        h.validate_request(request())
        for edit in [{'extra': True}, {'ownerEmail': OWNER + ',other@example.invalid'}, {'nodePath': '/usr/../bin/node'},
                     {'databasePath': 'relative.sqlite'}, {'mode': 'send'}, {'reviewedSha': 'main'}, {'runtimeSha': 'main'}, {'nodeSha256': ''}, {'sourcePins': {}}]:
            with self.subTest(edit=edit), self.assertRaises((ValueError, TypeError)):
                h.validate_request({**request(), **edit})
        with self.assertRaises(ValueError): h.validate_request({'ownerEmail': OWNER})

    def test_result_is_exact_typed_and_coarse(self):
        for value in [{'attempted': False, 'status': 'ready'}, {'attempted': None, 'status': 'review-required'}, {'attempted': True, 'status': 'accepted'}]:
            self.assertEqual(h.validate_result(value), value)
        for value in [None, [], {'attempted': 1, 'status': 'accepted'}, {'attempted': False, 'status': 'accepted'}, {'attempted': True, 'status': 'accepted', 'secret': KEY}]:
            with self.assertRaises(ValueError): h.validate_result(value)

    def test_public_program_has_no_private_values_or_initializer_call(self):
        command = t.public_program()
        self.assertLess(len(command), 100000)
        self.assertNotIn(OWNER, command); self.assertNotIn(KEY, command)
        self.assertEqual(shlex.split(command)[:4], ['/usr/bin/python3', '-I', '-B', '-c'])
        # Compile the exact emitted program without executing host operations.
        code = shlex.split(command)[4]
        captured = []
        with patch('builtins.exec', side_effect=lambda value: captured.append(value)):
            eval(compile(code, '<public-bootstrap>', 'exec'), {'base64': base64, 'zlib': zlib})
        self.assertEqual(len(captured), 1)

    def test_request_refuses_debug_wrong_repo_source_drift_and_send_rerun(self):
        def bounded(argv, **_):
            return (SHA + '\n').encode() if 'rev-parse' in argv else b''
        facts = SimpleNamespace(require=f.require, bounded=bounded)
        h.validate_request(t.request(environment(), OWNER, facts, h))
        for edit in [{'RUNNER_DEBUG': '1'}, {'ACTIONS_STEP_DEBUG': 'true'}, {'GITHUB_REF': 'refs/heads/feature'},
                     {'GITHUB_SHA': 'd' * 40}, {'TEST_MODE': 'send', 'DELIVERY_APPROVED': 'true', 'GITHUB_RUN_ATTEMPT': '2'}]:
            with self.subTest(edit=edit), self.assertRaises(ValueError):
                t.request({**environment(), **edit}, OWNER, facts, h)
        facts.bounded = lambda *a, **kw: b'dirty'
        with self.assertRaises(ValueError): t.request(environment(), OWNER, facts, h)

    def test_transport_recipient_only_stdin_clean_environment_and_one_attempt(self):
        calls = []
        def bounded(argv, data=None, **kwargs):
            if 'rev-parse' in argv: return (SHA + '\n').encode()
            if 'status' in argv: return b''
            calls.append((argv, data, kwargs))
            self.assertEqual(argv[:3], ['/usr/local/bin/tailscale', 'ssh', 'root@hermes'])
            self.assertNotIn(OWNER, repr(argv)); self.assertNotIn(KEY, repr(argv))
            self.assertNotIn('BUBBLEWASH_OWNER_EMAIL', os.environ)
            self.assertEqual(json.loads(data)['ownerEmail'], OWNER)
            self.assertEqual(set(kwargs['env']), {'PATH', 'HOME', 'LC_ALL'})
            self.assertNotIn('SYNTHETIC_NOT_FOR_SSH', repr(kwargs['env']))
            return b'{"attempted":false,"status":"ready"}'
        facts = SimpleNamespace(require=f.require, bounded=bounded, canonical=f.canonical, strict_json=f.strict_json)
        output = io.StringIO()
        with patch.dict(os.environ, environment(), clear=True), patch.object(t, 'module', side_effect=[facts, h]), contextlib.redirect_stdout(output):
            self.assertEqual(t.main(), 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(output.getvalue()), {'attempted': False, 'status': 'ready'})

    def test_transport_uncertainty_never_retries_or_exposes_errors(self):
        for mode, expected in [('check', {'attempted': False, 'status': 'blocked'}), ('send', {'attempted': None, 'status': 'review-required'})]:
            calls = []
            def bounded(argv, data=None, **kwargs):
                if 'rev-parse' in argv: return (SHA + '\n').encode()
                if 'status' in argv: return b''
                calls.append(1); raise RuntimeError(KEY + OWNER)
            facts = SimpleNamespace(require=f.require, bounded=bounded, canonical=f.canonical, strict_json=f.strict_json)
            output = io.StringIO()
            with patch.dict(os.environ, {**environment(), 'TEST_MODE': mode, 'DELIVERY_APPROVED': 'true'}, clear=True), patch.object(t, 'module', side_effect=[facts, h]), contextlib.redirect_stdout(output):
                self.assertEqual(t.main(), 1)
            self.assertEqual(len(calls), 1); self.assertEqual(json.loads(output.getvalue()), expected)


class RuntimeArtifact(unittest.TestCase):
    def test_exact_full_git_tree_and_hashes_not_current_main_source(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(['/usr/bin/git', '-C', str(root), *args], stderr=subprocess.DEVNULL)
            git('init', '-q')
            (root / 'runtime.txt').write_text('reviewed runtime only')
            git('add', 'runtime.txt')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
            sha = git('rev-parse', 'HEAD').decode().strip()
            pins = {'schema': 'bubblewash-survey-only/v1', 'runtimeTree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
                    'runtimeFiles': {'runtime.txt': hashlib.sha256((root / 'runtime.txt').read_bytes()).hexdigest()}}
            def bounded(argv, **kwargs):
                self.assertEqual(kwargs['env'], {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
                raw = subprocess.check_output(argv, env=kwargs['env'], stderr=subprocess.DEVNULL)
                self.assertLessEqual(len(raw), kwargs['limit']); return raw
            facts = SimpleNamespace(require=f.require, bounded=bounded)
            with patch.object(t, 'ROOT', root), patch.object(t, 'source', side_effect=lambda _: json.dumps(pins).encode()):
                self.assertEqual(t.runtime_pins({'RUNTIME_SHA': sha}, facts), (sha, pins['runtimeFiles']))
                for edit in ['hash', 'missing', 'extra', 'tree', 'sha']:
                    original = json.loads(json.dumps(pins)); value = sha
                    if edit == 'hash': pins['runtimeFiles']['runtime.txt'] = '0' * 64
                    if edit == 'missing': pins['runtimeFiles'] = {}
                    if edit == 'extra': pins['runtimeFiles']['unreviewed.txt'] = 'a' * 64
                    if edit == 'tree': pins['runtimeTree'] = 'a' * 40
                    if edit == 'sha': value = 'main'
                    with self.subTest(edit=edit), self.assertRaises(ValueError): t.runtime_pins({'RUNTIME_SHA': value}, facts)
                    pins.clear(); pins.update(original)


class Host(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name); self.runtime = self.root / 'runtime'; self.runtime.mkdir()
        (self.runtime / 'deploy.lock').touch(mode=0o600)
        self.release = self.root / 'release'; self.release.mkdir()
        self.current = self.root / 'current'; self.current.symlink_to(self.release, target_is_directory=True)
        self.config = self.root / 'config'; self.config.mkdir(mode=0o700)
        self.env = self.config / 'env'; self.db = self.root / 'existing.sqlite'; self.db.touch(mode=0o600)
        self.marker = self.runtime / 'current-release'; self.marker.write_text(f'sha={"e" * 40}\npath={self.release}\n')
        self.env.write_text(f'BUBBLEWASH_DATABASE_DRIVER=sqlite\nBUBBLEWASH_DATABASE_PATH={self.db}\nBUBBLEWASH_RESEARCH_RESEND_KEY={KEY}\nNODE_OPTIONS=untrusted\n')
        self.env.chmod(0o600)
        self.value = request()
        self.calls = []
        def bounded(argv, data=None, **kwargs):
            if '--version' in argv: return b'v22.23.3\n'
            self.calls.append((argv, data, kwargs))
            self.assertEqual(json.loads(data), {'ownerEmail': OWNER})
            self.assertNotIn(OWNER, repr(argv)); self.assertNotIn(KEY, repr(argv))
            self.assertEqual(set(kwargs['env']), {'PATH', 'HOME', 'LC_ALL', 'NODE_ENV', 'BUBBLEWASH_DATABASE_PATH', 'BUBBLEWASH_RESEARCH_RESEND_KEY'})
            return b'{"attempted":false,"status":"ready"}'
        def source(path, *_):
            if str(path) == '/usr/bin/node': return {'sha256': 'b' * 64, 'trustedOwnership': True}
            return {'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest(), 'trustedOwnership': True}
        self.facts = SimpleNamespace(require=f.require, strict_json=f.strict_json, bounded=bounded, source=source,
            installer_metadata=lambda *_: ({k: True for k in ('environmentMetadataSafe', 'deploymentLockMetadataSafe', 'toolsMetadataSafe')}, set()),
            trusted_executable=lambda x: x, ancestry=lambda _: [{'kind': 'directory', 'uid': os.getuid(), 'mode': 0o700}])
        self.patches = [patch.object(h, 'ENV', self.env), patch.object(h, 'CURRENT', self.current), patch.object(h, 'RUNTIME', self.runtime),
                        patch.object(h, 'verify_source'), patch.object(h, 'verify_runtime'), patch.object(h.os, 'chdir')]
        for item in self.patches: item.start(); self.addCleanup(item.stop)

    def operation(self, value=None):
        return h.run(value or self.value, self.facts, i, p, os.getuid(), os.getgid())

    def test_host_check_uses_existing_lock_env_and_private_stdin_only(self):
        self.assertEqual(self.operation(), {'attempted': False, 'status': 'ready'})
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn('NODE_OPTIONS', self.calls[0][2]['env'])

    def test_unsafe_env_or_database_binding_blocks_before_child(self):
        for edit in [lambda: self.env.chmod(0o644), lambda: self.db.unlink(), lambda: self.marker.write_text('sha=' + 'd' * 40 + '\npath=' + str(self.release))]:
            old = self.env.read_bytes(); old_marker = self.marker.read_bytes()
            edit(); self.assertEqual(self.operation(), {'attempted': False, 'status': 'blocked'}); self.assertFalse(self.calls)
            self.env.write_bytes(old); self.env.chmod(0o600); self.marker.write_bytes(old_marker); self.db.touch(mode=0o600)
        self.env.write_text(self.env.read_text().replace(str(self.db), 'relative.sqlite'))
        self.assertEqual(self.operation(), {'attempted': False, 'status': 'blocked'})

    def test_parent_guard_failure_is_hard_stop_without_content_read(self):
        self.config.chmod(0o777)
        with patch.object(h.os, 'read') as read:
            self.assertEqual(self.operation(), {'attempted': False, 'status': 'blocked'})
        read.assert_not_called(); self.assertFalse(self.calls)

    def test_collector_aggregate_is_not_used_and_parent_drift_refuses(self):
        self.facts.installer_metadata = lambda *_: (_ for _ in ()).throw(AssertionError('not authority'))
        self.assertEqual(self.operation(), {'attempted': False, 'status': 'ready'})
        with h.retained_environment(self.facts, i, os.getuid(), os.getgid()) as (_, unchanged):
            self.config.chmod(0o755)
            with self.assertRaises(ValueError): unchanged()

    def test_symlink_hardlink_and_unsafe_sidecar_refused(self):
        real = self.root / 'real-env'; self.env.rename(real); self.env.symlink_to(real)
        self.assertEqual(self.operation(), {'attempted': False, 'status': 'blocked'})
        self.env.unlink(); os.link(real, self.env)
        self.assertEqual(self.operation(), {'attempted': False, 'status': 'blocked'})
        self.env.unlink(); real.rename(self.env)
        sidecar = Path(str(self.db) + '-wal'); sidecar.symlink_to(self.marker)
        self.assertEqual(self.operation(), {'attempted': False, 'status': 'blocked'}); self.assertFalse(self.calls)

    def test_retained_env_replacement_or_content_change_refused(self):
        with h.retained_environment(self.facts, i, os.getuid(), os.getgid()) as (_, unchanged):
            self.env.write_text('MODIFIED=yes\n')
            with self.assertRaises(ValueError): unchanged()

    def test_uncertain_send_or_post_send_binding_drift_is_never_false_no_attempt(self):
        self.value.update(mode='send', deliveryApproved=True)
        for outcome in ('error', 'drift'):
            calls = []
            def bounded(argv, data=None, **kwargs):
                if '--version' in argv: return b'v22.23.3\n'
                calls.append(1)
                if outcome == 'error': raise RuntimeError(KEY)
                self.env.write_text('CHANGED=true\n')
                return b'{"attempted":true,"status":"accepted"}'
            self.facts.bounded = bounded
            self.assertEqual(self.operation(), {'attempted': None, 'status': 'review-required'})
            self.assertEqual(len(calls), 1)

    def test_main_irreversibly_drops_uid_before_any_app_file(self):
        events = []
        facts = SimpleNamespace(require=f.require, strict_json=f.strict_json)
        def operation(*args):
            self.assertEqual(events, ['groups', 'gid', 'uid'])
            return {'attempted': False, 'status': 'ready'}
        with patch.object(h.os, 'geteuid', side_effect=[0, 1000]), patch.object(h.os, 'getuid', return_value=1000), \
             patch.object(h.os, 'uname', side_effect=AssertionError('OS hostname is not the authenticated tailnet identity')), \
             patch.object(h.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1000, pw_gid=1000)), \
             patch.object(h.os, 'setgroups', side_effect=lambda _: events.append('groups')), patch.object(h.os, 'setgid', side_effect=lambda _: events.append('gid')), \
             patch.object(h.os, 'setuid', side_effect=lambda _: events.append('uid')), patch.object(h, 'run', side_effect=operation), \
             patch.object(h.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(self.value).encode()))), contextlib.redirect_stdout(io.StringIO()) as output:
            h.main(facts, i, p)
        self.assertEqual(json.loads(output.getvalue()), {'attempted': False, 'status': 'ready'})

    def test_nonroot_operator_never_reads_request_or_runs_app(self):
        with patch.object(h.os,'geteuid',return_value=1000),patch.object(h.sys,'stdin',None),patch.object(h,'run') as run,contextlib.redirect_stdout(io.StringIO()) as output:
            h.main(self.facts,i,p)
        run.assert_not_called();self.assertEqual(json.loads(output.getvalue()),{'attempted':False,'status':'blocked'})


class Workflow(unittest.TestCase):
    def test_fixed_environment_action_pins_private_recipient_no_provider_key_from_actions(self):
        text = (ROOT / '.github/workflows/research-email-test.yml').read_text()
        for value in ['environment: backup-storage', 'group: bubblewash-production', 'cancel-in-progress: false',
                      'default: check', 'default: false', 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
                      'tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8',
                      'BUBBLEWASH_OWNER_EMAIL: ${{ secrets.BUBBLEWASH_OWNER_EMAIL }}']:
            self.assertIn(value, text)
        self.assertIn('protected owner recipient only; no CC or BCC', text)
        self.assertNotIn('info@bubblewash.co', text)
        self.assertNotIn('database_path', text)
        self.assertNotIn('VERIFIED_DATABASE_PATH', text)
        self.assertNotIn('secrets.BUBBLEWASH_RESEARCH_RESEND_KEY', text)
        self.assertNotIn('upload-artifact', text)
        self.assertNotIn(OWNER, text)


class RuntimeBinding(unittest.TestCase):
    def test_listener_not_main_pid_proves_node_and_binding_drift_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); release = root / 'release'; release.mkdir()
            node = root / 'node'; node.touch(); proc = root / 'proc'; proc.mkdir()
            for pid in (41, 42):
                folder = proc / str(pid); folder.mkdir(); (folder / 'cwd').symlink_to(release, target_is_directory=True)
                (folder / 'cgroup').write_text('0::/application')
                (folder / 'environ').write_bytes(b'BUBBLEWASH_DATABASE_PATH=/private/test.sqlite\0IGNORED=synthetic-secret\0')
            (proc / '42' / 'exe').symlink_to(node)
            original_path = Path
            def paths(value):
                value = str(value)
                return proc / value[len('/proc/'): ] if value.startswith('/proc/') else proc if value == '/proc' else original_path(value)
            unit = f'LoadState=loaded\nActiveState=active\nNeedDaemonReload=no\nMainPID=41\nWorkingDirectory={release}\nEnvironmentFiles={h.ENV} (ignore_errors=no)\n'.encode()
            def bounded(argv, **kwargs):
                return unit if argv[0] == '/usr/bin/systemctl' else b'LISTEN users:(("node",pid=42,fd=20))'
            facts = SimpleNamespace(require=f.require, trusted_executable=lambda x:x, bounded=bounded)
            proof = SimpleNamespace(parse_env=p.parse_env, process_identity=lambda pid:(pid, 123), bounded_bytes=lambda path, limit: path.read_bytes(), runtime_flags=lambda pid:{'NODE_ENV':'production'})
            with patch.object(h, 'Path', side_effect=paths):
                h.verify_runtime(facts, proof, release, str(node), os.getuid(), Path('/private/test.sqlite'))
                (proc / '42' / 'cgroup').write_text('0::/another-service')
                with self.assertRaises(ValueError): h.verify_runtime(facts, proof, release, str(node), os.getuid(), Path('/private/test.sqlite'))
                (proc / '42' / 'cgroup').write_text('0::/application')
                with self.assertRaises(ValueError): h.verify_runtime(facts, proof, release, str(root / 'different-node'), os.getuid(), Path('/private/test.sqlite'))
                for raw in (b'', b'BUBBLEWASH_DATABASE_PATH=/wrong\0', b'BUBBLEWASH_DATABASE_PATH=/private/test.sqlite\0BUBBLEWASH_DATABASE_PATH=/private/test.sqlite\0'):
                    (proc / '42' / 'environ').write_bytes(raw)
                    with self.assertRaises(ValueError): h.verify_runtime(facts, proof, release, str(node), os.getuid(), Path('/private/test.sqlite'))
                facts.bounded = lambda argv, **kwargs: unit if argv[0] == '/usr/bin/systemctl' else b'pid=42 pid=43'
                with self.assertRaises(ValueError): h.verify_runtime(facts, proof, release, str(node), os.getuid(), Path('/private/test.sqlite'))



class SourceOwnership(unittest.TestCase):
    def test_protected_same_user_dependencies_allowed_but_escape_and_writes_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory); modules = release / 'node_modules'; modules.mkdir(mode=0o700)
            dependency = modules / 'dependency.js'; dependency.write_text('export default 1;'); dependency.chmod(0o600)
            facts = SimpleNamespace(require=f.require, source=lambda path, uid, limit:{'trustedOwnership':True,'sha256':'c'*64})
            h.verify_source(facts, release, {}, os.getuid())
            dependency.chmod(0o622)
            with self.assertRaises(ValueError): h.verify_source(facts, release, {}, os.getuid())
            dependency.chmod(0o600)
            (modules / 'escape').symlink_to(release)
            with self.assertRaises(ValueError): h.verify_source(facts, release, {}, os.getuid())


if __name__ == '__main__': unittest.main()
