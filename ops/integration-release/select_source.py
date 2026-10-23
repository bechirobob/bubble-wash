#!/usr/bin/env python3
"""CI-only exact selector; never invokes or widens the historical deploy route."""
import argparse
import importlib.util
from pathlib import Path
import sys
sys.dont_write_bytecode = True
from contracts import HERE, PROFILE_NAMES, read_json, verify_source, require


def select(root, requested=None):
    root = Path(root).resolve(strict=True)
    # Preserve the historical validator byte-for-byte. This route invokes it only
    # for its original candidate, not as a generic permissive fallback.
    source = root/'ops/deploy-personal-owner.py'
    spec = importlib.util.spec_from_file_location('historical_owner_source', source)
    historical = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(historical)
    if requested in (None, 'historical-owner-v1'):
        try:
            historical.verify_owner_candidate(root)
        except ValueError:
            if requested == 'historical-owner-v1':
                raise
        else:
            return 'historical-owner-v1'
    contract = read_json(HERE/'source-contracts.json')
    matches = []
    for profile in PROFILE_NAMES:
        if requested is not None and requested != profile:
            continue
        try:
            verify_source(root, contract, profile)
        except ValueError:
            continue
        matches.append(profile)
    require(len(matches) == 1, 'source matches no unique reviewed integration contract')
    return matches[0]

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--profile', choices=('historical-owner-v1', *PROFILE_NAMES))
    args = parser.parse_args()
    print(select(args.release, args.profile))
