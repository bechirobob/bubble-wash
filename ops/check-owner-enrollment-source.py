#!/usr/bin/env python3
"""Read-only validation for one explicitly selected enrollment source contract."""
import argparse
import importlib.util
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
namespace = {'__name__': 'owner_enrollment_contract_check'}
exec(compile((ROOT / 'scripts/owner-enrollment-source-contract.py').read_text(), 'owner-source-contract', 'exec'), namespace)


def check_source(release, source_contract):
    if source_contract == namespace['HISTORICAL_ENROLLMENT_CONTRACT']:
        spec = importlib.util.spec_from_file_location('historical_owner_release', ROOT / 'ops/deploy-personal-owner.py')
        historical = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(historical)
        historical.verify_owner_candidate(release)
        return
    contract = json.loads((ROOT / 'ops/owner-enrollment-integration-pins.json').read_text())
    profile = namespace['load_integration_enrollment_profile'](contract, source_contract)
    if not namespace['integration_enrollment_source_matches'](release, profile, source_contract):
        raise ValueError('Owner enrollment source does not match the selected exact contract.')


def verify_runner_source(release):
    """Runner checkout recognition is separate from the explicit host selector."""
    matches = []
    for source_contract in ['historical-owner-v1', *namespace['INTEGRATION_ENROLLMENT_PROFILE_SHA256']]:
        try:
            check_source(release, source_contract)
            matches.append(source_contract)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    if len(matches) != 1:
        raise ValueError('Runner checkout lacks one exact reviewed source contract.')
    return matches[0]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--source-contract', default='historical-owner-v1',
                        choices=['historical-owner-v1', *namespace['INTEGRATION_ENROLLMENT_PROFILE_SHA256']])
    selection.add_argument('--verify-runner', action='store_true',
                           help='Verify this runner checkout only; does not select a host contract.')
    parser.add_argument('--release', type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        release = Path(os.path.abspath(args.release))
        if args.verify_runner:
            verify_runner_source(release)
        else:
            check_source(release, args.source_contract)
    except (OSError, ValueError, KeyError, TypeError):
        raise SystemExit('Selected owner enrollment source contract did not match; no host action attempted.') from None
    print('Selected exact enrollment source contract matches; no host action or account enrollment was performed.')
