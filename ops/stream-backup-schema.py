"""Reviewed source stream for the existing protected tailnet SSH stdin channel."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEPENDENCIES = {
 'ops/deploy-preserving.py': '29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a',
 'ops/deploy-survey-only.py': 'bb435e7a32baa516b8d89e65e64f2b2db0779657f6c25039130c9520f5d5e509',
 'ops/deploy-survey-update.py': '8de4ce5d5f543bc52a4d81590490058681df4450dbe44702f426c97cf0fd4e0a',
 'ops/customer-update-source-pins.json': '8c7b3397c658201b22474f4ac17b7aa2329c04d6cc0af03e5f41195ed443f6ba',
}


def prepare(env):
    if env.get('GITHUB_REPOSITORY') != 'bechirobob/bubble-wash' or env.get('GITHUB_REF') != 'refs/heads/main' or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch':
        raise ValueError('manual main only')
    request = dict(controlSha=env['GITHUB_SHA'], runId=env['GITHUB_RUN_ID'], runAttempt=env['GITHUB_RUN_ATTEMPT'],
                   runtimeSha=env['EXPECTED_LIVE_SHA'], backupSha256=env['BACKUP_SHA256'], receiptRun=env['RECEIPT_RUN'], storeSha=env['BACKUP_STORE_SHA'], storeId=env['BACKUP_STORE_ID'])
    if request['controlSha'] != env['SOURCE_SHA'] or subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip() != request['controlSha']:
        raise ValueError('source binding differs')
    if subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=ROOT):
        raise ValueError('dirty source')
    spec=importlib.util.spec_from_file_location('backup_schema_host',ROOT/'ops/attest-backup-schema.py')
    host=importlib.util.module_from_spec(spec); spec.loader.exec_module(host); host.validate(request)
    sources={name:(ROOT/name).read_text() for name in DEPENDENCIES}
    if any(hashlib.sha256(raw.encode()).hexdigest()!=DEPENDENCIES[name] for name,raw in sources.items()):
        raise ValueError('dependency differs')
    ddl_source=(ROOT/'ops/administrator-invitation-transition.ts').read_text()
    if ('export const administratorPermissionsDdl = `'+host.DDL+'`;') not in ddl_source:
        raise ValueError('approved DDL differs')
    # All payload members are reviewed source or public binding values. No server key.
    payload={'sources':sources,'host':(ROOT/'ops/attest-backup-schema.py').read_text(),'request':request}
    return "import json,types\np=json.loads("+repr(json.dumps(payload))+''')
def module(name, source):
 m=types.ModuleType(name);exec(compile(source,name,'exec'),m.__dict__);return m
s=p['sources']
core=module('reviewed_preserving',s['ops/deploy-preserving.py'])
guards=module('reviewed_guards',s['ops/deploy-survey-only.py']);guards.core=core
scanner=module('reviewed_scanner',s['ops/deploy-survey-update.py']);scanner.guards=guards
pins=json.loads(s['ops/customer-update-source-pins.json']);scanner.pins=pins
host=module('reviewed_backup_attestation',p['host'])
host.core,host.guards,host.scanner,host.pins=core,guards,scanner,pins
host.main(p['request'])
'''


if __name__=='__main__':
    try: sys.stdout.write(prepare(os.environ))
    except Exception: raise SystemExit('Exact manual attestation source and inputs required.')
