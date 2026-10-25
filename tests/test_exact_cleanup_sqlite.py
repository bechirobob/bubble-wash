"""Real WAL lifecycle under the existing test UID; no privileged or host actions.
Only external host guards/UID-drop transport are stubbed, not SQLite/filesystem.
"""
import contextlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from unittest import mock
from test_exact_cleanup_host import m
import test_test_data_cleanup_core as core_tests
cleanup=core_tests.m

class RealSQLite(unittest.TestCase):
    def setUp(self):
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.directory=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        fixture=core_tests.CleanupTests();self.addCleanup(fixture.doCleanups)
        memory,raw=fixture.fixture()
        dbpath=self.directory/'live.sqlite';writer=sqlite3.connect(dbpath);memory.backup(writer)
        writer.execute('PRAGMA journal_mode=WAL');writer.execute('UPDATE rate_limits SET value=value');writer.commit()
        self.addCleanup(writer.close)
        env=self.directory/'env';env.write_bytes(raw);env.chmod(0o600)
        self.stack.enter_context(mock.patch.object(m,'ENV',env))
        real_tempfile=tempfile.TemporaryFile
        self.stack.enter_context(mock.patch.object(m.tempfile,'TemporaryFile',side_effect=lambda **k:real_tempfile(dir=self.directory)))
        test=self
        class LocalHost(m.Host):
            def __init__(self):
                self.owner=types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
                self.cleanup=cleanup;self.dbpath=dbpath;self.raw=raw;self.stopped=False;self.held=False;self.resumed=False
                self.writer=writer;self.failure=None;self.env_id=([],m.file_identity(env));self.db_id=m.file_identity(dbpath)[:6]
                self.guards=types.SimpleNamespace(safe_path=lambda p,o: test.assertTrue(p.exists()),
                    database_identity=lambda p,o:m.file_identity(p)[:6],migrate_as_app=lambda owner,fn:fn())
            @contextlib.contextmanager
            def locked(self):yield
            def preflight(self):return env.read_bytes()
            def recovery_copy(self,raw,plan):
                (test.directory/'recovery.env').write_bytes(raw)
            def hold(self):self.held=True
            def stop(self):self.writer.close();self.stopped=True
            def quiet(self):test.assertTrue(self.stopped);test.assertTrue(self.held)
            def unchanged(self,raw):test.assertEqual(env.read_bytes(),raw)
            def resume(self,raw):
                test.assertEqual(env.read_bytes(),raw)
                self.writer=sqlite3.connect(dbpath);test.addCleanup(self.writer.close)
                self.stopped=False;self.held=False;self.resumed=True
            def emergency_hold_stop(self):self.hold();self.stop()
        self.host=LocalHost();self.raw=raw;self.env=env;self.dbpath=dbpath

    def test_last_close_removes_wal_then_complete_transaction_and_restart(self):
        self.assertTrue(Path(str(self.dbpath)+'-wal').exists());self.assertTrue(Path(str(self.dbpath)+'-shm').exists())
        plan=self.host.snapshot_plan(self.raw)
        original_stop=self.host.stop
        def stop():
            original_stop()
            self.assertFalse(Path(str(self.dbpath)+'-wal').exists());self.assertFalse(Path(str(self.dbpath)+'-shm').exists())
        self.host.stop=stop
        out=m.run_cleanup(self.host,cleanup,plan['fingerprint'],cleanup.CONFIRMATION,True)
        self.assertTrue(out['ok']);self.assertTrue(self.host.resumed);self.assertFalse(self.host.held)
        self.assertEqual(self.host.writer.execute('SELECT count(*) FROM research_responses').fetchone()[0],0)
        for key in cleanup.REMOVE_KEYS:self.assertNotIn((key+'=').encode(),self.env.read_bytes())
        for suffix in ('','-wal','-shm'):
            p=Path(str(self.dbpath)+suffix)
            if p.exists():self.assertEqual(p.stat().st_uid,os.getuid())
        self.assertEqual((self.directory/'recovery.env').read_bytes(),self.raw)

    def test_real_transaction_env_ack_failure_rolls_back_but_stays_held(self):
        plan=self.host.snapshot_plan(self.raw);original=m.atomic_env
        def install(*args):original(*args);raise OSError('synthetic acknowledgement loss')
        with mock.patch.object(m,'atomic_env',side_effect=install):
            with self.assertRaises(OSError):m.run_cleanup(self.host,cleanup,plan['fingerprint'],cleanup.CONFIRMATION,True)
        self.assertTrue(self.host.held);self.assertFalse(self.host.resumed)
        with sqlite3.connect(self.dbpath) as db:self.assertEqual(db.execute('SELECT count(*) FROM research_responses').fetchone()[0],1)
        self.assertNotEqual(self.env.read_bytes(),self.raw)

    def test_stopped_read_preflight_failure_resumes_only_unchanged_original(self):
        plan=self.host.snapshot_plan(self.raw);original=self.host.snapshot_plan;calls=0
        def read(raw):
            nonlocal calls
            calls+=1
            if calls==2:raise ValueError('synthetic stopped check failure')
            return original(raw)
        self.host.snapshot_plan=read
        with self.assertRaises(ValueError):m.run_cleanup(self.host,cleanup,plan['fingerprint'],cleanup.CONFIRMATION,True)
        self.assertTrue(self.host.resumed);self.assertFalse(self.host.held);self.assertEqual(self.env.read_bytes(),self.raw)
        self.assertEqual(self.host.writer.execute('SELECT count(*) FROM research_responses').fetchone()[0],1)

if __name__=='__main__':unittest.main()
