#!/usr/bin/env python3
"""Read only Caddy's local active HTTP routes. Never print configuration bodies."""
import json
import urllib.request

HOSTS = {'bubblewash.co', 'www.bubblewash.co', 'staff.bubblewash.co', '*.bubblewash.co'}
LIMIT = 2 * 1024 * 1024


def summarise(config):
    """Emit only known Bubble Wash host matches and bounded loopback upstreams."""
    rows = []
    def visit(value, inherited=()):
        if isinstance(value, list):
            for item in value: visit(item, inherited)
        elif isinstance(value, dict):
            matches = value.get('match', [])
            hosts = sorted({host for match in matches if isinstance(match, dict)
                            for host in match.get('host', []) if host in HOSTS}) or list(inherited)
            if value.get('handler') == 'reverse_proxy' and hosts:
                upstreams = value.get('upstreams', [])
                targets = []
                for upstream in upstreams:
                    dial = upstream.get('dial') if isinstance(upstream, dict) else None
                    targets.append(dial if dial in ('127.0.0.1:3000', 'localhost:3000', '[::1]:3000') else 'OTHER')
                rows.append({'hosts': hosts, 'targets': targets[:8],
                             'hostHeaderOverride': any(key.lower() == 'host' for key in value.get('headers', {}).get('request', {}).get('set', {})),
                             'upstreamCount': len(upstreams)})
            for key in ('routes', 'handle'):
                if key in value: visit(value[key], hosts)
            if 'servers' in value and isinstance(value['servers'], dict):
                for server in value['servers'].values(): visit(server, hosts)
    visit({'servers': config})
    if len(rows) > 20: raise ValueError('bounded route count exceeded')
    return {'ok': True, 'source': 'active-local-caddy', 'routes': rows,
            'staffRoutePresent': any(set(row['hosts']) & {'staff.bubblewash.co', '*.bubblewash.co'} for row in rows),
            'absenceIsNotProof': True,
            'configurationChanged': False}


def main():
    try:
        # Local-only admin read. No auth values or complete config leave the host.
        with urllib.request.urlopen('http://127.0.0.1:2019/config/apps/http/servers', timeout=5) as response:
            raw = response.read(LIMIT + 1)
        if len(raw) > LIMIT: raise ValueError('configuration too large')
        print(json.dumps(summarise(json.loads(raw)), sort_keys=True))
    except Exception:
        print('{"ok":false,"status":"active-route-unavailable","configurationChanged":false}')
        raise SystemExit(1)


if __name__ == '__main__': main()
