#!/usr/bin/env python3
"""Offline plan materialization only. Does not stage, install, build, or operate services.

Run AFTER the source/adapter pair, real commits, built runtime, installed dependency
bytes, host inventory, gate installation and owner evidence have been reviewed.
The output digest is reviewed explicitly before invoking the manual host route.
"""
import argparse
import sys
import copy
from pathlib import Path
import re
sys.dont_write_bytecode = True
from contracts import (HERE, BASELINE, PROFILE_NAMES, canonical, digest, read_json, require,
                       verify_source, dependency_manifest, git_binding, runtime_manifest)
from host_adapter import adapter_manifest


def materialize(template, git_roots):
    plan = copy.deepcopy(template)
    require(plan['schema'] == 'bubblewash-integration-host-plan/v1' and plan['oldSha'] == BASELINE, 'wrong template baseline')
    contract = read_json(HERE/'source-contracts.json')
    plan['sourceContractSha256'] = digest(HERE/'source-contracts.json')
    plan['adapterFiles'] = adapter_manifest()
    plan['manifests'] = {}
    plan['dependencies'] = {}
    plan['gitBindings'] = {}
    for key, profile in zip(('candidate', 'fallback'), PROFILE_NAMES):
        root = Path(plan[key])
        sha = plan['releaseShas'][key]
        source_root = Path(git_roots[key]).resolve(strict=True)
        verify_source(source_root, contract, profile)
        verify_source(root, contract, profile)
        plan['gitBindings'][key] = git_binding(source_root, sha)
        plan['manifests'][key] = runtime_manifest(root, sha)
        plan['dependencies'][key] = dependency_manifest(root/'node_modules')
        require((root/'.release-sha').read_text().strip() == sha, 'staged release marker differs')
    names = ('src/lib/auth.ts', 'src/lib/admin-mfa.ts', 'src/lib/staff-accounts.ts')
    owner_files = {name: digest(Path(plan['candidate'])/name) for name in names}
    require(all(digest(Path(plan['fallback'])/name) == pin for name,pin in owner_files.items()), 'owner pair differs')
    plan['ownerEvidenceSha256'] = digest(plan['ownerEvidencePath'])
    plan['ownerContract'] = {'reviewed': True, 'evidenceSha256': plan['ownerEvidenceSha256'], 'files': owner_files}
    db = Path(plan['database']).lstat()
    plan['databaseIdentity'] = [db.st_dev, db.st_ino]
    require(plan['node']['sha256'] == digest(plan['node']['path']), 'node pin differs')
    return plan

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', type=Path, required=True)
    parser.add_argument('--candidate-checkout', type=Path, required=True)
    parser.add_argument('--fallback-checkout', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    plan = materialize(read_json(args.template), {'candidate': args.candidate_checkout, 'fallback': args.fallback_checkout})
    with args.output.open('xb') as stream:
        stream.write(canonical(plan)+b'\n')
    print(digest(args.output))
