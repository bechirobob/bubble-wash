"""Pure exact-source checks, also streamed to the host before enrollment code.

These profiles cover only the separately reviewed 5dc997 website integration
and owner-aware fallback. They never extend the historical deployment guard.
No host inspection, accounts, provider calls or runtime changes occur here.
"""
import hashlib
import json
from pathlib import Path
import stat

HISTORICAL_ENROLLMENT_CONTRACT = 'historical-owner-v1'
INTEGRATION_ENROLLMENT_PROFILE_SHA256 = {
    'integration-candidate-v1': 'c8353b945e2f839d425c1cb361e528928ea909f458f043c04fcf499201d7b8b6',
    'integration-fallback-v1': 'f3ead9e67ea7f03b640c0bb7d7b9981ab52df48e443bcb06f773b702df178d5a',
}
ENROLLMENT_COMPLETE_SOURCE_ROOTS = ('src', 'public', 'db')


def integration_enrollment_profile_valid(profile, source_contract):
    if not isinstance(source_contract, str):
        return False
    expected = INTEGRATION_ENROLLMENT_PROFILE_SHA256.get(source_contract)
    if expected is None or not isinstance(profile, dict) or profile.get('sourceContract') != source_contract:
        return False
    try:
        encoded = json.dumps(profile, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    except (TypeError, ValueError):
        return False
    return hashlib.sha256(encoded).hexdigest() == expected


def load_integration_enrollment_profile(contract, source_contract):
    """Reject unknown, missing, combined or edited profiles before emitting stdin."""
    if not isinstance(contract, dict) or set(contract) != {'schema', 'profiles'} or contract.get('schema') != 'bubblewash-owner-enrollment-integration/v1':
        raise ValueError('Unreviewed owner enrollment source contract.')
    profiles = contract.get('profiles')
    if not isinstance(profiles, dict) or set(profiles) != set(INTEGRATION_ENROLLMENT_PROFILE_SHA256):
        raise ValueError('Unreviewed owner enrollment source contract.')
    if source_contract not in profiles or not all(integration_enrollment_profile_valid(profile, name) for name, profile in profiles.items()):
        raise ValueError('Unreviewed owner enrollment source contract.')
    return profiles[source_contract]


def integration_enrollment_source_matches(release, profile, source_contract):
    """Match one entire pinned combination; never a per-file digest allowlist."""
    if not integration_enrollment_profile_valid(profile, source_contract):
        return False
    try:
        release = Path(release)
        if release.resolve(strict=True) != release or not release.is_dir():
            return False
        pins = profile['sourceFiles']
        for relative, expected in pins.items():
            relative_path = Path(relative)
            if relative_path.is_absolute() or '..' in relative_path.parts:
                return False
            path = release / relative_path
            # Reject links at every component, not just the final pinned file.
            if any(part.is_symlink() for part in (path, *path.parents) if part != release and part.is_relative_to(release)):
                return False
            if not stat.S_ISREG(path.lstat().st_mode) or not path.resolve(strict=True).is_relative_to(release):
                return False
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                return False
        for name in ENROLLMENT_COMPLETE_SOURCE_ROOTS:
            directory = release / name
            if directory.is_symlink() or not directory.is_dir():
                return False
            actual = set()
            for path in directory.rglob('*'):
                mode = path.lstat().st_mode
                if stat.S_ISDIR(mode):
                    continue
                if not stat.S_ISREG(mode):
                    return False
                actual.add(path.relative_to(release).as_posix())
            if actual != {relative for relative in pins if relative.startswith(name + '/')}:
                return False
        return True
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        return False
