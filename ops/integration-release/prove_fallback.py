#!/usr/bin/env python3
"""Runner-only proof for immutable accepted fallback; never a deployment/source-policy override.

The historical backup run remains failed. This separately committed control
package verifies the pristine fallback, creates a disposable two-test-file
harness, and exercises every original backup/preserving/owner test. No installed
fallback file, historical selector, diagnostic pin, or host engine is changed.
"""
import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
FALLBACK = {
    'commit': '80ec00902fcc5fe16a17ab814c7d191ad44afb64',
    'tree': 'c90fe5e836022d8084d0f8f936e5d00bb8522be6',
    'files': 331,
    'contentSha256': '638c7e6f5524b18a62484cbdf614b2e2df4e0df4e4045122ccc53fc9a722bee2',
}
HISTORICAL_EVIDENCE = {
    'pilot': {'runId': 40112979424, 'conclusion': 'success'},
    'browser': {'runId': 40112914981, 'conclusion': 'success',
                'artifactId': 12567173726,
                'artifactSha256': '3be6625ef60329c9da0ade9035b734414168d26538a2b247d575b19fcb2f59a7'},
    'backup': {'runId': 40104978158, 'conclusion': 'failure',
               'retainedAsHistoricalFailure': True,
               'commit': 'f5354485d1d7d1f9509c7da977aea840ae13eb71'},
}

SUITES = {
    'backup': ('.github/backup', 'test_*.py', 102),
    'preserving': ('tests', 'test_preserving_deploy.py', 105),
    'owner': ('tests', 'test_owner_deploy.py', 20),
}
# Exact reviewed inputs AND outputs, not a general-purpose test allowlist.
OVERLAY = {
    '.github/backup/test_owner_enrollment.py': {
        'beforeSha256': 'adf73314b5799c74d51d74252ad07923c9bd5ac167cee0c1b9334ea199555ad6',
        'afterSha256': '5a241b55e572b7b55c7d9766bc39559803e5bb21fb7de9e0623a6c2bf077ce49',
    },
    'tests/test_owner_deploy.py': {
        'beforeSha256': '04c619482a99780d3f99ceaa2d74fac810afd7345f92d13aaf91abdae91561da',
        'afterSha256': '0ddb11886fa64b0ecdf9d6d66bb5b99401bef65222f1ce589528728514dd0496',
    },
}
ENROLLMENT_BEFORE = """        self.assertTrue(SOURCE_MATCHES(ROOT,pins))
"""
ENROLLMENT_AFTER = """        # Test-only runner recognition; the historical host selector MUST refuse.
        proof_spec=importlib.util.spec_from_file_location('fallback_control_proof',os.environ['BUBBLEWASH_FALLBACK_PROOF_SCRIPT'])
        proof=importlib.util.module_from_spec(proof_spec); proof_spec.loader.exec_module(proof)
        self.assertEqual(proof.verify_runner_harness(ROOT),'integration-fallback-v1')
        self.assertFalse(SOURCE_MATCHES(ROOT,pins))
"""
OWNER_IMPORT_BEFORE = """spec.loader.exec_module(owner)

ORIGINAL_GATE"""
OWNER_IMPORT_AFTER = """spec.loader.exec_module(owner)


def verify_fallback_test_harness():
    # This helper is injected only into an exact, disposable test harness.
    proof_spec = importlib.util.spec_from_file_location(
        'fallback_control_proof', __import__('os').environ['BUBBLEWASH_FALLBACK_PROOF_SCRIPT'])
    proof = importlib.util.module_from_spec(proof_spec)
    proof_spec.loader.exec_module(proof)
    return proof.verify_runner_harness(ROOT)


ORIGINAL_GATE"""
DIAGNOSTIC_BEFORE = """        for relative, expected in pins.items():
            self.assertEqual(owner.digest(ROOT / relative), expected)
"""
DIAGNOSTIC_AFTER = """        self.assertEqual(verify_fallback_test_harness(), 'integration-fallback-v1')
        # The unchanged historical diagnostic must reject the real fallback.
        with self.assertRaisesRegex(ValueError, '^pin$'):
            namespace['reference_ddl'](ROOT, pins)
        # Exercise the same positive DDL semantics with test-only exact fallback
        # hashes AFTER whole pristine/harness verification. Never change owner
        # constants, host selectors, or the runtime diagnostic's accepted pins.
        pins = {
            'src/lib/data-store.ts': 'b448962f8d6b8039485f39a80b4782a0a82b3d93966d34b27a479fb27120bb0f',
            'src/lib/staff-accounts.ts': 'e2986ffd74a9d007a8489dc068bba9a7bcbdfd30f39b2a681c0a65c54e20960e',
        }
        for relative, expected in pins.items():
            self.assertEqual(owner.digest(ROOT / relative), expected)
"""
MANIFEST_BEFORE = """        self.assertEqual(owner.OWNER_CANDIDATE_SOURCE_MANIFEST, owner.source_manifest(ROOT))
"""
MANIFEST_AFTER = """        self.assertEqual(verify_fallback_test_harness(), 'integration-fallback-v1')
        self.assertNotEqual(owner.OWNER_CANDIDATE_SOURCE_MANIFEST, owner.source_manifest(ROOT))
        with self.assertRaises(ValueError):
            owner.verify_owner_candidate(ROOT)
"""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def git_object(kind, data):
    return hashlib.sha1(kind.encode() + b' ' + str(len(data)).encode() + b'\0' + data).digest()


