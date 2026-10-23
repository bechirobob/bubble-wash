#!/usr/bin/env python3
"""Send a protected Actions secret only over stdin; never emit it or save it."""
import base64
import os
from pathlib import Path
import re
import resource
import shlex
import subprocess
import sys


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    key = os.environ.pop('BUBBLEWASH_RESEARCH_RESEND_KEY', '')
    if not re.fullmatch(r're_[A-Za-z0-9_-]{16,200}', key):
        raise ValueError('invalid dedicated credential')
    if os.environ.get('RUNNER_DEBUG') == '1' or os.environ.get('ACTIONS_STEP_DEBUG') == 'true':
        raise ValueError('debug must be disabled')
    source = Path('ops/install-research-email.py').read_bytes()
    # Public reviewed program only in argv. The key is absent from child env/argv.
    program = "import base64;exec(compile(base64.b64decode(" + repr(base64.b64encode(source)) + "),'<survey-installer>','exec'))"
    command = '/usr/bin/python3 -I -B -c ' + shlex.quote(program)
    result = subprocess.run(['tailscale', 'ssh', 'root@hermes', command], input=key.encode(),
                            capture_output=True, timeout=90)
    if result.returncode or result.stdout.strip() not in (b'installed-disabled', b'already-installed-disabled'):
        raise RuntimeError('installation outcome unconfirmed')
    print('Dedicated survey credential installed; sending remains disabled. No restart or email performed.')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('Survey credential installation outcome unconfirmed; inspect non-secret status before retrying.', file=sys.stderr)
        sys.exit(1)
