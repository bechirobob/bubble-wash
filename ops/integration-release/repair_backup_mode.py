"""One approved directory mode correction; no recursion or recovery guessing."""
import os
from pathlib import Path
import pwd
import stat

TARGET = Path('/home/ubuntu/bubblewash-backups')
RUNTIME = Path('/home/ubuntu/bubblewash-runtime')
EXPECTED = (2049, 254581, 1000, 1000, 0o775)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid,
            stat.S_IMODE(info.st_mode))


def _repair(path, uid, expected, unchanged):
    """All directory traversal uses retained, no-follow descriptors."""
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts and str(path) == os.path.normpath(str(path)), 'noncanonical target')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptors = []
    links = []
    try:
        fd = os.open('/', flags)
        descriptors.append(fd)
        for name in path.parts[1:]:
            parent = os.fstat(fd)
            require(stat.S_ISDIR(parent.st_mode) and parent.st_uid in (0, uid)
                    and not parent.st_mode & 0o022, 'unprotected ancestor')
            child = os.open(name, flags, dir_fd=fd)
            descriptors.append(child)
            links.append((fd, name, child, identity(os.fstat(child))))
            fd = child
        info = os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) and identity(info) == expected, 'target identity or mode differs')
        require(expected[2:4] == (uid, uid) and expected[4] == 0o775, 'unexpected repair contract')

        def recheck(target_mode):
            unchanged()
            for index, (parent_fd, name, child_fd, original) in enumerate(links):
                opened = os.fstat(child_fd)
                named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                wanted = original[:-1] + (target_mode,) if index == len(links)-1 else original
                require(stat.S_ISDIR(named.st_mode) and identity(named) == wanted
                        and identity(opened) == wanted, 'directory changed during repair')
                parent = os.fstat(parent_fd)
                require(parent.st_uid in (0, uid) and not parent.st_mode & 0o022,
                        'ancestor protection changed')
        recheck(0o775)
        os.fchmod(fd, 0o755)
        recheck(0o755)
        return {'ok': True, 'status': 'backup-directory-group-write-removed'}
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def repair_backup_mode(guard):
    require(os.geteuid() == 0, 'root required')
    uid = pwd.getpwnam('ubuntu').pw_uid
    require(uid == 1000, 'ubuntu identity differs')
    with guard.deployment_lock(RUNTIME, uid) as unchanged:
        return _repair(TARGET, uid, EXPECTED, unchanged)