def tree_hash(nodes):
    entries = []
    for name, value in sorted(nodes.items(), key=lambda pair: (pair[0] + ('/' if isinstance(pair[1], dict) else '')).encode()):
        mode, digest = ('40000', tree_hash(value)) if isinstance(value, dict) else value
        entries.append(mode.encode() + b' ' + name.encode() + b'\0' + digest)
    return git_object('tree', b''.join(entries))


def snapshot(root):
    """Hash EVERY non-.git file, including ignored/untracked files and all modes."""
    root = Path(root)
    require(root.is_absolute() and root.resolve(strict=True) == root and not root.is_symlink(), 'noncanonical proof source root')
    files, nodes, directories = {}, {}, []
    for directory, children, names in os.walk(root, followlinks=False):
        parent = Path(directory)
        if parent == root and '.git' in children:
            require(not (root/'.git').is_symlink(), 'unsafe Git metadata directory')
            children.remove('.git')
        for name in children:
            require(not (parent/name).is_symlink(), 'source directory symlink rejected')
            directories.append((parent/name).relative_to(root).as_posix())
        for name in names:
            path = parent/name
            rel = path.relative_to(root).as_posix()
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'nonregular or shared source file')
            data = path.read_bytes()
            mode = '100755' if info.st_mode & 0o111 else '100644'
            files[rel] = {'sha256': sha256(data), 'mode': mode}
            node = nodes
            for part in Path(rel).parts[:-1]:
                node = node.setdefault(part, {})
            node[Path(rel).name] = (mode, git_object('blob', data))
    require(all(any(name.startswith(directory+'/') for name in files) for directory in directories), 'untracked empty source directory')
    hashes = {name: value['sha256'] for name, value in files.items()}
    return {'tree': tree_hash(nodes).hex(), 'files': len(files),
            'contentSha256': sha256(canonical(hashes)), 'manifest': files}


def summary(value):
    return {name: value[name] for name in ('tree', 'files', 'contentSha256')}


def verify_pristine(root):
    value = snapshot(root)
    require(summary(value) == {key: FALLBACK[key] for key in ('tree', 'files', 'contentSha256')},
            'immutable fallback whole tree/content/count differs')
    return value


# This self-contained compact profile deliberately has no dependency on pending
# candidate/control contracts. Whole-tree verification additionally covers every
# control/test byte; runtime recognition is ONLY this fixed fallback profile.
FALLBACK_ROOT_FILES = (
    '.env.production.example', '.gitignore', 'DESIGN.md', 'README.md',
    'eslint.config.mjs', 'next.config.mjs', 'package-lock.json', 'package.json',
    'playwright.config.mjs', 'tsconfig.json',
)
FALLBACK_SOURCE_DIRS = ('src', 'public', 'scripts', 'ops', 'db', 'tests', '.github', 'tooling', 'docs', 'integration-evidence')
FALLBACK_PROFILE = {
    'name': 'integration-fallback-v1', 'publicationCommit': FALLBACK['commit'],
    'appInputGitTree': FALLBACK['tree'], 'contentSha256': FALLBACK['contentSha256'],
    'rootFiles': FALLBACK_ROOT_FILES,
}


def verify_compact_profile(root):
    value = verify_pristine(root)
    manifest = value['manifest']
    roots = {name for name in manifest if '/' not in name}
    require(roots == set(FALLBACK_PROFILE['rootFiles']), 'compact fallback root files differ')
    require(all('/' not in name or name.split('/', 1)[0] in FALLBACK_SOURCE_DIRS for name in manifest),
            'compact fallback source directory differs')
    require(sha256(canonical({name: row['sha256'] for name, row in manifest.items()})) == FALLBACK_PROFILE['contentSha256']
            and value['tree'] == FALLBACK_PROFILE['appInputGitTree'], 'compact fallback identity differs')
    return FALLBACK_PROFILE['name']


