"""No secret argv/temp files/logs. Stream to the existing encrypted SSH stdin."""
import json
import os
from pathlib import Path
import re
import sys

email = os.environ.get('OWNER_EMAIL','').strip().lower()
sha = os.environ.get('EXPECTED_LIVE_SHA','')
actor = os.environ.get('GITHUB_ACTOR','')
mode = os.environ.get('ENROLLMENT_MODE','check')
approved = os.environ.get('DELIVERY_APPROVED','false') == 'true'
if len(email)>160 or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+',email) or not re.fullmatch('[0-9a-f]{40}',sha) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?',actor) or mode not in ('check','send') or (mode=='send' and not approved):
    raise SystemExit('Private input, exact release pin, actor or explicit delivery approval is missing.')
pins = json.loads(Path('ops/owner-enrollment-source-pins.json').read_text())
sys.stdout.write("__name__ = 'private_owner_enrollment'\n" + Path('scripts/release-preflight.py').read_text())
sys.stdout.write('\n' + Path('scripts/owner-enrollment-host.py').read_text())
sys.stdout.write('\ntry:\n    _result = run_private_enrollment(' + ', '.join(repr(value) for value in (email,sha,actor,mode,approved,pins)) + ')\nexcept Exception:\n    _result = {"ok":False,"state":"outcome-uncertain-stop-inspect-privately","retryPermitted":False}\n')
sys.stdout.write('print(json.dumps(_result, sort_keys=True))\nraise SystemExit(0 if _result.get("ok") is True else 1)\n')
