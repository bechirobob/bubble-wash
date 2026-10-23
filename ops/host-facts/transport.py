#!/usr/bin/env python3
"""Manual encrypted host facts; no installation, backup lifecycle or host writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import types

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BACKUP_PIN = '86d085e65b0e6dba906b57c296868da41b01c83982e5b93d6430fd73f05f6992'
SOURCE_PINS = {'ops/host-facts/facts.py': '42ff5948773808b941ad2c9f8a7b6a6db95329b812d9d42ff2cf92b06df0f0eb', 'ops/host-facts/crypto.mjs': '35dfc7aade5492512823b39687dfa14c615f01451bac015ebd487ca588f103f9', 'scripts/php-exposure-inventory.py': 'd1d5eeab85aa3146be20d5d6db32084cb71b9a624c03bcf4a15694866f9e34e5'}  # Filled by the local package freeze, not by runtime input.
KEY = '/home/ubuntu/.hermes/secrets/bubblewash-backup-keys/github-actions.key'
STORE = 'bechirobob/becore-backups'
MAGIC = b'BWHFACT1'

def load_source(path, name, expected=None):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError('source refused')
    raw = path.read_bytes()
    if expected is not None and hashlib.sha256(raw).hexdigest() != expected: raise ValueError('source drift')
    module = types.ModuleType(name); module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module

f = load_source(HERE/'facts.py', 'host_facts', SOURCE_PINS.get('ops/host-facts/facts.py'))

def inputs(env):
    f.require(env.get('GITHUB_REPOSITORY') == 'bechirobob/bubble-wash' and env.get('GITHUB_REF') == 'refs/heads/main' and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch')
    value = {'sourceSha': env.get('GITHUB_SHA'), 'runId': env.get('GITHUB_RUN_ID'), 'runAttempt': env.get('GITHUB_RUN_ATTEMPT')}
    f.require(type(value['sourceSha']) is str and re.fullmatch('[a-f0-9]{40}', value['sourceSha']))
    f.require(all(type(value[k]) is str and re.fullmatch('[1-9][0-9]{0,19}', value[k]) for k in ('runId','runAttempt')))
    f.require(re.fullmatch('[a-f0-9]{40}', env.get('BACKUP_STORE_SHA','')) and re.fullmatch('[1-9][0-9]{0,19}', env.get('BACKUP_STORE_ID','')))
    return value

def payload(context):
    sources = {}
    for name, expected in SOURCE_PINS.items():
        path = ROOT/name; raw = path.read_bytes(); f.require(hashlib.sha256(raw).hexdigest() == expected); sources[name] = raw.decode()
    facts, php, crypto = (sources[n] for n in ('ops/host-facts/facts.py','scripts/php-exposure-inventory.py','ops/host-facts/crypto.mjs'))
    return ("import os,sys,types,json,signal\nsys.dont_write_bytecode=True\n" +
        "facts=types.ModuleType('facts');exec(compile(" + repr(facts) + ",'reviewed-facts','exec'),facts.__dict__)\n" +
        "php=types.ModuleType('php');exec(compile(" + repr(php) + ",'reviewed-php','exec'),php.__dict__)\n" +
        "def deadline(*_): raise TimeoutError()\nsignal.signal(signal.SIGALRM,deadline);signal.alarm(150)\n" +
        "failure='inspection-failed'\ntry:\n facts.require(os.geteuid()==0)\n report,summary=facts.collect(php)\n failure='encryption-unavailable'\n" +
        " node=facts.trusted_executable('/usr/bin/node')\n" +
        " uid=facts.pwd.getpwnam('ubuntu').pw_uid\n" +
        " header={'schema':'bubblewash-host-facts/v1','context':" + repr(context) + ",'summary':summary}\n" +
        " data=facts.canonical(header)+b'\\n'+facts.canonical(report)\n" +
        " crypto=" + repr(crypto + '\nawait main(["encrypt",' + json.dumps(KEY) + ',String(' + 'APP_UID' + ')]);') + "\n" +
        " crypto=crypto.replace('APP_UID',str(uid))\n" +
        " encrypted=facts.bounded([node,'--input-type=module','-e',crypto],data,timeout=30,limit=facts.LIMIT+8232)\n" +
        " sys.stdout.buffer.write(encrypted)\n" +
        "except BaseException:\n sys.stdout.write(json.dumps(facts.summary(result=failure)))\n").encode()

def envelope(data, context):
    f.require(40 < len(data) <= f.LIMIT+8232 and data[:8] == MAGIC)
    length = int.from_bytes(data[8:12], 'big'); f.require(0 < length <= 8192 and len(data) > 12+length+28)
    header = f.strict_json(data[12:12+length]); f.require(f.canonical(header) == data[12:12+length])
    f.require(set(header) == {'schema','context','summary'} and header['schema'] == 'bubblewash-host-facts/v1' and header['context'] == context)
    f.validate_summary(header['summary']); f.require(header['summary']['result'] == 'captured')
    return header

def store_api():
    module = load_source(ROOT/'.github/backup/backup_release.py', 'reviewed_backup_primitives', BACKUP_PIN)
    class API(module.GitHub):
        def command(self, args, data=None):
            return f.strict_json(f.bounded(['gh', *args], data, timeout=180, limit=f.LIMIT+8232, env=self.env))
        def download(self, asset_id, target, expected_size):
            f.require(type(asset_id) is int and asset_id > 0 and 0 < expected_size <= f.LIMIT+8232)
            raw = f.bounded(['gh','api',*self.binary_flags,'--hostname','github.com','--method','GET','-H','Accept: application/octet-stream',f'repos/{self.repository}/releases/assets/{asset_id}'], timeout=180, limit=expected_size, env=self.env)
            f.require(len(raw) == expected_size); write_private(target,raw)
    return module, API(STORE)

def write_private(path, data):
    fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd,'wb') as handle: handle.write(data); handle.flush(); os.fsync(handle.fileno())
    except BaseException: raise

def preflight(module, api, env):
    module.private_repository(api,STORE,int(env['BACKUP_STORE_ID']))
    f.require(api.api('git/commits/'+env['BACKUP_STORE_SHA']).get('sha') == env['BACKUP_STORE_SHA'])

def publish(module, api, env, context, path, work):
    info=path.lstat();f.require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and not info.st_mode&0o077)
    f.require(path.name==f"bubblewash-host-facts-{context['runId']}-{context['runAttempt']}.enc");envelope(path.read_bytes(),context)
    preflight(module,api,env)
    ctx = {'tag':f"bubblewash-host-facts-{context['runId']}-{context['runAttempt']}", 'storageSha':env['BACKUP_STORE_SHA']}
    sha = module.digest(path); checksum=work/(path.name+'.sha256');write_private(checksum,f'{sha}  {path.name}\n'.encode())
    expected={p.name:(p.stat().st_size,module.digest(p)) for p in (path,checksum)}
    release=api.api('releases','POST',{'tag_name':ctx['tag'],'target_commitish':ctx['storageSha'],'name':ctx['tag'], 'body':'Encrypted read-only host facts. Not a backup, restore proof, readiness result or exclusion receipt. No automatic expiry.', 'draft':True,'prerelease':True,'make_latest':'false'})
    identity=release['id'];f.require(type(identity) is int and identity>0)
    for item in (path,checksum):api.upload(identity,item)
    assets=module.validate_release(api.api(f'releases/{identity}'),ctx,expected,True)
    for item in assets:
        target=work/('verify-'+item['name']);api.download(item['id'],target,item['size']);f.require(module.digest(target)==expected[item['name']][1])
    preflight(module,api,env)
    published=api.api(f'releases/{identity}','PATCH',{'draft':False,'make_latest':'false'})
    final=module.validate_release(published,ctx,expected,False)
    f.require(published.get('published_at') and {x['name']:x['id'] for x in final}=={x['name']:x['id'] for x in assets})
    preflight(module,api,env)
    return {'schema':'bubblewash-host-facts-private-receipt/v1','context':context,'storageId':int(env['BACKUP_STORE_ID']),'storageSha':ctx['storageSha'],'tag':ctx['tag'],'releaseId':identity,'assets':[{'name':x['name'],'id':x['id'],'size':x['size'],'sha256':expected[x['name']][1]} for x in assets]}

def retrieve(module,api,receipt,target):
    f.require(set(receipt)=={'schema','context','storageId','storageSha','tag','releaseId','assets'} and receipt['schema']=='bubblewash-host-facts-private-receipt/v1')
    ctx=receipt['context'];env={'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_SHA':ctx['sourceSha'],'GITHUB_RUN_ID':ctx['runId'],'GITHUB_RUN_ATTEMPT':ctx['runAttempt'],'BACKUP_STORE_SHA':receipt['storageSha'],'BACKUP_STORE_ID':str(receipt['storageId'])};inputs(env)
    f.require(type(receipt['releaseId']) is int and receipt['releaseId']>0 and type(receipt['storageId']) is int and receipt['storageId']>0)
    tag=f"bubblewash-host-facts-{ctx['runId']}-{ctx['runAttempt']}";f.require(receipt['tag']==tag)
    name=tag+'.enc';f.require(len(receipt['assets'])==2 and {a['name'] for a in receipt['assets']}=={name,name+'.sha256'})
    for item in receipt['assets']:
        f.require(set(item)=={'name','id','size','sha256'} and type(item['size']) is int and 0<item['size']<=f.LIMIT+8232 and re.fullmatch('[a-f0-9]{64}',item['sha256']))
    expected={a['name']:(a['size'],a['sha256']) for a in receipt['assets']}
    preflight(module,api,env)
    assets=module.validate_release(api.api(f"releases/{receipt['releaseId']}"),{'tag':tag,'storageSha':receipt['storageSha']},expected,False)
    f.require({x['name']:x['id'] for x in assets}=={x['name']:x['id'] for x in receipt['assets']})
    with tempfile.TemporaryDirectory(prefix='private-facts-download-') as directory:
        for item in assets:
            file=Path(directory)/item['name'];api.download(item['id'],file,item['size']);f.require(module.digest(file)==expected[item['name']][1])
        raw=(Path(directory)/name).read_bytes();envelope(raw,ctx)
        f.require((Path(directory)/(name+'.sha256')).read_bytes()==f"{expected[name][1]}  {name}\n".encode())
        preflight(module,api,env);write_private(target,raw)

def discover_receipt(module,api,env,ctx):
    preflight(module,api,env)
    tag=f"bubblewash-host-facts-{ctx['runId']}-{ctx['runAttempt']}"
    release=api.api('releases/tags/'+tag)
    f.require(release.get('tag_name')==tag and release.get('target_commitish')==env['BACKUP_STORE_SHA'] and release.get('draft') is False and release.get('prerelease') is True)
    assets=release.get('assets',[]);name=tag+'.enc'
    f.require(len(assets)==2 and {a.get('name') for a in assets}=={name,name+'.sha256'})
    for asset in assets:f.require(re.fullmatch('sha256:[a-f0-9]{64}',asset.get('digest','')))
    return {'schema':'bubblewash-host-facts-private-receipt/v1','context':ctx,'storageId':int(env['BACKUP_STORE_ID']),'storageSha':env['BACKUP_STORE_SHA'],'tag':tag,'releaseId':release['id'],'assets':[{'name':a['name'],'id':a['id'],'size':a['size'],'sha256':a['digest'][7:]} for a in assets]}

class PhaseFailure(Exception):
    """Only fixed public result categories, never raw errors or host output."""
    def __init__(self, result):
        f.require(result in ('transport-failed', 'storage-failed'))
        self.result = result
        super().__init__(result)


def runner_environment():
    # Tailscale writeKnownHosts uses Go os.UserConfigDir, which needs HOME on Linux.
    # Do not inherit tokens, SSH agents, XDG overrides or debug settings.
    home = os.environ.get('HOME', '')
    f.require(0 < len(home) <= 4096 and Path(home).is_absolute()
              and not any(character in home for character in ('\0', '\r', '\n')))
    return {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': home}


def runner_transport(ctx):
    try:
        # Exact location used by the pinned official Tailscale action on Linux.
        raw=f.bounded(['/usr/local/bin/tailscale','ssh','root@hermes','/usr/bin/python3 -I -B -'],payload(ctx),timeout=180,limit=f.LIMIT+8232,env=runner_environment())
        if raw[:8] != MAGIC:
            f.require(len(raw) <= 8192)
            failure=f.validate_summary(f.strict_json(raw))
            f.require(failure['result'] in ('inspection-failed', 'encryption-unavailable'))
            return raw, failure
        return raw, envelope(raw,ctx)
    except BaseException:
        raise PhaseFailure('transport-failed') from None


def storage_step(function, *args):
    try:
        return function(*args)
    except BaseException:
        raise PhaseFailure('storage-failed') from None

def public_summary(value):
    # Expanded observations remain only in the authenticated private backup header.
    f.validate_summary(value)
    return f.summary(value['flags'], result=value['result'])


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=('inspect','retrieve'));parser.add_argument('--receipt',type=Path);parser.add_argument('--output',type=Path);args=parser.parse_args()
    module,api=storage_step(store_api)
    if args.mode=='retrieve':
        f.require(args.output);receipt=f.strict_json(args.receipt.read_bytes()) if args.receipt else discover_receipt(module,api,os.environ,inputs(os.environ));retrieve(module,api,receipt,args.output);print('HOST_FACTS_RETRIEVAL_VERIFIED');return
    f.require(not args.receipt and not args.output);ctx=inputs(os.environ);storage_step(preflight,module,api,os.environ)
    raw,header=runner_transport(ctx)
    if raw[:8] != MAGIC:
        print('HOST_FACTS_SUMMARY '+f.canonical(public_summary(header)).decode());return 1
    with tempfile.TemporaryDirectory(prefix='encrypted-host-facts-',dir=os.environ['RUNNER_TEMP']) as directory:
        work=Path(directory);path=work/f"bubblewash-host-facts-{ctx['runId']}-{ctx['runAttempt']}.enc";write_private(path,raw)
        receipt=storage_step(publish,module,api,os.environ,ctx,path,work)
    write_private(Path(os.environ['RUNNER_TEMP'])/'host-facts-receipt.json',f.canonical(receipt))
    print('HOST_FACTS_SUMMARY '+f.canonical(public_summary(header['summary'])).decode())
    print('HOST_FACTS_CIPHERTEXT_SHA256 '+hashlib.sha256(raw).hexdigest())

if __name__=='__main__':
    try:result=main()
    except PhaseFailure as error:
        print('HOST_FACTS_SUMMARY '+f.canonical(f.summary(result=error.result)).decode());result=1
    except BaseException:
        print('HOST_FACTS_SUMMARY '+f.canonical(f.summary(result='inspection-failed')).decode());result=1
    raise SystemExit(result or 0)
