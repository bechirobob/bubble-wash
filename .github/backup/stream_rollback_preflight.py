"""Emit only reviewed read-only code and explicit public release pins.
Not wired into any workflow: publication and host execution require review.
"""
from pathlib import Path
import re
import sys


def stream(sha, path):
    if not re.fullmatch('[0-9a-f]{40}', sha) or not (
        path == '/var/lib/bubblewash-release/releases/' + sha or
        re.fullmatch(r'/home/ubuntu/bubblewash-releases/\d{8}T\d{6}Z-' + sha[:12], path)
    ):
        raise ValueError('Exact live SHA and approved release path required')
    root = Path(__file__).resolve().parents[2]
    source = "__name__ = 'pinned_rollback_preflight'\n"
    for name in ('release-preflight.py', 'release-rollback-inspection.py'):
        source += (root / 'scripts' / name).read_text() + '\n'
    source += f'_result = rollback_inspection({sha!r}, {path!r})\n'
    source += "print(json.dumps(_result, sort_keys=True))\nraise SystemExit(1 if _result['inspectionFailed'] else 0)\n"
    return source


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('pins required')
        sys.stdout.write(stream(*sys.argv[1:]))
    except Exception:
        raise SystemExit('Read-only inspection requires exact approved release pins.')
