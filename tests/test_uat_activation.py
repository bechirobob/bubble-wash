import importlib.util
from pathlib import Path
import tempfile
import base64
import sqlite3
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('activation',ROOT/'ops/uat/activate-host.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ActivationTests(unittest.TestCase):
    def test_all_sandbox_properties_preserved(self):
        unit=(ROOT/'ops/uat/bubblewash-uat.service').read_text()
        props=m.sandbox_properties(unit)
        for expected in ['SystemCallFilter=~connect','User=bubblewash-uat','ProtectSystem=strict','ProtectHome=true','ReadWritePaths=/var/lib/bubblewash-uat','MemoryMax=512M','IPAddressDeny=any','EnvironmentFile=/etc/bubblewash-uat/environment']:
            self.assertIn(expected,props)
        self.assertFalse(any(p.startswith('ExecStart=') for p in props))
    def test_environment_is_closed_allowlist(self):
        # Extract the installer-generated environment, without generating/installing credentials.
        source=(ROOT/'ops/uat/prepare-host.py').read_text()
        start=source.index("    environment = '\\n'.join([");end=source.index('\n    new_file(',start)
        scope={'ROOTS':m.CONFIG and ('/opt/bubblewash-uat','/var/lib/bubblewash-uat','/etc/bubblewash-uat')}
        class Secrets:
            def token_urlsafe(self,n): return 'x'*64
        scope['secrets']=Secrets()
        exec(source[start:end].strip(),scope)
        env=scope['environment']; changed=m.environment(env)
        self.assertEqual(changed,env.replace('BUBBLEWASH_BOOKINGS_DISABLED=true','BUBBLEWASH_BOOKINGS_DISABLED=false'))
        for bad in [env+'PAYSTACK_SECRET_KEY=oops\n',env+'BUBBLEWASH_UAT_ENABLED=true\n',env.replace('BUBBLEWASH_TRUST_PROXY_HEADERS=false','BUBBLEWASH_TRUST_PROXY_HEADERS=true'),env.replace('BUBBLEWASH_BOOKINGS_DISABLED=true','BUBBLEWASH_BOOKINGS_DISABLED=false')]:
            with self.assertRaises(ValueError):m.environment(bad)
    def test_anonymous_and_unissued_readiness(self):
        valid=[(200,b'{}'),(200,b'UAT username'),(403,b'{}'),(503,b'{"environment":"isolated-uat"}')]
        with patch.object(m,'request',side_effect=valid):m.checks()
        for index,value in [(1,(200,b'ordinary login')),(2,(200,b'{}')),(3,(200,b'{"environment":"isolated-uat"}'))]:
            bad=valid.copy();bad[index]=value
            with patch.object(m,'request',side_effect=bad),self.assertRaises(ValueError):m.checks()
    def test_failure_stops_only_new_service_retains_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(m,'CONFIG',Path(tmp)),patch.object(m,'verify',return_value=('unit','newenv')),patch.object(m,'transient'),patch.object(m,'loaded_unit'),patch.object(m,'run') as run,patch.object(m,'checks',side_effect=ValueError('failure')):
                with self.assertRaises(ValueError):m.activate('a'*40)
                self.assertTrue((Path(tmp)/'activation-started.json').exists())
                self.assertIn((['/usr/bin/systemctl','stop','bubblewash-uat.service'],),[c.args for c in run.call_args_list])
                with self.assertRaises(FileExistsError):m.activate('a'*40)
    def test_eval_capsule_preserves_javascript_without_expansion(self):
        source='const suffix="one"; console.log(`uat-vendor-${suffix}`);'
        capsule=m.eval_capsule(source)
        self.assertNotIn('$',capsule)
        encoded=capsule.split('base64,',1)[1].split("'",1)[0]
        self.assertEqual(base64.b64decode(encoded).decode(),source)
        with self.assertRaises(ValueError):m.eval_capsule('x'*131073)
    def test_priority_resume_never_reseeds_and_retains_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=Path(tmp);old=config/'activation-started.json';old.write_text('{"stage":"synthetic-priority"}')
            with patch.object(m,'CONFIG',config),patch.object(m,'verify',return_value=('unit','newenv')) as verify,patch.object(m,'trusted'),patch.object(m,'loaded_unit'),patch.object(m,'transient') as transient,patch.object(m,'run') as run,patch.object(m,'checks',side_effect=ValueError('intentional end')):
                run.return_value.stdout=b''
                with self.assertRaises(ValueError):m.activate('a'*40,resume_priority=True)
                verify.assert_called_once_with('a'*40,allow_priority_resume=True)
                self.assertEqual((config/'activation-before-priority-resume.json').read_text(),'{"stage":"synthetic-priority"}')
                self.assertNotIn('seed',[call.args[1] for call in transient.call_args_list])
                self.assertIn('fixture-priority',[call.args[1] for call in transient.call_args_list])
                with self.assertRaises(FileExistsError):m.activate('a'*40,resume_priority=True)
    def test_pristine_seed_rejects_existing_submissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);(directory/'cache').mkdir();db=sqlite3.connect(directory/'uat.sqlite');db.execute('CREATE TABLE submissions(id TEXT)');db.execute("INSERT INTO submissions VALUES('synthetic-existing')");db.commit();db.close()
            with patch.object(m,'DATA',directory),self.assertRaisesRegex(ValueError,'Existing submissions'):m.pristine_seed()
            (directory/'unexpected').touch()
            with patch.object(m,'DATA',directory),self.assertRaisesRegex(ValueError,'closed pristine'):m.pristine_seed()
    def test_pristine_seed_rejects_issued_accounts_before_roster(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);(directory/'cache').mkdir();db=sqlite3.connect(directory/'uat.sqlite')
            db.executescript("CREATE TABLE submissions(id TEXT);CREATE TABLE staff_uat_accounts(username TEXT);INSERT INTO staff_uat_accounts VALUES('synthetic');");db.close()
            with patch.object(m,'DATA',directory),self.assertRaisesRegex(ValueError,'Existing issuance'):m.pristine_seed()
    def test_probe_no_remote_destination_or_plaintext(self):
        probe=(ROOT/'scripts/uat-isolation-check.mjs').read_text()
        self.assertIn("host:'127.0.0.1', port:9",probe)
        self.assertIn("error.code === 'EPERM'",probe)
        self.assertNotIn('SESSION_SECRET',probe)

if __name__=='__main__': unittest.main()
