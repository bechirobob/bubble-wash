"""Stream reviewed preflight plus bounded private inputs directly into SSH stdin.
No temporary files, secret argv, debug output, artifacts, or remote env evaluation.
"""
import os
from pathlib import Path
import re
import sys

email = os.environ.get('OWNER_EMAIL', '').strip().lower()
sha = os.environ.get('EXPECTED_LIVE_SHA', '')
if len(email) > 160 or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', email) or not re.fullmatch('[0-9a-f]{40}', sha):
    raise SystemExit('Private recipient secret and exact live SHA are required.')
source = Path('scripts/release-preflight.py').read_text()
sys.stdout.write("__name__ = 'private_owner_preflight'\n" + source)
sys.stdout.write("\n_result = collect(owner_email=" + repr(email) + ", expected_live_sha=" + repr(sha) + ")\n")
sys.stdout.write("print(json.dumps(_result, sort_keys=True))\nraise SystemExit(0 if _result.get('ownerInspection', {}).get('completed') else 1)\n")
