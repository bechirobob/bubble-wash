#!/usr/bin/env python3
"""Publish encrypted backups only, then independently download/hash before receipt.

Uses a destination-only credential from a main-restricted environment. Never overwrites/deletes a release or asset, never
loads an encryption key, and never expires/prunes old backups. Failed attempts
retain their private draft for inspection. Reruns use a distinct attempt tag.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import tempfile
import time
from urllib.parse import quote

SCHEMA = 'becore-encrypted-backup-release/v2'
STORAGE_REPOSITORY = 'bechirobob/becore-backups'
PROJECTS = {'tickets': ('bechirobob/tickets', r'tickets-[0-9TZ.:-]+\.tar\.gz\.enc'),
            'bubblewash': ('bechirobob/bubble-wash', r'bubblewash-[0-9TZ.:-]+\.sqlite\.enc')}
MAX_SIZE = 2 * 1024 ** 3 - 1


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def context(env):
    project = env['BACKUP_PROJECT']
    require(project in PROJECTS, 'Unsupported backup project.')
    repository, pattern = PROJECTS[project]
    require(env['GITHUB_REPOSITORY'] == repository, 'Unexpected repository.')
    require(env['GITHUB_REF'] == 'refs/heads/main', 'Only main may publish backups.')
    require(env['GITHUB_EVENT_NAME'] in ('schedule', 'workflow_dispatch'), 'Unexpected backup event.')
    require(re.fullmatch(r'[a-f0-9]{40}', env['GITHUB_SHA']), 'Exact source SHA required.')
    for field in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        require(re.fullmatch(r'[1-9][0-9]{0,19}', env[field]), 'Positive bounded run identity required.')
    require(re.fullmatch(r'[a-f0-9]{40}', env.get('BACKUP_STORE_SHA', '')), 'Pinned backup-store SHA required.')
    require(re.fullmatch(r'[1-9][0-9]{0,19}', env.get('BACKUP_STORE_ID', '')), 'Pinned backup-store repository ID required.')
    path = Path(env['BACKUP_PATH'])
    require(path.is_absolute() and re.fullmatch(pattern, path.name), 'Invalid encrypted backup path.')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_SIZE, 'Backup must be a bounded nonempty regular file.')
    magic = b'BCTBACKUP1' if project == 'tickets' else b'BWBACKUP1'
    with path.open('rb') as handle:
        header = handle.read(len(magic))
    require(info.st_size > len(magic) + 28 and header == magic, 'Encrypted backup format marker is invalid.')
    return {'project': project, 'repository': repository, 'path': path,
            'storageRepository': STORAGE_REPOSITORY, 'storageSha': env['BACKUP_STORE_SHA'],
            'storageId': int(env['BACKUP_STORE_ID']),
            'sourceSha': env['GITHUB_SHA'], 'runId': env['GITHUB_RUN_ID'],
            'runAttempt': env['GITHUB_RUN_ATTEMPT'],
            'tag': f"{project}-encrypted-backup-{env['GITHUB_RUN_ID']}-{env['GITHUB_RUN_ATTEMPT']}"}


class GitHub:
    def __init__(self, repository):
        require(bool(os.environ.get('GH_TOKEN')), 'The destination-only backup token is required.')
        self.repository = repository
        self.env = dict(os.environ, GH_HOST='github.com', GH_PROMPT_DISABLED='1',
                        GH_PAGER='cat', GH_DEBUG='', NO_COLOR='1')
        self.env.pop('GH_FORCE_TTY', None)
        # New gh versions require this flag for arbitrary encrypted binary bytes.
        help_result = subprocess.run(['gh', 'api', '--help'], capture_output=True,
                                     env=self.env, timeout=20, check=True)
        self.binary_flags = ['--allow-escape-sequences'] if b'--allow-escape-sequences' in help_result.stdout else []

    def command(self, args, data=None):
        result = subprocess.run(['gh', *args], input=data, capture_output=True,
                                env=self.env, timeout=180, check=False)
        require(result.returncode == 0, 'GitHub API operation failed; no uncertain mutation is retried.')
        require(len(result.stdout) < 4 * 1024 ** 2, 'Unexpectedly large API response.')
        return json.loads(result.stdout)

    def api(self, suffix='', method='GET', payload=None):
        require(re.fullmatch(r'[A-Za-z0-9_./?-]*', suffix) and '..' not in suffix, 'Invalid API suffix.')
        args = ['api', '--hostname', 'github.com', '--method', method,
                '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28',
                f'repos/{self.repository}/{suffix}'.rstrip('/')]
        if payload is not None:
            args += ['--input', '-']
        return self.command(args, None if payload is None else canonical(payload))

    def upload(self, release_id, path):
        require(type(release_id) is int and release_id > 0, 'Invalid release ID.')
        # Fixed host and locally generated name, never an API-provided upload URL.
        endpoint = f'https://uploads.github.com/repos/{self.repository}/releases/{release_id}/assets?name={quote(path.name, safe="")}'
        return self.command(['api', '--method', 'POST', '-H', 'Content-Type: application/octet-stream',
                             '-H', 'Accept: application/vnd.github+json', '--input', str(path), endpoint])

    def download(self, asset_id, target, expected_size):
        require(type(asset_id) is int and asset_id > 0 and 0 < expected_size <= MAX_SIZE, 'Invalid asset identity.')
        args = ['gh', 'api', *self.binary_flags, '--hostname', 'github.com', '--method', 'GET',
                '-H', 'Accept: application/octet-stream',
                f'repos/{self.repository}/releases/assets/{asset_id}']
        with target.open('xb') as output, tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors, env=self.env)
            started, count = time.monotonic(), 0
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        require(time.monotonic() - started < 180, 'Asset download exceeded deadline.')
                        events = selector.select(timeout=1)
                        if not events:
                            continue
                        block = os.read(process.stdout.fileno(), 65536)
                        if not block:
                            break
                        count += len(block)
                        require(count <= expected_size, 'Asset download exceeds expected size.')
                        output.write(block)
                require(process.wait(timeout=10) == 0 and count == expected_size, 'Incomplete asset download.')
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        target.chmod(0o600)


def private_repository(api, repository, repository_id):
    data = api.api()
    require(data.get('private') is True and data.get('visibility') == 'private'
            and data.get('full_name') == repository and data.get('id') == repository_id, 'Repository must remain private.')


def validate_release(data, ctx, expected, draft):
    require(type(data.get('id')) is int and data['id'] > 0, 'Invalid release ID.')
    require(data.get('tag_name') == ctx['tag'] and data.get('target_commitish') == ctx['storageSha'], 'Release identity mismatch.')
    require(data.get('draft') is draft and data.get('prerelease') is True, 'Unexpected release visibility/state.')
    assets = data.get('assets', [])
    require(len(assets) == len(expected), 'Unexpected or missing release assets.')
    seen = set()
    for asset in assets:
        name = asset.get('name')
        require(name in expected and name not in seen, 'Unexpected or duplicate asset.')
        seen.add(name)
        size, sha256 = expected[name]
        require(asset.get('state') == 'uploaded' and asset.get('size') == size, 'Incomplete uploaded asset.')
        require(asset.get('content_type') == 'application/octet-stream', 'Unexpected asset content type.')
        require(asset.get('digest') == 'sha256:' + sha256, 'GitHub asset digest mismatch.')
        require(type(asset.get('id')) is int and asset['id'] > 0, 'Invalid asset ID.')
    return assets


def publish(ctx, api, work):
    private_repository(api, ctx['storageRepository'], ctx['storageId'])
    path = ctx['path']
    archive_hash = digest(path)
    checksum = work / (path.name + '.sha256')
    with checksum.open('xb') as handle:
        handle.write(f'{archive_hash}  {path.name}\n'.encode())
    checksum.chmod(0o600)
    expected = {item.name: (item.stat().st_size, digest(item)) for item in (path, checksum)}
    body = f"Source: {ctx['repository']} at {ctx['sourceSha']}.\nEncrypted backup only. Run {ctx['runId']} attempt {ctx['runAttempt']}.\nSHA-256: {archive_hash}\nNo automatic expiry; retention requires a separately approved policy.\n"
    release = api.api('releases', 'POST', {'tag_name': ctx['tag'], 'target_commitish': ctx['storageSha'],
                       'name': ctx['tag'], 'body': body, 'draft': True, 'prerelease': True, 'make_latest': 'false'})
    release_id = release['id']
    require(type(release_id) is int and release_id > 0, 'Invalid created release ID.')
    for item in (path, checksum):
        api.upload(release_id, item)
    release = api.api(f'releases/{release_id}')
    assets = validate_release(release, ctx, expected, True)
    for asset in assets:
        target = work / ('download-' + asset['name'])
        api.download(asset['id'], target, asset['size'])
        require(digest(target) == expected[asset['name']][1], 'Downloaded asset hash mismatch; no receipt recorded.')
    require((work / ('download-' + checksum.name)).read_bytes() == checksum.read_bytes(), 'Downloaded checksum mismatch.')
    private_repository(api, ctx['storageRepository'], ctx['storageId'])
    published = api.api(f'releases/{release_id}', 'PATCH', {'draft': False, 'make_latest': 'false'})
    published_assets = validate_release(published, ctx, expected, False)
    require({a['name']: a['id'] for a in published_assets} == {a['name']: a['id'] for a in assets}, 'Published assets changed.')
    require(published.get('published_at'), 'Release is not published.')
    private_repository(api, ctx['storageRepository'], ctx['storageId'])
    receipt = {'schema': SCHEMA, 'repository': ctx['repository'], 'storageRepository': ctx['storageRepository'],
               'storageRepositoryId': ctx['storageId'], 'storageSha': ctx['storageSha'], 'filename': path.name,
               'runId': ctx['runId'], 'runAttempt': ctx['runAttempt'], 'sourceSha': ctx['sourceSha'],
               'encrypted': True, 'restoreTested': True, 'downloadVerified': True,
               'sha256': archive_hash, 'size': expected[path.name][0], 'storage': 'private-github-release',
               'retentionDays': None, 'automaticExpiry': False, 'releaseTag': ctx['tag'],
               'releaseId': release_id, 'releaseUrl': f"https://github.com/{ctx['storageRepository']}/releases/tag/{ctx['tag']}",
               'verifiedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'assets': [{'name': a['name'], 'id': a['id'], 'sha256': expected[a['name']][1], 'size': a['size']} for a in assets]}
    return receipt


def main():
    ctx = context(os.environ)
    with tempfile.TemporaryDirectory(prefix='verified-backup-', dir=os.environ['RUNNER_TEMP']) as directory:
        receipt = publish(ctx, GitHub(ctx['storageRepository']), Path(directory))
    target = Path(os.environ['RUNNER_TEMP']) / 'offhost-release-receipt.json'
    with target.open('xb') as handle:
        handle.write(canonical(receipt))
    target.chmod(0o600)
    print('BECORE_BACKUP_RELEASE_RECEIPT ' + canonical(receipt).decode().strip())


if __name__ == '__main__':
    main()
