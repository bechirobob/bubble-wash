#!/usr/bin/env python3
"""Install only the dedicated survey key, disabled; never restart or send mail.

Secret arrives on stdin, not argv. No file paths or configuration values are
accepted as arguments. Failures emit only fixed diagnostics.
"""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import pwd
import re
import resource
import stat
import subprocess
import sys
import secrets

ENV = Path('/home/ubuntu/.config/bubblewash/env')
RUNTIME = Path('/home/ubuntu/bubblewash-runtime')
KEY = b'BUBBLEWASH_RESEARCH_RESEND_KEY'
FLAG = b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED'


def require(value):
    if not value:
        raise ValueError('precondition failed')


def updated(raw, key):
    require(re.fullmatch(rb're_[A-Za-z0-9_-]{16,200}', key))
    require(len(raw) <= 65536 and b'\x00' not in raw)
    entries = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith((b'#', b';')):
            continue
        match = re.fullmatch(rb'([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        require(match and match[1] not in entries)
        value = match[2].strip()
        if value.startswith((b'"', b"'")):
            require(len(value) >= 2 and value[-1:] == value[:1])
            value = value[1:-1]
        require(not any(c in value for c in (b'\\', b'"', b"'", b'`', b'\r', b'\n')))
        entries[match[1]] = value
    # Existing non-matching credentials or enabled state require separate review.
    if KEY in entries or FLAG in entries:
        require(entries.get(KEY) == key and entries.get(FLAG) == b'false')
        return raw
    suffix = b'' if not raw or raw.endswith(b'\n') else b'\n'
    result = raw + suffix + KEY + b'=' + key + b'\n' + FLAG + b'=false\n'
    require(len(result) <= 65536)
    return result


def identity(value):
    return tuple(getattr(value, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns'))


@contextmanager
def deployment_lock(runtime, app_uid):
    require(runtime.resolve(strict=True) == runtime)
    directory = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    lock = None
    try:
        ds = os.fstat(directory)
        require(ds.st_uid in (0, app_uid) and not ds.st_mode & 0o022)
        lock = os.open('deploy.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        ls = os.fstat(lock)
        require(stat.S_ISREG(ls.st_mode) and ls.st_nlink == 1 and ls.st_uid in (0, app_uid) and not ls.st_mode & 0o022)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def unchanged():
            require(runtime.resolve(strict=True) == runtime)
            fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink')
            require(all(getattr(runtime.lstat(), k) == getattr(ds, k) for k in fields))
            require(all(getattr(os.stat('deploy.lock', dir_fd=directory, follow_symlinks=False), k) == getattr(ls, k) for k in fields))
            require(os.fstat(lock).st_nlink == 1)
        unchanged()
        yield unchanged
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)


def install(path, key, app_uid, unchanged):
    parent = path.parent
    require(parent.resolve(strict=True) == parent)
    # Do not broaden permissions. Abort if the existing protected file is unsafe.
    for directory_path in (parent, parent.parent):
        ds = directory_path.stat()
        require(ds.st_uid in (0, app_uid) and not ds.st_mode & 0o022)
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    temporary = None
    try:
        parent_id = identity(os.fstat(directory))[:6]
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        original = os.fstat(fd)
        require(stat.S_ISREG(original.st_mode) and original.st_nlink == 1 and original.st_uid == app_uid)
        require(stat.S_IMODE(original.st_mode) == 0o600 and original.st_size <= 65536)
        require(not os.listxattr(fd))  # Do not silently drop ACLs or extended attributes.
        raw = os.read(fd, 65537)
        require(len(raw) == original.st_size)
        replacement = updated(raw, key)
        unchanged()
        if replacement == raw:
            require(parent.resolve(strict=True) == parent and identity(parent.lstat())[:6] == parent_id)
            require(identity(os.stat(path.name, dir_fd=directory, follow_symlinks=False)) == identity(original))
            unchanged()
            return 'already-installed-disabled'
        temporary = '.research-env-' + secrets.token_hex(16)
        newfd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            os.fchown(newfd, original.st_uid, original.st_gid)
            os.fchmod(newfd, stat.S_IMODE(original.st_mode))
            with os.fdopen(newfd, 'wb') as handle:
                handle.write(replacement)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            try:
                os.close(newfd)
            except OSError:
                pass
            raise
        unchanged()
        require(parent.resolve(strict=True) == parent and identity(parent.lstat())[:6] == parent_id)
        require(identity(os.stat(path.name, dir_fd=directory, follow_symlinks=False)) == identity(original))
        os.lseek(fd, 0, os.SEEK_SET)
        require(os.read(fd, 65537) == raw)
        os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        temporary = None
        os.fsync(directory)
        verify = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            current = os.fstat(verify)
            require((current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)) == (original.st_uid, original.st_gid, 0o600))
            require(os.read(verify, 65537) == replacement)
            require(parent.resolve(strict=True) == parent and identity(parent.lstat())[:6] == parent_id)
            require(identity(os.stat(path.name, dir_fd=directory, follow_symlinks=False)) == identity(current))
            unchanged()
        finally:
            os.close(verify)
        return 'installed-disabled'
    finally:
        if temporary is not None:
            os.unlink(temporary, dir_fd=directory)
        if fd is not None:
            os.close(fd)
        os.close(directory)


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    require(os.geteuid() == 0 and len(sys.argv) == 1)
    # Host identity is bound by the fixed authenticated root@hermes transport.
    account = pwd.getpwnam('ubuntu')
    app_uid = account.pw_uid
    require(app_uid > 0)
    # Only the existing read-only lock descriptor is acquired as root.
    with deployment_lock(RUNTIME, app_uid) as unchanged:
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(app_uid)
        require(os.geteuid() == app_uid and os.getuid() == app_uid)
        unchanged()
        # No credential input, environment or app source access before the drop.
        key = sys.stdin.buffer.read(205)
        require(len(key) <= 203)
        result = subprocess.run(['/usr/bin/systemctl', '--user', 'show', 'bubblewash-local.service',
                                 '--property=LoadState,EnvironmentFiles'], capture_output=True, timeout=20, check=True,
                                env={'PATH': '/usr/bin:/bin', 'HOME': '/home/ubuntu', 'XDG_RUNTIME_DIR': f'/run/user/{app_uid}'})
        properties = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
        require(properties.get('LoadState') == 'loaded' and properties.get('EnvironmentFiles') == f'{ENV} (ignore_errors=no)')
        status = install(ENV, key, app_uid, unchanged)
    print(status)


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('Survey credential installation did not confirm completion; inspect non-secret status before retrying.', file=sys.stderr)
        sys.exit(1)
