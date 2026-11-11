"""Preparation-only UAT transaction engine. No CLI, host adapter or network access.

Adapters are trusted implementations awaiting independent review. A passing mock
rehearsal is NOT host admission or permission to invoke a real adapter.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import Protocol

MINIMUM_PRESTOP_BUDGET_MS = 15 * 60 * 1000

class Refused(Exception):
    pass

@dataclass(frozen=True)
class Contract:
    operation_id: str
    previous_revision: str
    candidate_revision: str
    artifact_sha256: str
    configuration_sha256: str
    accounts_sha256: str
    schema_sha256: str
    expiry_ms: int

    def validate(self):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{15,63}', self.operation_id): raise Refused('invalid operation')
        for value in (self.previous_revision, self.candidate_revision):
            if not re.fullmatch('[a-f0-9]{40}', value): raise Refused('invalid revision')
        if self.previous_revision == self.candidate_revision: raise Refused('unchanged revision')
        for value in (self.artifact_sha256,self.configuration_sha256,self.accounts_sha256,self.schema_sha256):
            if not re.fullmatch('[a-f0-9]{64}',value): raise Refused('invalid commitment')
        if type(self.expiry_ms) is not int or self.expiry_ms <= 0: raise Refused('invalid expiry')

@dataclass(frozen=True)
class Evidence:
    revision: str
    configuration_sha256: str
    accounts_sha256: str
    schema_sha256: str
    expiry_ms: int
    isolated: bool
    production_untouched: bool
    exclusive: bool
    capacity_ok: bool

    def require(self, c: Contract, revision: str):
        if (self.revision,self.configuration_sha256,self.accounts_sha256,self.schema_sha256,self.expiry_ms) != (revision,c.configuration_sha256,c.accounts_sha256,c.schema_sha256,c.expiry_ms):
            raise Refused('invariant mismatch')
        if not all(x is True for x in (self.isolated,self.production_untouched,self.exclusive,self.capacity_ok)):
            raise Refused('admission refused')

class Adapter(Protocol):
    """Methods must not output secrets. All actions stay within isolated UAT.

inspect acquires/checks exclusive host coordination held until final receipt;
now_ms is trusted host time. stage verifies/extracts the exact reviewed artifact
into a new protected directory, returns its artifact SHA, never changes active
code. stop issues one UAT-only stop; stopped verifies absence of process/listener
and returns fresh invariant evidence. snapshot retains a protected recoverable
DB+sidecars copy after stopped verification, returns True only after verifying
its integrity/recovery and account/schema commitments. switch preserves old code
and installs candidate with atomic exchange or a durably recoverable two-rename
plan; no DB/config/unit/account mutations. start issues one UAT-only start.
postverify verifies actual runtime readiness, protected invariants and isolation.
No method may perform automatic restart, retry, account issuance or DB restore.
"""
    def now_ms(self) -> int: ...
    def inspect(self, c: Contract) -> Evidence: ...
    def stage(self, c: Contract) -> str: ...
    def stop(self, c: Contract) -> None: ...
    def stopped(self, c: Contract) -> Evidence: ...
    def snapshot(self, c: Contract) -> bool: ...
    def switch(self, c: Contract) -> None: ...
    def start(self, c: Contract) -> None: ...
    def postverify(self, c: Contract) -> Evidence: ...

class FileJournal:
    """Append-only durable journal in an existing trusted private directory.

Directory and parent trust/mount durability must be separately admitted. No
resume facility. An existing operation file, even empty/corrupt, blocks replay.
A persistent active-operation marker also blocks different IDs and is never
    automatically cleared. The host adapter must use one fixed journal directory.
    The journal contains commitments/events only, not evidence or exception text.
"""
    def __init__(self, directory: Path):
        self.directory=Path(directory)
        self.fd=None
        self.seq=0
    def claim(self,c: Contract):
        if self.fd is not None: raise Refused('journal already claimed')
        for p in (self.directory,*self.directory.parents):
            s=p.lstat()
            if stat.S_ISLNK(s.st_mode) or not stat.S_ISDIR(s.st_mode): raise Refused('untrusted journal')
        s=self.directory.stat()
        if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700: raise Refused('journal must be private')
        directory_fd=os.open(self.directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            # Permanent active marker blocks all IDs, including after success.
            # Clearing it requires separately reviewed recovery, never this engine.
            marker=os.open('active-operation',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=directory_fd)
            try:
                raw=(c.operation_id+'\n').encode()
                offset=0
                while offset<len(raw):
                    n=os.write(marker,raw[offset:])
                    if n<=0: raise Refused('marker write failed')
                    offset+=n
                os.fsync(marker)
            finally: os.close(marker)
            os.fsync(directory_fd)
            self.fd=os.open(c.operation_id+'.jsonl',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=directory_fd)
            os.fsync(directory_fd)
            commitment=hashlib.sha256(json.dumps(c.__dict__,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            self.record('claimed',commitment)
        except Exception:
            self.close()
            raise
        finally: os.close(directory_fd)
    def record(self,event: str,commitment: str=''):
        if self.fd is None: raise Refused('unclaimed journal')
        raw=(json.dumps({'sequence':self.seq,'event':event,'contract':commitment},sort_keys=True)+'\n').encode()
        offset=0
        while offset<len(raw):
            n=os.write(self.fd,raw[offset:])
            if n<=0: raise Refused('journal write failed')
            offset+=n
        os.fsync(self.fd)
        self.seq+=1
    def close(self):
        if self.fd is not None:
            os.close(self.fd);self.fd=None

@dataclass(frozen=True)
class Receipt:
    state: str
    stage: str


def execute(c: Contract, adapter: Adapter, journal: FileJournal) -> Receipt:
    """Single attempt only. Caller must keep exclusive coordination on uncertainty.

Every adapter boundary is journaled before invocation. A failure may mean an
operation took effect, including when its completion journal write fails. Return
only fixed labels. Never infer rollback or successful stop from an exception.
"""
    c.validate()
    journal.claim(c)  # existing or damaged journal is always an admission failure
    stage='inspect'
    try:
        for stage in ('inspect','stage','stop','stopped','snapshot','switch','start','postverify'):
            journal.record('enter:'+stage)
            if stage in ('inspect','stop'):
                now=adapter.now_ms()
                if type(now) is not int or now<0 or c.expiry_ms-now<MINIMUM_PRESTOP_BUDGET_MS: raise Refused('insufficient pre-stop window')
            # After stop, deadline passage must not itself strand the service.
            # Account expiry is preserved and verified, never extended.
            result=getattr(adapter,stage)(c)
            if stage in ('inspect','stopped','postverify'):
                if not isinstance(result,Evidence): raise Refused('missing evidence')
                result.require(c,c.candidate_revision if stage=='postverify' else c.previous_revision)
            elif stage=='stage' and result!=c.artifact_sha256: raise Refused('artifact mismatch')
            elif stage=='snapshot' and result is not True: raise Refused('snapshot unverified')
            elif stage in ('stop','switch','start') and result is not None: raise Refused('unexpected action receipt')
            journal.record('done:'+stage)
        journal.record('verified')
        return Receipt('verified','postverify')
    except Exception:
        # Even failure recording can fail: the durable enter event still requires
        # manual read-only inspection. No further host method is invoked.
        try: journal.record('uncertain:'+stage)
        except Exception: pass
        return Receipt('inspection-required',stage)
    finally:
        journal.close()
