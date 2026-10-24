#!/usr/bin/env python3
"""Emit a trusted stdin bootstrap, verifying all adapter bytes BEFORE imports."""
import argparse
import sys
from pathlib import Path
import re
sys.dont_write_bytecode = True
from contracts import HERE, VENDOR, digest, require, require_fallback_proof_binding
from host_adapter import adapter_manifest, completion_confirmation


def validate_preparation_request(request, contract):
    keys = {'runId','runAttempt','candidateSha','fallbackSha','backupSha256','receiptRun','storeSha','storeId','node'}
    require(type(request) is dict and set(request) == keys, 'invalid preparation fields')
    require(type(request['runAttempt']) is int and request['runAttempt'] == 1, 'preparation retry refused')
    for key in ('runId','receiptRun'):
        require(type(request[key]) is str and re.fullmatch('[1-9][0-9]{0,19}',request[key]), 'invalid run identity')
    for key in ('backupSha256',):
        require(type(request[key]) is str and re.fullmatch('[a-f0-9]{64}', request[key]), 'invalid backup pin')
    require(type(request['storeSha']) is str and re.fullmatch('[a-f0-9]{40}',request['storeSha']) and type(request['storeId']) is int and request['storeId'] > 0, 'invalid store identity')
    for label in ('candidate','fallback'):
        require(request[label+'Sha'] == contract['profiles']['integration-'+label+'-v1']['publicationCommit'], 'published pair differs')
    node=request['node']
    require(type(node) is dict and set(node)=={'path','sha256'} and type(node['path']) is str and
            Path(node['path']).is_absolute() and '..' not in Path(node['path']).parts and
            type(node['sha256']) is str and re.fullmatch('[a-f0-9]{64}',node['sha256']), 'invalid Node identity')
    return request


def public_package():
    """Only reviewed code is serialized; private host values never enter this emitter."""
    import hashlib
    from contracts import canonical
    files=adapter_manifest()
    data={name:(HERE/name).read_text() for name in files}
    data['source-contracts.json']=(HERE/'source-contracts.json').read_text()
    package=hashlib.sha256(canonical({'adapterFiles':files,'sourceContractSha256':digest(HERE/'source-contracts.json')})).hexdigest()
    return package, data


def embedded_dependencies():
    from contracts import read_json
    root=HERE.parent
    pins=read_json(root/'survey-update-source-pins.json')
    require(pins['runtimeSha']=='853b7c1020fb7dab66f302a2603369d5fa8b3dff' and pins['runtimeTree']=='24fbe62668c996d0821153cf341b24765ef653b1', 'live source differs')
    for name,pin in pins['dependencies'].items():
        require(digest(root/name)==pin,'existing preparation guard differs')
    require(digest(root/'inactive-staging/prepare_pair.py') == __import__('contracts').PREPARATION_HELPER_SHA256, 'preparation helper differs')
    paths={'preparation_core':root/'deploy-preserving.py','preparation_guards':root/'deploy-survey-only.py',
           'preparation_scanner':root/'deploy-survey-update.py','integration_preparation':root/'inactive-staging/prepare_pair.py',
           'preparation_stager':root/'inactive-staging/stage_artifact.py'}
    return {name:path.read_text() for name,path in paths.items()}, pins, read_json(root/'survey-only-source-pins.json')


