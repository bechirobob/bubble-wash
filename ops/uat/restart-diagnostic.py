"""Bounded, non-authoritative read-only restart observations. Never exports host values."""
import re
import shlex
import signal
import time
import xml.etree.ElementTree as ET

SELF='ops/uat/restart-diagnostic.py'
HOOKS=('ExecCondition','ExecStartPre','ExecStartPost','ExecReload','ExecStop','ExecStopPost','ExecStart')
UNIT_PROPERTIES=('Upholds','UpheldBy')
BASE=['/usr/bin/busctl','--system']
DEST='org.freedesktop.systemd1'
OBJECT='/org/freedesktop/systemd1/unit/bubblewash_2duat_2eservice'
UNIT=DEST+'.Unit'
SERVICE=DEST+'.Service'
SKIP='skipped'
SCHEMA={
 'collection':{'complete','partial','unavailable',SKIP},
 'loadedSchema':{'complete','missing','unexpected','duplicate','malformed','read-failed',SKIP},
 'version':{'pre-249','249-250','251-plus','unrecognized','read-failed',SKIP},
 'quiescence':{'passed','failed',SKIP},
 'isolationFirst':{'passed','failed',SKIP},'isolationSecond':{'passed','failed',SKIP},
 'loadedFirst':{'passed','failed',SKIP},'loadedSecond':{'passed','failed',SKIP},
 'isolationStability':{'stable','changed','unavailable'},'loadedStability':{'stable','changed','unavailable'}}
GROUPS={
 'wantsMembership':{'present','absent',SKIP},
 'properties':{'empty','nonempty','match','mismatch','missing','unavailable',SKIP},
 'hooks':{'empty','nonempty','match','mismatch','malformed','read-failed',SKIP},
 'dependencies':{'active','masked-inert','missing-inert','failed',SKIP},
 'unitInterface':{'supported','absent','malformed','read-failed',SKIP},
 'unitArrays':{'empty','nonempty','malformed','read-failed',SKIP}}


def blank(names,dependencies):
    value={key:('unavailable' if key.endswith('Stability') else SKIP) for key in SCHEMA}
    for key,keys in (('wantsMembership',(*dependencies,'unknown','outsideValidatedRequired','duplicate')),('properties',names),('hooks',HOOKS),('dependencies',dependencies),
                     ('unitInterface',UNIT_PROPERTIES),('unitArrays',UNIT_PROPERTIES)):
        value[key]={name:SKIP for name in keys}
    value['dependencySites']={name:[] for name in dependencies}
    return value


def validate(value,names,dependencies,require,sites=()):
    expected=blank(names,dependencies)
    require(type(value) is dict and set(value)==set(expected))
    for key,allowed in SCHEMA.items():require(type(value[key]) is str and value[key] in allowed)
    for key,allowed in GROUPS.items():
        require(type(value[key]) is dict and set(value[key])==set(expected[key]))
        require(all(type(item) is str and item in allowed for item in value[key].values()))
    require(type(value['dependencySites']) is dict and set(value['dependencySites'])==set(dependencies))
    for name,tokens in value['dependencySites'].items():
        if tokens:require(value['dependencies'][name]=='failed')
        require(type(tokens) is list and len(tokens)<=8)
        require(all(type(token) is str and token in sites for token in tokens))
    for prefix in ('isolation','loaded'):
        if value[prefix+'Stability']!='unavailable':
            require(value[prefix+'First']==value[prefix+'Second']=='passed')
    return value


