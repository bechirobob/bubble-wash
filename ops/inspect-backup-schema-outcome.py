"""Metadata only for one failed attestation. No key, file contents or deletion."""
import json
import os
from pathlib import Path
import pwd
import re
import stat
import time

FAILED_RUN = '42022520775'
FAILED_JOB = '127228613722'
FAILED_SOURCE = 'b63fc992e4dde7fc839ce768c3ef796a9a862c08'
RUN_ROOT = Path('/run')
SCRATCH_NAME = 'bubblewash-schema-attestation-' + FAILED_RUN
NAMES = tuple(base + suffix for base in ('snapshot.sqlite', 'after.sqlite')
              for suffix in ('', '-wal', '-shm', '-journal'))
core = None
STAGE = 'binding'


def require(ok):
    if not ok: raise ValueError('fixed outcome inspection refused')


def validate(context):
    require(type(context) is dict and set(context) == {'controlSha', 'runId', 'runAttempt'})
    require(type(context['controlSha']) is str and re.fullmatch('[a-f0-9]{40}', context['controlSha']))
    require(type(context['runId']) is str and re.fullmatch('[1-9][0-9]{0,19}', context['runId']))
    require(context['runAttempt'] == '1' and context['runId'] != FAILED_RUN)


def identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def metadata(info):
    kind = ('directory' if stat.S_ISDIR(info.st_mode) else 'regular' if stat.S_ISREG(info.st_mode)
            else 'symlink' if stat.S_ISLNK(info.st_mode) else 'other')
    return {'exists': True, 'type': kind, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': format(stat.S_IMODE(info.st_mode), '04o'), 'size': info.st_size,
            'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns, 'atimeNs': info.st_atime_ns}


def root_directory(info, private=False):
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    if private: require(stat.S_IMODE(info.st_mode) == 0o700)


def inspect_fixed_scratch():
    """Stat fixed children through held directories; never enumerate or open files."""
    require(RUN_ROOT.resolve(strict=True) == RUN_ROOT)
    root = os.open(RUN_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    scratch = None
    try:
        root_info = os.fstat(root); root_directory(root_info)
        def root_bound():
            current = os.stat(RUN_ROOT, follow_symlinks=False)
            root_directory(current)
            require((current.st_dev,current.st_ino) == (root_info.st_dev,root_info.st_ino))
        try: before = os.stat(SCRATCH_NAME, dir_fd=root, follow_symlinks=False)
        except FileNotFoundError:
            try: os.stat(SCRATCH_NAME, dir_fd=root, follow_symlinks=False)
            except FileNotFoundError:
                root_bound()
                return {'scratch': {'exists': False}, 'observation': 'absent-at-inspection', 'historicalCleanupProven': False}
            raise ValueError('changed')
        result = {'scratch': metadata(before), 'historicalCleanupProven': False,
                  'directoryEmptyVerified': False, 'knownPathsOnly': True}
        if not stat.S_ISDIR(before.st_mode) or before.st_uid != 0 or stat.S_IMODE(before.st_mode) != 0o700:
            require(identity(os.stat(SCRATCH_NAME, dir_fd=root, follow_symlinks=False)) == identity(before))
            root_bound()
            return {**result, 'observation': 'present-unsafe-not-traversed'}
        scratch = os.open(SCRATCH_NAME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        root_directory(os.fstat(scratch), private=True)
        require(identity(os.fstat(scratch)) == identity(before))
        files, observed = {}, {}
        for name in NAMES:
            try: info = os.stat(name, dir_fd=scratch, follow_symlinks=False)
            except FileNotFoundError: files[name] = {'exists': False}; observed[name] = None
            else: files[name] = metadata(info); observed[name] = identity(info)
        for name in NAMES:
            try: after = os.stat(name, dir_fd=scratch, follow_symlinks=False)
            except FileNotFoundError: require(observed[name] is None)
            else: require(identity(after) == observed[name])
        require(identity(os.fstat(scratch)) == identity(before))
        require(identity(os.stat(SCRATCH_NAME, dir_fd=root, follow_symlinks=False)) == identity(before))
        root_bound()
        return {**result, 'observation': 'present-metadata-only', 'files': files}
    finally:
        if scratch is not None: os.close(scratch)
        os.close(root)


def inspect(context):
    global STAGE
    STAGE = 'binding'
    validate(context); require(os.geteuid() == 0)
    STAGE = 'deployment-lock'
    with core.deployment_lock(core.RUNTIME, pwd.getpwnam('ubuntu').pw_uid) as unchanged:
        unchanged(); STAGE = 'scratch-metadata'
        result = inspect_fixed_scratch(); unchanged()
    STAGE = 'complete'
    return {'schema': 'bubblewash-backup-schema-outcome/v1', 'context': context,
            'failedOperation': {'runId': FAILED_RUN, 'jobId': FAILED_JOB, 'sourceSha': FAILED_SOURCE, 'attempt': 1},
            'metadataOnly': True, 'fileContentsRead': False, 'keyLoaded': False, 'deletionAttempted': False,
            'processState': 'unattributable-no-pid-recorded', 'guardStage': 'not-recorded-by-failed-invocation',
            'deploymentLockAvailableAtInspection': True, 'observedAtUnixNs': time.time_ns(), **result}


def main(context):
    try: result = inspect(context)
    except Exception:
        print(json.dumps({'schema': 'bubblewash-backup-schema-outcome/v1', 'state': 'metadata-inspection-blocked', 'cleanupStatus': 'unknown', 'inspectionStage': STAGE}, sort_keys=True))
        raise SystemExit(1)
    print(json.dumps(result, sort_keys=True))