def test_inventory(source):
    tree = ast.parse(source)
    return sorted((node.name, item.name) for node in tree.body if isinstance(node, ast.ClassDef)
                  for item in node.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
                  and item.name.startswith('test_'))


def patched_bytes(relative, before):
    require(relative in OVERLAY and sha256(before) == OVERLAY[relative]['beforeSha256'], 'test patch preimage differs')
    edits = [(ENROLLMENT_BEFORE, ENROLLMENT_AFTER)] if relative.startswith('.github/') else [
        (OWNER_IMPORT_BEFORE, OWNER_IMPORT_AFTER), (DIAGNOSTIC_BEFORE, DIAGNOSTIC_AFTER), (MANIFEST_BEFORE, MANIFEST_AFTER)]
    result = before.decode('utf-8')
    for old, new in edits:
        require(result.count(old) == 1, 'test patch anchor is not unique')
        result = result.replace(old, new, 1)
    result = result.encode('utf-8')
    require(sha256(result) == OVERLAY[relative]['afterSha256'], 'reviewed test patch output differs')
    require(test_inventory(before) == test_inventory(result), 'test inventory changed')
    return result


def expected_harness_manifest(pristine, pristine_snapshot):
    manifest = {name: dict(value) for name, value in pristine_snapshot['manifest'].items()}
    for name, pins in OVERLAY.items():
        # Derive from exact original bytes; never authenticate arbitrary test edits.
        patched_bytes(name, (pristine/name).read_bytes())
        manifest[name]['sha256'] = pins['afterSha256']
    return manifest


def verify_harness(pristine, harness):
    pristine, harness = Path(pristine), Path(harness)
    require(pristine != harness and not harness.is_relative_to(pristine) and not pristine.is_relative_to(harness), 'harness must be separate from pristine fallback')
    original = verify_pristine(pristine)
    actual = snapshot(harness)
    require(actual['manifest'] == expected_harness_manifest(pristine, original), 'harness differs from exact reviewed two-file overlay')
    return actual


def verify_runner_harness(harness):
    """Test-only classification. This cannot authorize any historical host route."""
    pristine = Path(os.environ['BUBBLEWASH_FALLBACK_PRISTINE'])
    verify_harness(pristine, Path(harness))
    verify_compact_profile(pristine)
    return 'integration-fallback-v1'


def make_harness(pristine, destination):
    verify_pristine(pristine)  # Must happen BEFORE copying or deriving test changes.
    require(not destination.exists(), 'harness destination already exists')
    shutil.copytree(pristine, destination, ignore=lambda directory, names: ['.git'] if Path(directory) == pristine else [])
    for name in OVERLAY:
        (destination/name).write_bytes(patched_bytes(name, (pristine/name).read_bytes()))
    verify_harness(pristine, destination)


def git_binding(root, expected):
    require(re.fullmatch('[a-f0-9]{40}', expected or ''), 'exact commit required')
    def git(*arguments):
        return subprocess.check_output(['git', '-C', str(root), *arguments], text=True, timeout=30).strip()
    require(git('rev-parse', '--show-toplevel') == str(root), 'not a separate checkout')
    require(git('rev-parse', 'HEAD') == expected, 'checkout commit differs')
    require(not git('status', '--porcelain', '--untracked-files=all'), 'checkout is dirty')
    value = snapshot(root)
    require(value['tree'] == git('rev-parse', 'HEAD^{tree}'), 'checkout whole tree differs from commit')
    return {'commit': expected, **summary(value)}


def run_suite(name, harness, result_path):
    start, pattern, expected = SUITES[name]
    verify_runner_harness(harness)
    suite = unittest.TestLoader().discover(str(harness/start), pattern=pattern)
    require(suite.countTestCases() == expected, 'original suite test count differs')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    value = {'name': name, 'testsRun': result.testsRun, 'failures': len(result.failures),
             'errors': len(result.errors), 'skipped': len(result.skipped),
             'expectedFailures': len(result.expectedFailures),
             'unexpectedSuccesses': len(result.unexpectedSuccesses),
             'successful': result.wasSuccessful()}
    result_path.write_bytes(canonical(value) + b'\n')
    return 0 if suite_passed(value, name) else 1


