#!/usr/bin/env python3
"""Stream reviewed public read-only checker; never request a provider credential."""
import json
import os
from pathlib import Path
import re
import sys
import types

ROOT=Path(__file__).resolve().parents[1]

def main():
    sha=os.environ.get('REVIEWED_SHA','')
    if not (re.fullmatch('[a-f0-9]{40}',sha) and sha==os.environ.get('GITHUB_SHA') and
            os.environ.get('GITHUB_REPOSITORY')=='bechirobob/bubble-wash' and os.environ.get('GITHUB_REF')=='refs/heads/main' and
            os.environ.get('GITHUB_EVENT_NAME')=='workflow_dispatch'):
        raise ValueError('source refused')
    sources=[(ROOT/'ops'/n).read_text() for n in ('install-research-email.py','check-research-email-state.py')]
    checker=types.ModuleType('state_checker');exec(compile(sources[1],'<checker>','exec'),checker.__dict__)
    program="import types\ni=types.ModuleType('installer');exec("+repr(sources[0])+",i.__dict__)\ns=types.ModuleType('checker');exec("+repr(sources[1])+",s.__dict__)\ns.main(i)\n"
    # No private input, environment key, or raw stderr forwarding.
    home=os.environ.get('HOME','')
    if not home.startswith('/') or any(x in home for x in ('\0','\n','\r')):raise ValueError('runner refused')
    facts=types.ModuleType('facts');exec(compile((ROOT/'ops/host-facts/facts.py').read_bytes(),'<facts>','exec'),facts.__dict__)
    raw=facts.bounded(['/usr/local/bin/tailscale','ssh','root@hermes','/usr/bin/python3 -I -B -'],
        program.encode(),timeout=60,limit=4096,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','HOME':home})
    value=facts.strict_json(raw);checker.validate(value)
    print(json.dumps(value,sort_keys=True,separators=(',',':')))

if __name__=='__main__':
    try:main()
    except BaseException:
        print('Survey credential state check unconfirmed.',file=sys.stderr);sys.exit(1)
