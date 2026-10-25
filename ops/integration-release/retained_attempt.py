"""Read-only metadata for one failed rehearsal. No SQLite or application execution."""
import hashlib
import json
import os
from pathlib import Path
import stat

OPERATION='40144518668-1'
PACKAGE='e7f430ecba95a687f610e68c707d429183e3f5926d4bfca0b74e4da8a079d1d8'
PAIR={'candidate':'5f256800d65dbe3b69f54e95afa0e8ab30b5e881','fallback':'80ec00902fcc5fe16a17ab814c7d191ad44afb64'}
STATE=Path('/var/lib/bubblewash-release')
RUNTIME=Path('/home/ubuntu/bubblewash-runtime')
WORK=Path('/home/ubuntu/bubblewash-releases')


def file_metadata(path, hash_limit=None):
    try:
        info=path.lstat()
    except FileNotFoundError:
        return {'present':False}
    except OSError:
        return {'status':'unavailable'}
    row={'present':True,'kind':'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other',
         'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode),'links':info.st_nlink,'size':info.st_size,
         'device':info.st_dev,'inode':info.st_ino}
    # Only explicit source/report files are eligible. SQLite and archives are
    # metadata-only, and no arbitrary child name is ever opened.
    if hash_limit is not None and row['kind']=='file' and info.st_nlink==1 and info.st_uid==0 and info.st_size<=hash_limit:
        try:
            if path.resolve(strict=True)!=path:return row
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                before=os.fstat(fd)
                if before!=info:return row
                raw=os.read(fd,hash_limit+1)
                if len(raw)==info.st_size and os.fstat(fd)==before and path.lstat()==before:
                    row['sha256']=hashlib.sha256(raw).hexdigest()
            finally:os.close(fd)
        except OSError:row['hashStatus']='unavailable'
    return row


def inspect_retained(core, artifacts=None):
    if os.geteuid()!=0:raise ValueError('root reader required')
    result={'schema':'bubblewash-retained-attempt/v1','operation':OPERATION,'releaseAcceptance':False,
            'databaseOpened':False,'hostStateChanged':False,'automaticRetry':False,'files':{},'units':{},'probeDirectories':{}}
    private=STATE/'rehearsal-evidence'/OPERATION
    known={'package':STATE/'packages'/PACKAGE,'rehearsal':private,'preimage':private/'preimage.sqlite',
           'evidence':private/'evidence.json'}
    for label,sha in PAIR.items():
        known[label+'-manifest']=private/(sha+'-manifest.json')
        known[label+'-archive']=private/(sha+'.tar')
        known[label+'-frozen']=STATE/'releases'/sha
        for kind in ('build','runtime'):known[label+'-'+kind]=WORK/('prepare-'+kind+'-'+OPERATION+'-'+sha)
    with core.deployment_lock(RUNTIME,1000) as unchanged:
        for name,path in known.items():
            result['files'][name]=file_metadata(path,8*1024**2 if name.endswith('-manifest') else 131072 if name=='evidence' else None)
        # The implementation writes no failure-report file. evidence.json, when
        # present, is a success receipt, not permission to retry or activate.
        result['reportStorage']='success-evidence-only-no-failure-report-writer'
        for label in PAIR:
            unit='bubblewash-prepare-'+OPERATION+'-'+label+'-probe.service'
            try:
                props=core.probe_state(unit)
                result['units'][label]={'LoadState':props['LoadState'],'ActiveState':props['ActiveState'],'MainPID':int(props['MainPID'])}
            except Exception:result['units'][label]={'status':'unavailable'}
        prefixes={label:'release-rehearsal-bubblewash-prepare-'+OPERATION+'-'+label+'-' for label in PAIR}
        try:
            # One bounded nonrecursive listing; ignore all unrelated names.
            with os.scandir(RUNTIME) as entries:
                count=0
                for entry in entries:
                    count+=1
                    if count>256:raise ValueError('listing bound exceeded')
                    for label,prefix in prefixes.items():
                        if entry.name.startswith(prefix):
                            rows=result['probeDirectories'].setdefault(label,[])
                            if len(rows)>=4:raise ValueError('matching directory bound exceeded')
                            rows.append(file_metadata(RUNTIME/entry.name))
            result['probeListing']='complete'
        except Exception:result['probeListing']='unavailable-or-bounded'
        if artifacts is not None:
            try:
                result['retainedArtifacts']={'status':'verified','pins':artifacts()['pins']}
            except Exception:
                result['retainedArtifacts']={'status':'refused-or-unavailable'}
        unchanged()
    return result
