"""Stream one fixed-attempt diagnosis; no remote paths or inputs are accepted."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

RUNTIME = '1406b0e217ed02709ebe1c423aecb42c6be5b0aa'
TREE = 'b4eba8dfd833288b7bb7ee86386a18326577d749'


def stream():
    root = Path(__file__).resolve().parents[2]
    checkout = root / 'inspection-runtime'
    def git(*args):
        return subprocess.run(['git', '-C', str(checkout), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30).stdout
    if git('rev-parse', 'HEAD').decode().strip() != RUNTIME or git('rev-parse', 'HEAD^{tree}').decode().strip() != TREE:
        raise ValueError('runtime mismatch')
    raw = git('archive', '--format=tar', RUNTIME)
    if len(raw) > 64 * 1024 * 1024: raise ValueError('archive too large')
    expected = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        for member in archive:
            if member.isdir(): continue
            if not member.isfile() or member.size > 32 * 1024 * 1024 or member.name in expected:
                raise ValueError('unsupported source')
            expected[member.name] = hashlib.sha256(archive.extractfile(member).read()).hexdigest()
    source = "__name__ = 'fixed_attempt_diagnosis'\n"
    for name in ('release-preflight.py', 'inspect-workspace-attempt.py'):
        source += (root / 'scripts' / name).read_text() + '\n'
    source += '_result = inspect_workspace_attempt(' + repr(expected) + ')\n'
    source += "print(json.dumps(_result, sort_keys=True))\nraise SystemExit(1 if _result['inspectionFailed'] else 0)\n"
    return source


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1: raise ValueError('no inputs accepted')
        sys.stdout.write(stream())
    except Exception:
        raise SystemExit('Fixed attempt diagnosis could not be prepared.')
