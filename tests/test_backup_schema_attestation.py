import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('attest_schema', ROOT/'ops/attest-backup-schema.py')
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)

class Snapshot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        live = sqlite3.connect(self.root/'synthetic-live.sqlite')
        self.addCleanup(live.close)
        live.execute('PRAGMA journal_mode=WAL'); live.execute('PRAGMA wal_autocheckpoint=0')
        live.executescript('CREATE TABLE staff_accounts(email TEXT PRIMARY KEY); CREATE TABLE wal_only(id INTEGER);')
        snapshot = sqlite3.connect(self.root/'backup.sqlite'); live.backup(snapshot); snapshot.close()
        self.plain = (self.root/'backup.sqlite').read_bytes()
        self.work = self.root/'scratch'; self.work.mkdir(mode=0o700)
        self.live = live

    def test_backup_wal_schema_and_after_ddl_hash(self):
        before, after = a.snapshot_hashes(self.plain, self.work)
        rows = self.live.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
        self.assertEqual(before, hashlib.sha256(a.canonical(rows)).hexdigest())
        expected = sorted(rows + [('index','sqlite_autoindex_staff_admin_permissions_1','staff_admin_permissions',None),('table','staff_admin_permissions','staff_admin_permissions',a.DDL)])
        self.assertEqual(after, hashlib.sha256(a.canonical(expected)).hexdigest())
        self.assertEqual((self.work/'snapshot.sqlite').read_bytes(), self.plain)
        self.assertFalse((self.work/'snapshot.sqlite-wal').exists())
        self.assertFalse((self.work/'snapshot.sqlite-shm').exists())
        self.assertFalse(self.live.execute("SELECT 1 FROM sqlite_master WHERE name='staff_admin_permissions'").fetchone())
        self.live.execute('CREATE TABLE later(id INTEGER)')
        self.assertNotEqual(before, hashlib.sha256(a.canonical(self.live.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall())).hexdigest())

    def test_existing_exact_table_has_same_hash(self):
        self.live.execute(a.DDL); self.live.commit()
        snap = sqlite3.connect(self.root/'second.sqlite'); self.live.backup(snap); snap.close()
        before, after = a.snapshot_hashes((self.root/'second.sqlite').read_bytes(), self.work)
        self.assertEqual(before, after)

    def test_views_malformed_permissions_and_corrupt_bytes_refused(self):
        for statement in ('CREATE VIEW forbidden AS SELECT 1', 'CREATE TABLE staff_admin_permissions(bad INTEGER)'):
            with self.subTest(statement=statement), tempfile.TemporaryDirectory() as directory:
                db = sqlite3.connect(':memory:'); db.executescript('CREATE TABLE staff_accounts(email TEXT PRIMARY KEY);'+statement)
                plain = db.serialize(); db.close()
                with self.assertRaises((ValueError, sqlite3.DatabaseError)):
                    a.snapshot_hashes(plain, Path(directory))
        with self.assertRaises(ValueError): a.snapshot_hashes(b'bad', self.work)

    def test_exclusive_scratch_files_refuse_overwrite(self):
        (self.work/'snapshot.sqlite').write_bytes(b'keep')
        with self.assertRaises(FileExistsError): a.snapshot_hashes(self.plain, self.work)
        self.assertEqual((self.work/'snapshot.sqlite').read_bytes(), b'keep')

    def test_authenticated_decryption_and_tamper_refusal(self):
        key = base64.b64encode(os.urandom(32)).decode()
        code = "const fs=require('node:fs'),c=require('node:crypto');const p=JSON.parse(fs.readFileSync(0));const iv=c.randomBytes(12),d=c.createCipheriv('aes-256-gcm',Buffer.from(p.key,'base64'),iv);const body=Buffer.concat([d.update(Buffer.from(p.plain,'base64')),d.final()]);process.stdout.write(Buffer.concat([Buffer.from('BWBACKUP1'),iv,d.getAuthTag(),body]));"
        encrypted = subprocess.run([shutil.which('node'),'-e',code],input=a.canonical({'key':key,'plain':base64.b64encode(self.plain).decode()}),capture_output=True,check=True).stdout
        real_run = subprocess.run
        def local_node(args, **kwargs):
            self.assertEqual(args[0], '/usr/bin/node')
            return real_run([shutil.which('node'), *args[1:]], **kwargs)
        self.enterContext(mock.patch.object(a.subprocess, 'run', side_effect=local_node))
        self.assertEqual(a.decrypt(encrypted,key), self.plain)
        for corrupted in (encrypted[:-1]+bytes([encrypted[-1]^1]), b'bad', b'X'+encrypted[1:]):
            with self.assertRaises(ValueError): a.decrypt(corrupted,key)
        with self.assertRaises(ValueError): a.decrypt(encrypted,base64.b64encode(os.urandom(32)).decode())

    def test_request_exact_identity_and_first_attempt(self):
        request = dict(controlSha='a'*40,runId='1',runAttempt='1',runtimeSha=a.LIVE,backupSha256='b'*64,receiptRun='2',storeSha='c'*40,storeId='1403152795')
        a.validate(request)
        for key, value in [('runtimeSha','d'*40),('runAttempt','2'),('storeId','7'),('backupSha256','bad')]:
            with self.assertRaises(ValueError): a.validate({**request,key:value})
        with self.assertRaises(ValueError): a.validate({**request,'unexpected':True})

    def test_errors_never_print_secret_or_traceback(self):
        import contextlib, io
        output=io.StringIO()
        with mock.patch.object(a,'attest',side_effect=ValueError('synthetic-private-value')), contextlib.redirect_stdout(output), self.assertRaises(SystemExit): a.main({})
        self.assertNotIn('synthetic-private-value',output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['state'],'blocked-inspect-outcome-before-retry')

