#!/usr/bin/env python3
"""Read-only aggregate UAT host admission facts; no secrets, DB or service changes.
Run only on the existing authorized VPS. Output is evidence, not approval to deploy.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess


def bounded(command):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=5, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        if result.returncode or len(result.stdout) > 65536:
            return None
        return result.stdout.decode('utf-8', errors='strict')
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def inspect():
    result = {'schema': 'bubblewash-uat-capacity/v1', 'readOnly': True, 'deploymentApproved': False}
    mem = {}
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            key, value = line.split(':', 1)
            if key in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
                mem[key] = int(value.split()[0]) * 1024
    except (OSError, ValueError):
        pass
    result['memoryBytes'] = mem
    result['cpuCount'] = os.cpu_count()
    try:
        result['loadAverage'] = list(os.getloadavg())
    except OSError:
        result['loadAverage'] = None
    try:
        usage = shutil.disk_usage('/var/lib')
        result['varLibBytes'] = {'total': usage.total, 'free': usage.free}
    except OSError:
        result['varLibBytes'] = None
    sockets = bounded(['/usr/bin/ss', '-H', '-ltn'])
    ports = (3000, 3001, 3108)
    result['tcpListening'] = {str(port): None if sockets is None else any(
        len(line.split()) > 3 and line.split()[3].rsplit(':', 1)[-1] == str(port)
        for line in sockets.splitlines()) for port in ports}
    result['uatPathsAlreadyExist'] = {name: os.path.lexists(name) for name in (
        '/var/lib/bubblewash-uat', '/opt/bubblewash-uat', '/etc/bubblewash-uat')}
    try:
        pwd.getpwnam('bubblewash-uat')
        result['uatUserAlreadyExists'] = True
    except KeyError:
        result['uatUserAlreadyExists'] = False
    result['uatUnitState'] = bounded(['/usr/bin/systemctl', 'show', 'bubblewash-uat.service',
                                     '--property=LoadState,ActiveState,SubState'])
    # Only a digest of the fixed routing file is exposed; no contents/config values.
    caddy = Path('/etc/caddy/Caddyfile')
    try:
        info = caddy.lstat()
        if stat.S_ISREG(info.st_mode) and info.st_size <= 1048576:
            result['caddyFileSha256'] = hashlib.sha256(caddy.read_bytes()).hexdigest()
    except OSError:
        result['caddyFileSha256'] = None
    return result


if __name__ == '__main__':
    print(json.dumps(inspect(), sort_keys=True))
