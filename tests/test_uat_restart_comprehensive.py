"""Comprehensive diagnostic privacy and typed evidence, entirely synthetic."""
from contextlib import ExitStack
import copy
import importlib.util
import json
import itertools
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('comprehensive_review',ROOT/'ops/uat/single-restart.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
d=s.d
NAMES=(*s.EMPTY,*s.FIXED,'Requires','Wants','Conflicts')

class Comprehensive(unittest.TestCase):
    def setUp(self):
        self.rows={**{name:'' for name in s.EMPTY},**s.FIXED,'Requires':'sysinit.target system.slice','Wants':'tmp.mount','Conflicts':'shutdown.target'}
        self.overrides={};self.calls=[]
        self.bundle={name:(ROOT/name).read_text() for name in s.REMOTE_FILES}
    def command(self,args,limit):
        self.calls.append(args)
        self.assertEqual(limit,65536)
        key=args[-1]
        if args[0]=='/usr/bin/systemctl':key='loaded'
        if key in self.overrides:
            value=self.overrides[key]
            if isinstance(value,Exception):raise value
            return value
        if key=='loaded':return '\n'.join(name+'='+value for name,value in self.rows.items())
        if '--xml-interface' in args:
            return '<node><interface name="'+d.UNIT+'">'+''.join('<property name="'+name+'" type="as" access="read"/>' for name in d.UNIT_PROPERTIES)+'</interface></node>'
        if key in d.UNIT_PROPERTIES:return 'as 0'
        if key=='Version':return 's "249.11-0ubuntu3"'
        if key=='ExecStart':return shlex.join(['a(sasbttttuii)','1',s.ARGV[0],str(len(s.ARGV)),*s.ARGV,'false',*['0']*7])
        return 'a(sasbttttuii) 0'
    def run_probe(self,collect=None,loaded=None,quiet=None,dep=None):
        with mock.patch.object(s.c,'command',side_effect=self.command),mock.patch.object(s.c,'collect_restart_isolation',side_effect=collect or [{'private':'canary'},{'private':'canary'}]) as isolation:
            loaded=mock.Mock(side_effect=loaded or [{'path':'canary'},{'path':'canary'}])
            quiet=mock.Mock(side_effect=quiet)
            dependency=mock.Mock(side_effect=dep or (lambda name:{'LoadState':'loaded'}))
            value=d.collect(s.c,s.p,s.EMPTY,s.FIXED,s.DEPENDENCIES,s.ARGV,loaded,quiet,dependency,{})
            d.validate(value,NAMES,s.DEPENDENCIES,s.require)
            self.assertNotIn('canary',json.dumps(value));self.assertNotIn('/private',json.dumps(value))
            self.assertTrue(all(call.kwargs=={'before_restart':True} for call in isolation.call_args_list))
            return value,dependency,quiet
    def test_all_independent_checks_and_typed_exact_arrays(self):
        value,dep,quiet=self.run_probe()
        self.assertEqual(value['loadedSchema'],'complete');self.assertEqual(value['hooks']['ExecStart'],'match')
        self.assertEqual(value['hooks']['ExecCondition'],'empty');self.assertEqual(value['version'],'249-250')
        self.assertEqual(value['unitInterface'],dict.fromkeys(d.UNIT_PROPERTIES,'supported'))
        self.assertEqual(value['isolationStability'],'stable');self.assertEqual(value['loadedStability'],'stable')
        self.assertEqual([call.args[0] for call in dep.call_args_list],list(s.DEPENDENCIES));quiet.assert_called_once()
    def test_missing_empty_fixed_dependency_rules_and_no_dynamic_names(self):
        self.rows.pop('ExecStartPre');self.rows['ExecStop']='password-canary';self.rows['Type']='password-canary'
        self.rows['Requires']='sysinit.target system.slice malicious-canary.service';self.rows['Wants']='tmp.mount tmp.mount'
        value,dep,_=self.run_probe()
        for name,outcome in (('ExecStartPre','missing'),('ExecStop','nonempty'),('Type','mismatch'),('Requires','mismatch'),('Wants','mismatch')):
            self.assertEqual(value['properties'][name],outcome)
        self.assertEqual(value['loadedSchema'],'missing')
        self.assertEqual([call.args[0] for call in dep.call_args_list],list(s.DEPENDENCIES))
        self.assertNotIn('canary',json.dumps(self.calls))
    def test_wants_fixed_membership_without_host_names(self):
        for required,wanted,match,outside,unknown in (
            ('sysinit.target system.slice','sysinit.target system.slice tmp.mount','match','absent','absent'),
            ('sysinit.target system.slice -.mount','-.mount','match','absent','absent'),
            ('sysinit.target system.slice','-.mount','mismatch','present','absent'),
            ('sysinit.target system.slice canary.service','canary.service','mismatch','present','present'),
            ('sysinit.target system.slice','sysinit.target sysinit.target','mismatch','absent','absent')):
            self.rows.update(Requires=required,Wants=wanted)
            value,_,_=self.run_probe()
            self.assertEqual(value['properties']['Wants'],match)
            self.assertEqual(value['wantsMembership']['unknown'],unknown)
            self.assertEqual(value['wantsMembership']['duplicate'],'present' if len(wanted.split())!=len(set(wanted.split())) else 'absent')
            self.assertEqual(value['wantsMembership']['outsideValidatedRequired'],outside)
            for name in s.DEPENDENCIES:self.assertEqual(value['wantsMembership'][name],'present' if name in wanted.split() else 'absent')
    def test_unknown_duplicate_and_malformed_rows_never_export_names_or_values(self):
        for suffix,outcome in (('\n/private/canary=secret','unexpected'),('\nType=canary','duplicate'),('\ncanary','malformed')):
            self.overrides['loaded']='\n'.join(k+'='+v for k,v in self.rows.items())+suffix
            value,_,_=self.run_probe();self.assertEqual(value['loadedSchema'],outcome)
            self.assertEqual(set(value['properties'].values()),{'unavailable'})
    def test_execcondition_nonempty_malformed_wrong_types_and_failed_probes(self):
        nonempty='a(sasbttttuii) 1 "/private/canary" 1 "password-canary" false 0 0 0 0 0 0 0'
        for raw,outcome in ((nonempty,'nonempty'),('a(sasbttttuii) 0 canary','malformed'),('as 0','malformed'),('a(sasbttttuii) true','malformed'),(ValueError('password-canary'),'read-failed')):
            self.overrides['ExecCondition']=raw
            value,_,_=self.run_probe();self.assertEqual(value['hooks']['ExecCondition'],outcome)
        for raw in ('a(sasbttttuii) 1','a(sasbttttuii) 129','a(sasbttttuii) -1',nonempty.replace('false','0'),nonempty+' canary',nonempty.replace('false 0','false '+str(2**64))):
            with self.subTest(raw=raw),self.assertRaises((ValueError,IndexError)):d.exec_array(raw,None)
    def test_failed_probes_do_not_skip_other_independent_checks(self):
        self.overrides['loaded']=ValueError('canary');self.overrides['ExecStart']=ValueError('canary')
        value,dep,quiet=self.run_probe(collect=[ValueError('canary'),{}],loaded=[{},ValueError('canary')],quiet=ValueError('canary'),dep=ValueError('canary'))
        self.assertEqual(value['loadedSchema'],'read-failed');self.assertEqual(value['quiescence'],'failed')
        self.assertEqual(value['isolationStability'],'unavailable');self.assertEqual(value['loadedStability'],'unavailable')
        self.assertEqual(dep.call_count,4);quiet.assert_called_once()
    def test_dependency_outcomes_and_stability_changes(self):
        states=iter(['loaded','loaded','masked','not-found'])
        value,_,_=self.run_probe(collect=[{}, {'changed':'canary'}],loaded=[{}, {'changed':'canary'}],dep=lambda name:{'LoadState':next(states)})
        self.assertEqual(list(value['dependencies'].values()),['active','active','masked-inert','missing-inert'])
        self.assertEqual(value['isolationStability'],'changed');self.assertEqual(value['loadedStability'],'changed')
    def test_unsupported_interface_does_not_get_version_assumed_success(self):
        self.overrides[d.UNIT]='<node><interface name="'+d.UNIT+'"/></node>'
        self.overrides['Upholds']=ValueError('unsupported-canary')
        value,_,_=self.run_probe();self.assertEqual(value['unitInterface']['Upholds'],'absent')
        self.assertEqual(value['unitArrays']['Upholds'],'read-failed')
        for raw,expected in (('s "248"','pre-249'),('s "250"','249-250'),('s "251"','251-plus'),('s "password-canary"','unrecognized'),('u 249','unrecognized')):
            self.overrides['Version']=raw;value,_,_=self.run_probe();self.assertEqual(value['version'],expected)
    def test_budget_skips_without_invocations_or_false_stability(self):
        with mock.patch.object(d.time,'monotonic',side_effect=itertools.count(0,41)),mock.patch.object(s.c,'command') as command:
            value=d.collect(s.c,s.p,s.EMPTY,s.FIXED,s.DEPENDENCIES,s.ARGV,mock.Mock(),mock.Mock(),mock.Mock(),{})
        expected=d.blank(NAMES,s.DEPENDENCIES);expected['collection']='partial'
        self.assertEqual(value,expected);command.assert_not_called()
    def test_nested_timeout_interrupts_and_restores_existing_alarm(self):
        captured={}
        def handler(sig,fn):captured['handler']=fn
        def command(*args,**kwargs):captured['handler'](None,None)
        with mock.patch.object(d.signal,'getitimer',return_value=(100,0)),mock.patch.object(d.signal,'getsignal',return_value='original'),mock.patch.object(d.signal,'signal',side_effect=handler) as handlers,mock.patch.object(d.signal,'setitimer') as timers,mock.patch.object(s.c,'command',side_effect=command) as calls:
            value=d.collect(s.c,s.p,s.EMPTY,s.FIXED,s.DEPENDENCIES,s.ARGV,mock.Mock(),mock.Mock(),mock.Mock(),{})
        self.assertEqual(calls.call_count,1);self.assertEqual(value['collection'],'partial')
        self.assertEqual(value['loadedSchema'],'skipped');self.assertEqual(value['isolationStability'],'unavailable')
        self.assertEqual(handlers.call_args.args,(d.signal.SIGALRM,'original'))
        self.assertEqual(timers.call_args_list[0].args,(d.signal.ITIMER_REAL,40))
        self.assertGreater(timers.call_args.args[1],99)

    def test_near_expired_host_budget_does_not_probe(self):
        with mock.patch.object(d.signal,'getitimer',return_value=(.5,0)),mock.patch.object(s.c,'command') as command,mock.patch.object(d.signal,'setitimer') as timers:
            value=d.collect(s.c,s.p,s.EMPTY,s.FIXED,s.DEPENDENCIES,s.ARGV,mock.Mock(),mock.Mock(),mock.Mock(),{})
        self.assertEqual(value['collection'],'partial');command.assert_not_called();timers.assert_not_called()

    def test_dependency_failures_only_export_reviewed_statement_tokens(self):
        sites=s.diagnostic_sites(self.bundle);line=next(iter(sites[s.SELF]));token=sites[s.SELF][line]
        code=compile('\n'*(line-1)+'raise ValueError("password-canary /private/path")',s.SELF,'exec')
        def fail(name):exec(code,{})
        with mock.patch.object(s.c,'command',side_effect=self.command),mock.patch.object(s.c,'collect_restart_isolation',return_value={}):
            value=d.collect(s.c,s.p,s.EMPTY,s.FIXED,s.DEPENDENCIES,s.ARGV,lambda:{},lambda:None,fail,{},sites)
        self.assertEqual(value['dependencySites'],dict.fromkeys(s.DEPENDENCIES,[token]))
        d.validate(value,NAMES,s.DEPENDENCIES,s.require,{token})
        self.assertNotIn('canary',json.dumps(value));self.assertNotIn('/private',json.dumps(value))
        for bad in (None,True,[True],['canary'],[token]*9):
            broken=copy.deepcopy(value);broken['dependencySites']['tmp.mount']=bad
            with self.assertRaises(ValueError):d.validate(broken,NAMES,s.DEPENDENCIES,s.require,{token})
        value['dependencySites']['canary']=[]
        with self.assertRaises(ValueError):d.validate(value,NAMES,s.DEPENDENCIES,s.require,{token})

    def test_closed_schema_unknown_keys_values_booleans_and_false_stability(self):
        valid=d.blank(NAMES,s.DEPENDENCIES)
        for group in (None,*d.GROUPS):
            for bad in (True,False,0,1,None,{},'canary'):
                value=copy.deepcopy(valid)
                if group:value[group][next(iter(value[group]))]=bad
                else:value['version']=bad
                with self.assertRaises(ValueError):d.validate(value,NAMES,s.DEPENDENCIES,s.require)
            value=copy.deepcopy(valid)
            (value[group] if group else value)['canary']='skipped'
            with self.assertRaises(ValueError):d.validate(value,NAMES,s.DEPENDENCIES,s.require)
        value=copy.deepcopy(valid);value['isolationStability']='stable'
        with self.assertRaises(ValueError):d.validate(value,NAMES,s.DEPENDENCIES,s.require)
    def test_helper_is_exact_source_verified_and_restore_payload_unchanged(self):
        full={name:(ROOT/name).read_text() for name in s.t.SOURCE_FILES}
        self.assertNotIn(d.SELF,full)
        s.t.remote_command(full)  # Original restore bootstrap must retain both size caps.
        request={'mode':'inspect','operationId':'e01f1a5d-3297-4c22-b246-7bdb509289ca'}
        def source(args,**kwargs):
            name=args[-1].split(':',1)[1]
            return b'tampered' if name==d.SELF else (ROOT/name).read_bytes()
        with mock.patch.object(s,'context',return_value=request),mock.patch.object(s.t,'source_bundle',return_value=full),mock.patch.object(s.subprocess,'check_output',side_effect=source),mock.patch.object(s.t,'exchange') as exchange:
            with self.assertRaises(ValueError):s.perform(ROOT,{'SOURCE_SHA':'a'*40})
            exchange.assert_not_called()

    def test_missing_or_symlink_helper_is_refused_before_exchange(self):
        request={'mode':'inspect','operationId':'e01f1a5d-3297-4c22-b246-7bdb509289ca'}
        for symlink in (False,True):
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory);(root/s.SELF).parent.mkdir(parents=True)
                (root/s.SELF).write_bytes((ROOT/s.SELF).read_bytes())
                if symlink:(root/d.SELF).symlink_to(ROOT/d.SELF)
                with mock.patch.object(s,'context',return_value=request),mock.patch.object(s.t,'source_bundle',return_value={}),mock.patch.object(s.subprocess,'check_output',return_value=(ROOT/s.SELF).read_bytes()),mock.patch.object(s.t,'exchange') as exchange:
                    with self.assertRaises((ValueError,FileNotFoundError)):s.perform(root,{'SOURCE_SHA':'a'*40})
                    exchange.assert_not_called()

    def test_enrichment_failure_preserves_strict_receipt(self):
        for failure in (ValueError('password-canary'),{'unknown':'password-canary'}):
            with mock.patch.object(s,'strict_inspection',return_value=s.inspection_receipt('loaded-unit')),mock.patch.object(d,'collect',side_effect=failure if isinstance(failure,Exception) else None,return_value=failure):
                value=s.inspect_prechecks(self.bundle,{})
            self.assertEqual(value['failureStage'],'loaded-unit');self.assertFalse(value['ok']);self.assertFalse(value['precheckPassed'])
            self.assertEqual(value['diagnostics']['collection'],'unavailable');self.assertNotIn('canary',json.dumps(value))

    def test_enrichment_never_changes_strict_failure_or_invokes_actions(self):
        receipt=s.inspection_receipt('loaded-unit')
        diagnostic,_,_=self.run_probe()
        with mock.patch.object(s,'strict_inspection',return_value=receipt),mock.patch.object(d,'collect',return_value=diagnostic),mock.patch.object(s,'execute') as execute,mock.patch.object(s,'health') as health,mock.patch.object(s.t,'exchange') as exchange:
            value=s.inspect_prechecks(self.bundle,{})
        self.assertEqual(value['failureStage'],'loaded-unit');self.assertFalse(value['precheckPassed']);self.assertFalse(value['ok'])
        execute.assert_not_called();health.assert_not_called();exchange.assert_not_called()
        self.assertLess(len(json.dumps(value).encode()),16384)

if __name__=='__main__':unittest.main()
