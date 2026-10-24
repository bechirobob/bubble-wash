"""Exact, content-addressed integration identities. No source allowlist expansion."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

HERE = Path(__file__).resolve().parent
BASELINE = '5dc997db0393e1cf88dde29859b7e1c4550ee4ee'
LIVE_SHA = '853b7c1020fb7dab66f302a2603369d5fa8b3dff'
LIVE_TREE = '24fbe62668c996d0821153cf341b24765ef653b1'
COORDINATED_UNITS = ('system/bubblewash-maintenance.timer', 'system/bubblewash-maintenance.service', 'user/bubblewash-local.service')
RESIDUAL_ASSUMPTION = 'Deployment coordinates the three known Bubble Wash units under the exclusive deployment lock and persistent holds. Privileged root, ubuntu and other operators or unknown invokers are not technically excluded; they must not write the database or launch Bubble Wash during the approved window.'
RESIDUAL_ASSUMPTION_SHA256 = hashlib.sha256(RESIDUAL_ASSUMPTION.encode()).hexdigest()
PREPARATION_HELPER_SHA256 = '1b3ca324c50241d561868f432b081bb761875c9cd696df30846a976997529a2e'
FALLBACK_CONTROL_PROOF = {
    'controlSha': 'a01336dd8a873f31d41fa4343631ddd7a8c03819',
    'runId': 40139632801,
    'artifactId': 12578210919,
    'artifactSha256': 'f97e4cdd041a2f7deb6113c0adfd500ed0cc51cbd7eb317f96d5eee02a6f1019',
}  # Actual successful hosted proof, independently downloaded and verified.

PROFILE_NAMES = ('integration-candidate-v1', 'integration-fallback-v1')
VENDOR = {
 'bubblewash-durable-controller/controller.py': '136df02ef9303acbbb7627ae3ed4b51f00d42fe748ea988726cd267fa0bcb9bf',
 'bubblewash-migration-transition/transition.py': '1a3eab202dafbfa90e7b4163ecf6e1caca053195953b70e5a6f0577803e9f42f',
 'bubblewash-web-a476-baseline/ops/deploy-preserving.py': '29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a',
}
SOURCE_DIRS = ('src', 'public', 'scripts', 'ops', 'db', 'tests', '.github', 'tooling', 'docs', 'integration-evidence')
# This review package is pinned independently by adapterFiles/adapterSha256.
# It cannot be part of its own source-content manifest.
CONTROL_PREFIX = 'ops/integration-release/'
GENERATED = {'next-env.d.ts', 'tsconfig.tsbuildinfo'}

def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def object_digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def relative(name):
    p = Path(name)
    require(isinstance(name, str) and name and not p.is_absolute() and '..' not in p.parts
            and p.as_posix() == name and '\\' not in name, 'invalid manifest path')
    return p


def read_json(path):
    def pairs(rows):
        obj = {}
        for key, value in rows:
            require(key not in obj, 'duplicate JSON key')
            obj[key] = value
        return obj
    return json.loads(Path(path).read_bytes(), object_pairs_hook=pairs)


def regular(path):
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe regular-file identity')
    return info


def content_manifest(root, root_files):
    root = Path(root)
    require(root.resolve(strict=True) == root and not root.is_symlink(), 'noncanonical source root')
    result = {}
    allowed_dirs = set(SOURCE_DIRS) | {'.git', '.next', 'node_modules', 'data'}
    allowed_files = set(root_files) | GENERATED | {'.release-sha'}
    for entry in root.iterdir():
        if entry.is_dir() or (entry.is_symlink() and entry.name == 'node_modules'):
            require(entry.name in allowed_dirs, 'unexpected source root directory')
        else:
            require(entry.name in allowed_files, 'unexpected source root file')
    for name in SOURCE_DIRS:
        directory = root / name
        if not directory.exists():
            continue
        require(directory.is_dir() and not directory.is_symlink(), 'source directory invalid')
        for path in sorted(directory.rglob('*')):
            rel = path.relative_to(root).as_posix()
            if rel.startswith(CONTROL_PREFIX):
                continue
            require(not path.is_symlink(), 'source symlink rejected')
            if path.is_dir():
                continue
            regular(path)
            result[rel] = digest(path)
    for name in root_files:
        relative(name)
        require('/' not in name and name not in GENERATED, 'invalid source root pin')
        regular(root/name)
        result[name] = digest(root/name)
    return result


def verify_source(root, contract, profile):
    require(contract.get('schema') == 'bubblewash-integration-source/v2'
            and contract.get('baseCommit') == BASELINE
            and set(contract.get('profiles', {})) == set(PROFILE_NAMES), 'unknown integration source contract')
    require(profile in PROFILE_NAMES, 'unknown integration profile')
    pinned = contract['profiles'][profile]
    require(type(pinned) is dict and set(pinned) == {'contentSha256', 'rootFiles', 'appInputGitTree', 'publicationCommit'}, 'invalid compact source profile')
    require(type(pinned['contentSha256']) is str and re.fullmatch('[a-f0-9]{64}', pinned['contentSha256']), 'invalid source commitment')
    require(type(pinned['rootFiles']) is list and all(type(name) is str for name in pinned['rootFiles']) and len(set(pinned['rootFiles'])) == len(pinned['rootFiles']), 'invalid source root pins')
    require(object_digest(content_manifest(Path(root).resolve(), pinned['rootFiles'])) == pinned['contentSha256'], 'exact integration source differs')
    return pinned


def dependency_manifest(root):
    """Pin all installed bytes/modes and safe internal symlink targets, including native addons."""
    root = Path(root)
    require(root.is_dir() and not root.is_symlink() and root.resolve(strict=True) == root, 'shared or symlinked dependency root refused')
    result = {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root).as_posix()
        info = path.lstat()
        if path.is_symlink():
            target = os.readlink(path)
            require(not Path(target).is_absolute() and path.resolve(strict=True).is_relative_to(root), 'dependency link escapes installation')
            require(path.resolve().is_file(), 'dependency directory link refused')
            result[rel] = {'link': target}
        elif path.is_dir():
            continue
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe dependency object')
            result[rel] = {'sha256': digest(path), 'mode': stat.S_IMODE(info.st_mode)}
    require(result and 'next/package.json' in result and 'better-sqlite3/package.json' in result, 'installed dependencies incomplete')
    return result


def load_controller():
    sys.dont_write_bytecode = True
    for name, pin in VENDOR.items():
        require(digest(HERE/'vendor'/name) == pin, 'frozen release primitive changed')
    source = HERE/'vendor/bubblewash-durable-controller/controller.py'
    spec = importlib.util.spec_from_file_location('bubblewash_frozen_controller', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Defend against an earlier unrelated `transition` import in the same process.
    require(Path(module.core.__file__).resolve() == HERE/'vendor/bubblewash-migration-transition/transition.py', 'wrong transition module loaded')
    class CoordinatedController(module.Controller):
        def pins(self):
            require(hashlib.sha256(json.dumps(self.plan,sort_keys=True).encode()).hexdigest()==self.plan_hash,'release plan mutated')
            roots=[Path(self.plan[key]) for key in ('old','candidate','fallback')]
            require(len(set(roots))==3 and all(path.is_dir() and not path.is_symlink() and path.resolve(strict=True)==path for path in roots),'release roots must be independent and canonical')
            require(Path(self.plan['current']).is_symlink(),'current must remain symlink')
            database=Path(self.plan['database']);snapshot=Path(self.plan['snapshot'])
            require(database.is_absolute() and database.resolve(strict=True)==database and not any(database.is_relative_to(root) for root in roots),'unstable database path')
            require(snapshot.is_absolute() and snapshot!=database and not any(snapshot.is_relative_to(root) for root in roots),'unsafe snapshot path')
            required_helpers={str(HERE/'vendor/bubblewash-durable-controller/controller.py'),str(Path(module.core.__file__).resolve())}
            require(required_helpers.issubset(self.plan.get('controllerPins',{})),'controller/helper pins missing')
            for name,digest in self.plan['controllerPins'].items():require(module.core.digest(name)==digest,'controller/helper changed')
            require(self.guard() is True,'host lock/backup/config not verified')
            require(getattr(self.guard,'database_path',None)==Path(self.plan['database']),'guarded database not bound to plan')
            require(getattr(self.guard,'marker_path',None)==Path(self.plan['marker']),'guarded release marker not bound to plan')
            self.state.check();require(self.verify_gates() is True,'effective installed gates not verified')
            require('externalInvokersExcluded' not in self.plan, 'legacy global exclusion claim refused')
            hold = self.plan.get('coordinatedWriterHold')
            require(type(hold) is dict and set(hold) == {'schema', 'knownUnits', 'knownInvokersSha256', 'riskApprovalSha256', 'residualAccessAcknowledged', 'residualAssumptionSha256'}, 'coordinated writer review missing')
            require(hold['schema'] == 'bubblewash-coordinated-writer-hold/v1' and hold['knownUnits'] == list(COORDINATED_UNITS) and hold['residualAccessAcknowledged'] is True and hold['residualAssumptionSha256'] == RESIDUAL_ASSUMPTION_SHA256, 'coordinated writer boundary differs')
            require(all(type(hold[k]) is str and re.fullmatch('[a-f0-9]{64}', hold[k]) for k in ('knownInvokersSha256', 'riskApprovalSha256')), 'coordinated review digests invalid')
            require(str(HERE/'contracts.py') in self.plan['controllerPins'], 'named controller policy pin missing')
            for key in ('candidate','fallback'):
                target=Path(self.plan[key]);manifest=self.plan['manifests'][key]
                require(manifest.get('releaseSha')==self.plan['releaseShas'][key],'release identity differs')
                module.core.verify_release(target,manifest);module.owner_compatible(target,manifest,self.plan['ownerContract'])
            db=Path(self.plan['database']);require(module.file_identity(db)[:2]==tuple(self.plan['databaseIdentity']),'database replaced')
    module.CoordinatedController = CoordinatedController
    return module


def runtime_manifest(root, release_sha):
    require(re.fullmatch('[a-f0-9]{40}', release_sha or ''), 'real published commit required')
    root = Path(root).resolve(strict=True)
    files = {}
    for directory in ('src', 'public', '.next', 'scripts', 'ops'):
        require((root/directory).is_dir() and not (root/directory).is_symlink(), 'runtime root invalid')
        for path in (root/directory).rglob('*'):
            if directory == '.next' and path.relative_to(root/'.next').parts[0] == 'cache':
                continue
            require(not path.is_symlink(), 'runtime symlink rejected')
            if path.is_dir():
                continue
            regular(path)
            files[path.relative_to(root).as_posix()] = digest(path)
    for name in ('package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json'):
        regular(root/name); files[name] = digest(root/name)
    return {'releaseSha': release_sha, 'files': files, 'buildIdSha256': digest(root/'.next/BUILD_ID')}


def git_binding(root, expected):
    require(re.fullmatch('[a-f0-9]{40}', expected or ''), 'real commit SHA required')
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True, timeout=30).strip()
    require(git('rev-parse', 'HEAD') == expected, 'checkout commit differs')
    require(not git('status', '--porcelain', '--untracked-files=normal'), 'checkout is not clean')
    return {'commit': expected, 'tree': git('rev-parse', 'HEAD^{tree}')}


def verify_published_source(root, contract, profile, commit):
    pinned = verify_source(root, contract, profile)
    require(commit == pinned['publicationCommit'], 'published source commit differs')
    binding = git_binding(root, commit)
    require(binding['tree'] == pinned['appInputGitTree'], 'published source tree differs')
    return binding


def control_runner_manifest(root):
    """A complete runner-only commitment; host source profiles remain separate."""
    root = Path(root).resolve(strict=True)
    rows = {}
    require(all(not x.is_dir() or x.name in set(SOURCE_DIRS) | {'.git'} for x in root.iterdir()), 'unexpected runner root directory')
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root).as_posix()
        if rel == 'ops/integration-release/source-contracts.json' or rel.split('/')[0] == '.git':
            continue
        require(not path.is_symlink(), 'runner source symlink refused')
        if path.is_dir():
            continue
        regular(path)
        require('__pycache__' not in path.parts and path.suffix != '.pyc' and rel.split('/')[0] not in ('node_modules', '.next', 'data'), 'generated runner file refused')
        rows[rel] = digest(path)
    return rows


def verify_control_runner(root, contract):
    pin = contract.get('controlRunner')
    require(type(pin) is dict and set(pin) == {'schema', 'files', 'contentSha256'} and pin['schema'] == 'bubblewash-control-runner/v1', 'runner commitment missing')
    rows = control_runner_manifest(root)
    require(len(rows) == pin['files'] and object_digest(rows) == pin['contentSha256'], 'exact runner source differs')
    return 'reviewed-runner-only-v1'


def require_fallback_proof_binding(commit):
    contract = read_json(HERE/'source-contracts.json')
    require(commit == contract['profiles']['integration-fallback-v1']['publicationCommit'], 'fallback differs')
    proof = FALLBACK_CONTROL_PROOF
    require(type(proof) is dict and set(proof) == {'controlSha', 'runId', 'artifactId', 'artifactSha256'}, 'successful fallback control proof is not yet bound')
    require(re.fullmatch('[a-f0-9]{40}', proof['controlSha']) and re.fullmatch('[a-f0-9]{64}', proof['artifactSha256']) and type(proof['runId']) is int and proof['runId'] > 0 and type(proof['artifactId']) is int and proof['artifactId'] > 0, 'proof receipt malformed')
    return proof


def verify_fallback_ci(commit, fetch):
    """No historical failure is reclassified; require explicit proof receipt."""
    proof = require_fallback_proof_binding(commit)
    base = 'https://api.github.com/repos/bechirobob/bubble-wash/actions'
    for run_id, path, sha in ((40112979424, 'pilot-ci.yml', commit), (40112914981, 'browser-regression.yml', commit), (proof['runId'], 'integration-fallback-proof.yml', proof['controlSha'])):
        run = fetch(f'{base}/runs/{run_id}')
        require(run.get('id') == run_id and run.get('head_sha') == sha and run.get('head_repository', {}).get('full_name') == 'bechirobob/bubble-wash' and run.get('path') == '.github/workflows/'+path and run.get('status') == 'completed' and run.get('conclusion') == 'success', 'bound fallback check is not successful')
    artifacts = fetch(f"{base}/runs/{proof['runId']}/artifacts?per_page=100")
    require(artifacts.get('total_count') == 1 and len(artifacts.get('artifacts', [])) == 1, 'proof artifact set differs')
    artifact = artifacts['artifacts'][0]
    require(artifact.get('id') == proof['artifactId'] and artifact.get('name') == 'integration-fallback-control-proof' and artifact.get('expired') is False and artifact.get('digest') == 'sha256:'+proof['artifactSha256'], 'proof artifact differs')
    return True


if __name__ == '__main__':
    import argparse
    import urllib.request
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify-fallback-ci', required=True)
    args = parser.parse_args()
    def fetch(url):
        request = urllib.request.Request(url, headers={'Accept':'application/vnd.github+json', 'User-Agent':'bubblewash-release-gate'})
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    verify_fallback_ci(args.verify_fallback_ci, fetch)
    print('Exact fallback evidence verified.')
