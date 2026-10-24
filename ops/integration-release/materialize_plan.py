#!/usr/bin/env python3
"""Bind reviewed records and successful private rehearsal to one protected plan.

No live SQLite opens, service actions, holds or source/dependency installation.
A partial write is retained and refused on retry; it is never overwritten.
"""
import copy
import os
from pathlib import Path
import re
import stat
import sys
sys.dont_write_bytecode = True
from contracts import (HERE, LIVE_SHA, PROFILE_NAMES, canonical, digest, read_json, require,
                       verify_source, dependency_manifest, runtime_manifest, object_digest,
                       COORDINATED_UNITS, RESIDUAL_ASSUMPTION_SHA256, PREPARATION_HELPER_SHA256)
import host_adapter as adapter


def hex_value(value, size=64):
    return type(value) is str and re.fullmatch('[a-f0-9]{'+str(size)+'}', value) is not None


def validate_materialization_request(request, contract):
    fields = {'packageId','preparationRunId','preparationEvidenceSha256','ownerEvidenceSha256',
              'operatorApprovalSha256','riskApprovalSha256','gitBindings','backup','reviewRecords'}
    require(type(request) is dict and set(request) == fields, 'invalid materialization request fields')
    for key in fields-{'preparationRunId','gitBindings','backup','reviewRecords'}:
        require(hex_value(request[key]), 'invalid materialization digest')
    require(type(request['preparationRunId']) is str and re.fullmatch('[1-9][0-9]{0,19}',request['preparationRunId']), 'invalid preparation run')
    bindings=request['gitBindings']
    require(type(bindings) is dict and set(bindings)=={'candidate','fallback'}, 'missing clean Git bindings')
    for label, profile in zip(('candidate','fallback'), PROFILE_NAMES):
        expected=contract['profiles'][profile]
        require(bindings[label]=={'commit':expected['publicationCommit'],'tree':expected['appInputGitTree']}, 'runtime Git binding differs')
    backup=request['backup']
    require(type(backup) is dict and set(backup)=={'sha256','receiptRun','storeSha','storeId'} and
            hex_value(backup['sha256']) and hex_value(backup['storeSha'],40) and
            type(backup['receiptRun']) is str and re.fullmatch('[1-9][0-9]{0,19}',backup['receiptRun']) and
            type(backup['storeId']) is int and backup['storeId']>0, 'invalid backup binding')
    records=request['reviewRecords']
    require(type(records) is dict and set(records)=={'owner','operator'}, 'both review records required')
    owner,operator=records['owner'],records['operator']
    require(type(owner) is dict and set(owner)=={'schema','candidateSha','fallbackSha','ownerFiles',
            'ownerCapabilityPreserved','MFAPreserved','enrollmentCompatible','reviewReference'}, 'invalid owner review')
    require(owner['schema']=='bubblewash-owner-pair-review/v1' and owner['ownerFiles']==contract['ownerFiles'] and
            all(owner[key] is True for key in ('ownerCapabilityPreserved','MFAPreserved','enrollmentCompatible')) and
            hex_value(owner['reviewReference']), 'owner compatibility review incomplete')
    require(type(operator) is dict and set(operator)=={'schema','candidateSha','fallbackSha','riskApprovalSha256',
            'residualAssumptionSha256','approved','reviewReference'}, 'invalid operator review')
    require(operator['schema']=='bubblewash-operator-approval/v1' and operator['approved'] is True and
            operator['riskApprovalSha256']==request['riskApprovalSha256'] and
            operator['residualAssumptionSha256']==RESIDUAL_ASSUMPTION_SHA256 and
            hex_value(operator['reviewReference']), 'operator residual-risk approval missing')
    for row in (owner,operator):
        require(all(row[label+'Sha']==bindings[label]['commit'] for label in bindings), 'reviewed release pair differs')
    require(object_digest(owner)==request['ownerEvidenceSha256'] and
            object_digest(operator)==request['operatorApprovalSha256'], 'review record digest differs')
    return request


def protected_directory(path):
    path=Path(path)
    require(path.is_absolute() and path.resolve(strict=True)==path, 'noncanonical protected directory')
    for parent in (path,*path.parents):
        info=parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode & 0o022, 'unsafe protected directory')


