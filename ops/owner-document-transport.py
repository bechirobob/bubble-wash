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
SOURCE_PINS={'ops/deploy-preserving.py': '29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a', 'ops/deploy-survey-only.py': 'bb435e7a32baa516b8d89e65e64f2b2db0779657f6c25039130c9520f5d5e509', 'ops/deploy-survey-update.py': '8de4ce5d5f543bc52a4d81590490058681df4450dbe44702f426c97cf0fd4e0a', 'ops/survey-update-source-pins.json': '2a32e268366871daf30d30a8bc791e65b91af24c99309f4d0017175457c73ca3', 'scripts/release-preflight.py': '35c2b2b2ff9943d9989c97568e8a9da5735c8970e99d863297f15c8970df1a1a', 'ops/host-facts/facts.py': '42ff5948773808b941ad2c9f8a7b6a6db95329b812d9d42ff2cf92b06df0f0eb', 'ops/run-research-test.py': '36f6d9cfae5c901be144a45d0c8b0e6ccaaa5af7e19596cfd569ed6db34ff6fb', '.github/backup/backup_release.py': '86d085e65b0e6dba906b57c296868da41b01c83982e5b93d6430fd73f05f6992', 'ops/owner-document-host.py': '02409c3032e86cf7897a7e939322425cb8c642d11fa3af8011d1c400f6ab362f', 'ops/owner-document-capsule.mjs': 'd03201c365b9f09e42a410960bf13b21887c2d6fdca18c967f93fbd5343e2500'}  # Exact reviewed public helpers only.


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
    if mode=='issue-document':require(env.get('HANDOVER_READY')=='true' and approved)
    request={'mode':mode,'approved':approved,'recipient':person,'context':{'controlSha':env.get('GITHUB_SHA',''),'runtimeSha':env.get('RUNTIME_SHA',''),
             'runId':env.get('GITHUB_RUN_ID',''),'runAttempt':env.get('GITHUB_RUN_ATTEMPT',''),'actor':env.get('GITHUB_ACTOR','')},
             'publicKey':public_key_from_input(env.get('HANDOFF_PUBLIC_KEY','')) if mode=='issue-document' else '',
             'backup':{'sha256':env.get('BACKUP_SHA',''),'runId':env.get('RECEIPT_RUN',''),'storeSha':env.get('BACKUP_STORE_SHA',''),'storeId':int(env.get('BACKUP_STORE_ID','0'))} if mode=='issue-document' else None}
    host=module('owner_host_validation','ops/owner-document-host.py');host.pins=pins;host.validate(request)
    return request,host


def payload(request,pins):
    paths={'core':'ops/deploy-preserving.py','guards':'ops/deploy-survey-only.py','scanner':'ops/deploy-survey-update.py',
           'preflight':'scripts/release-preflight.py','facts':'ops/host-facts/facts.py','operator':'ops/run-research-test.py','host':'ops/owner-document-host.py'}
    program='import types\n'
    for name,path in paths.items():
        program+=name+"=types.ModuleType("+repr('reviewed_'+name)+');exec(compile('+repr(source(path).decode())+','+repr(path)+",'exec'),"+name+'.__dict__)\n'
    program+="guards.core=core;scanner.core=core;scanner.guards=guards;scanner.pins="+repr(pins)+'\n'
    program+='host.core=core;host.guards=guards;host.scanner=scanner;host.preflight=preflight;host.facts=facts;host.operator=operator;host.pins='+repr(pins)+'\n'
    program+='host.CAPSULE='+repr(source('ops/owner-document-capsule.mjs').decode())+'\n'
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
    host.envelope(raw,request);store_preflight(backup,api,env)
    tag='bubblewash-owner-document-'+request['context']['runId']+'-1';ctx={'tag':tag,'storageSha':env['BACKUP_STORE_SHA']}
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
        return {'ok':True,'state':'sealed-handover-stored','retryPermitted':False,'context':host.context(request),'releaseId':identity,
                'assets':[{'id':a['id'],'name':a['name'],'size':a['size'],'sha256':expected[a['name']][1]} for a in verified]}


def main():
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));stage='input';attempted=False
    try:
        pins=json.loads(source('ops/survey-update-source-pins.json'));request,host=input_request(os.environ,pins)
        facts=module('owner_bounded_transport','ops/host-facts/facts.py')
        backup=api=None
        if request['mode']=='issue-document':
            stage='storage';backup=module('owner_private_storage','.github/backup/backup_release.py');api=backup.GitHub(STORE);store_preflight(backup,api,os.environ)
        stage='host';attempted=request['mode']=='issue-document'
        # Capture both pipes; neither private inputs nor unchecked output reach logs.
        raw=facts.bounded(['/usr/local/bin/tailscale','ssh','root@hermes','/usr/bin/python3 -I -B -'],payload(request,pins),timeout=180,limit=16384,env=runner_environment())
        if request['mode']=='check' or raw.startswith(b'{"ok"') or b'"schema"' not in raw:
            result=json.loads(raw)
            allowed={'ok','state','duplicateTypes','managedRole','managedStatus','accountCreated','retryPermitted','stage'}
            require(type(result) is dict and set(result)<=allowed and result.get('state') in ('clear','collision','blocked','outcome-uncertain-stop'))
            require(type(result.get('ok')) is bool and result.get('retryPermitted') is False)
            if 'accountCreated' in result:require(result['accountCreated'] is False)
            if 'duplicateTypes' in result:require(type(result['duplicateTypes']) is list and all(v in ('configured','master','managed','roster') for v in result['duplicateTypes']))
            if 'managedRole' in result:require(result['managedRole'] in (None,'admin','vendor','driver','support','unknown'))
            if 'managedStatus' in result:require(result['managedStatus'] in (None,'active','invited','suspended','unknown'))
            if 'stage' in result:require(result['stage'] in ('request','source','configuration','runtime','collision','backup','issuance'))
            require(request['mode']=='check' or result['ok'] is False)
        else:
            stage='storage';result=publish(backup,api,os.environ,request,raw,host)
        print(json.dumps(result,sort_keys=True));raise SystemExit(0 if result['ok'] else 1)
    except SystemExit:raise
    except BaseException:
        print(json.dumps({'ok':False,'state':'outcome-uncertain-stop' if attempted else 'blocked','stage':stage,'retryPermitted':False}));raise SystemExit(1)


if __name__=='__main__':main()
