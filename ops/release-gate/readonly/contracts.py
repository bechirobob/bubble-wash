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
