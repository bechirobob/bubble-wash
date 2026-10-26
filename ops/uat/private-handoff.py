#!/usr/bin/env python3
"""Capture sealed UAT credentials into the existing verified private release store."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import tempfile
import urllib.request
import urllib.error

ROOT=Path(__file__).resolve().parents[2]
STORE='bechirobob/becore-backups';STORE_ID=1403152795
RECIPIENT='a479abb3611e11c65eb89e1a437577873e26798161e284572e0bf29ccdc8b4c9'

def require(value):
    if not value:raise ValueError('Private UAT handoff refused')

def context(env):
    require(env.get('GITHUB_REPOSITORY')=='bechirobob/bubble-wash' and env.get('GITHUB_REF')=='refs/heads/main' and env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('GITHUB_RUN_ATTEMPT')=='1')
    require(env.get('ISSUANCE_APPROVED')=='true' and env.get('HANDOVER_READY')=='true' and env.get('RUNNER_DEBUG')!='1' and env.get('ACTIONS_STEP_DEBUG')!='true')
    for name in ('SOURCE_SHA','RUNTIME_SHA','BACKUP_STORE_SHA'):require(re.fullmatch('[a-f0-9]{40}',env.get(name,'')))
    require(env['SOURCE_SHA']==env.get('GITHUB_SHA') and env.get('MODE') in ('issue','retrieve') and re.fullmatch('[1-9][0-9]{0,19}',env.get('GITHUB_RUN_ID','')))
    require(env.get('BACKUP_STORE_ID')==str(STORE_ID))
    key=base64.b64decode(env.get('HANDOFF_PUBLIC_KEY',''),validate=True);require(300<len(key)<1024 and hashlib.sha256(key).hexdigest()==RECIPIENT)
    encoded=base64.b64encode(key).decode();pem='-----BEGIN PUBLIC KEY-----\n'+'\n'.join(encoded[i:i+64] for i in range(0,len(encoded),64))+'\n-----END PUBLIC KEY-----\n'
    return {'mode':env['MODE'],'approved':True,'ready':True,'runtimeSha':env['RUNTIME_SHA'],'publicKey':pem}

def envelope(raw):
    require(0<len(raw)<=16384);value=json.loads(raw)
    require(set(value)=={'schema','recipientSha256','wrappedKey','iv','tag','ciphertext'} and value['schema']=='bubblewash-uat-handover/v1' and value['recipientSha256']==RECIPIENT)
    sizes={k:len(base64.b64decode(value[k],validate=True)) for k in ('wrappedKey','iv','tag','ciphertext')}
    require(sizes['wrappedKey']==384 and sizes['iv']==12 and sizes['tag']==16 and 128<sizes['ciphertext']<8192)
    return value

def private_store(backup,api,env):
    backup.private_repository(api,STORE,STORE_ID)
    require(api.api('git/commits/'+env['BACKUP_STORE_SHA']).get('sha')==env['BACKUP_STORE_SHA'])

def publish(backup,api,env,raw):
    envelope(raw);private_store(backup,api,env)
    tag='bubblewash-uat-handover-'+env['GITHUB_RUN_ID']+'-1';ctx={'tag':tag,'storageSha':env['BACKUP_STORE_SHA']}
    with tempfile.TemporaryDirectory(prefix='sealed-uat-') as directory:
        work=Path(directory);path=work/(tag+'.enc');path.write_bytes(raw);path.chmod(0o600)
        checksum=work/(tag+'.enc.sha256');checksum.write_text(backup.digest(path)+'  '+path.name+'\n');checksum.chmod(0o600)
        expected={p.name:(p.stat().st_size,backup.digest(p)) for p in (path,checksum)}
        release=api.api('releases','POST',{'tag_name':tag,'target_commitish':ctx['storageSha'],'name':tag,'body':'Temporary encrypted UAT credential handover only. No plaintext passwords or customer records. Remove after verified private delivery.','draft':True,'prerelease':True,'make_latest':'false'})
        identity=release['id'];require(type(identity) is int and identity>0)
        for item in (path,checksum):api.upload(identity,item)
        assets=backup.validate_release(api.api(f'releases/{identity}'),ctx,expected,True)
        for asset in assets:
            target=work/('verify-'+asset['name']);api.download(asset['id'],target,asset['size']);require(backup.digest(target)==expected[asset['name']][1])
        private_store(backup,api,env)
        final=api.api(f'releases/{identity}','PATCH',{'draft':False,'make_latest':'false'})
        verified=backup.validate_release(final,ctx,expected,False);require(final.get('published_at') and {a['name']:a['id'] for a in verified}=={a['name']:a['id'] for a in assets})
        private_store(backup,api,env)
        return {'ok':True,'state':'sealed-uat-handover-stored','releaseId':identity,'tag':tag,'retryPermitted':False,'recipientSha256':RECIPIENT,'assets':[{'id':a['id'],'name':a['name'],'size':a['size'],'sha256':expected[a['name']][1]} for a in verified]}

def public_readiness(mode):
    try:
        with urllib.request.urlopen('https://uat.bubblewash.co/api/uat/ready',timeout=10) as response:
            status=response.status;raw=response.read(4097)
    except urllib.error.HTTPError as error:
        status=error.code;raw=error.read(4097)
    require(len(raw)<=4096)
    value=json.loads(raw)
    require(value.get('environment')=='isolated-uat' and value.get('externalProviders')=='disabled' and value.get('productionReady') is False)
    require((status==503 and value.get('ok') is False) if mode=='issue' else status in (200,503))


def main():
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    env=os.environ;request=context(env)
    require(subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()==env['SOURCE_SHA'])
    spec=importlib.util.spec_from_file_location('backup',ROOT/'.github/backup/backup_release.py');backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
    api=backup.GitHub(STORE);private_store(backup,api,env);public_readiness(request['mode'])
    capsule=subprocess.check_output(['git','show',request['runtimeSha']+':scripts/uat-sealed-handover.mjs'],cwd=ROOT)
    request['capsuleSha256']=hashlib.sha256(capsule).hexdigest()
    unit=subprocess.check_output(['git','show',request['runtimeSha']+':ops/uat/bubblewash-uat.service'],cwd=ROOT)
    request['unitSha256']=hashlib.sha256(unit).hexdigest()
    source=(ROOT/'ops/uat/handoff-host.py').read_text()
    require(subprocess.check_output(['git','show',env['SOURCE_SHA']+':ops/uat/handoff-host.py'],cwd=ROOT)==source.encode())
    payload=(source+'\ntry:\n main('+repr(request)+')\nexcept BaseException:\n raise SystemExit(1)\n').encode()
    # Neither the unvalidated remote output nor stderr reaches public job logs.
    spec=importlib.util.spec_from_file_location('bounded_transport',ROOT/'ops/uat/transport-install.py');transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)
    with tempfile.TemporaryFile() as stream:
        stream.write(payload);stream.seek(0)
        raw=transport.bounded(['tailscale','ssh','root@hermes','python3 -I -B -'],stream)
    envelope(raw)
    print(json.dumps(publish(backup,api,env,raw),sort_keys=True))

if __name__=='__main__':
    try:main()
    except BaseException:
        print(json.dumps({'ok':False,'state':'handover-incomplete-stop','retryPermitted':False}));raise SystemExit(1)
