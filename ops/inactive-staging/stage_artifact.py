#!/usr/bin/env python3
"""Exact inactive artifact copy only. Never selects or executes staged code."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile
import sys

MAX_MANIFEST = 32 * 1024**2
MAX_ARCHIVE = 2 * 1024**3
MAX_EXPANDED = 4 * 1024**3
MAX_FILES = 100000
MAX_FILE = 512 * 1024**2

def require(ok):
    if not ok:
        raise ValueError('artifact staging refused')

def sha(data):
    return hashlib.sha256(data).hexdigest()

def path_name(name):
    require(isinstance(name, str) and name != '.' and 0 < len(name) <= 1024 and '\\' not in name and '\x00' not in name)
    p = PurePosixPath(name)
    require(not p.is_absolute() and p.as_posix() == name and all(x not in ('', '.', '..') for x in p.parts))
    return p

def pairs(rows):
    result = {}
    for key, value in rows:
        require(key not in result)
        result[key] = value
    return result

def parse_manifest(raw, expected):
    require(len(raw) <= MAX_MANIFEST and re.fullmatch('[a-f0-9]{64}', expected or '') and sha(raw) == expected)
    m = json.loads(raw, object_pairs_hook=pairs)
    require(set(m) == {'schema', 'archiveSha256', 'files'} and m['schema'] == 'bubblewash-inactive-artifact/v1')
    require(re.fullmatch('[a-f0-9]{64}', m['archiveSha256']) and isinstance(m['files'], dict) and 0 < len(m['files']) <= MAX_FILES)
    total = 0
    objects = set(m['files'])
    for name, row in m['files'].items():
        p = path_name(name)
        objects.update(str(parent) for parent in p.parents if str(parent) != '.')
        require(len(objects) <= MAX_FILES)
        require(p.parts[0] not in ('data', 'backups') and name not in ('.env', '.env.local', '.env.production', '.env.production.local'))
        require(not any(str(parent) in m['files'] for parent in p.parents if str(parent) != '.'))
        require(isinstance(row, dict))
        if row.get('type') == 'file':
            require(set(row) == {'type', 'size', 'mode', 'sha256'} and type(row['size']) is int and 0 <= row['size'] <= MAX_FILE)
            require(type(row['mode']) is int and row['mode'] in (0o644, 0o755) and re.fullmatch('[a-f0-9]{64}', row['sha256']))
            total += row['size']
        else:
            require(set(row) == {'type', 'target'} and row['type'] == 'link')
            target = row['target']
            require(isinstance(target, str) and 0 < len(target) <= 1024 and not target.startswith('/') and '\\' not in target and '\x00' not in target)
            resolved = os.path.normpath(str(p.parent / target))
            path_name(resolved)
            require(resolved in m['files'] and m['files'][resolved].get('type') == 'file')
    require(total <= MAX_EXPANDED)
    return m

def protected_directory(path, uid):
    require(path.is_absolute() and path == path.resolve(strict=True))
    for current in (path, *path.parents):
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and not info.st_mode & 0o022)

def digest_stream(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024**2), b''):
        h.update(chunk)
    return h.hexdigest()

def inspect_tar_headers(source):
    """Reject extension headers before tarfile can allocate their declared payload."""
    source.seek(0)
    count = 0
    while True:
        header = source.read(512)
        require(len(header) == 512)
        if header == bytes(512):
            require(source.read(512) == bytes(512))
            for rest in iter(lambda: source.read(1024**2), b''):
                require(not rest.strip(b'\x00'))
            break
        count += 1
        require(count <= MAX_FILES and header[156:157] in (b'0', b'\x00', b'2') and header[257:263] == b'ustar\x00')
        field = header[124:136].strip(b'\x00 ')
        require(field and all(c in b'01234567' for c in field))
        size = int(field, 8)
        require(size <= MAX_FILE and (header[156:157] != b'2' or size == 0))
        source.seek(((size + 511) // 512) * 512, 1)
    source.seek(0)

def file_digest(path):
    with path.open('rb') as stream:
        return digest_stream(stream)


def stage(archive, raw_manifest, manifest_sha, base, name, uid=0, check_parent=protected_directory, hook=lambda _: None):
    """Tests inject only parent ownership checking; production CLI has no override."""
    require(re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', name or ''))
    m = parse_manifest(raw_manifest, manifest_sha)
    base = Path(base)
    check_parent(base, uid)
    target = base / name
    require(not target.exists() and not target.is_symlink())
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAX_ARCHIVE)
        require(digest_stream(source) == m['archiveSha256'])
        inspect_tar_headers(source)
        # Uncompressed tar keeps parser expansion bounded by archive size.
        with tarfile.open(fileobj=source, mode='r:') as tar:
            members = {}
            for member in tar:
                require(len(members) < MAX_FILES and member.name not in members and not member.pax_headers)
                path_name(member.name)
                require(member.name in m['files'])
                row = m['files'][member.name]
                if row['type'] == 'file':
                    require(member.isreg() and not member.issparse() and member.size == row['size'] and member.mode == row['mode'])
                    with tar.extractfile(member) as payload:
                        require(digest_stream(payload) == row['sha256'])
                else:
                    require(member.issym() and member.size == 0 and member.linkname == row['target'])
                members[member.name] = member
            require(set(members) == set(m['files']))
            check_parent(base, uid)
            # Exclusive directory reservation: no rename-over-existing race.
            target.mkdir(mode=0o700)
            hook('reserved')
            for name, member in members.items():
                row = m['files'][name]
                if row['type'] != 'file':
                    continue
                out = target / name
                out.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                with os.fdopen(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, row['mode']), 'wb') as dest:
                    with tar.extractfile(member) as payload:
                        for chunk in iter(lambda: payload.read(1024**2), b''):
                            dest.write(chunk)
                    dest.flush()
                    os.fchmod(dest.fileno(), row['mode'])
                    os.fsync(dest.fileno())
                require(file_digest(out) == row['sha256'])
                hook('file')
            for name, row in m['files'].items():
                if row['type'] == 'link':
                    out = target / name
                    out.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                    require((out.parent / row['target']).resolve(strict=True).is_relative_to(target))
                    os.symlink(row['target'], out)
            actual = {str(p.relative_to(target)) for p in target.rglob('*') if not p.is_dir() or p.is_symlink()}
            require(actual == set(m['files']))
            for name, row in m['files'].items():
                out = target / name
                info = out.lstat()
                if row['type'] == 'file':
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == row['mode'] and info.st_uid == uid and file_digest(out) == row['sha256'])
                else:
                    require(out.is_symlink() and os.readlink(out) == row['target'] and info.st_uid == uid)
            for directory in target.rglob('*'):
                if directory.is_dir() and not directory.is_symlink():
                    info = directory.lstat()
                    require(info.st_uid == uid)
                    os.chmod(directory, 0o755, follow_symlinks=False)
            hook('verified')
            for directory in sorted([p for p in target.rglob('*') if p.is_dir() and not p.is_symlink()], key=lambda p: len(p.parts), reverse=True) + [target, base]:
                d = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try: os.fsync(d)
                finally: os.close(d)
    os.chmod(target, 0o755)
    directory_fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(directory_fd)
    finally: os.close(directory_fd)
    return {'ok': True, 'status': 'inactive-bytes-verified', 'manifestSha256': manifest_sha, 'fileCount': len(m['files']), 'runtimeAccepted': False}

def receive(raw_manifest, manifest_sha, kind, name):
    """Receive archive bytes on stdin through the existing SSH transport."""
    require(os.geteuid() == 0 and kind in ('release', 'package'))
    parse_manifest(raw_manifest, manifest_sha)
    base = Path('/var/lib/bubblewash-release') / ('releases' if kind == 'release' else 'packages')
    protected_directory(base, 0)
    require(re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', name or ''))
    require(not (base/name).exists() and not (base/name).is_symlink())
    # Kept on success or failure for explicit inspection/recoverable cleanup.
    with tempfile.NamedTemporaryFile(prefix='.incoming-', suffix='.tar', dir=base, delete=False) as incoming:
        total = 0
        while True:
            chunk = sys.stdin.buffer.read(min(1024**2, MAX_ARCHIVE + 1 - total))
            if not chunk: break
            total += len(chunk)
            require(total <= MAX_ARCHIVE)
            incoming.write(chunk)
        incoming.flush()
        os.fsync(incoming.fileno())
        archive = incoming.name
    return stage(archive, raw_manifest, manifest_sha, base, name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--kind', required=True, choices=['release', 'package'])
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0)
        with args.manifest.open('rb') as manifest_stream:
            raw = manifest_stream.read(MAX_MANIFEST + 1)
        require(len(raw) <= MAX_MANIFEST)
        base = Path('/var/lib/bubblewash-release') / ('releases' if args.kind == 'release' else 'packages')
        result = stage(args.archive, raw, args.manifest_sha256, base, args.name)
        print(json.dumps(result, sort_keys=True))
    except Exception:
        print('{"ok":false,"status":"staging-refused-or-incomplete","inspectBeforeRetry":true}')
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
