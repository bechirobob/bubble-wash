#!/usr/bin/env python3
"""Verify fixed reviewed candidate source before any production staging."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('owner_release', ROOT / 'ops/deploy-personal-owner.py')
owner_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner_release)

if __name__ == '__main__':
    owner_release.verify_owner_candidate(ROOT)
    print('Exact reviewed owner source pins match; no account enrollment was performed.')