def exec_array(raw,argv):
    """Parse the exact typed Service array, consuming every field without exporting it."""
    fields=shlex.split(raw)
    if len(fields)<2 or fields[0]!='a(sasbttttuii)' or not re.fullmatch('[0-9]+',fields[1]):raise ValueError()
    count=int(fields[1]);index=2;records=[]
    if count>128:raise ValueError()
    for _ in range(count):
        path=fields[index];n=fields[index+1]
        if not re.fullmatch('[0-9]+',n) or int(n)>128:raise ValueError()
        n=int(n);args=fields[index+2:index+2+n];index+=2+n
        flag=fields[index];numbers=fields[index+1:index+8];index+=8
        if len(args)!=n or flag not in ('true','false') or len(numbers)!=7:raise ValueError()
        for item,bits,signed in zip(numbers,(64,64,64,64,32,32,32),(False,False,False,False,False,True,True)):
            if not re.fullmatch('-?[0-9]+' if signed else '[0-9]+',item):raise ValueError()
            number=int(item)
            if not (-(2**(bits-1)) if signed else 0)<=number<(2**(bits-1) if signed else 2**bits):raise ValueError()
        records.append((path,args,flag,numbers))
    if index!=len(fields):raise ValueError()
    if argv is None:return 'empty' if count==0 else 'nonempty'
    if count!=1:return 'mismatch'
    path,args,flag,numbers=records[0]
    return 'match' if path==argv[0] and args==argv and flag=='false' and all(x.isdecimal() for x in numbers) else 'mismatch'


class BudgetExpired(Exception):pass


def collect(c,p,empty,fixed,dependencies,argv,loaded_unit,quiet_sample,dependency_state,pins,sites=None):
    # Interrupt nested collector calls too; restore the original host alarm and handler.
    started=time.monotonic();previous=signal.getitimer(signal.ITIMER_REAL)
    handler=signal.getsignal(signal.SIGALRM)
    budget=min(40,max(0,previous[0]-1)) if previous[0] else 40
    if not budget:
        result=blank((*empty,*fixed,'Requires','Wants','Conflicts'),dependencies)
        result['collection']='partial';return result
    def expired(*args):raise BudgetExpired()
    signal.signal(signal.SIGALRM,expired)
    try:
        signal.setitimer(signal.ITIMER_REAL,budget)
        return _collect(c,p,empty,fixed,dependencies,argv,loaded_unit,quiet_sample,dependency_state,pins,budget,sites or {})
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGALRM,handler)
        if previous[0]:signal.setitimer(signal.ITIMER_REAL,max(.001,previous[0]-(time.monotonic()-started)),previous[1])


