"""Reviewed source-only receiver: isolated start or exact additive routing, never accounts."""
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import tempfile

PIN='e7de6a5ea121b50b3ae691451fe9377466d7bba7ca5748009f6612a10194b735'
FILES={'ops/uat/activate-host.py','ops/uat/bubblewash-uat.service','scripts/uat-isolation-check.mjs','ops/add-uat-host.py'}
MODES={'check','start','route-check','route-activate'}

def validate(ctx,sources):
    if set(ctx)!={'source','runtime','runId','mode','caddy'} or ctx['mode'] not in MODES or ctx['caddy']!=PIN: raise ValueError('context')
    if any(not re.fullmatch('[a-f0-9]{40}',ctx[k]) for k in ('source','runtime')) or not re.fullmatch('[1-9][0-9]{0,19}',ctx['runId']): raise ValueError('pin')
    if set(sources)!=FILES or any(not isinstance(s,str) or not 0<len(s.encode())<=131072 for s in sources.values()): raise ValueError('source bounds')

def no_accounts(path):
    if path.is_symlink() or not path.is_file() or path.resolve()!=path: raise ValueError('unsafe database')
    database=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)
    try:
        database.execute('PRAGMA query_only=ON')
        database.execute('PRAGMA trusted_schema=OFF')
        exists=database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_uat_accounts'").fetchone()
        if exists and database.execute('SELECT 1 FROM staff_uat_accounts LIMIT 1').fetchone(): raise ValueError('Accounts already issued')
    finally: database.close()

def route_ready(module,ctx,unit):
    for path in (module.APP/'SOURCE_REVISION',module.UNIT,module.CONFIG/'environment'):
        module.trusted(path)
    if (module.APP/'SOURCE_REVISION').read_text()!=ctx['runtime']+'\n' or module.UNIT.read_text()!=unit: raise ValueError('runtime mismatch')
    text=(module.CONFIG/'environment').read_text()
    if text.count('BUBBLEWASH_BOOKINGS_DISABLED=false\n')!=1: raise ValueError('inactive environment')
    module.environment(text.replace('BUBBLEWASH_BOOKINGS_DISABLED=false\n','BUBBLEWASH_BOOKINGS_DISABLED=true\n'))
    module.loaded_unit()
    module.run(['/usr/bin/systemctl','is-active','--quiet',module.SERVICE])
    pid=module.run(['/usr/bin/systemctl','show',module.SERVICE,'-p','MainPID','--value'],capture=True).stdout.decode().strip()
    lines=module.run(['/usr/bin/ss','-H','-ltnp','sport = :3108'],capture=True).stdout.decode().splitlines()
    if not pid.isdigit() or int(pid)<=1 or len(lines)!=1 or '127.0.0.1:3108' not in lines[0] or 'pid='+pid+',' not in lines[0]: raise ValueError('listener ownership')
    no_accounts(module.DATA/'uat.sqlite')
    module.checks() # UAT login, anonymous forbidden and readiness503: no issued accounts.

def main(ctx,sources):
    try:
        validate(ctx,sources)
        if os.geteuid()!=0: raise ValueError('root')
        signal.alarm(300)
        for path in (Path('/var'),Path('/var/lib')):
            info=path.lstat()
            if path.is_symlink() or info.st_uid!=0 or info.st_mode&0o022: raise ValueError('staging ancestry')
        os.umask(0o077)
        stage=Path(tempfile.mkdtemp(prefix='bubblewash-uat-activation-'+ctx['runId']+'-',dir='/var/lib'))
        for name,text in sources.items():
            target=stage/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w') as out:out.write(text)
        spec=importlib.util.spec_from_file_location('uat_activation',stage/'ops/uat/activate-host.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        if ctx['mode']=='check': module.verify(ctx['runtime'])
        elif ctx['mode']=='start': module.activate(ctx['runtime'])
        else:
            route_ready(module,ctx,sources['ops/uat/bubblewash-uat.service'])
            result=module.run(['/usr/bin/python3','-I','-B',str(stage/'ops/add-uat-host.py'),'--activate' if ctx['mode']=='route-activate' else '--check-only',ctx['caddy']],timeout=90,capture=True)
            if len(result.stdout)>16384:raise ValueError('route receipt bounds')
            receipt=json.loads(result.stdout)
            if receipt.get('ok') is not True or receipt.get('otherRoutesEquivalent') is not True:raise ValueError('route receipt')
            if ctx['mode']=='route-check' and (receipt.get('checkOnly') is not True or receipt.get('configurationChanged') is not False):raise ValueError('check receipt')
            if ctx['mode']=='route-activate' and (receipt.get('host')!='uat.bubblewash.co' or receipt.get('upstream')!='127.0.0.1:3108'):raise ValueError('activation receipt')
        print(json.dumps({'ok':True,'mode':ctx['mode'],'source':ctx['source'],'runtime':ctx['runtime'],'accountsIssued':False,'automaticRetry':False}))
    except Exception:
        print('{"ok":false,"automaticRetry":false,"message":"UAT action refused or incomplete; inspect retained state."}')
        raise SystemExit(1)