def preparation_bootstrap(mode, request):
    import hashlib
    from contracts import read_json
    contract=read_json(HERE/'source-contracts.json')
    if mode=='prepare': validate_preparation_request(request,contract)
    else:
        from materialize_plan import validate_materialization_request
        validate_materialization_request(request,contract)
    require_fallback_proof_binding(contract['profiles']['integration-fallback-v1']['publicationCommit'])
    package, sources=public_package()
    if mode=='materialize': require(request['packageId']==package,'materialization package differs')
    dependencies,pins,guard_pins=embedded_dependencies()
    # No host imports occur until every protected package byte is checked. New
    # packages are exclusive; an uncertain preparation cannot overwrite them.
    program='''import os, sys, stat, pathlib, hashlib, json, types
sys.dont_write_bytecode=True
require=lambda value: None if value else (_ for _ in ()).throw(ValueError('control bootstrap refused'))
require(os.geteuid()==0 and os.getegid()==0)
os.umask(0o022)
state=pathlib.Path('/var/lib/bubblewash-release')
def protected(path):
 require(path.resolve(strict=True)==path)
 for p in (path,*path.parents):
  s=p.lstat();require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_gid==0 and not s.st_mode & 0o022)
protected(state)
'''
    program += 'mode='+repr(mode)+'\nrequest='+repr(request)+'\nsources='+repr(sources)+'\n'
    program += 'base=state/"packages"/'+repr(package)+'\n'
    program += '''if mode=='prepare':
 for name,permissions in (('packages',0o755),('releases',0o755),('plans',0o700),('rehearsal-evidence',0o700)):
  p=state/name
  if not os.path.lexists(p):p.mkdir(mode=permissions)
  protected(p);require(stat.S_IMODE(p.stat().st_mode)==permissions)
 base.mkdir(mode=0o755)
 for name,body in sorted(sources.items()):
  path=base/name
  for parent in reversed(path.parent.relative_to(base).parents):
   p=base/parent
   if not p.exists():p.mkdir(mode=0o755)
  path.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
  protected(path.parent)
  with path.open('xb') as stream:
   os.fchmod(stream.fileno(),0o644);stream.write(body.encode());stream.flush();os.fsync(stream.fileno())
 for p in sorted([base.parent,base]+[p for p in base.rglob('*') if p.is_dir()],key=lambda p:len(p.parts),reverse=True):
  fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:os.fsync(fd)
  finally:os.close(fd)
protected(base)
entries=list(base.rglob('*'))
require(all(not p.is_symlink() for p in entries))
require({p.relative_to(base).as_posix() for p in entries if p.is_file()}==set(sources))
for name,body in sources.items():
 p=base/name;protected(p.parent);s=p.lstat()
 require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_gid==0 and s.st_nlink==1 and not s.st_mode & 0o022)
 require(p.read_bytes()==body.encode())
sys.path.insert(0,str(base))
import contracts, host_adapter
'''
    program += 'dependencies='+repr(dependencies)+'\n'
    program += '''for name,body in dependencies.items():
 m=types.ModuleType(name);m.__file__='/nonexistent-reviewed-control/'+name+'.py';sys.modules[name]=m
 exec(compile(body,m.__file__,'exec'),m.__dict__)
 m.__source_sha256__=hashlib.sha256(body.encode()).hexdigest();m.__source_verified__=True
core=sys.modules['preparation_core'];guards=sys.modules['preparation_guards'];scanner=sys.modules['preparation_scanner']
guards.core=core
'''
    program += 'guards.pins='+repr(guard_pins)+'\nscanner.pins='+repr(pins)+'\n'
    program += '''scanner.core=core;scanner.guards=guards
contract=contracts.read_json(base/'source-contracts.json')
if mode=='prepare':
 result=sys.modules['integration_preparation'].prepare_pair(request,core=core,guards=guards,scanner=scanner,
  contracts=contracts,adapter=host_adapter,stager=sys.modules['preparation_stager'],contract=contract)
 require(type(result) is dict)
 if result.get('ok'):
  evidence=state/'rehearsal-evidence'/(request['runId']+'-1')/'evidence.json'
  protected(evidence.parent);info=evidence.lstat()
  require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_gid==0 and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600)
  raw=evidence.read_bytes();record=json.loads(raw)
  require(record['schema']=='bubblewash-inactive-preparation/v1' and record['operation']==request['runId']+'-1' and record['maintenanceApproval'] is False)
  require(record['liveSha']=='853b7c1020fb7dab66f302a2603369d5fa8b3dff' and all(record['pair'][label]['sha']==request[label+'Sha'] for label in ('candidate','fallback')))
  result.update(preparationEvidenceSha256=hashlib.sha256(raw).hexdigest(),packageId=base.name)
 print(json.dumps(result,sort_keys=True))
 if not result.get('ok'):raise SystemExit(1)
else:
 from materialize_plan import materialize_prepared
 result=materialize_prepared(request)
 print(json.dumps(result,sort_keys=True))
'''
    # An exception can contain private host values. Report only fixed refusal
    # metadata while keeping the failed operation nonzero and non-retriable.
    import textwrap
    return "import sys,json\ntry:\n" + textwrap.indent(program,' ') + "\nexcept BaseException:\n print(json.dumps({'ok':False,'status':'control-bootstrap-refused-or-incomplete','inspectBeforeRetry':True,'automaticRetry':False}),file=sys.stderr)\n raise SystemExit(1)\n"


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan-id', default='')
    parser.add_argument('--plan-sha256', default='')
    parser.add_argument('--candidate-sha', default='')
    parser.add_argument('--fallback-sha', default='')
    parser.add_argument('--mode', choices=('prepare','materialize','inspect-host-evidence','inspect','execute','recover','complete-migration'), required=True)
    parser.add_argument('--completion-confirmation', default='')
    parser.add_argument('--preparation-request', type=Path)
    parser.add_argument('--materialization-request', type=Path)
    args=parser.parse_args()
    if args.mode in ('prepare','materialize'):
        from contracts import read_json
        request_path = args.preparation_request if args.mode == 'prepare' else args.materialization_request
        require(request_path is not None and not any((args.plan_id,args.plan_sha256,args.candidate_sha,args.fallback_sha,args.completion_confirmation)), 'unexpected preparation inputs')
        require(not (args.materialization_request if args.mode == 'prepare' else args.preparation_request), 'conflicting request')
        print(preparation_bootstrap(args.mode,read_json(request_path)))
        raise SystemExit(0)
    require(not args.preparation_request and not args.materialization_request, 'unexpected request')
    if args.mode == 'inspect-host-evidence':
        require(not any((args.plan_id, args.plan_sha256, args.candidate_sha,
                         args.fallback_sha, args.completion_confirmation)),
                'evidence route takes no release inputs')
        # Use existing reviewed modules in memory. Never stage/import host code,
        # create files or instantiate the durable controller for this route.
        guard_name = 'bubblewash-web-a476-baseline/ops/deploy-preserving.py'
        require(digest(HERE/'vendor'/guard_name) == VENDOR[guard_name],
                'historical evidence guard differs')
        modules = [('contracts', HERE/'contracts.py'),
                   ('host_adapter', HERE/'host_adapter.py'),
                   ('evidence_guard', HERE/'vendor/bubblewash-web-a476-baseline/ops/deploy-preserving.py')]
        print('import sys, types, json\nsys.dont_write_bytecode = True')
        for name, path in modules:
            body = path.read_text()
            print('m = types.ModuleType('+repr(name)+')')
            print('m.__file__ = '+repr('/nonexistent-bubblewash-evidence/'+name+'.py'))
            print('sys.modules['+repr(name)+'] = m')
            print('exec(compile('+repr(body)+', m.__file__, "exec"), m.__dict__)')
        print("try:\n print(json.dumps(sys.modules['host_adapter'].inspect_host_evidence(sys.modules['evidence_guard']), sort_keys=True))\nexcept BaseException as error:\n print(json.dumps(sys.modules['host_adapter'].evidence_failure(error), sort_keys=True), file=sys.stderr)\n raise SystemExit(1)")
        raise SystemExit(0)
    require(re.fullmatch('[a-f0-9]{64}',args.plan_id) and re.fullmatch('[a-f0-9]{64}',args.plan_sha256), 'invalid plan identity')
    require(re.fullmatch('[a-f0-9]{40}',args.candidate_sha) and re.fullmatch('[a-f0-9]{40}',args.fallback_sha) and args.candidate_sha != args.fallback_sha, 'invalid published pair')
    completion_confirmation(args.mode, args.completion_confirmation, args.plan_sha256)
    if args.mode != 'inspect': require_fallback_proof_binding(args.fallback_sha)
    files=adapter_manifest()
    # The approval materialization is host-local; stdin contains only public code
    # hashes and selected review IDs, never env/backup/database content.
    print('''import hashlib, json, os, pathlib, stat, sys
sys.dont_write_bytecode = True
require = lambda value: None if value else (_ for _ in ()).throw(ValueError('bootstrap refused'))
base = pathlib.Path('/var/lib/bubblewash-release/packages') / '''+repr(args.plan_id)+'''
require(os.geteuid() == 0 and base.resolve(strict=True) == base)
for directory in (base, *base.parents):
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
expected = '''+repr(files)+'''
entries = list(base.rglob('*'))
require(all(not p.is_symlink() and '__pycache__' not in p.parts and p.suffix != '.pyc' for p in entries))
for entry in entries:
    info = entry.lstat()
    require((stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) and info.st_uid == 0 and not info.st_mode & 0o022)
    if stat.S_ISREG(info.st_mode):
        require(info.st_nlink == 1)
actual = {p.relative_to(base).as_posix() for p in entries if p.is_file() and p.name != 'source-contracts.json'}
require(actual == set(expected))
for name, pin in expected.items():
    path = base / name
    info = path.lstat()
    require(path.resolve(strict=True) == path)
    for parent in path.parents:
        parent_info = parent.lstat()
        require(stat.S_ISDIR(parent_info.st_mode) and parent_info.st_uid == 0 and not parent_info.st_mode & 0o022)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and not info.st_mode & 0o022)
    require(hashlib.sha256(path.read_bytes()).hexdigest() == pin)
plan_path = pathlib.Path('/var/lib/bubblewash-release/plans/'''+args.plan_id+'''.json')
info = plan_path.lstat()
require(plan_path.resolve(strict=True) == plan_path and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022)
require(hashlib.sha256(plan_path.read_bytes()).hexdigest() == '''+repr(args.plan_sha256)+''')
plan = json.loads(plan_path.read_bytes())
require(plan['releaseShas'] == '''+repr({'candidate':args.candidate_sha,'fallback':args.fallback_sha})+''')
require(hashlib.sha256((base/'source-contracts.json').read_bytes()).hexdigest() == '''+repr(digest(HERE/'source-contracts.json'))+''')
require(plan['sourceContractSha256'] == '''+repr(digest(HERE/'source-contracts.json'))+''')
sys.path.insert(0, str(base))
from host_adapter import main
sys.argv = ['host_adapter', '--plan', '/var/lib/bubblewash-release/plans/'''+args.plan_id+'''.json', '--plan-sha256', '''+repr(args.plan_sha256)+''', '--mode', '''+repr(args.mode)+''', '--completion-confirmation', '''+repr(args.completion_confirmation)+''']
try:
    main()
except BaseException:
    print('Integration host route did not confirm acceptance; inspect durable state before retry.', file=sys.stderr)
    raise SystemExit(1)
''')