def private_json(path, expected=None):
    adapter.protected(path, parents=True)
    require(stat.S_IMODE(path.stat().st_mode)==0o600, 'private evidence mode differs')
    if expected is not None:require(digest(path)==expected, 'private evidence digest differs')
    return read_json(path)


def write_private(path, value):
    """Exclusive, non-following create. Retain partial files for explicit recovery."""
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:
        os.fchmod(stream.fileno(),0o600);stream.write(canonical(value));stream.flush();os.fsync(stream.fileno())
    d=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(d)
    finally:os.close(d)


def materialize_prepared(request, guard=None, run=None):
    require(os.geteuid()==0, 'host plan requires root')
    contract=read_json(HERE/'source-contracts.json')
    validate_materialization_request(request,contract)
    package=adapter.STATE/'packages'/request['packageId']
    require(HERE==package, 'selected control package differs')
    require(object_digest({'adapterFiles':adapter.adapter_manifest(),'sourceContractSha256':digest(HERE/'source-contracts.json')})==request['packageId'], 'control package identity differs')
    private=adapter.STATE/'rehearsal-evidence'/(request['preparationRunId']+'-1')
    for folder,mode in ((package,0o755),(private,0o700),(adapter.STATE/'plans',0o700)):
        protected_directory(folder)
        require(stat.S_IMODE(folder.stat().st_mode)==mode, 'protected preparation directory mode differs')
    path=adapter.STATE/'plans'/(request['packageId']+'.json')
    review_dir=adapter.STATE/'plans'/request['packageId']
    owner_path=review_dir/'owner-review.json';operator_path=review_dir/'operator-review.json'
    snapshot=adapter.RUNTIME/('integration-snapshot-'+request['packageId'][:16]+'.sqlite')
    for p in (path,review_dir,owner_path,operator_path,snapshot):require(not os.path.lexists(p),'existing plan/review/snapshot requires inspection')
    require(not os.path.lexists(adapter.STATE/'transition.json'), 'existing transition journal requires inspection')
    evidence_path=private/'evidence.json';preimage=private/'preimage.sqlite'
    evidence=private_json(evidence_path,request['preparationEvidenceSha256'])
    require(evidence.get('schema')=='bubblewash-inactive-preparation/v1' and
            evidence.get('operation')==request['preparationRunId']+'-1' and evidence.get('liveSha')==LIVE_SHA and
            evidence.get('maintenanceApproval') is False and evidence.get('sourceContractSha256')==digest(HERE/'source-contracts.json'),
            'successful preparation evidence differs')
    adapter.protected(preimage,parents=True)
    require(stat.S_IMODE(preimage.stat().st_mode)==0o600 and digest(preimage)==evidence['preimageSha256'], 'preimage changed')
    pair=evidence['pair'];require(set(pair)=={'candidate','fallback'}, 'prepared pair incomplete')
    plan={'schema':'bubblewash-integration-host-plan/v1','sourceContractSha256':digest(HERE/'source-contracts.json'),
          'adapterFiles':adapter.adapter_manifest(),'releaseShas':{},'manifests':{},'dependencies':{},
          'gitBindings':copy.deepcopy(request['gitBindings']),'snapshot':str(snapshot)}
    for label,profile in zip(('candidate','fallback'),PROFILE_NAMES):
        sha=request['gitBindings'][label]['commit'];root=adapter.STATE/'releases'/sha
        require(pair[label]['sha']==sha and pair[label]['tree']==request['gitBindings'][label]['tree'], 'prepared pair identity differs')
        protected_directory(root);adapter.require_no_runtime_cache(root)
        verify_source(root,contract,profile)
        preparation=sys.modules.get('integration_preparation')
        require(preparation is not None and getattr(preparation,'__source_sha256__',None)==PREPARATION_HELPER_SHA256, 'authenticated preparation module missing')
        require(preparation.git_tree(preparation.source_files(root,0,label=='candidate'))==request['gitBindings'][label]['tree'], 'complete prepared source tree differs')
        adapter.protected(root/'.release-sha',parents=True)
        require((root/'.release-sha').read_text().strip()==sha, 'frozen release marker differs')
        runtime=runtime_manifest(root,sha);deps=dependency_manifest(root/'node_modules')
        require(runtime==pair[label]['runtime'] and deps==pair[label]['dependencies'], 'rehearsed runtime/dependency image changed')
        plan[label]=str(root);plan['releaseShas'][label]=sha;plan['manifests'][label]=runtime;plan['dependencies'][label]=deps
    def prepared_unchanged():
        require(digest(HERE/'source-contracts.json')==plan['sourceContractSha256'] and
                adapter.adapter_manifest()==plan['adapterFiles'], 'control package changed')
        require(private_json(evidence_path,request['preparationEvidenceSha256'])==evidence, 'preparation evidence changed')
        adapter.protected(preimage,parents=True)
        require(stat.S_IMODE(preimage.stat().st_mode)==0o600 and digest(preimage)==evidence['preimageSha256'], 'preimage changed')
        preparation=sys.modules.get('integration_preparation')
        require(preparation is not None and getattr(preparation,'__source_sha256__',None)==PREPARATION_HELPER_SHA256,
                'authenticated preparation module missing')
        for label,profile in zip(('candidate','fallback'),PROFILE_NAMES):
            root=Path(plan[label]);sha=plan['releaseShas'][label]
            protected_directory(root);adapter.require_no_runtime_cache(root)
            verify_source(root,contract,profile)
            require(preparation.git_tree(preparation.source_files(root,0,label=='candidate'))==plan['gitBindings'][label]['tree'], 'prepared source tree changed')
            adapter.protected(root/'.release-sha',parents=True)
            require((root/'.release-sha').read_text().strip()==sha, 'prepared release marker changed')
            require(runtime_manifest(root,sha)==plan['manifests'][label] and
                    dependency_manifest(root/'node_modules')==plan['dependencies'][label], 'prepared runtime/dependencies changed')

    plan.update(ownerEvidencePath=str(owner_path),ownerEvidenceSha256=request['ownerEvidenceSha256'],
                ownerContract={'reviewed':True,'evidenceSha256':request['ownerEvidenceSha256'],'files':contract['ownerFiles']})
    with adapter.locked_materialization_facts(request,run=run) as (facts,recheck):
        for p in (path,review_dir,snapshot,adapter.STATE/'transition.json'):
            require(not os.path.lexists(p), 'plan or transition appeared before locked materialization')
        for key in ('old','oldSha','current','marker','state','database','databaseIdentity','node','guards','units'):
            plan[key]=facts[key]
        receipt={key:facts[key] for key in ('hostMachineIdSha256','bootId','issuedAt','expiresAt','knownInvokersSha256')}
        receipt.update(schema='bubblewash-coordinated-operator-review/v1',sourceContractSha256=plan['sourceContractSha256'],
                       riskApprovalSha256=request['riskApprovalSha256'],reviewReference=request['operatorApprovalSha256'],
                       residualAssumptionSha256=RESIDUAL_ASSUMPTION_SHA256)
        plan['hostAcceptance']={'operatorReceipt':str(operator_path),'operatorReceiptSha256':object_digest(receipt),
                               'knownInvokersSha256':facts['knownInvokersSha256'],'riskApprovalSha256':request['riskApprovalSha256'],'launcherAliases':[]}
        plan['coordinatedWriterHold']={'schema':'bubblewash-coordinated-writer-hold/v1','knownUnits':list(COORDINATED_UNITS),
                'knownInvokersSha256':facts['knownInvokersSha256'],'riskApprovalSha256':request['riskApprovalSha256'],
                'residualAccessAcknowledged':True,'residualAssumptionSha256':RESIDUAL_ASSUMPTION_SHA256}
        recheck()
        prepared_unchanged()
        review_dir.mkdir(mode=0o700)
        protected_directory(review_dir)
        write_private(owner_path,request['reviewRecords']['owner'])
        write_private(operator_path,receipt)
        # Keep the actual operator approval record separately from the host receipt.
        write_private(review_dir/'operator-approval.json',request['reviewRecords']['operator'])
        adapter.validate_plan(plan,host=True)
        recheck()
        prepared_unchanged()
        write_private(path,plan)
        return {'ok':True,'status':'plan-materialized','packageId':request['packageId'],'planSha256':digest(path),
                'productionChanged':False,'liveDatabaseWritten':False,'maintenanceApproval':False}
