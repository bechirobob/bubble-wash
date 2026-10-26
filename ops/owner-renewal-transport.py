#!/usr/bin/env python3
"""One protected recipient, captured SSH output, ciphertext-only private storage."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import sys
import tempfile
import types

ROOT=Path(__file__).resolve().parents[1]
STORE='bechirobob/becore-backups'
SOURCE_PINS = json.loads((ROOT/'ops/owner-renewal-source-pins.json').read_bytes())['sourceHashes']


def require(value):
    if not value:raise ValueError('private owner operation refused')


def source(name):
    path=ROOT/name;require(not path.is_symlink() and path.is_file());raw=path.read_bytes()
    require(hashlib.sha256(raw).hexdigest()==SOURCE_PINS[name]);return raw


def module(name,path):
    value=types.ModuleType(name);value.__file__=str(ROOT/path);exec(compile(source(path),path,'exec'),value.__dict__);return value


def public_key_from_input(value):
    # GitHub's workflow string field is single-line. Accept only canonical
    # base64 SPKI DER, not PEM, whitespace, private keys or alternate encodings.
    # Existing host/capsule validation still enforces RSA3072 and the same DER hash.
    require(type(value) is str and 0<len(value)<=2048)
    raw=base64.b64decode(value,validate=True)
    require(300<len(raw)<1024 and base64.b64encode(raw).decode('ascii')==value)
    return '-----BEGIN PUBLIC KEY-----\n'+'\n'.join(value[i:i+64] for i in range(0,len(value),64))+'\n-----END PUBLIC KEY-----\n'


def input_request(env,pins):
    require(env.get('GITHUB_REPOSITORY')=='bechirobob/bubble-wash' and env.get('GITHUB_REF')=='refs/heads/main' and env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('GITHUB_RUN_ATTEMPT')=='1')
    require(env.get('RUNNER_DEBUG')!='1' and env.get('ACTIONS_STEP_DEBUG')!='true')
    private=env.pop('BUBBLEWASH_ADDITIONAL_OWNER_INPUT','');require(0<len(private)<=1024)
    person=json.loads(private);mode=env.get('OWNER_MODE','check');approved=env.get('ISSUANCE_APPROVED')=='true'
    if mode=='renew-document':require(env.get('HANDOVER_READY')=='true' and approved)
    request={'mode':mode,'approved':approved,'recipient':person,'context':{'controlSha':env.get('GITHUB_SHA',''),'runtimeSha':env.get('RUNTIME_SHA',''),
             'runId':env.get('GITHUB_RUN_ID',''),'runAttempt':env.get('GITHUB_RUN_ATTEMPT',''),'actor':env.get('GITHUB_ACTOR','')},
             'publicKey':public_key_from_input(env.get('HANDOFF_PUBLIC_KEY','')) if mode=='renew-document' else '',
             'expectedFingerprint':env.get('STATUS_FINGERPRINT',''),
             'backup':{'sha256':env.get('BACKUP_SHA',''),'runId':env.get('RECEIPT_RUN',''),'storeSha':env.get('BACKUP_STORE_SHA',''),'storeId':int(env.get('BACKUP_STORE_ID','0'))} if mode=='renew-document' else None}
    host=module('owner_host_validation','ops/owner-renewal-host.py');host.pins=pins;host.old=module('old_owner_validation','ops/owner-document-host.py');host.validate(request)
    return request,host


def payload(request,pins):
    paths={'preserving':'ops/deploy-preserving.py','guards':'ops/deploy-survey-only.py','update':'ops/deploy-survey-update.py',
           'base':'ops/exact-cleanup-host.py','old':'ops/owner-document-host.py','host':'ops/owner-renewal-host.py'}
    program='import types\n'
    for name,path in paths.items():
        program+=name+"=types.ModuleType("+repr('reviewed_'+name)+');exec(compile('+repr(source(path).decode())+','+repr(path)+",'exec'),"+name+'.__dict__)\n'
    program+="host.modules={'preserving':preserving,'guards':guards,'update':update}\n"
    program+='host.base=base;host.old=old;host.pins='+repr(pins)+'\n'
    program+='host.CAPSULE='+repr(source('ops/owner-renewal-capsule.mjs').decode())+'\n'
    program+='host.main('+repr(request)+')\n'
    return program.encode()


def runner_environment():
    home=os.environ.get('HOME','');require(Path(home).is_absolute() and len(home)<=4096 and not any(c in home for c in '\r\n\0'))
    return {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':home,'LC_ALL':'C'}


def store_preflight(backup,api,env):
    require(re.fullmatch('[a-f0-9]{40}',env.get('BACKUP_STORE_SHA','')) and re.fullmatch('[1-9][0-9]*',env.get('BACKUP_STORE_ID','')))
    backup.private_repository(api,STORE,int(env['BACKUP_STORE_ID']))
    require(api.api('git/commits/'+env['BACKUP_STORE_SHA']).get('sha')==env['BACKUP_STORE_SHA'])


def write_private(path,raw):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as handle:handle.write(raw);handle.flush();os.fsync(handle.fileno())


def publish(backup,api,env,request,raw,host):
    host.old.envelope(raw,request);store_preflight(backup,api,env)
    tag='bubblewash-owner-renewal-'+request['context']['runId']+'-1';ctx={'tag':tag,'storageSha':env['BACKUP_STORE_SHA']}
    with tempfile.TemporaryDirectory(prefix='sealed-owner-document-') as directory:
        work=Path(directory);encrypted=work/(tag+'.enc');write_private(encrypted,raw)
        digest=hashlib.sha256(raw).hexdigest();checksum=work/(tag+'.enc.sha256');write_private(checksum,(digest+'  '+encrypted.name+'\n').encode())
        expected={p.name:(p.stat().st_size,backup.digest(p)) for p in (encrypted,checksum)}
        release=api.api('releases','POST',{'tag_name':tag,'target_commitish':ctx['storageSha'],'name':tag,
                  'body':'One-operation encrypted owner handover. Not a database backup. No plaintext credentials or recipient metadata.',
                  'draft':True,'prerelease':True,'make_latest':'false'})
        identity=release['id'];require(type(identity) is int and identity>0)
        for item in (encrypted,checksum):api.upload(identity,item)
        assets=backup.validate_release(api.api(f'releases/{identity}'),ctx,expected,True)
        for asset in assets:
            target=work/('verify-'+asset['name']);api.download(asset['id'],target,asset['size']);require(backup.digest(target)==expected[asset['name']][1])
        store_preflight(backup,api,env)
        final=api.api(f'releases/{identity}','PATCH',{'draft':False,'make_latest':'false'})
        verified=backup.validate_release(final,ctx,expected,False);require(final.get('published_at') and {a['name']:a['id'] for a in verified}=={a['name']:a['id'] for a in assets})
        store_preflight(backup,api,env)
        return {'ok':True,'state':'sealed-handover-stored','retryPermitted':False,'context':host.old.context(request),'releaseId':identity,
                'assets':[{'id':a['id'],'name':a['name'],'size':a['size'],'sha256':expected[a['name']][1]} for a in verified]}


def main():
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));stage='input';attempted=False
    try:
        pins={'runtimeSha':'f7305933b15a285bbd393a2057bf5d27e4b9985c','runtimePins':json.loads(source('ops/pwa-update-source-pins.json'))};request,host=input_request(os.environ,pins)
        facts=module('owner_bounded_transport','ops/host-facts/facts.py')
        backup=api=None
        if request['mode']=='renew-document':
            stage='storage';backup=module('owner_private_storage','.github/backup/backup_release.py');api=backup.GitHub(STORE);store_preflight(backup,api,os.environ)
        stage='host';attempted=request['mode']=='renew-document'
        # Capture both pipes; neither private inputs nor unchecked output reach logs.
        raw=facts.bounded(['/usr/local/bin/tailscale','ssh','root@hermes','/usr/bin/python3 -I -B -'],payload(request,pins),timeout=180,limit=16384,env=runner_environment())
        if request['mode']=='check' or raw.startswith(b'{"ok"') or b'"schema"' not in raw:
            result=json.loads(raw)
            if request['mode']=='check' and 'eligible' in result:
                host.result_valid(result)
                result={**result,'ok':True,'readOnly':True,'retryPermitted':False}
            else:
                require(type(result) is dict and set(result)=={'ok','state','check','retryPermitted','stage'})
                require(result['ok'] is False and result['retryPermitted'] is False)
                require(result['check'] in module('renewal_check_labels','ops/exact-cleanup-host.py').CHECKPOINTS)
                require(result['state'] in ('blocked','outcome-uncertain-stop') and result['stage'] in ('binding','preflight','status','renewal'))
        else:
            stage='storage';result=publish(backup,api,os.environ,request,raw,host)
        print(json.dumps(result,sort_keys=True));raise SystemExit(0 if result['ok'] else 1)
    except SystemExit:raise
    except BaseException:
        print(json.dumps({'ok':False,'state':'outcome-uncertain-stop' if attempted else 'blocked','stage':stage,'retryPermitted':False}));raise SystemExit(1)


if __name__=='__main__':main()
