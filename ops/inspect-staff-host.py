#!/usr/bin/env python3
"""Read only Caddy's local active HTTP routes. Never print configuration bodies."""
import hashlib
import copy
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import urllib.request

HOSTS = {'bubblewash.co', 'www.bubblewash.co', 'staff.bubblewash.co', '*.bubblewash.co'}
LIMIT = 2 * 1024 * 1024
STAFF_BLOCK=b'\n\n# Separate Bubble Wash staff home-screen app\nstaff.bubblewash.co {\n\treverse_proxy 127.0.0.1:3000\n}\n'


def summarise(config):
    """Emit only known Bubble Wash host matches and bounded loopback upstreams."""
    rows = []
    def visit(value, inherited=()):
        if isinstance(value, list):
            for item in value: visit(item, inherited)
        elif isinstance(value, dict):
            matches = value.get('match', [])
            hosts = sorted({host for match in matches if isinstance(match, dict)
                            for host in match.get('host', []) if host in HOSTS}) or list(inherited)
            if value.get('handler') == 'reverse_proxy' and hosts:
                upstreams = value.get('upstreams', [])
                targets = []
                for upstream in upstreams:
                    dial = upstream.get('dial') if isinstance(upstream, dict) else None
                    targets.append(dial if dial in ('127.0.0.1:3000', 'localhost:3000', '[::1]:3000') else 'OTHER')
                rows.append({'hosts': hosts, 'targets': targets[:8],
                             'hostHeaderOverride': any(key.lower() == 'host' for key in value.get('headers', {}).get('request', {}).get('set', {})),
                             'upstreamCount': len(upstreams)})
            for key in ('routes', 'handle'):
                if key in value: visit(value[key], hosts)
            if 'servers' in value and isinstance(value['servers'], dict):
                for server in value['servers'].values(): visit(server, hosts)
    visit({'servers': config})
    if len(rows) > 20: raise ValueError('bounded route count exceeded')
    return {'ok': True, 'source': 'active-local-caddy', 'routes': rows,
            'staffRoutePresent': any(set(row['hosts']) & {'staff.bubblewash.co', '*.bubblewash.co'} for row in rows),
            'absenceIsNotProof': True,
            'configurationChanged': False}


def persistent_summary(unit_properties, raw=None):
    """Only reveal a fixed config path and a strictly allowlisted simple block."""
    props=dict(line.split('=',1) for line in unit_properties.splitlines() if '=' in line)
    start=props.get('ExecStart','')
    if not re.search(r'--config(?:=|\s+)/etc/caddy/Caddyfile(?:\s|;|$)',start):
        return {'status':'unsupported-config-source'}
    result={'path':'/etc/caddy/Caddyfile','format':'caddyfile',
            'reloadUsesSamePath':bool(re.search(r'--config(?:=|\s+)/etc/caddy/Caddyfile(?:\s|;|$)',props.get('ExecReload','')))}
    if raw is None:return {**result,'status':'source-not-read'}
    result['sha256']=hashlib.sha256(raw).hexdigest()
    text=raw.decode('utf-8')
    # Do not output arbitrary config text: only a literal public hostname and
    # the existing loopback target qualify. Nested/auth/header blocks refuse.
    pattern=r'(?m)^[ \t]*bubblewash\.co[ \t]*\{[ \t]*\n[ \t]*reverse_proxy[ \t]+(127\.0\.0\.1:3000|localhost:3000|\[::1\]:3000)[ \t]*\n[ \t]*\}'
    blocks=list(re.finditer(pattern,text))
    host_declarations=re.findall(r'(?m)^[^#\n]*\bbubblewash\.co\b[^\n]*\{',text)
    result['containsImports']=bool(re.search(r'(?m)^\s*import\s',text))
    if len(blocks)!=1 or len(host_declarations)!=1:
        return {**result,'status':'non-simple-block-needs-review'}
    block=blocks[0]
    return {**result,'status':'simple-exact-block','host':'bubblewash.co','upstream':block.group(1),
            'blockSha256':hashlib.sha256(block.group(0).encode()).hexdigest(),
            'blockStartLine':text.count('\n',0,block.start())+1,
            'blockLines':block.group(0).count('\n')+1}



def exact_staff_delta(before, after):
    expected={'match':[{'host':['staff.bubblewash.co']}],
      'handle':[{'handler':'subroute','routes':[{'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:3000'}]}]}]}],
      'terminal':True}
    reduced=copy.deepcopy(after);count=0
    for server in reduced.get('apps',{}).get('http',{}).get('servers',{}).values():
        routes=server.get('routes',[]);kept=[]
        for route in routes:
            if route==expected:count+=1
            else:kept.append(route)
        if len(kept)!=len(routes):server['routes']=kept
    return count==1 and reduced==before