def suite_passed(value, name):
    return (type(value) is dict and set(value) == {'name', 'testsRun', 'failures', 'errors', 'skipped', 'expectedFailures', 'unexpectedSuccesses', 'successful'}
            and value['name'] == name and type(value['testsRun']) is int and value['testsRun'] == SUITES[name][2]
            and value['successful'] is True
            and all(type(value[key]) is int and value[key] == 0 for key in ('failures', 'errors', 'skipped', 'expectedFailures', 'unexpectedSuccesses')))


def run_all_suites(pristine, harness, work):
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL') if key in os.environ}
    env.update(PYTHONDONTWRITEBYTECODE='1', BUBBLEWASH_FALLBACK_PRISTINE=str(pristine),
               BUBBLEWASH_FALLBACK_PROOF_SCRIPT=str(Path(__file__).resolve()))
    results = []
    for name in SUITES:  # No fail-fast: attempt all three original suites.
        output = work/(name+'-result.json')
        try:
            process = subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).resolve()),
                                      '--run-suite', name, '--harness', str(harness), '--suite-result', str(output)],
                                     cwd=harness, env=env, timeout=240, check=False)
            value = json.loads(output.read_bytes()) if output.is_file() else {'name': name, 'successful': False}
            if process.returncode != 0:
                value['successful'] = False
        except (subprocess.TimeoutExpired, OSError, ValueError):
            value = {'name': name, 'successful': False}
        results.append(value)
    return results


def prove(control, pristine, expected_control, output):
    require(Path(__file__).resolve() == control/'ops/integration-release/prove_fallback.py', 'proof script is not from selected controls')
    require(control != pristine and not control.is_relative_to(pristine) and not pristine.is_relative_to(control), 'separate control and fallback checkouts required')
    require(not output.exists() and not output.is_relative_to(control) and not output.is_relative_to(pristine), 'receipt must be new and outside source checkouts')
    control_binding = git_binding(control, expected_control)
    fallback_binding = git_binding(pristine, FALLBACK['commit'])
    require(fallback_binding == FALLBACK, 'fallback checkout provenance differs')
    before = verify_pristine(pristine)
    verify_compact_profile(pristine)
    with tempfile.TemporaryDirectory(prefix='bubblewash-fallback-proof-') as temporary:
        work = Path(temporary).resolve()
        harness = work/'harness'
        make_harness(pristine, harness)
        harness_before = verify_harness(pristine, harness)
        results = run_all_suites(pristine, harness, work)
        # Mandatory after-checks run even when a suite failed.
        harness_after = verify_harness(pristine, harness)
        after = verify_pristine(pristine)
        require(git_binding(control, expected_control) == control_binding, 'control checkout changed during proof')
        require(git_binding(pristine, FALLBACK['commit']) == fallback_binding, 'fallback checkout changed during proof')
        require(summary(before) == summary(after) and summary(harness_before) == summary(harness_after), 'proof source changed during suites')
        require(len(results) == len(SUITES) and all(suite_passed(value, name) for value, name in zip(results, SUITES)), 'one or more original fallback suites failed or skipped')
        receipt = {
            'schema': 'bubblewash-fallback-control-proof/v1', 'status': 'passed',
            'scope': 'runner-only-no-host-action', 'control': control_binding,
            'fallback': fallback_binding, 'historicalEvidence': HISTORICAL_EVIDENCE,
            'overlay': OVERLAY, 'suites': results,
            'integrity': {'pristineBefore': summary(before), 'pristineAfter': summary(after),
                          'harnessBefore': summary(harness_before), 'harnessAfter': summary(harness_after),
                          'exactTwoTestFileDeltas': True, 'productionByteEquality': True},
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as stream:
            stream.write(canonical(receipt) + b'\n')
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control-root', type=Path)
    parser.add_argument('--fallback-root', type=Path)
    parser.add_argument('--control-sha')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--run-suite', choices=tuple(SUITES), help=argparse.SUPPRESS)
    parser.add_argument('--harness', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--suite-result', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.run_suite:
        require(args.harness is not None and args.suite_result is not None, 'suite paths required')
        return run_suite(args.run_suite, args.harness.resolve(strict=True), args.suite_result)
    require(args.control_root is not None and args.fallback_root is not None and args.output is not None, 'proof checkout/output arguments required')
    require(args.control_sha == os.environ.get('GITHUB_SHA') and os.environ.get('GITHUB_ACTIONS') == 'true', 'hosted proof must bind exact control GITHUB_SHA')
    prove(args.control_root.resolve(strict=True), args.fallback_root.resolve(strict=True), args.control_sha, args.output.resolve())
    print('Separate immutable-fallback control proof passed; historical backup run remains failed. No host action performed.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('Fallback control proof refused: ' + str(error), file=sys.stderr)
        raise SystemExit(1) from None
