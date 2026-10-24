"""Synthetic-only tests. No production connection, service command or DB open."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'ops/integration-release'))
import host_adapter as a
spec = importlib.util.spec_from_file_location('guard', ROOT/'ops/integration-release/vendor/bubblewash-web-a476-baseline/ops/deploy-preserving.py')
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name); self.root=root
        self.runtime=root/'runtime';self.runtime.mkdir();(self.runtime/'deploy.lock').touch()
        self.releases=root/'releases';self.releases.mkdir();self.live=self.releases/'live';self.live.mkdir()
        self.current=root/'current';self.current.symlink_to(self.live)
        self.database=root/'private-database.sqlite';self.database.write_bytes(b'not even SQLite: never opened')
        self.env=root/'env';self.env.write_text('BUBBLEWASH_DATABASE_PATH='+str(self.database)+'\nSECRET=DO_NOT_DISCLOSE\n')
        (self.runtime/'current-release').write_text('sha='+'a'*40+'\npath='+str(self.live)+'\n')
        self.calls=[]
        def run(cmd):
            self.calls.append(cmd)
            if 'busctl' in cmd and cmd[-1] == 'Conditions':
                return 'a(sbbsi) 2 "ConditionPathExists" false false "'+str(a.STATE/'installed-v1')+'" 1 "ConditionPathExists" false true "'+str(a.STATE/'app-hold')+'" 1'
            if 'busctl' in cmd:
                return 'a(sasbttttuii) 1 "/usr/bin/node" 2 "/usr/bin/node" "SECRET_ARG" false 0 0 0 0 0 0 0'
            self.assertIn('show',cmd);self.assertNotIn('list-units',cmd)
            self.assertIn('--all',cmd)
            requested=next(part.removeprefix('--property=') for part in cmd if part.startswith('--property=')).split(',')
            if requested == ['MainPID']:return 'MainPID=1'
            props=dict.fromkeys(requested,'')
            props.update(LoadState='loaded',ActiveState='active',SubState='running',NeedDaemonReload='no',Conditions='SECRET_CONDITION')
            if 'MainPID' in props:props.update(MainPID='1',ControlPID='0')
            return '\n'.join(k+'='+v for k,v in props.items())
        self.run=run
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        for name,value in dict(RUNTIME=self.runtime,ENV=self.env,CURRENT=self.current,OLD_RELEASES=self.releases,RELEASES=root/'protected-releases',STATE=root/'state').items():
            self.stack.enter_context(patch.object(a,name,value))
        self.stack.enter_context(patch.object(a.os,'geteuid',return_value=0))
        self.stack.enter_context(patch.object(a.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())))
        for name in ('run_plan','load_controller'):
            self.stack.enter_context(patch.object(a,name,side_effect=AssertionError('forbidden release path')))
        self.stack.enter_context(patch.object(a.Host,'inventory',side_effect=AssertionError('forbidden inventory')))
        self.stack.enter_context(patch.object(a.sqlite3,'connect',side_effect=AssertionError('DB must not open')))
        self.stack.enter_context(patch.object(a,'inspect_node_process',return_value=({'path':'/usr/bin/node','sha256':'a'*64},lambda:True)))

    def test_exact_units_no_secrets_no_mutation(self):
        before={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result=a.inspect_host_evidence(g,self.run)
        after={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before,after)
        self.assertEqual(set(result['units']),{m+'/'+u for m,u in a.EVIDENCE_UNITS})
        self.assertEqual(len(self.calls),9)
        self.assertEqual(result['units']['user/bubblewash-local.service']['loadedConditions']['gates'][1], {'name': 'app-hold', 'trigger': False, 'negate': True, 'result': 1})
        rendered=json.dumps(result)
        for secret in ('DO_NOT_DISCLOSE','SECRET_ARG','SECRET_CONDITION',str(self.database)):
            self.assertNotIn(secret,rendered)
        self.assertFalse(result['releaseAcceptance']);self.assertFalse(result['databaseOpened'])
        self.assertFalse(result['paths'][str(a.STATE)]['present'])

    def test_live_main_pid_change_refused_before_return(self):
        def run(cmd):
            raw=self.run(cmd)
            return 'MainPID=2' if '--property=MainPID' in cmd else raw
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,run)
        self.assertEqual(a.EVIDENCE_STAGE,'NODE_IDENTITY')

    def test_node_recheck_failure_refused_before_return(self):
        def changed():raise ValueError('changed')
        with patch.object(a,'inspect_node_process',return_value=({'path':'/usr/bin/node','sha256':'a'*64},changed)):
            with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)

    def test_missing_lock_not_created(self):
        (self.runtime/'deploy.lock').unlink()
        with self.assertRaises(FileNotFoundError):a.inspect_host_evidence(g,self.run)
        self.assertFalse((self.runtime/'deploy.lock').exists());self.assertEqual(self.calls,[])

    def test_environment_symlink_refused(self):
        original=self.env.read_bytes();self.env.unlink();target=self.root/'other';target.write_bytes(original);self.env.symlink_to(target)
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)
        self.assertEqual(self.calls,[])

    def test_marker_mismatch_refused(self):
        (self.runtime/'current-release').write_text('sha='+'b'*40+'\npath=/wrong\n')
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)

    def test_writable_config_refused(self):
        self.env.chmod(0o666)
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)

    def test_database_in_release_refused(self):
        self.env.write_text('BUBBLEWASH_DATABASE_PATH='+str(self.live/'db')+'\n');(self.live/'db').touch()
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,self.run)

    def test_busy_lock_refused_without_commands(self):
        with g.deployment_lock(self.runtime,os.getuid()):
            with self.assertRaises(BlockingIOError):a.inspect_host_evidence(g,self.run)
        self.assertEqual(self.calls,[])

    def test_extra_property_refused(self):
        def run(cmd):return self.run(cmd)+'\nEnvironment=SECRET_VALUE'
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,run)

    def test_outside_unit_source_refused(self):
        def run(cmd):
            raw=self.run(cmd)
            return raw.replace('FragmentPath=','FragmentPath=/private/secret') if 'show' in cmd else raw
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,run)

    def test_sensitive_dropin_path_is_hash_only(self):
        home=self.root/'home'; source=home/'.config/systemd/user/bubblewash-local.service.d/customer-secret-token.conf'
        source.parent.mkdir(parents=True);source.write_text('[Unit]\nConditionPathExists=/safe\n')
        def run(cmd):
            raw=self.run(cmd)
            if 'show' in cmd and 'bubblewash-local.service' in cmd:
                raw=raw.replace('DropInPaths=', 'DropInPaths='+str(source))
            return raw
        with patch.object(a,'HOME',home):
            result=a.inspect_host_evidence(g,run)
        rendered=json.dumps(result)
        self.assertNotIn('customer-secret-token',rendered)
        self.assertNotIn(str(source),rendered)
        unit=result['units']['user/bubblewash-local.service']
        self.assertEqual(unit['sources'][0]['pathSha256'],a.object_digest(str(source)))
        self.assertEqual(unit['loadedConditions']['gates'][1]['name'],'app-hold')
        self.assertTrue(unit['loadedConditions']['gates'][1]['negate'])

    def test_unknown_conditions_redacted(self):
        host=types.SimpleNamespace(prefix=lambda _:[],run=lambda _: 'a(sbbsi) 1 "ConditionEnvironment" false false "SECRET_VALUE" 1')
        result=a.evidence_conditions(host,'system','bubblewash-maintenance.service')
        self.assertEqual(result['otherCount'],1);self.assertNotIn('SECRET_VALUE',json.dumps(result))

    def test_malformed_condition_refused(self):
        host=types.SimpleNamespace(prefix=lambda _:[],run=lambda _: 'a(sbbsi) 1 "ConditionPathExists" maybe false "/x" 1')
        with self.assertRaises(ValueError):a.evidence_conditions(host,'system','bubblewash-maintenance.service')

    def test_timer_has_only_applicable_properties(self):
        result=a.inspect_host_evidence(g,self.run)
        timer=result['units']['system/bubblewash-maintenance.timer']
        self.assertNotIn('MainPID',timer)
        self.assertNotIn('ControlGroupSha256',timer)
        self.assertIn('loadedConditions',timer)
        first=self.calls[0]
        requested=next(part for part in first if part.startswith('--property='))
        self.assertNotIn('MainPID',requested)
        self.assertNotIn('EnvironmentFiles',requested)
        self.assertIn('--all',first)

    def test_missing_service_property_still_refused(self):
        def run(cmd):
            raw=self.run(cmd)
            if 'show' in cmd and any(x.endswith('.service') for x in cmd):
                raw='\n'.join(line for line in raw.splitlines() if not line.startswith('MainPID='))
            return raw
        with self.assertRaises(ValueError):a.inspect_host_evidence(g,run)
        self.assertEqual(a.EVIDENCE_STAGE,'UNIT_PROPERTIES')

    def test_failure_diagnostic_redacts_exception(self):
        (self.runtime/'deploy.lock').unlink()
        try:a.inspect_host_evidence(g,self.run)
        except FileNotFoundError as error:result=a.evidence_failure(error)
        self.assertEqual(result['stage'],'LOCK');self.assertEqual(result['category'],'MISSING')
        self.assertNotIn(str(self.root),json.dumps(result))
        with patch.object(a,'EVIDENCE_STAGE','SECRET_STAGE'):
            result=a.evidence_failure(ValueError('SECRET_VALUE /private/path'))
        self.assertEqual(result['stage'],'INITIALIZE');self.assertEqual(result['category'],'REFUSED')
        self.assertNotIn('SECRET',json.dumps(result))

    def test_stream_no_plan_no_host_imports(self):
        command=[sys.executable,'-B',str(ROOT/'ops/integration-release/stream_host.py'),'--mode','inspect-host-evidence']
        value=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(value.returncode,0,value.stderr);compile(value.stdout,'stream','exec')
        self.assertIn('inspect_host_evidence',value.stdout)
        initialize=value.stdout.rsplit("try:\n print(json.dumps",1)[0]
        smoke=subprocess.run([sys.executable,'-I','-B','-'], input=initialize+"\nassert callable(sys.modules['host_adapter'].inspect_host_evidence)\nprint('initialized')\n",capture_output=True,text=True)
        self.assertEqual(smoke.returncode,0,smoke.stderr)
        self.assertEqual(smoke.stdout.strip(),'initialized')
        tail=value.stdout[len(initialize):]
        inject="\nm=sys.modules['host_adapter']\nm.EVIDENCE_STAGE='UNIT_PROPERTIES'\nm.inspect_host_evidence=lambda guard: (_ for _ in ()).throw(ValueError('SECRET_ENV /private/path'))\n"
        failed=subprocess.run([sys.executable,'-I','-B','-'],input=initialize+inject+tail,capture_output=True,text=True)
        self.assertEqual(failed.returncode,1);self.assertEqual(failed.stdout,'')
        report=json.loads(failed.stderr)
        self.assertEqual(report['stage'],'UNIT_PROPERTIES');self.assertEqual(report['category'],'REFUSED')
        self.assertNotIn('SECRET_ENV',failed.stderr);self.assertNotIn('/private/path',failed.stderr)
        bad=subprocess.run(command+['--plan-id','a'*64],capture_output=True,text=True)
        self.assertNotEqual(bad.returncode,0)

if __name__=='__main__':unittest.main()

class CoordinatedSafetyTests(unittest.TestCase):
    def test_production_admission_keeps_bookings_paused_and_commercial_off(self):
        values={'BUBBLEWASH_STAFF_AUTH_DISABLED':'false','BUBBLEWASH_BOOKINGS_DISABLED':'true',
                'BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false'}
        self.assertTrue(a.admit_production_configuration(values))
        for name in values:
            with self.subTest(name=name),self.assertRaises(ValueError):
                a.admit_production_configuration({**values,name:'unexpected'})
        with self.assertRaises(ValueError):a.admit_production_configuration({})

    def test_private_operator_review_bound_and_expiring(self):
        import contracts as k
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'operator.json'
            inventory={'schema':'bubblewash-known-invokers/v1','units':{}}
            receipt={'schema':'bubblewash-coordinated-operator-review/v1','hostMachineIdSha256':a.digest('/etc/machine-id'),
                     'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                     'issuedAt':100,'expiresAt':200,'sourceContractSha256':'c'*64,
                     'knownInvokersSha256':a.object_digest(inventory),'riskApprovalSha256':'d'*64,
                     'reviewReference':'e'*64,'residualAssumptionSha256':k.RESIDUAL_ASSUMPTION_SHA256}
            host=a.Host.__new__(a.Host);host.inventory=lambda:inventory
            host.plan={'sourceContractSha256':'c'*64,'hostAcceptance':{
                'operatorReceipt':str(path),'operatorReceiptSha256':'','knownInvokersSha256':a.object_digest(inventory),'riskApprovalSha256':'d'*64}}
            def write(value):
                path.write_bytes(a.canonical(value));path.chmod(0o600)
                host.plan['hostAcceptance']['operatorReceiptSha256']=a.digest(path)
            write(receipt)
            with patch.object(a,'protected',return_value=()),patch.object(a.time,'time',return_value=150):
                self.assertTrue(host.exclusion())
                for key,value in [('expiresAt',149),('issuedAt',151),('riskApprovalSha256','0'*64),
                                  ('residualAssumptionSha256','0'*64),('knownInvokersSha256','0'*64),
                                  ('bootId','wrong'),('sourceContractSha256','0'*64)]:
                    write({**receipt,key:value})
                    with self.subTest(key=key),self.assertRaises(ValueError):host.exclusion()
                write(receipt);path.chmod(0o644)
                with self.assertRaises(ValueError):host.exclusion()
                path.chmod(0o600);host.plan['hostAcceptance']['externalInvokersExcluded']=True
                with self.assertRaises(ValueError):host.exclusion()

    def test_materialization_rechecks_runtime_inside_lock_without_database_open(self):
        import contracts as k
        with tempfile.TemporaryDirectory() as directory,contextlib.ExitStack() as stack:
            root=Path(directory);runtime=root/'runtime';runtime.mkdir();releases=root/'old-releases';releases.mkdir()
            old=releases/'live';old.mkdir();current=root/'current';current.symlink_to(old)
            (old/'.release-sha').write_text(k.LIVE_SHA)
            database=root/'db';database.write_bytes(b'not SQLite')
            env=root/'env';env.write_text('BUBBLEWASH_DATABASE_PATH='+str(database)+'\nBUBBLEWASH_BACKUP_OFFSITE_DIR='+str(root)+'\nBUBBLEWASH_BACKUP_STATUS_PATH='+str(root/'status')+'\nBUBBLEWASH_STAFF_AUTH_DISABLED=false\nBUBBLEWASH_BOOKINGS_DISABLED=true\nBUBBLEWASH_DISABLE_DEMO_LOGIN=true\nNEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false\n')
            (runtime/'current-release').write_text('sha='+k.LIVE_SHA+'\npath='+str(old)+'\n')
            archive=root/'archive';archive.write_bytes(b'encrypted fixture')
            receipt=root/'receipt';receipt.write_text(json.dumps({'filename':'archive','sha256':a.digest(archive),'size':archive.stat().st_size}))
            (root/'status').write_text('{}')
            for name,value in {'RUNTIME':runtime,'ENV':env,'CURRENT':current,'OLD_RELEASES':releases,'RECEIPT':receipt,'STATE':root/'state'}.items():
                stack.enter_context(patch.object(a,name,value))
            calls=[]
            @contextlib.contextmanager
            def lock(*_):
                calls.append('lock');yield lambda:calls.append('lock-recheck');calls.append('unlock')
            guard=types.SimpleNamespace(deployment_lock=lock,parse=lambda raw:dict(line.split('=',1) for line in raw.decode().splitlines()),
                verify_receipt=lambda *_:calls.append('backup'),check_runtime=lambda *_:calls.append('runtime'))
            units=a.EVIDENCE_UNITS
            c=types.SimpleNamespace(core=types.SimpleNamespace(UNITS=units,TIMER=units[0][1],APP=units[2][1],
                    parse_properties=lambda raw:dict(line.split('=',1) for line in raw.splitlines())),
                guards_module=lambda:guard,DurableState=lambda _:object(),SystemdReader=lambda *_:None,
                LoadedGates=lambda *_:lambda:calls.append('gates'))
            inventory={'units':{}}
            for manager,unit in units:
                fragment=root/(manager+'-'+unit);fragment.write_text('fixture')
                inventory['units'][manager+'/'+unit]={'properties':{'FragmentPath':str(fragment),'WorkingDirectory':'','EnvironmentFiles':'','User':'','Group':''},'files':{str(fragment):a.digest(fragment)},'execStart':[]}
            preparation=types.SimpleNamespace(__source_sha256__=k.PREPARATION_HELPER_SHA256,source_files=lambda *_:{'source':'same'},git_tree=lambda _:k.LIVE_TREE)
            stack.enter_context(patch.dict(a.sys.modules,{'integration_preparation':preparation}))
            stack.enter_context(patch.object(a,'load_controller',return_value=c))
            stack.enter_context(patch.object(a.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(a.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())))
            stack.enter_context(patch.object(a,'protected',side_effect=lambda path,**_:tuple(getattr(Path(path).stat(),key) for key in ('st_dev','st_ino'))))
            stack.enter_context(patch.object(a.Host,'inventory',return_value=inventory))
            stack.enter_context(patch.object(a.Host,'show',return_value='LoadState=loaded\nActiveState=active\nSubState=running\nMainPID='+str(os.getpid())+'\nControlPID=0\nJob=\nControlGroup=/test\n'))
            stack.enter_context(patch.object(a.Host,'runtime_node',side_effect=lambda:calls.append('node')))
            stack.enter_context(patch.object(a.sqlite3,'connect',side_effect=AssertionError('live database must not be opened')))
            request={'backup':{'sha256':a.digest(archive),'receiptRun':'123','storeSha':'d'*40,'storeId':1}}
            with a.locked_materialization_facts(request) as (facts,recheck):
                self.assertEqual(facts['oldSha'],k.LIVE_SHA);self.assertEqual(facts['database'],str(database));recheck()
            self.assertEqual(calls[0],'lock');self.assertEqual(calls[-1],'unlock')
            self.assertEqual(calls.count('runtime'),3)
            with self.assertRaises(ValueError):
                with a.locked_materialization_facts(request) as (_,recheck):
                    env.write_text(env.read_text()+'CHANGED=true\n');recheck()

class MaterializationTests(unittest.TestCase):
    def setUp(self):
        import materialize_plan as m
        import contracts as k
        self.m,self.k=m,k
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.state=self.root/'state';self.state.mkdir()
        self.runtime=self.root/'runtime';self.runtime.mkdir()
        self.contract=k.read_json(k.HERE/'source-contracts.json')
        raw=k.canonical(self.contract);contract_hash=__import__('hashlib').sha256(raw).hexdigest()
        self.package_id=k.object_digest({'adapterFiles':{},'sourceContractSha256':contract_hash})
        self.package=self.state/'packages'/self.package_id;self.package.mkdir(parents=True);self.package.chmod(0o755)
        (self.package/'source-contracts.json').write_bytes(raw)
        (self.state/'plans').mkdir(mode=0o700)
        private=self.state/'rehearsal-evidence'/'123-1';private.mkdir(parents=True,mode=0o700)
        preimage=private/'preimage.sqlite';preimage.write_bytes(b'private copy');preimage.chmod(0o600)
        bindings={label:{'commit':self.contract['profiles'][profile]['publicationCommit'],'tree':self.contract['profiles'][profile]['appInputGitTree']} for label,profile in zip(('candidate','fallback'),k.PROFILE_NAMES)}
        pair={}
        for label,row in bindings.items():
            release=self.state/'releases'/row['commit'];release.mkdir(parents=True);(release/'.release-sha').write_text(row['commit'])
            pair[label]={'sha':row['commit'],'tree':row['tree'],'runtime':{'releaseSha':row['commit']},'dependencies':{'test':'deps'}}
        evidence={'schema':'bubblewash-inactive-preparation/v1','operation':'123-1','liveSha':k.LIVE_SHA,
                  'maintenanceApproval':False,'sourceContractSha256':contract_hash,'preimageSha256':k.digest(preimage),'pair':pair}
        evidence_path=private/'evidence.json';evidence_path.write_bytes(k.canonical(evidence));evidence_path.chmod(0o600)
        owner={'schema':'bubblewash-owner-pair-review/v1','candidateSha':bindings['candidate']['commit'],'fallbackSha':bindings['fallback']['commit'],
               'ownerFiles':self.contract['ownerFiles'],'ownerCapabilityPreserved':True,'MFAPreserved':True,'enrollmentCompatible':True,'reviewReference':'e'*64}
        operator={'schema':'bubblewash-operator-approval/v1','candidateSha':bindings['candidate']['commit'],'fallbackSha':bindings['fallback']['commit'],
                  'riskApprovalSha256':'a'*64,'residualAssumptionSha256':k.RESIDUAL_ASSUMPTION_SHA256,'approved':True,'reviewReference':'f'*64}
        self.request={'packageId':self.package_id,'preparationRunId':'123','preparationEvidenceSha256':k.digest(evidence_path),
                      'ownerEvidenceSha256':k.object_digest(owner),'operatorApprovalSha256':k.object_digest(operator),'riskApprovalSha256':'a'*64,
                      'gitBindings':bindings,'backup':{'sha256':'b'*64,'receiptRun':'124','storeSha':'c'*40,'storeId':1},'reviewRecords':{'owner':owner,'operator':operator}}
        self.calls=[]
        @contextlib.contextmanager
        def facts(*_,**__):
            self.calls.append('locked')
            value={key:'fixture' for key in ('old','current','marker','database')}
            value.update(oldSha=k.LIVE_SHA,state=str(self.state),databaseIdentity=[1,2],node={'path':'node','sha256':'1'*64},guards={},units={},
                         knownInvokersSha256='2'*64,hostMachineIdSha256='3'*64,bootId='boot',issuedAt=100,expiresAt=200)
            yield value,lambda:self.calls.append('recheck')
            self.calls.append('unlocked')
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        for obj,key,value in [(m,'HERE',self.package),(a,'STATE',self.state),(a,'RUNTIME',self.runtime)]:
            self.stack.enter_context(patch.object(obj,key,value))
        self.stack.enter_context(patch.object(a.os,'geteuid',return_value=0))
        self.stack.enter_context(patch.object(m,'protected_directory',side_effect=lambda p:self.assertTrue(Path(p).is_dir())))
        self.stack.enter_context(patch.object(a,'protected',return_value=()))
        self.stack.enter_context(patch.object(a,'adapter_manifest',return_value={}))
        self.stack.enter_context(patch.object(m,'verify_source',return_value=True))
        self.stack.enter_context(patch.object(m,'runtime_manifest',side_effect=lambda root,sha:{'releaseSha':sha}))
        self.stack.enter_context(patch.object(m,'dependency_manifest',return_value={'test':'deps'}))
        preparation=types.SimpleNamespace(__source_sha256__=k.PREPARATION_HELPER_SHA256,source_files=lambda root,*_:bindings['candidate' if root.name==bindings['candidate']['commit'] else 'fallback']['tree'],git_tree=lambda x:x)
        self.stack.enter_context(patch.dict(sys.modules,{'integration_preparation':preparation}))
        self.stack.enter_context(patch.object(a,'locked_materialization_facts',side_effect=facts))
        def validate(plan,host=True):
            self.calls.append('validate')
            self.assertTrue(host);self.assertEqual(plan['oldSha'],k.LIVE_SHA)
            self.assertEqual(k.digest(plan['ownerEvidencePath']),self.request['ownerEvidenceSha256'])
            self.assertEqual(k.digest(plan['hostAcceptance']['operatorReceipt']),plan['hostAcceptance']['operatorReceiptSha256'])
            return True
        self.stack.enter_context(patch.object(a,'validate_plan',side_effect=validate))

    def test_writes_private_records_then_plan_under_same_lock_and_refuses_retry(self):
        result=self.m.materialize_prepared(self.request)
        self.assertEqual(result['status'],'plan-materialized');self.assertFalse(result['productionChanged'])
        plan=self.state/'plans'/(self.package_id+'.json')
        self.assertEqual(result['planSha256'],self.k.digest(plan))
        self.assertEqual(plan.stat().st_mode & 0o777,0o600)
        for path in (self.state/'plans'/self.package_id).iterdir():self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertEqual(self.calls,['locked','recheck','validate','recheck','unlocked'])
        before=plan.read_bytes()
        with self.assertRaises(ValueError):self.m.materialize_prepared(self.request)
        self.assertEqual(plan.read_bytes(),before)

    def test_missing_review_or_changed_preimage_refuses_without_plan(self):
        import copy
        bad=copy.deepcopy(self.request);bad['reviewRecords']['operator']['approved']=False
        with self.assertRaises(ValueError):self.m.materialize_prepared(bad)
        preimage=self.state/'rehearsal-evidence'/'123-1'/'preimage.sqlite';preimage.write_bytes(b'changed')
        with self.assertRaises(ValueError):self.m.materialize_prepared(self.request)
        self.assertFalse((self.state/'plans'/(self.package_id+'.json')).exists());self.assertEqual(self.calls,[])

    def test_transition_appearing_at_lock_acquisition_refuses_without_writes(self):
        @contextlib.contextmanager
        def raced(*_,**__):
            (self.state/'transition.json').write_text('{}')
            yield {},lambda:None
        with patch.object(a,'locked_materialization_facts',side_effect=raced):
            with self.assertRaisesRegex(ValueError,'appeared'):
                self.m.materialize_prepared(self.request)
        self.assertFalse((self.state/'plans'/self.package_id).exists())

    def test_untrusted_preparation_module_refused_before_lock(self):
        with patch.dict(sys.modules,{'integration_preparation':types.SimpleNamespace(__source_sha256__='0'*64)}):
            with self.assertRaisesRegex(ValueError,'authenticated preparation'):
                self.m.materialize_prepared(self.request)
        self.assertEqual(self.calls,[])
        self.assertFalse((self.state/'plans'/self.package_id).exists())

    def test_expired_bound_recheck_refuses_before_writes(self):
        original=a.locked_materialization_facts.side_effect
        @contextlib.contextmanager
        def expired(*args,**kwargs):
            with original(*args,**kwargs) as (facts,_):
                def refuse():raise ValueError('materialization observation expired')
                yield facts,refuse
        with patch.object(a,'locked_materialization_facts',side_effect=expired):
            with self.assertRaisesRegex(ValueError,'expired'):
                self.m.materialize_prepared(self.request)
        self.assertFalse((self.state/'plans'/self.package_id).exists())

    def test_mid_lock_runtime_drift_refuses_before_plan(self):
        calls=[]
        def image(root,sha):
            calls.append(sha)
            return {'releaseSha':sha} if len(calls)<=2 else {'releaseSha':sha,'changed':True}
        with patch.object(self.m,'runtime_manifest',side_effect=image):
            with self.assertRaisesRegex(ValueError,'runtime/dependencies changed'):
                self.m.materialize_prepared(self.request)
        self.assertFalse((self.state/'plans'/(self.package_id+'.json')).exists())
        self.assertFalse((self.state/'plans'/self.package_id).exists())

    def test_mid_lock_control_package_drift_refuses_before_plan(self):
        calls=[]
        def image():
            calls.append(1)
            return {} if len(calls)<=2 else {'changed':'1'*64}
        with patch.object(a,'adapter_manifest',side_effect=image):
            with self.assertRaisesRegex(ValueError,'control package changed'):
                self.m.materialize_prepared(self.request)
        self.assertFalse((self.state/'plans'/(self.package_id+'.json')).exists())

    def test_post_review_dependency_drift_preserves_records_but_no_plan(self):
        calls=[]
        def deps(root):
            calls.append(root)
            return {'test':'deps'} if len(calls)<=4 else {'test':'changed'}
        with patch.object(self.m,'dependency_manifest',side_effect=deps):
            with self.assertRaisesRegex(ValueError,'runtime/dependencies changed'):
                self.m.materialize_prepared(self.request)
        self.assertFalse((self.state/'plans'/(self.package_id+'.json')).exists())
        self.assertTrue((self.state/'plans'/self.package_id/'owner-review.json').exists())


class NodeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.current=self.root/'current';self.current.mkdir()
        self.proc=self.root/'proc';self.proc.mkdir();self.process=self.proc/'123';self.process.mkdir()
        self.binary=self.root/'node';self.binary.write_bytes(b'public synthetic Node binary');self.binary.chmod(0o755)
        (self.process/'stat').write_text('123 (node) S '+' '.join(['0']*18+['99']+['0']*20))
        (self.process/'exe').symlink_to(self.binary);(self.process/'cwd').symlink_to(self.current)
        # Parent directories are a synthetic /tmp fixture, not host-protected.
        # Keep the exact protected-file call and test its rejection separately.
        self.protected=patch.object(a,'protected',side_effect=lambda p,**kw:(self.assertEqual(kw,{'owner':0,'parents':True}) or (Path(p).stat().st_dev,Path(p).stat().st_ino)))
        self.protected.start();self.addCleanup(self.protected.stop)

    def test_public_node_pin_only_and_stable_recheck(self):
        result,check=a.inspect_node_process('123',self.current,os.getuid(),self.proc)
        self.assertEqual(result,{'path':str(self.binary),'sha256':a.digest(self.binary)})
        self.assertTrue(check());self.assertEqual(set(result),{'path','sha256'})
        self.assertFalse((self.process/'cmdline').exists());self.assertFalse((self.process/'environ').exists())

    def test_pid_reuse_binary_replacement_and_cwd_change_are_refused(self):
        for change in ('pid','binary','cwd'):
            with self.subTest(change=change):
                result,check=a.inspect_node_process('123',self.current,os.getuid(),self.proc)
                original=(self.process/'stat').read_text()
                if change=='pid':(self.process/'stat').write_text(original.replace('99','100'))
                elif change=='binary':self.binary.write_bytes(b'replaced')
                else:(self.process/'cwd').unlink();(self.process/'cwd').symlink_to(self.root)
                with self.assertRaises(ValueError):check()
                if change=='pid':(self.process/'stat').write_text(original)
                elif change=='binary':self.binary.write_bytes(b'public synthetic Node binary')
                else:(self.process/'cwd').unlink();(self.process/'cwd').symlink_to(self.current)

    def test_protection_wrong_owner_and_non_node_are_refused(self):
        with patch.object(a,'protected',side_effect=ValueError('unsafe binary')):
            with self.assertRaises(ValueError):a.inspect_node_process('123',self.current,os.getuid(),self.proc)
        with self.assertRaises(ValueError):a.inspect_node_process('123',self.current,os.getuid()+1,self.proc)
        other=self.root/'unrecognized';other.write_bytes(b'other')
        (self.process/'exe').unlink();(self.process/'exe').symlink_to(other)
        with self.assertRaises(ValueError):a.inspect_node_process('123',self.current,os.getuid(),self.proc)
        for pid in ('0','1','abc','-2'):
            with self.assertRaises(ValueError):a.inspect_node_process(pid,self.current,os.getuid(),self.proc)
