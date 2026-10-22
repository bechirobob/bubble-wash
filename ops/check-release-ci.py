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
    for workflow in ('pilot-ci.yml', 'browser-regression.yml', 'backup-transport-checks.yml'):
        value = fetch(f'https://api.github.com/repos/{REPOSITORY}/actions/workflows/{workflow}/runs?head_sha={sha}&per_page=100')
        runs = [run for run in value.get('workflow_runs', []) if run.get('head_sha') == sha and run.get('event') in ('push', 'workflow_dispatch')]
        # Most recent matching main run must pass; an old success cannot hide a newer failure.
        runs.sort(key=lambda run: (run.get('run_number', 0), run.get('run_attempt', 0)), reverse=True)
        if not runs or not valid_run(runs[0], sha, workflow):
            raise ValueError('required exact-main CI is missing, pending, or failed: ' + workflow)


def fetch(url):
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'bubblewash-release-gate'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


if __name__ == '__main__':
    check(os.environ['TARGET_SHA'], fetch)
    print('All required exact-main release checks passed; no permissions were expanded.')
