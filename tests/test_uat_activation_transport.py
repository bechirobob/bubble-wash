import importlib.util
import json
import sqlite3
import tempfile
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/('ops/uat/'+name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('transport-activate');r=load('receive-activate')
class TransportTests(unittest.TestCase):
    def env(self):
        return dict(GITHUB_REPOSITORY='bechirobob/bubble-wash',GITHUB_REF='refs/heads/main',GITHUB_EVENT_NAME='workflow_dispatch',GITHUB_RUN_ATTEMPT='1',GITHUB_SHA='a'*40,SOURCE_SHA='a'*40,RUNTIME_SHA='b'*40,GITHUB_RUN_ID='123',UAT_ACTION='check',EXPECTED_CADDY_SHA=m.PIN)
    def test_exact_scope_and_mode(self):
        for mode in r.MODES:
            env=self.env();env['UAT_ACTION']=mode;self.assertEqual(m.context(env)['mode'],mode)
        for key,value in [('GITHUB_RUN_ATTEMPT','2'),('SOURCE_SHA','b'*40),('RUNTIME_SHA','x'),('UAT_ACTION','deploy'),('EXPECTED_CADDY_SHA','a'*64),('GITHUB_REF','refs/heads/prep'),('GITHUB_RUN_ID','1;echo')]:
            env=self.env();env[key]=value
            with self.assertRaises(ValueError):m.context(env)
    def test_closed_bounded_receipt(self):
        ctx=m.context(self.env());good={'ok':True,'mode':'check','source':'a'*40,'runtime':'b'*40,'accountsIssued':False,'automaticRetry':False}
        self.assertEqual(m.receipt(json.dumps(good),ctx),good)
        for bad in [dict(good,secret='not-allowed'),dict(good,accountsIssued=True),dict(good,mode='start')]:
            with self.assertRaises(ValueError):m.receipt(json.dumps(bad),ctx)
        with self.assertRaises(ValueError):m.receipt(' '*16385,ctx)
    def test_receiver_closed_sources(self):
        ctx=m.context(self.env());sources={p:(ROOT/p).read_text() for p in r.FILES};r.validate(ctx,sources)
        for bad in [dict(sources,extra='bad'),dict(sources,**{'ops/add-uat-host.py':''}),dict(sources,**{'ops/add-uat-host.py':'x'*131073})]:
            with self.assertRaises(ValueError):r.validate(ctx,bad)
        with self.assertRaises(ValueError):r.validate(dict(ctx,mode='accounts'),sources)
    def test_no_accounts_readonly_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'uat.sqlite';db=sqlite3.connect(path)
            db.execute('CREATE TABLE staff_uat_accounts (username TEXT)');db.commit()
            r.no_accounts(path)
            db.execute("INSERT INTO staff_uat_accounts VALUES ('synthetic')");db.commit()
            with self.assertRaises(ValueError):r.no_accounts(path)
            db.close()
            alias=Path(directory)/'alias.sqlite';alias.symlink_to(path)
            with self.assertRaises(ValueError):r.no_accounts(alias)
    def test_workflow_has_no_issuance_or_dns_action(self):
        text=(ROOT/'.github/workflows/uat-activate.yml').read_text()
        self.assertIn('options: [check, start, route-check, route-activate]',text)
        self.assertIn('group: bubblewash-production',text)
        self.assertIn('environment: backup-storage',text)
        self.assertIn('check-release-ci.py',text)
        self.assertNotIn('uat-sealed-handover',text)
if __name__=='__main__':unittest.main()
