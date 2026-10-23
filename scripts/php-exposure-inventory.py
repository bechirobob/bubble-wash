#!/usr/bin/env python3
"""Read-only host metadata, not a vulnerability verdict. No app/config/log reads."""
import json
import re
import subprocess
from pathlib import Path

PHP = re.compile(r'(?:php(?:[0-9]+(?:\.[0-9]+)?)?(?:-[a-z0-9.+-]+)?|libapache2-mod-php[0-9.]*)')
PROCESS = re.compile(r'php(?:-fpm)?(?:[0-9]+(?:\.[0-9]+)?)?')
UNIT = re.compile(r'(?:php[0-9.]*-fpm|apache2|nginx|httpd)\.service')
VERSION = re.compile(r'[0-9][A-Za-z0-9.+:~_-]{0,99}')

def command(args):
    # Fixed commands only. Do not print stderr, invoke a shell, or execute PHP.
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=10, check=True,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
    if len(result.stdout) > 1024 * 1024:
        raise ValueError('output bound exceeded')
    return result.stdout

def packages(raw):
    result = []
    for line in raw.splitlines():
        parts = line.split('\t')
        if len(parts) != 3:
            continue
        name, version, status = parts
        name = name.split(':')[0]
        if status == 'installed' and PHP.fullmatch(name) and VERSION.fullmatch(version):
            result.append({'name': name, 'version': version})
    return sorted(result, key=lambda item: item['name'])

def services(raw):
    result = []
    for line in raw.splitlines():
        fields = line.split()
        if len(fields) >= 4 and UNIT.fullmatch(fields[0]):
            result.append({'name': fields[0], 'active': fields[2] == 'active'})
    return sorted(result, key=lambda item: item['name'])

def listeners(raw):
    result = {'phpTcpListenerCount': 0, 'phpNonLoopbackTcpListenerCount': 0,
              'phpLoopbackTcpListenerCount': 0, 'phpUnknownBindingCount': 0}
    for line in raw.splitlines():
        # ss -H -ltnp: state recv-q send-q local peer process metadata.
        fields = line.split()
        if len(fields) < 6 or not any(PROCESS.fullmatch(name) for name in re.findall(r'\("([^"\n]+)",pid=', line)):
            continue
        result['phpTcpListenerCount'] += 1
        address = fields[3].rsplit(':', 1)[0].strip('[]')
        if address == '::1' or address.startswith('127.'):
            result['phpLoopbackTcpListenerCount'] += 1
        elif address == '*' or re.fullmatch(r'[0-9a-fA-F:.%]+', address):
            result['phpNonLoopbackTcpListenerCount'] += 1
        else:
            result['phpUnknownBindingCount'] += 1
    return result

def processes():
    count, unreadable, vanished, seen, truncated = 0, 0, 0, 0, 0
    limit_reached = False
    try:
        for item in Path('/proc').glob('[0-9]*/comm'):
            if seen >= 65536:
                limit_reached = True
                break
            seen += 1
            try:
                with item.open() as handle:
                    name = handle.read(64).rstrip('\n')
                # Linux comm is task-controlled and limited to 15 bytes; names
                # at that boundary may be truncated. Never infer executable identity.
                truncated += len(name.encode('utf-8')) >= 15
                count += bool(PROCESS.fullmatch(name))
            except FileNotFoundError:
                vanished += 1
            except (OSError, UnicodeError):
                unreadable += 1
        if not seen:
            return {'inspected': False, 'noProcessEntriesSeen': True}
        return {'inspected': True, 'phpNamedCount': count,
                'entriesSeen': seen, 'unreadableCount': unreadable,
                'vanishedCount': vanished, 'possiblyTruncatedNameCount': truncated,
                'entryLimitReached': limit_reached, 'executableIdentityVerified': False,
                'coverageComplete': False}
    except Exception:
        return {'inspected': False}

def collect():
    report = {'schema': 'php-exposure-inventory/v1', 'readOnly': True,
              'limits': {'routingVerified': False, 'containersInspected': False,
                         'customInstallationsInspected': False, 'apacheEmbeddedModulesVerified': False,
                         'unixSocketsInspected': False, 'distroBackportsVerified': False,
                         'externalReachabilityVerified': False, 'phpRuntimeExecuted': False,
                         'noPhpDetectedDoesNotProveAbsence': True}}
    for key, args, parser in [
        ('packages', ['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${db:Status-Status}\n'], packages),
        ('services', ['systemctl', 'list-units', '--type=service', '--all', '--no-legend', '--plain', '--no-pager'], services),
        ('tcpListeners', ['ss', '-H', '-ltnp'], listeners),
    ]:
        try:
            report[key] = {'inspected': True, 'result': parser(command(args))}
        except Exception:
            report[key] = {'inspected': False}
    report['processes'] = processes()
    return report

if __name__ == '__main__':
    try:
        print(json.dumps(collect(), sort_keys=True))
    except Exception:
        print('{"schema":"php-exposure-inventory/v1","inspectionFailed":true}')
        raise SystemExit(1)