class Boundaries(unittest.TestCase):
    def test_cleanup_blocks_handled_signals_and_propagates_failure(self):
        events=[]
        scratch=mock.Mock(); scratch.exists.return_value=False
        with mock.patch.object(a.signal,'alarm',side_effect=lambda n: events.append(('alarm',n))), mock.patch.object(a.signal,'pthread_sigmask',side_effect=lambda *args: events.append(('mask',args[0])) or set()), mock.patch.object(a.shutil,'rmtree',side_effect=lambda p: events.append(('remove',p))):
            a.clean_scratch(scratch)
        self.assertEqual([e[0] for e in events],['alarm','mask','remove','mask'])
        with mock.patch.object(a.signal,'alarm'), mock.patch.object(a.signal,'pthread_sigmask',return_value=set()), mock.patch.object(a.shutil,'rmtree',side_effect=OSError('blocked')):
            with self.assertRaises(OSError): a.clean_scratch(scratch)

    def test_live_database_and_sidecar_aliases_refused_before_open(self):
        with tempfile.TemporaryDirectory() as d:
            live=Path(d)/'live.sqlite';live.write_bytes(b'not opened')
            alias=Path(d)/'backup.enc';alias.symlink_to(live)
            values={'BUBBLEWASH_DATABASE_PATH':str(live)}
            guards=mock.Mock()
            with mock.patch.object(a,'guards',guards):
                for path in [live,alias,*[Path(str(live)+suffix) for suffix in ('-wal','-shm','-journal')]]:
                    with self.assertRaises(ValueError): a.protected_backup_path(path,values,object())
            guards.safe_path.assert_not_called()

    def test_descriptor_reader_rejects_ancestor_substitution(self):
        import types
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); parent=root/'archive'; parent.mkdir()
            target=parent/'receipt';target.write_bytes(b'approved')
            dbdir=root/'database';dbdir.mkdir();live=dbdir/'receipt';live.write_bytes(b'LIVE PRIVATE BYTES')
            values={'BUBBLEWASH_DATABASE_PATH':str(live)}
            owner=types.SimpleNamespace(pw_uid=os.getuid())
            # Only ownership of executor ancestors is synthetic; traversal,
            # descriptor reads, inode binding and substitution are real.
            with mock.patch.object(a,'guards',mock.Mock()), mock.patch.object(a,'check_directory'):
                self.assertEqual(a.read_backup(target,values,owner),b'approved')
                real_open=a.os.open; real_read=a.os.read; seen=[]
                def swap(name, flags, *args, **kwargs):
                    if name=='receipt' and flags & os.O_PATH:
                        parent.rename(root/'held');parent.symlink_to(dbdir)
                    return real_open(name,flags,*args,**kwargs)
                def observe(fd,count):
                    data=real_read(fd,count);seen.append(data);return data
                with mock.patch.object(a.os,'open',side_effect=swap), mock.patch.object(a.os,'read',side_effect=observe), self.assertRaises(ValueError):
                    a.read_backup(target,values,owner)
                self.assertNotIn(b'LIVE PRIVATE BYTES',seen)
                self.assertIn(b'approved',seen)

    def test_launcher_binds_manual_main_source_dependencies_and_ddl(self):
        spec=importlib.util.spec_from_file_location('attest_stream',ROOT/'ops/stream-backup-schema.py')
        stream=importlib.util.module_from_spec(spec);spec.loader.exec_module(stream)
        env=dict(GITHUB_REPOSITORY='bechirobob/bubble-wash',GITHUB_REF='refs/heads/main',GITHUB_EVENT_NAME='workflow_dispatch',GITHUB_SHA='a'*40,SOURCE_SHA='a'*40,GITHUB_RUN_ID='1',GITHUB_RUN_ATTEMPT='1',EXPECTED_LIVE_SHA=a.LIVE,BACKUP_SHA256='b'*64,RECEIPT_RUN='2',BACKUP_STORE_SHA='c'*40,BACKUP_STORE_ID='1403152795')
        with mock.patch.object(stream.subprocess,'check_output',side_effect=['a'*40+'\n',b'']):
            code=stream.prepare(env)
        compile(code,'synthetic-stream','exec')
        self.assertNotIn('BUBBLEWASH_BACKUP_ENCRYPTION_KEY=',code)
        with self.assertRaises(ValueError): stream.prepare({**env,'GITHUB_EVENT_NAME':'push'})
        with mock.patch.object(stream.subprocess,'check_output',return_value='d'*40), self.assertRaises(ValueError): stream.prepare(env)
        with mock.patch.dict(stream.DEPENDENCIES,{'ops/deploy-preserving.py':'0'*64}), mock.patch.object(stream.subprocess,'check_output',side_effect=['a'*40,b'']), self.assertRaises(ValueError): stream.prepare(env)

if __name__ == '__main__': unittest.main()