def _collect(c,p,empty,fixed,dependencies,argv,loaded_unit,quiet_sample,dependency_state,pins,budget,sites):
    names=(*empty,*fixed,'Requires','Wants','Conflicts')
    result=blank(names,dependencies);deadline=time.monotonic()+budget;expired=False
    def probe(call):
        nonlocal expired
        if expired or time.monotonic()>=deadline:return SKIP,None
        try:return 'passed',call()
        except BudgetExpired:expired=True;return SKIP,None
        except Exception:return 'failed',None
    def command(args):return c.command(args,limit=65536)
    def get(interface,name,path=OBJECT):
        return command([*BASE,'get-property',DEST,path,interface,name])
    status,raw=probe(lambda:command(['/usr/bin/systemctl','show',p.SERVICE,*[a for name in names for a in ('-p',name)]]))
    if status=='passed':
        rows={};schema='complete'
        for line in raw.splitlines():
            key,sep,value=line.partition('=')
            if not sep:schema='malformed';continue
            if key not in names:schema='unexpected' if schema=='complete' else schema;continue
            if key in rows:schema='duplicate' if schema=='complete' else schema;continue
            rows[key]=value
        if schema=='complete' and set(rows)!=set(names):schema='missing'
        result['loadedSchema']=schema
        required=rows.get('Requires','').split();wanted=rows.get('Wants','').split()
        validRequired=len(required)==len(set(required)) and {'sysinit.target','system.slice'}<=set(required)<={'sysinit.target','system.slice','-.mount'}
        if schema in ('complete','missing') and 'Wants' in rows:
            flags={name:name in wanted for name in dependencies}
            flags.update(duplicate=len(wanted)!=len(set(wanted)),unknown=bool(set(wanted)-set(dependencies)),outsideValidatedRequired=bool(set(wanted)-({'tmp.mount'}|set(required) if validRequired else {'tmp.mount'})))
            result['wantsMembership']={k:'present' if v else 'absent' for k,v in flags.items()}
        for name in names:
            if schema not in ('complete','missing'):outcome='unavailable'
            elif name not in rows:outcome='missing'
            elif name in empty:outcome='empty' if rows[name]=='' else 'nonempty'
            elif name in fixed:outcome='match' if rows[name]==fixed[name] else 'mismatch'
            elif name=='Conflicts':outcome='match' if rows[name]=='shutdown.target' else 'mismatch'
            else:
                tokens=rows[name].split();unique=set(tokens)
                valid=(len(tokens)==len(unique) and ({'sysinit.target','system.slice'}<=unique<={'sysinit.target','system.slice','-.mount'} if name=='Requires' else unique<=({'tmp.mount'}|set(required)) and validRequired))
                outcome='match' if valid else 'mismatch'
            result['properties'][name]=outcome
    else:result['loadedSchema']='read-failed' if status=='failed' else SKIP
    for name in HOOKS:
        status,raw=probe(lambda:get(SERVICE,name))
        outcome='read-failed' if status=='failed' else SKIP
        if status=='passed':
            try:outcome=exec_array(raw,argv if name=='ExecStart' else None)
            except Exception:outcome='malformed'
        result['hooks'][name]=outcome
    for name in dependencies:
        def dependency():
            try:return dependency_state(name)
            except BudgetExpired:raise
            except Exception as error:
                trace=error.__traceback__;tokens=[]
                while trace is not None:
                    token=sites.get(trace.tb_frame.f_code.co_filename,{}).get(trace.tb_lineno)
                    if token:tokens.append(token)
                    trace=trace.tb_next
                result['dependencySites'][name]=tokens[-8:]
                raise
        status,value=probe(dependency)
        outcome='failed' if status=='failed' else SKIP
        if status=='passed':
            outcome={'loaded':'active','masked':'masked-inert','not-found':'missing-inert'}.get(value.get('LoadState'),'failed')
        result['dependencies'][name]=outcome
    result['quiescence']=probe(quiet_sample)[0]
    status,raw=probe(lambda:get(DEST+'.Manager','Version','/org/freedesktop/systemd1'))
    result['version']='read-failed' if status=='failed' else SKIP
    if status=='passed':
        result['version']='unrecognized'
        try:
            fields=shlex.split(raw)
            match=re.fullmatch(r'([0-9]{3})(?:[ .+~()-].*)?',fields[1]) if len(fields)==2 and fields[0]=='s' else None
            if match:
                number=int(match[1]);result['version']='pre-249' if number<249 else '249-250' if number<251 else '251-plus'
        except Exception:pass
    status,raw=probe(lambda:command([*BASE,'--xml-interface','introspect',DEST,OBJECT,UNIT]))
    outcome='read-failed' if status=='failed' else SKIP
    result['unitInterface']={name:outcome for name in UNIT_PROPERTIES}
    if status=='passed':
        try:
            root=ET.fromstring(raw);interfaces=[node for node in root.findall('interface') if node.get('name')==UNIT]
            if len(interfaces)!=1:raise ValueError()
            for name in UNIT_PROPERTIES:
                matches=[node for node in interfaces[0].findall('property') if node.get('name')==name]
                result['unitInterface'][name]='absent' if not matches else 'supported' if len(matches)==1 and matches[0].get('type')=='as' and matches[0].get('access')=='read' else 'malformed'
        except Exception:result['unitInterface']={name:'malformed' for name in UNIT_PROPERTIES}
    for name in UNIT_PROPERTIES:
        status,raw=probe(lambda:get(UNIT,name));outcome='read-failed' if status=='failed' else SKIP
        if status=='passed':
            try:
                fields=shlex.split(raw)
                if len(fields)<2 or fields[0]!='as' or not re.fullmatch('[0-9]+',fields[1]) or int(fields[1])!=len(fields)-2:raise ValueError()
                outcome='empty' if fields[1]=='0' else 'nonempty'
            except Exception:outcome='malformed'
        result['unitArrays'][name]=outcome
    for prefix,call in (('isolation',lambda:c.collect_restart_isolation(pins,before_restart=True)),('loaded',loaded_unit)):
        first,a=probe(call);second,b=probe(call)
        result[prefix+'First']=first;result[prefix+'Second']=second
        if first==second=='passed':result[prefix+'Stability']='stable' if a==b else 'changed'
    skipped=any(value==SKIP for key,value in result.items() if key!='collection') or any(SKIP in result[key].values() for key in GROUPS)
    result['collection']='partial' if skipped else 'complete'
    return result
