"""Fixed-operation metadata inspection through the existing protected SSH channel."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CORE_SHA256 = '29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a'
FAILED_INPUTS = {'EXPECTED_LIVE_SHA': '277a3f8df85068f3245ddc30a6c446d10d9bdc39',
                 'BACKUP_SHA256': '900a2d14c1f4dd9ffa3cdcaac34e34c8ef055393b5566de1b98394a4076f3b39',
                 'RECEIPT_RUN': '41990651643'}


def prepare(env):
    if env.get('INSPECT_OUTCOME') != 'true' or env.get('GITHUB_REPOSITORY') != 'bechirobob/bubble-wash' or env.get('GITHUB_REF') != 'refs/heads/main' or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch':
        raise ValueError('exact outcome mode required')
    if any(env.get(k) != v for k, v in FAILED_INPUTS.items()): raise ValueError('failed invocation binding differs')
    context = {'controlSha': env['GITHUB_SHA'], 'runId': env['GITHUB_RUN_ID'], 'runAttempt': env['GITHUB_RUN_ATTEMPT']}
    if context['controlSha'] != env['SOURCE_SHA'] or subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip() != context['controlSha']:
        raise ValueError('source binding differs')
    if subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=ROOT): raise ValueError('dirty source')
    spec=importlib.util.spec_from_file_location('fixed_outcome',ROOT/'ops/inspect-backup-schema-outcome.py')
    host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host);host.validate(context)
    core=(ROOT/'ops/deploy-preserving.py').read_text()
    if hashlib.sha256(core.encode()).hexdigest()!=CORE_SHA256: raise ValueError('lock dependency differs')
    payload={'core':core,'host':(ROOT/'ops/inspect-backup-schema-outcome.py').read_text(),'context':context}
    return "import json,types\np=json.loads("+repr(json.dumps(payload))+''')
core=types.ModuleType('reviewed_lock');exec(compile(p['core'],'reviewed-lock','exec'),core.__dict__)
host=types.ModuleType('fixed_outcome');exec(compile(p['host'],'fixed-outcome','exec'),host.__dict__)
host.core=core
host.main(p['context'])
'''


if __name__=='__main__':
    try: sys.stdout.write(prepare(os.environ))
    except Exception: raise SystemExit('Exact fixed-operation outcome source and inputs required.')
