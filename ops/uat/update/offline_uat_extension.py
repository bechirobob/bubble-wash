"""Offline UAT grant transaction. No CLI, connection opening, filesystem or service actions.
Caller must drop to the UAT service uid/gid, establish a stopped/exclusive service,
validate exact database identity and snapshot it before opening existing mode=rw.
Private expectation values and database rows must never be logged by the caller.
"""
import hashlib
import json
import re
import sqlite3
import time
import uuid

START = 1793853008095
OLD = 1794457808095
NEW = 1795062608095
SCHEMA = 'CREATE TABLE staff_uat_extensions (username TEXT PRIMARY KEY COLLATE NOCASE, credential_version TEXT NOT NULL, starts_at INTEGER NOT NULL, original_expires_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at - original_expires_at = 604800000), operation_id TEXT NOT NULL, created_at INTEGER NOT NULL)'
class Refused(ValueError):
    pass

def require(condition):
    if not condition:
        raise Refused('UAT extension refused; no transaction committed')

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def fingerprint(db):
    schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    accounts = db.execute('SELECT * FROM staff_uat_accounts ORDER BY username').fetchall()
    require(0 < len(accounts) <= 1000)
    return {'schema': hashlib.sha256(canonical(schema)).hexdigest(), 'accounts': hashlib.sha256(canonical(accounts)).hexdigest()}

def state(db):
    schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    result = {}
    for kind, name, _, _ in schema:
        if kind != 'table':
            continue
        require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name))
        values = db.execute('SELECT * FROM "' + name + '"').fetchall()
        require(len(values) <= 100000)
        # In-memory multiset preserves duplicates, numeric types and BLOB values.
        result[name] = sorted(values, key=repr)
    return schema, result

def extend(db, expected, now_ms=None):
    """Perform one fresh, fully atomic grant transaction; return aggregate receipt.

    expected = {schema: sha256, accounts: sha256, usernames: [active original
    cohort usernames], operationId: bounded identifier, actor: audit attribution}.
    Fingerprints exactly match host_files.database_fingerprints conventions.
    A repeat is refused, not replayed: caller must inspect an uncertain outcome.
    now_ms is injectable solely for synthetic testing.
    """
    clock = now_ms if now_ms is not None else lambda: time.time_ns() // 1000000
    require(type(expected) is dict and set(expected) == {'schema', 'accounts', 'usernames', 'operationId', 'actor'})
    require(all(isinstance(expected[k], str) and re.fullmatch('[0-9a-f]{64}', expected[k]) for k in ('schema', 'accounts')))
    names = expected['usernames']
    require(type(names) is list and 0 < len(names) <= 1000 and all(isinstance(n, str) and re.fullmatch('[a-z][a-z0-9._-]{2,63}', n) for n in names) and len(set(names)) == len(names))
    require(isinstance(expected['operationId'], str) and re.fullmatch('[a-zA-Z0-9-]{8,80}', expected['operationId']))
    require(isinstance(expected['actor'], str) and 0 < len(expected['actor'].strip()) <= 160 and len(expected['actor']) <= 160)
    require(not db.in_transaction)
    db.execute('PRAGMA trusted_schema=OFF')
    db.execute('BEGIN IMMEDIATE')
    try:
        now = clock()
        require(type(now) is int and START <= now < OLD)
        require(fingerprint(db) == {k: expected[k] for k in ('schema', 'accounts')})
        before_schema, before = state(db)
        require('staff_uat_extensions' not in before and 'staff_uat_accounts' in before and 'staff_uat_audit' in before)
        active = db.execute("SELECT username,credential_version,starts_at,expires_at,role,password_hash FROM staff_uat_accounts WHERE status='active' ORDER BY username").fetchall()
        # No hidden differently dated active cohort is included or silently ignored.
        require(sorted(r[0] for r in active) == sorted(names))
        require(any(r[4] == 'admin' for r in active))
        require(all(r[2] == START and r[3] == OLD and isinstance(r[1], str) and r[1] and isinstance(r[5], str) and r[5] for r in active))
        db.execute(SCHEMA)
        audit_added = []
        for name, version, start, expiry, _, _ in active:
            db.execute('INSERT INTO staff_uat_extensions VALUES (?,?,?,?,?,?,?)', (name, version, start, expiry, NEW, expected['operationId'], now))
            row = (str(uuid.uuid4()), name, 'extended-seven-days', expected['actor'], now, start, NEW)
            db.execute('INSERT INTO staff_uat_audit (id,username,action,actor,occurred_at,starts_at,expires_at) VALUES (?,?,?,?,?,?,?)', row)
            audit_added.append(row)
        after_schema, after = state(db)
        require(after_schema == sorted(before_schema + [('table','staff_uat_extensions','staff_uat_extensions',SCHEMA)], key=lambda r:(r[0], r[1])))
        require(set(after) == set(before) | {'staff_uat_extensions'})
        for name, values in before.items():
            require(after[name] == (sorted(values + audit_added, key=repr) if name == 'staff_uat_audit' else values))
        require(after['staff_uat_extensions'] == sorted([(r[0],r[1],START,OLD,NEW,expected['operationId'],now) for r in active],key=repr))
        require(START <= clock() < OLD)
        db.commit()
        return {'extended':len(active), 'expiresAt':NEW, 'originalAccountsUnchanged':True, 'otherRecordsUnchanged':True}
    except BaseException:
        db.rollback()
        raise
