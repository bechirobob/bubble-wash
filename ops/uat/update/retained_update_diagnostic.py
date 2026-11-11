"""Read-only retained-update diagnostic. No CLI, imports with host IO or writes.
Reuse source-bound reviewed controls. Never call HostAdapter.inspect/execute.
SQLite read-only connections may access existing SHM reader marks; no SQL writes,
credentials, account rows, timestamps, private hashes or exception text emitted.
"""
import os
from pathlib import Path
import re
import stat
from live_host_adapter import WORK,DATABASE,database_commitments,pins

GUARDS=('source-pins','runtime-original','loaded-unit','quiet','node22','database-readable','expiry-matches-request','expiry-matches-observed','disk-capacity','memory-capacity','retained-work-trusted','retained-layout-known','artifact-retained','host-lock-retained','journal-empty','active-marker-absent','candidate-absent','snapshot-absent','transaction-not-started-evidence')

def _regular(path,mode):
    s=path.lstat()
    return stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==mode

def retained_metadata(work=WORK):
    """Fixed paths only. Report neither names of unknown entries nor file contents."""
    work=Path(work);info=work.lstat()
    trusted=stat.S_ISDIR(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o700
    if not trusted:raise ValueError('untrusted retained root')
    entries={x.name for x in work.iterdir()}
    journal=work/'journal';j=journal.lstat()
    if not stat.S_ISDIR(j.st_mode) or j.st_uid!=0 or stat.S_IMODE(j.st_mode)!=0o700:raise ValueError('untrusted journal')
    journal_entries={x.name for x in journal.iterdir()}
    marker='active-operation' not in journal_entries
    no_candidate='candidate' not in entries;no_snapshot='snapshot.sqlite' not in entries
    return {'retained-work-trusted':True,'retained-layout-known':entries<= {'artifact.tar.gz','journal','host.lock'},
            'artifact-retained':'artifact.tar.gz' in entries and _regular(work/'artifact.tar.gz',0o600),
            'host-lock-retained':'host.lock' in entries and _regular(work/'host.lock',0o600),
            'journal-empty':not journal_entries,'active-marker-absent':marker,
            'candidate-absent':no_candidate,'snapshot-absent':no_snapshot,
            # Metadata supports, but cannot establish historical chronology alone.
            'transaction-not-started-evidence':not journal_entries and no_candidate and no_snapshot}


def diagnose(controls,original_pins,expected_expiry_ms,observed_expiry_ms):
    if any(type(x) is not int or x<=0 for x in (expected_expiry_ms,observed_expiry_ms)):raise ValueError('invalid expiry constraints')
    result={name:False for name in GUARDS}
    def check(name,fn):
        try:result[name]=fn() is True
        except Exception:result[name]=False
    check('source-pins',lambda: pins(original_pins,'f4fd4ce424c2b363fc5a2196432e0ac2ce7c05a1') is None)
    if not result['source-pins']:return {'readOnly':True,'automaticRetry':False,'guards':result}
    check('runtime-original',lambda: bool(controls.c.collect_restart_isolation(original_pins,before_restart=False)))
    check('loaded-unit',lambda: isinstance(controls.loaded_unit(),dict))
    check('quiet',lambda: controls.quiet_sample() is None)
    check('node22',lambda: bool(re.fullmatch(r'v22\.[0-9]+\.[0-9]+',controls.c.command(['/usr/bin/node','--version'],limit=128).strip())))
    try:
        # Existing original collector verifies path ownership and live isolation
        # before this read-only query. Do not probe a DB when that guard fails.
        if result['runtime-original']:
            value=database_commitments(DATABASE)
            result['database-readable']=True
            result['expiry-matches-request']=value['expiry']==expected_expiry_ms
            result['expiry-matches-observed']=value['expiry']==observed_expiry_ms
    except Exception:pass
    check('disk-capacity',lambda: (lambda v:v.f_bavail*v.f_frsize>=8*1024**3)(os.statvfs(WORK)))
    def memory():
        m=re.search(r'^MemAvailable:\s+(\d+) kB$',controls.c.read('/proc/meminfo',16384).decode(),re.M)
        return bool(m and int(m[1])>=1024**2)
    check('memory-capacity',memory)
    try:
        controls.c.trusted(WORK,directory=True,mode=0o700)
        result.update(retained_metadata())
    except Exception:pass
    return {'readOnly':True,'automaticRetry':False,'guards':result}
