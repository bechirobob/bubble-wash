import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('preflight', ROOT/'ops/uat/restoration-preflight.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class Environment(unittest.TestCase):
    def setUp(self):
        self.config = dict(m.EXPECTED_ENV, BUBBLEWASH_SESSION_SECRET='x'*64)
        self.process = dict(self.config, NODE_ENV='production', HOME=m.DATA, PATH='/usr/bin:/bin')
    def check(self, config=None, process=None):
        raw = '\n'.join(k+'='+v for k,v in (config or self.config).items()).encode()
        runtime = '\0'.join(k+'='+v for k,v in (process or self.process).items()).encode()+b'\0'
        return m.verify_environment(raw,runtime)
    def test_good_values_never_returned(self):
        result=self.check()
        self.assertTrue(all(result.values()))
        self.assertNotIn('x'*64,json.dumps(result))
        self.assertNotIn(m.DATABASE,json.dumps(result))
    def test_runtime_drift_and_all_unknown_environment_refused(self):
        for key,value in [('PAYSTACK_SECRET_KEY','synthetic'),('AWS_SECRET_ACCESS_KEY','synthetic'),('NODE_OPTIONS','--require=/tmp/unknown'),('BUBBLEWASH_PUBLIC_URL','https://staff.bubblewash.co'),('BUBBLEWASH_UAT_ENABLED','false')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.check(process=dict(self.process,**{key:value}))
    def test_newline_in_process_value_cannot_spoof_environment(self):
        forged=b'PATH=/bin\n'+b'\n'.join((k+'='+v).encode() for k,v in self.process.items())+b'\0'
        with self.assertRaises(ValueError):m.verify_environment(b'\n'.join((k+'='+v).encode() for k,v in self.config.items()),forged)
    def test_duplicate_configuration_refused(self):
        with self.assertRaises(ValueError):m.parse_environment(b'A=a\nA=b\n')


class Runtime(unittest.TestCase):
    def test_actual_revision_and_every_file_pin_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            app=Path(directory)/'app'; app.mkdir();unit=Path(directory)/'unit'
            revision='a'*40; (app/'SOURCE_REVISION').write_text(revision+'\n');unit.write_text('synthetic unit')
            pins={}
            for name in m.PIN_FILES:
                path=app/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('synthetic source')
                pins[name]=hashlib.sha256(path.read_bytes()).hexdigest()
            unit_pin=hashlib.sha256(unit.read_bytes()).hexdigest()
            self.assertTrue(m.verify_runtime(app,unit,revision,pins,unit_pin)['installedRuntimeVerified'])
            (app/'SOURCE_REVISION').write_text('b'*40+'\n')
            with self.assertRaises(ValueError):m.verify_runtime(app,unit,revision,pins,unit_pin)
            (app/'SOURCE_REVISION').write_text(revision+'\n')
            (app/'src/lib/auth.ts').write_text('different source')
            with self.assertRaises(ValueError):m.verify_runtime(app,unit,revision,pins,unit_pin)


class Service(unittest.TestCase):
    def setUp(self):
        self.props={'ActiveState':'active','SubState':'running','FragmentPath':m.UNIT,'DropInPaths':'',
            'User':'bubblewash-uat','Group':'bubblewash-uat','WorkingDirectory':m.APP,
            'NoNewPrivileges':True,'ProtectSystem':'strict','ProtectHome':True,'PrivateTmp':True,'PrivateDevices':True,
            'ProtectKernelTunables':True,'ProtectKernelModules':True,'ProtectKernelLogs':True,'ProtectControlGroups':True,
            'ProtectClock':True,'RestrictSUIDSGID':True,'RestrictRealtime':True,'LockPersonality':True,'RestrictNamespaces':True,
            'CapabilityBoundingSet':[],'AmbientCapabilities':[],'ReadWritePaths':[m.DATA],
            'BindPaths':[[m.DATA+'/cache',m.APP+'/.next/cache']],
            'InaccessiblePaths':['/etc/bubblewash','/opt/bubblewash','/var/lib/bubblewash'],
            'RestrictAddressFamilies':['AF_INET','AF_INET6','AF_UNIX'],'IPAddressDeny':['0.0.0.0/0','::/0'],
            'IPAddressAllow':['127.0.0.0/8','::1/128'],'SystemCallFilterDeny':['connect'],'SystemCallErrorNumber':'EPERM',
            'SocketBindDeny':['any'],'SocketBindAllow':['ipv4:tcp:3108'],'EnvironmentFiles':[m.ENVIRONMENT],
            'UMask':'0077','MainPID':123,'ControlGroup':'/system.slice/'+m.SERVICE}
        self.proc={'pid':123,'uids':[1001]*4,'gids':[1001]*4,'groups':[1001],'cwd':m.APP,'executable':'/usr/bin/node',
            'NoNewPrivs':1,'Seccomp':2,'effectiveCapabilities':0,'cgroup':'/system.slice/'+m.SERVICE,
            'listeners':[{'address':'127.0.0.1','port':3108,'pid':123}]}
    def test_fixed_sandbox_and_identity(self):
        self.assertTrue(all(m.verify_service(self.props,self.proc,1001,1001).values()))
    def test_weaker_filter_dropin_or_writable_production_rejected(self):
        for field,value in [('SystemCallFilterDeny',[]),('DropInPaths','/etc/unknown.conf'),('ReadWritePaths',[m.DATA,'/var/lib/bubblewash']),('IPAddressDeny',[]),('EnvironmentFiles',[m.ENVIRONMENT,'/other/env'])]:
            with self.subTest(field=field),self.assertRaises(ValueError):
                m.verify_service(dict(self.props,**{field:value}),self.proc,1001,1001)
    def test_different_process_or_kernel_sandbox_state_rejected(self):
        for field,value in [('pid',456),('uids',[0]*4),('groups',[1001,0]),('Seccomp',0),('NoNewPrivs',0),('effectiveCapabilities',1),('cwd','/home/ubuntu/live'),('listeners',[{'address':'0.0.0.0','port':3108,'pid':123}])]:
            with self.subTest(field=field),self.assertRaises(ValueError):
                m.verify_service(self.props,dict(self.proc,**{field:value}),1001,1001)


class Mounts(unittest.TestCase):
    host='1 0 8:1 / / rw - ext4 /dev/sda1 rw\n'
    service=host+'2 1 8:1 /var/lib/bubblewash-uat/cache /opt/bubblewash-uat/app/.next/cache rw - ext4 /dev/sda1 rw\n'
    production=['/home/ubuntu/live/app','/home/ubuntu/live/data','/home/ubuntu/.config/bubblewash/env']
    uat=[m.APP,m.DATA,m.DATABASE,m.ENVIRONMENT]
    def test_shared_disk_separate_directories_pass(self):
        self.assertTrue(m.verify_storage_isolation(self.uat,self.production,self.host,self.service)['mountBackingsIndependent'])
    def test_bind_mount_alias_to_production_refused(self):
        alias=self.host+'2 1 8:1 /home/ubuntu/live/data /var/lib/bubblewash-uat rw - ext4 /dev/sda1 rw\n'
        with self.assertRaises(ValueError):m.verify_storage_isolation(self.uat,self.production,alias,alias)
    def test_service_namespace_override_refused(self):
        service=self.host+'2 1 8:1 /other-data /var/lib/bubblewash-uat rw - ext4 /dev/sda1 rw\n'
        with self.assertRaises(ValueError):m.verify_storage_isolation(self.uat,self.production,self.host,service)
    def test_cache_or_descendant_production_alias_refused(self):
        bad=self.service.replace('/var/lib/bubblewash-uat/cache /opt','/home/ubuntu/live/data /opt')
        with self.assertRaises(ValueError):m.verify_storage_isolation(self.uat,self.production,self.host,bad)
        bad=self.service+'3 1 8:1 /home/ubuntu/live/data /var/lib/bubblewash-uat/hidden rw - ext4 /dev/sda1 rw\n'
        with self.assertRaises(ValueError):m.verify_storage_isolation(self.uat,self.production,self.host,bad)
    def test_unknown_union_backing_refused(self):
        for filesystem in ('overlay','aufs'):
            with self.subTest(filesystem=filesystem),self.assertRaises(ValueError):
                m.mount_backing(m.DATA,f'1 0 0:1 / / rw - {filesystem} {filesystem} rw\n')
    def test_unrelated_opaque_roots_pass(self):
        for filesystem in ('nsfs','other'):
            opaque=f'3 1 0:4 net:[4026531840] /run/netns/example rw - {filesystem} {filesystem} rw\n'
            with self.subTest(filesystem=filesystem):
                self.assertTrue(all(m.verify_storage_isolation(self.uat,self.production,
                    self.host+opaque,self.service+opaque).values()))
    def test_relevant_opaque_roots_refused(self):
        for point in (m.DATA,m.DATA+'/cache',m.APP+'/.next/cache',m.APP+'/hidden',m.DATA+'/hidden'):
            opaque=f'3 1 0:4 net:[4026531840] {point} rw - nsfs nsfs rw\n'
            with self.subTest(point=point),self.assertRaises(ValueError):
                m.verify_storage_isolation(self.uat,self.production,self.host,self.service+opaque)
    def test_sibling_prefix_is_not_a_relevant_mount(self):
        for point in (m.DATA+'-sibling',m.APP+'-sibling'):
            opaque=f'3 1 0:4 net:[4026531840] {point} rw - nsfs nsfs rw\n'
            with self.subTest(point=point):
                self.assertTrue(all(m.verify_storage_isolation(self.uat,self.production,
                    self.host+opaque,self.service+opaque).values()))
    def test_malformed_unrelated_records_refused_globally(self):
        for record in (
            '3 1 0:4 / run/netns/example rw - nsfs nsfs rw',
            '3 1 invalid / /run/netns/example rw - nsfs nsfs rw',
            '3 1 0:4 / /run/netns/example - nsfs nsfs rw',
            '3 1 0:4 / /run/netns/example rw - nsfs nsfs',
            '3 1 0:4 / /run/netns/example rw nsfs nsfs rw',
        ):
            with self.subTest(record=record),self.assertRaises(ValueError):
                m.mount_backing(m.DATA,self.host+record+'\n')
    def test_deepest_mount_selected_and_ambiguity_refused(self):
        child=f'2 1 8:2 /backing {m.DATA} rw - ext4 /dev/sdb1 rw\n'
        self.assertEqual(m.mount_backing(m.DATA+'/cache',self.host+child),('8:2','/backing/cache'))
        with self.assertRaises(ValueError):m.mount_backing(m.DATA,self.host+child+child)
    def test_escaped_root_preserved(self):
        root=r'/backing\040space\011tab\012newline\134slash'
        child=f'2 1 8:2 {root} {m.DATA} rw - ext4 /dev/sdb1 rw\n'
        self.assertEqual(m.mount_backing(m.DATA+'/cache',self.host+child),
            ('8:2','/backing space\ttab\nnewline\\slash/cache'))


class Accounts(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'uat.sqlite'
        self.db=sqlite3.connect(self.path);self.addCleanup(self.db.close)
        self.db.executescript(';'.join(m.SCHEMA.values())+';')
        self.db.executescript('''        CREATE TABLE vendor_availability(vendor_id TEXT); INSERT INTO vendor_availability VALUES ('synthetic-vendor');
        CREATE TABLE driver_availability(driver_id TEXT); INSERT INTO driver_availability VALUES ('synthetic-driver');
        CREATE TABLE test_history(value TEXT);INSERT INTO test_history VALUES ('preserve');''')
        for role in sorted(m.ROLES):
            entity='synthetic-'+role if role in ('driver','vendor') else ''
            self.db.execute("INSERT INTO staff_uat_accounts (username,role,entity_id,starts_at,expires_at,status,name,password_hash,credential_version,created_at) VALUES (?,?,?,?,?,?,'Synthetic','synthetic-hash','synthetic-version',0)",(role,role,entity,m.ORIGINAL_START,m.ORIGINAL_START+m.WINDOW,'active'))
            self.db.execute('INSERT INTO staff_uat_audit (username,action,actor,starts_at,expires_at,id,occurred_at) VALUES (?,?,?,?,?,hex(randomblob(16)),0)',(role,'created','approved-uat-issuance',m.ORIGINAL_START,m.ORIGINAL_START+m.WINDOW))
        self.db.execute("INSERT INTO staff_uat_accounts (username,role,entity_id,starts_at,expires_at,status,name,password_hash,credential_version,created_at) VALUES (?,?,?,?,?,?,'Synthetic','synthetic-hash','synthetic-version',0)",('revoked-child','support','',m.ORIGINAL_START,m.ORIGINAL_START+m.WINDOW,'revoked'))
        self.db.commit()
        self.now=m.ORIGINAL_START+m.WINDOW
    def check(self):return m.inspect_accounts(self.path,self.now)
    def snapshot(self):return '\n'.join(self.db.iterdump())
    def test_expired_active_rows_not_housekept_or_mutated(self):
        before=self.snapshot(); raw=self.path.read_bytes(); result=self.check()
        self.assertEqual(result['originalRoleCount'],4);self.assertEqual(result['revokedAccountCount'],1)
        self.assertEqual(before,self.snapshot());self.assertEqual(raw,self.path.read_bytes())
        self.assertNotIn('revoked-child',json.dumps(result))
    def test_readonly_includes_committed_wal(self):
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute("UPDATE staff_uat_accounts SET status='revoked' WHERE role='admin'");self.db.commit()
        with self.assertRaises(ValueError):self.check()
    def test_unexpired_and_revoked_refused(self):
        self.now-=1
        with self.assertRaises(ValueError):self.check()
        self.now+=1
        self.db.execute("UPDATE staff_uat_accounts SET status='revoked' WHERE role='admin'");self.db.commit()
        with self.assertRaises(ValueError):self.check()
    def test_duplicate_role_refused(self):
        self.db.execute("UPDATE staff_uat_accounts SET role='support' WHERE role='driver'");self.db.commit()
        with self.assertRaises(ValueError):self.check()
    def test_prior_restoration_audit_refused(self):
        self.db.execute("INSERT INTO staff_uat_audit (username,action,actor,starts_at,expires_at,id,occurred_at) VALUES ('admin','restored-original-after','operator',0,0,'synthetic-marker',0)");self.db.commit()
        with self.assertRaises(ValueError):self.check()
    def test_missing_roster_refused(self):
        self.db.execute('DELETE FROM driver_availability');self.db.commit()
        with self.assertRaises(ValueError):self.check()
    def test_mutating_trigger_refused_without_touching_history(self):
        self.db.execute("CREATE TRIGGER bad AFTER UPDATE ON staff_uat_accounts BEGIN DELETE FROM test_history; END");self.db.commit()
        before=self.snapshot()
        with self.assertRaises(ValueError):self.check()
        self.assertEqual(before,self.snapshot())
    def test_unknown_disabled_state_refused(self):
        self.db.execute('PRAGMA ignore_check_constraints=ON')
        self.db.execute("UPDATE staff_uat_accounts SET status='disabled' WHERE role='admin'");self.db.commit()
        with self.assertRaises(ValueError):self.check()


if __name__=='__main__':unittest.main()
