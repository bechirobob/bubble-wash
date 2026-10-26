import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import os
import types
from unittest.mock import patch
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare', ROOT / 'ops/uat/prepare-host.py')
prepare = importlib.util.module_from_spec(spec); spec.loader.exec_module(prepare)
REV = 'a' * 40


class HostPreparationTests(unittest.TestCase):
    def facts(self):
        return {'schema':'bubblewash-uat-capacity/v1','readOnly':True,'memoryBytes':{'MemAvailable':2*prepare.GIB},'varLibBytes':{'free':8*prepare.GIB},'cpuCount':2,'loadAverage':[.2,.2,.2],'tcpListening':{'3108':False},'uatUserAlreadyExists':False,'uatPathsAlreadyExist':{p:False for p in prepare.ROOTS},'uatUnitState':'LoadState=not-found\nActiveState=inactive\nSubState=dead\n'}

    def test_admits_safe_capacity(self):
        prepare.admit(self.facts(), prepare.GIB)

    def test_capacity_collision_and_unknown_fail_closed(self):
        cases=[('memoryBytes',{}),('varLibBytes',None),('cpuCount',1),('loadAverage',None),('loadAverage',[2,0,0]),('loadAverage',[float('nan'),0,0]),('tcpListening',{}),('tcpListening',{'3108':True}),('uatUserAlreadyExists',True),('uatUnitState','LoadState=loaded\nActiveState=inactive\nSubState=dead'),('uatPathsAlreadyExist',{})]
        for key,value in cases:
            facts=self.facts();facts[key]=value
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):prepare.admit(facts,prepare.GIB)
        facts=self.facts();facts['uatPathsAlreadyExist'][prepare.ROOTS[0]]=True
        with self.assertRaises(ValueError):prepare.admit(facts,prepare.GIB)

    def archive(self, extras=()):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        path=Path(folder.name)/'artifact.tar'
        names=['.next/BUILD_ID','package.json','node_modules/next/dist/bin/next','next.config.mjs','src/lib/uat-accounts.ts','scripts/uat-account.mjs']
        receipt={'schema':'bubblewash-uat-build/v1','revision':REV,'onlinePayments':False,'automatedUpdates':False,'providerCredentialsIncluded':False}
        with tarfile.open(path,'w') as tar:
            for name,data in [(n,b'test') for n in names]+[('uat-build.json',json.dumps(receipt).encode()),('SOURCE_REVISION',(REV+'\n').encode())]:
                info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
            for name,kind in extras:
                info=tarfile.TarInfo(name)
                if kind=='link':info.type=tarfile.SYMTYPE;info.linkname='/var/lib/bubblewash'
                elif kind=='hardlink':info.type=tarfile.LNKTYPE;info.linkname='package.json'
                elif kind=='fifo':info.type=tarfile.FIFOTYPE
                else:info.size=1
                tar.addfile(info,io.BytesIO(b'x') if info.isfile() else None)
        return path,hashlib.sha256(path.read_bytes()).hexdigest()

    def test_exact_regular_artifact(self):
        path,digest=self.archive();self.assertGreater(prepare.inspect_archive(path,digest,REV),0)
        with self.assertRaises(ValueError):prepare.inspect_archive(path,'0'*64,REV)
        with self.assertRaises(ValueError):prepare.inspect_archive(path,digest,'b'*40)

    def test_unsafe_artifacts_refused(self):
        cases=[[('../escape','file')],[('/absolute','file')],[('data/live.sqlite','file')],[('.env.production','file')],[('secrets/key','file')],[('package.json','file')],[('bad','link')],[('bad','hardlink')],[('bad','fifo')],[('parent','file'),('parent/child','file')],[('parent/child','file'),('parent','file')]]
        for extras in cases:
            with self.subTest(extras=extras):
                path,digest=self.archive(extras)
                with self.assertRaises(ValueError):prepare.inspect_archive(path,digest,REV)

    def test_install_only_new_private_fixture_retains_no_live_dependencies(self):
        artifact,_=self.archive()
        with tempfile.TemporaryDirectory() as directory:
            roots=tuple(str(Path(directory)/part) for part in ('app-root','data-root','config-root'))
            unit=str(Path(directory)/'uat.service')
            commands=[]
            account=types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
            original_umask=os.umask(0o077)
            try:
                with patch.object(prepare,'ROOTS',roots),patch.object(prepare,'UNIT',unit),patch.object(prepare,'run',side_effect=lambda command:commands.append(command)),patch.object(prepare.pwd,'getpwnam',return_value=account),patch.object(prepare.os,'chown'),patch.object(prepare.secrets,'token_urlsafe',return_value='synthetic-test-only-not-a-real-secret'):
                    prepare.install(artifact,REV,'[Unit]\nDescription=Synthetic fixture\n')
                config=Path(roots[2])/'environment'
                self.assertEqual(config.stat().st_mode & 0o777,0o600)
                self.assertEqual(Path(roots[0]).stat().st_mode & 0o777,0o755)
                self.assertEqual((Path(roots[0])/'app').stat().st_mode & 0o777,0o755)
                self.assertEqual((Path(roots[0])/'app/.next/cache').stat().st_mode & 0o777,0o755)
                self.assertEqual((Path(roots[0])/'app/package.json').stat().st_mode & 0o777,0o644)
                self.assertEqual((Path(roots[0])/'app/node_modules/next/dist/bin/next').stat().st_mode & 0o777,0o644)
                self.assertEqual((Path(roots[0])/'app/node_modules').stat().st_mode & 0o777,0o755)
                text=config.read_text()
                self.assertIn('BUBBLEWASH_SESSION_SECRET=synthetic-test-only-not-a-real-secret',text)
                self.assertNotIn('RESEND_API_KEY',text)
                self.assertNotIn('PAYSTACK_SECRET_KEY',text)
                self.assertIn('BUBBLEWASH_BOOKINGS_DISABLED=true',text)
                self.assertFalse((Path(roots[1])/'uat.sqlite').exists())
                self.assertEqual(json.loads((Path(roots[2])/'release.json').read_text())['accountsIssued'],False)
                self.assertEqual([c[0] for c in commands],['/usr/sbin/useradd','/usr/bin/systemd-analyze'])
                with self.assertRaises(FileExistsError):prepare.new_file(config,'overwrite refused')
                self.assertEqual(config.read_text(),text)
            finally:os.umask(original_umask)

    def test_unit_additive_readonly_network_and_resource_boundary(self):
        unit=(ROOT/'ops/uat/bubblewash-uat.service').read_text()
        for item in ['User=bubblewash-uat','--hostname 127.0.0.1 --port 3108','ProtectSystem=strict','ProtectHome=true','NoNewPrivileges=true','SystemCallFilter=~connect','IPAddressDeny=any','SocketBindDeny=any','ReadWritePaths=/var/lib/bubblewash-uat','MemoryMax=512M','CPUQuota=50%','TasksMax=128']:
            self.assertIn(item,unit)
        source=(ROOT/'ops/uat/prepare-host.py').read_text()
        self.assertNotIn("'systemctl'",source)
        self.assertNotIn('Caddyfile',source)
        self.assertNotIn('rmtree',source)
        self.assertIn('os.O_EXCL | os.O_NOFOLLOW',source)
        self.assertIn('secrets.token_urlsafe(48)',source)


if __name__=='__main__':unittest.main()
