"""Filesystem/SQLite preparation rehearsal only. Never a live-service adapter."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from uat_update_engine import Contract,Evidence,FileJournal,execute


def digest(raw):return hashlib.sha256(raw).hexdigest()

class SyntheticAdapter:
    def __init__(self,root,fail=None):
        self.root=Path(root)
        # Only our private direct /tmp children are allowed, including on systems
        # with TMPDIR pointing elsewhere. No user-selected host paths supported.
        if (self.root.parent!=Path('/tmp') or not self.root.name.startswith('bw-uat-rehearsal-') or self.root.is_symlink() or
            self.root.resolve()!=self.root or not self.root.is_dir() or self.root.stat().st_uid!=os.getuid() or self.root.stat().st_mode & 0o077):
            raise ValueError('synthetic temporary root required')
        self.fail=fail;self.calls=[];self.now=1000;self.running=True
        for name in ('app','candidate','journal'): (self.root/name).mkdir(mode=0o700)
        (self.root/'app/revision').write_text('a'*40)
        (self.root/'candidate/revision').write_text('b'*40)
        (self.root/'config').write_text('synthetic isolated configuration; no credentials')
        (self.root/'production-sentinel').write_bytes(b'unchanged synthetic production sentinel')
        self.production_digest=digest((self.root/'production-sentinel').read_bytes())
        with sqlite3.connect(self.root/'uat.sqlite') as db:
            db.execute('CREATE TABLE accounts (name TEXT PRIMARY KEY, role TEXT, credential_version TEXT, password_hash TEXT, starts_at INTEGER, expires_at INTEGER)')
            db.executemany('INSERT INTO accounts VALUES (?,?,?,?,?,?)',[(role,role,'synthetic-v1','not-a-real-password-hash',1,10000000) for role in ('admin','support','vendor','driver')])
            db.execute('CREATE TABLE orders (id TEXT PRIMARY KEY, amount INTEGER)')
            db.execute("INSERT INTO orders VALUES ('SYNTHETIC-1',2500)")
        self.c=Contract('filesystem-synthetic-operation-01','a'*40,'b'*40,digest(b'b'*40),digest((self.root/'config').read_bytes()),self.account_digest(),self.schema_digest(),10000000)
    def _call(self,name):self.calls.append(name)
    def _db(self):return sqlite3.connect('file:'+str(self.root/'uat.sqlite')+'?mode=ro',uri=True)
    def account_digest(self):
        with self._db() as db:return digest(json.dumps(db.execute('SELECT * FROM accounts ORDER BY name').fetchall()).encode())
    def schema_digest(self):
        with self._db() as db:return digest(json.dumps(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()).encode())
    def evidence(self):
        with self._db() as db:expiry=db.execute('SELECT min(expires_at) FROM accounts').fetchone()[0]
        return Evidence((self.root/'app/revision').read_text(),digest((self.root/'config').read_bytes()),self.account_digest(),self.schema_digest(),expiry,True,digest((self.root/'production-sentinel').read_bytes())==self.production_digest,True,True)
    def now_ms(self):return self.now
    def inspect(self,c):self._call('inspect');return self.evidence()
    def stage(self,c):self._call('stage');return digest((self.root/'candidate/revision').read_bytes())
    def stop(self,c):self._call('stop');self.running=False
    def stopped(self,c):
        self._call('stopped')
        if self.running:raise ValueError('synthetic process remains active')
        return self.evidence()
    def snapshot(self,c):
        self._call('snapshot')
        if self.running:raise ValueError('snapshot before synthetic stop')
        # Fixture is closed and no WAL writers exist. Snapshot actually opens
        # SQLite read-only, uses SQLite backup, then checks independent integrity.
        snapshot=self.root/'snapshot.sqlite'
        if snapshot.exists():raise ValueError('snapshot collision')
        fd=os.open(snapshot,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
        with self._db() as source,sqlite3.connect(snapshot) as backup:source.backup(backup)
        with sqlite3.connect('file:'+str(snapshot)+'?mode=ro',uri=True) as db:
            ok=db.execute('PRAGMA integrity_check').fetchone()==('ok',)
            accounts=digest(json.dumps(db.execute('SELECT * FROM accounts ORDER BY name').fetchall()).encode())
        return ok and accounts==c.accounts_sha256
    def switch(self,c):
        self._call('switch')
        if self.running:raise ValueError('switch while running')
        if self.fail=='before-switch':raise RuntimeError('synthetic boundary failure')
        # Deliberately recoverable two-rename sequence. Engine's durable enter
        # event plus these retained directories describe an uncertain attempt.
        os.rename(self.root/'app',self.root/'rollback')
        if self.fail=='between-renames':raise RuntimeError('synthetic boundary failure')
        os.rename(self.root/'candidate',self.root/'app')
        if self.fail=='after-switch':raise RuntimeError('synthetic boundary failure')
    def start(self,c):self._call('start');self.running=True
    def postverify(self,c):
        self._call('postverify')
        if self.fail=='config-drift':(self.root/'config').write_text('synthetic drift')
        if self.fail=='account-drift':
            with sqlite3.connect(self.root/'uat.sqlite') as db:db.execute("UPDATE accounts SET expires_at=20000000 WHERE name='admin'")
        return self.evidence()


def rehearse(failure=None):
    with tempfile.TemporaryDirectory(prefix='bw-uat-rehearsal-',dir='/tmp') as root:
        a=SyntheticAdapter(root,failure);before=(a.root/'uat.sqlite').read_bytes()
        receipt=execute(a.c,a,FileJournal(a.root/'journal'))
        return {'case':failure or 'success','state':receipt.state,'stage':receipt.stage,
                'databaseUnchanged':before==(a.root/'uat.sqlite').read_bytes(),
                'snapshotRetained':(a.root/'snapshot.sqlite').is_file(),
                'rollbackRetained':(a.root/'rollback/revision').is_file(),
                'candidateActive':(a.root/'app/revision').is_file() and (a.root/'app/revision').read_text()==a.c.candidate_revision,
                'startCalled':'start' in a.calls,'switchCalls':a.calls.count('switch')}
