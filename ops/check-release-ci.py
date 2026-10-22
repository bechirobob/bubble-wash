#!/usr/bin/env python3
"""Read public run metadata only. No new token permissions, auth grants or writes."""
import json
import os
import re
import urllib.request

REPOSITORY = 'bechirobob/bubble-wash'


def valid_run(run, sha, workflow):
    return (run.get('head_sha') == sha and run.get('head_branch') == 'main' and
            run.get('head_repository', {}).get('full_name') == REPOSITORY and
            run.get('event') in ('push', 'workflow_dispatch') and
            run.get('path') == '.github/workflows/' + workflow and
            run.get('status') == 'completed' and run.get('conclusion') == 'success')


def check(sha, fetch):
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('full candidate SHA required')
    # Do not filter status/event: a newer pending or failed run must remain visible.
    # Fetch the supported repository collection, then select exact workflow paths.
    all_runs = []
    seen = set()
    total = None
    for page in range(1, 11):
        value = fetch(f'https://api.github.com/repos/{REPOSITORY}/actions/runs?head_sha={sha}&per_page=100&page={page}')
        count = value.get('total_count') if isinstance(value, dict) else None
        batch = value.get('workflow_runs') if isinstance(value, dict) else None
        if type(count) is not int or not 0 <= count <= 1000 or not isinstance(batch, list) or len(batch) > 100:
            raise ValueError('incomplete or unsupported repository CI listing')
        if total is None:
            total = count
        if count != total:
            raise ValueError('repository CI listing changed during pagination')
        for run in batch:
            run_id = run.get('id') if isinstance(run, dict) else None
            if type(run_id) is not int or run_id <= 0 or run_id in seen:
                raise ValueError('invalid or repeated CI run during pagination')
            # Validate identity before filtering: a partially fetched newer failure
            # must not disappear merely because its SHA/path/event is missing.
            if (not isinstance(run.get('head_sha'), str) or
                    not re.fullmatch(r'[a-f0-9]{40}', run['head_sha']) or
                    any(not isinstance(run.get(key), str) or not run[key]
                        for key in ('head_branch', 'path', 'event', 'status')) or
                    not isinstance(run.get('head_repository'), dict) or
                    not isinstance(run['head_repository'].get('full_name'), str) or
                    not run['head_repository']['full_name'] or
                    any(type(run.get(key)) is not int or run[key] <= 0
                        for key in ('run_number', 'run_attempt')) or
                    'conclusion' not in run or
                    (run['conclusion'] is not None and not isinstance(run['conclusion'], str))):
                raise ValueError('repository CI run metadata is incomplete')
            seen.add(run_id)
            all_runs.append(run)
        if len(all_runs) > total:
            raise ValueError('repository CI listing exceeds declared count')
        if len(all_runs) == total:
            break
        if len(batch) != 100:
            raise ValueError('repository CI listing ended before declared count')
    else:
        raise ValueError('repository CI pagination limit reached')

    for workflow in ('pilot-ci.yml', 'browser-regression.yml', 'backup-transport-checks.yml'):
        runs = [run for run in all_runs if run.get('head_sha') == sha and
                run.get('path') == '.github/workflows/' + workflow and
                run.get('event') in ('push', 'workflow_dispatch')]
        if len({(run['run_number'], run['run_attempt']) for run in runs}) != len(runs):
            raise ValueError('required CI run ordering is ambiguous: ' + workflow)
        # Most recent matching run must pass identity checks as well as success;
        # an old success cannot hide a newer failure, rerun, fork or branch mismatch.
        runs.sort(key=lambda run: (run['run_number'], run['run_attempt']), reverse=True)
        if not runs or not valid_run(runs[0], sha, workflow):
            raise ValueError('required exact-main CI is missing, pending, or failed: ' + workflow)


def fetch(url):
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'bubblewash-release-gate'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


if __name__ == '__main__':
    check(os.environ['TARGET_SHA'], fetch)
    print('All required exact-main release checks passed; no permissions were expanded.')

