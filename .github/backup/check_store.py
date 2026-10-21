#!/usr/bin/env python3
"""Read-only backup destination preflight. Never log credential values."""
import os
import re

from backup_release import GitHub, STORAGE_REPOSITORY, private_repository, require


def check_store(env, api_factory=GitHub):
    errors = []
    if not env.get('GH_TOKEN', '').strip():
        errors.append('BACKUP_STORE_TOKEN is unavailable to this job; check the backup-storage environment and Actions secret scope')
    if not re.fullmatch(r'[a-f0-9]{40}', env.get('BACKUP_STORE_SHA', '')):
        errors.append('BACKUP_STORE_SHA must be a pinned 40-character commit SHA')
    if not re.fullmatch(r'[1-9][0-9]{0,19}', env.get('BACKUP_STORE_ID', '')):
        errors.append('BACKUP_STORE_ID must be a pinned positive repository ID')
    require(not errors, 'Backup destination configuration: ' + '; '.join(errors) + '.')
    api = api_factory(STORAGE_REPOSITORY)
    private_repository(api, STORAGE_REPOSITORY, int(env['BACKUP_STORE_ID']))
    commit = api.api('git/commits/' + env['BACKUP_STORE_SHA'])
    require(commit.get('sha') == env['BACKUP_STORE_SHA'], 'Backup store commit mismatch.')


if __name__ == '__main__':
    check_store(os.environ)
    print('Private backup destination identity and pinned commit verified; no backup created.')