def baseline_comparison(raw):
    """Read/adapt only; stdout, stderr and private config never leave this host."""
    values={}; report={}
    for name, args, stdin in (
        ('stdin', ['adapt','--config','-','--adapter','caddyfile'], raw),
        ('file', ['adapt','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'], None),
        ('candidate', ['adapt','--config','-','--adapter','caddyfile'], raw+STAFF_BLOCK),
    ):
        try:
            result=subprocess.run(['/usr/bin/caddy',*args],input=stdin,capture_output=True,
                                  cwd='/etc/caddy',timeout=30)
            if result.returncode!=0:
                report[name]={'status':'adapt-command-failed'};continue
            if len(result.stdout)>LIMIT:
                report[name]={'status':'adapt-output-too-large'};continue
            value=json.loads(result.stdout)
            if not isinstance(value,dict):raise ValueError('non-object')
            values[name]=value;report[name]={'status':'ok'}
        except subprocess.TimeoutExpired:report[name]={'status':'adapt-timeout'}
        except json.JSONDecodeError:report[name]={'status':'adapt-non-json'}
        except Exception:report[name]={'status':'adapt-unavailable'}
    try:
        with urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=5) as response:
            body=response.read(LIMIT+1)
        if len(body)>LIMIT:raise ValueError('too large')
        value=json.loads(body)
        if not isinstance(value,dict):raise ValueError('non-object')
        values['active']=value;report['active']={'status':'ok'}
    except Exception:report['active']={'status':'active-unavailable'}
    for left,right,label in (('stdin','file','stdinEqualsFile'),('file','active','fileEqualsActive'),('stdin','active','stdinEqualsActive')):
        if left in values and right in values:report[label]=values[left]==values[right]
    # Fixed schema categories only. No routes, hostnames, paths, values, stderr,
    # arbitrary object keys or configuration bodies are emitted.
    if 'file' in values and 'active' in values and values['file']!=values['active']:
        a,b=values['file'],values['active']
        report['differentSections']=[key for key in ('admin','apps','logging','storage') if a.get(key)!=b.get(key)]
        report['otherTopLevelDifference']={k:v for k,v in a.items() if k not in ('admin','apps','logging','storage')}!={k:v for k,v in b.items() if k not in ('admin','apps','logging','storage')}
        aa,bb=a.get('apps',{}),b.get('apps',{})
        report['httpDifference']=aa.get('http')!=bb.get('http') if isinstance(aa,dict) and isinstance(bb,dict) else True
        report['tlsDifference']=aa.get('tls')!=bb.get('tls') if isinstance(aa,dict) and isinstance(bb,dict) else True
    if 'stdin' in values and 'candidate' in values:
        try:report['candidateExactAdditiveDelta']=exact_staff_delta(values['stdin'],values['candidate'])
        except Exception:report['candidateExactAdditiveDelta']=False
    placeholders=re.findall(rb'\{\$([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}',raw)
    report['environmentPlaceholderCount']=len(placeholders)
    report['environmentPlaceholderUnsetCount']=sum(name.decode() not in os.environ for name,_ in placeholders)
    return report


def inspect_persistent():
    try:
        props=subprocess.run(['systemctl','show','caddy.service','--property=ExecStart,ExecReload'],
                             capture_output=True,text=True,check=True,timeout=5).stdout
        result=persistent_summary(props)
        if result.get('path')!='/etc/caddy/Caddyfile':return result
        path=Path(result['path'])
        if path.resolve(strict=True)!=path:raise ValueError('noncanonical')
        for parent in path.parents:
            info=parent.lstat()
            if info.st_uid!=0 or info.st_mode & 0o022:raise ValueError('mutable parent')
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
            info=os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode & 0o022 or info.st_size>131072:raise ValueError('unsupported source')
            raw=stream.read(131073)
            if len(raw)!=info.st_size:raise ValueError('changed source')
            fields=('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')
            if any(getattr(info,k)!=getattr(path.lstat(),k) for k in fields):raise ValueError('changed source')
        result=persistent_summary(props,raw)
        baseline=baseline_comparison(raw)
        # Refuse comparison evidence if the persistent source changed meanwhile.
        if any(getattr(info,k)!=getattr(path.lstat(),k) for k in fields):raise ValueError('changed source')
        result['baseline']=baseline
        return result
    except Exception:
        return {'status':'persistent-source-unavailable'}


def main():
    try:
        # Local-only admin read. No auth values or complete config leave the host.
        with urllib.request.urlopen('http://127.0.0.1:2019/config/apps/http/servers', timeout=5) as response:
            raw = response.read(LIMIT + 1)
        if len(raw) > LIMIT: raise ValueError('configuration too large')
        result=summarise(json.loads(raw))
        result['persistent']=inspect_persistent()
        print(json.dumps(result, sort_keys=True))
    except Exception:
        print('{"ok":false,"status":"active-route-unavailable","configurationChanged":false}')
        raise SystemExit(1)


if __name__ == '__main__': main()
