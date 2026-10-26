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
STAGE='context'
PUBLIC_STATUS=None
PUBLIC_JSON=None
STAGES={'context','checkout-pin','storage-repository','storage-commit','public-readiness','runtime-source-pins','host-source-pin','host-capture','host-check-receipt','envelope-validation','publication'}
def stage(value):
    global STAGE
    if value not in STAGES:raise ValueError('Unknown diagnostic stage')
    STAGE=value

def failure_receipt():
    return {'ok':False,'state':'handover-incomplete-stop','retryPermitted':False,'stage':STAGE if STAGE in STAGES else 'context','publicHttpStatus':PUBLIC_STATUS if type(PUBLIC_STATUS) is int and 100<=PUBLIC_STATUS<=599 else None,'publicJson':PUBLIC_JSON if type(PUBLIC_JSON) is bool else None}

RECIPIENT='a479abb3611e11c65eb89e1a437577873e26798161e284572e0bf29ccdc8b4c9'

def require(value):
    if not value:raise ValueError('Private UAT handoff refused')

def context(env):
    require(env.get('GITHUB_REPOSITORY')=='bechirobob/bubble-wash' and env.get('GITHUB_REF')=='refs/heads/main' and env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('GITHUB_RUN_ATTEMPT')=='1')
    require(env.get('ISSUANCE_APPROVED')=='true' and env.get('HANDOVER_READY')=='true' and env.get('RUNNER_DEBUG')!='1' and env.get('ACTIONS_STEP_DEBUG')!='true')
    for name in ('SOURCE_SHA','RUNTIME_SHA','BACKUP_STORE_SHA'):require(re.fullmatch('[a-f0-9]{40}',env.get(name,'')))
    require(env['SOURCE_SHA']==env.get('GITHUB_SHA') and env.get('MODE') in ('issue','retrieve','check') and re.fullmatch('[1-9][0-9]{0,19}',env.get('GITHUB_RUN_ID','')))
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
    stage('storage-repository')
    backup.private_repository(api,STORE,STORE_ID)
    stage('storage-commit')
    require(api.api('git/commits/'+env['BACKUP_STORE_SHA']).get('sha')==env['BACKUP_STORE_SHA'])

def publish(backup,api,env,raw):
    envelope(raw);private_store(backup,api,env);stage('publication')
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
        stage('publication')
        final=api.api(f'releases/{identity}','PATCH',{'draft':False,'make_latest':'false'})
        verified=backup.validate_release(final,ctx,expected,False);require(final.get('published_at') and {a['name']:a['id'] for a in verified}=={a['name']:a['id'] for a in assets})
        private_store(backup,api,env)
        return {'ok':True,'state':'sealed-uat-handover-stored','releaseId':identity,'tag':tag,'retryPermitted':False,'recipientSha256':RECIPIENT,'assets':[{'id':a['id'],'name':a['name'],'size':a['size'],'sha256':expected[a['name']][1]} for a in verified]}

def public_readiness(mode):
    global PUBLIC_STATUS,PUBLIC_JSON
    stage('public-readiness');PUBLIC_STATUS=None;PUBLIC_JSON=None
    try:
        request=urllib.request.Request('https://uat.bubblewash.co/api/uat/ready',headers={'User-Agent':'BubbleWash-UAT-Verification/1.0'})
        with urllib.request.urlopen(request,timeout=10) as response:
            status=response.status;raw=response.read(4097)
    except urllib.error.HTTPError as error:
        status=error.code;raw=error.read(4097)
    PUBLIC_STATUS=status
    require(len(raw)<=4096)
    PUBLIC_JSON=False
    value=json.loads(raw)
    PUBLIC_JSON=isinstance(value,dict)
    require(PUBLIC_JSON)
    require(value.get('environment')=='isolated-uat' and value.get('externalProviders')=='disabled' and value.get('productionReady') is False)
    require((status==503 and value.get('ok') is False) if mode=='issue' else status in (200,503))


def check_receipt(raw):
    require(0<len(raw)<=4096)
    value=json.loads(raw)
    require(set(value)=={'ok','mode','hostVerified','localReadinessStatus','localReady','uatAccountCount','sealedPackageCount'} and value['ok'] is True and value['mode']=='check' and value['hostVerified'] is True and type(value['localReady']) is bool and (value['localReadinessStatus'],value['localReady'])==(503,False) and type(value['uatAccountCount']) is int and value['uatAccountCount']==0 and type(value['sealedPackageCount']) is int and value['sealedPackageCount']==0)
    return {'ok':True,'state':'handover-readonly-check-passed','readOnly':True,'accountsIssued':False,'credentialsRetrieved':False,'storageChanged':False,'publicHttpStatus':PUBLIC_STATUS,**value}

def finish_capture(request,raw,backup,api,env):
    if request['mode']=='check':
        stage('host-check-receipt')
        return check_receipt(raw)
    stage('envelope-validation');envelope(raw)
    stage('publication')
    return publish(backup,api,env,raw)

def main():
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    stage('context')
    env=os.environ;request=context(env)
    stage('checkout-pin')
    require(subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()==env['SOURCE_SHA'])
    spec=importlib.util.spec_from_file_location('backup',ROOT/'.github/backup/backup_release.py');backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
    api=backup.GitHub(STORE);private_store(backup,api,env);public_readiness(request['mode'])
    stage('runtime-source-pins')
    capsule=subprocess.check_output(['git','show',request['runtimeSha']+':scripts/uat-sealed-handover.mjs'],cwd=ROOT)
    request['capsuleSha256']=hashlib.sha256(capsule).hexdigest()
    unit=subprocess.check_output(['git','show',request['runtimeSha']+':ops/uat/bubblewash-uat.service'],cwd=ROOT)
    request['unitSha256']=hashlib.sha256(unit).hexdigest()
    stage('host-source-pin')
    source=(ROOT/'ops/uat/handoff-host.py').read_text()
    require(subprocess.check_output(['git','show',env['SOURCE_SHA']+':ops/uat/handoff-host.py'],cwd=ROOT)==source.encode())
    payload=(source+'\ntry:\n main('+repr(request)+')\nexcept BaseException:\n raise SystemExit(1)\n').encode()
    # Neither the unvalidated remote output nor stderr reaches public job logs.
    spec=importlib.util.spec_from_file_location('bounded_transport',ROOT/'ops/uat/transport-install.py');transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)
    stage('host-capture')
    with tempfile.TemporaryFile() as stream:
        stream.write(payload);stream.seek(0)
        raw=transport.bounded(['tailscale','ssh','root@hermes','python3 -I -B -'],stream)
    print(json.dumps(finish_capture(request,raw,backup,api,env),sort_keys=True))

if __name__=='__main__':
    try:main()
    except BaseException:
        print(json.dumps(failure_receipt(),sort_keys=True));raise SystemExit(1)
