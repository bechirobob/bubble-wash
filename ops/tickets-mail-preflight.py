import configparser
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request

report = {'readOnly': True}
report['os'] = {line.split('=', 1)[0]: line.split('=', 1)[1].strip('"') for line in Path('/etc/os-release').read_text().splitlines() if line.startswith(('ID=', 'VERSION_ID='))}
report['diskFreeGiB'] = round(shutil.disk_usage('/srv').free / (1024 ** 3), 1)
report['memoryGiB'] = round(int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))) / (1024 ** 2), 1)
report['tools'] = {tool: bool(shutil.which(tool)) for tool in ['python3', 'openssl', 'apt-get', 'caddy', 'postfix', 'opendkim']}
report['ovhConfiguration'] = []
for path in ['/root/.ovh.conf', '/home/ubuntu/.ovh.conf', '/etc/ovh.conf', '/root/.config/ovh/ovh.conf']:
    item = {'path': path, 'exists': Path(path).is_file()}
    if item['exists']:
        config = configparser.ConfigParser()
        config.read(path)
        item['sections'] = {section: list(config[section].keys()) for section in config.sections()}
    report['ovhConfiguration'].append(item)
report['workerSecretsManageable'] = False
fallback = Path('/etc/becore-tickets-fallback.env')
report['ticketsCloudflareConnection'] = fallback.is_file()
if fallback.is_file():
    values = dict(line.split('=', 1) for line in fallback.read_text().splitlines() if '=' in line)
    token = values.get('CLOUDFLARE_API_TOKEN')
    def api(path):
        req = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)['result']
    try:
        zone = api('/zones/' + values['CLOUDFLARE_ZONE_ID'])
        report['dnsConnection'] = {'zone': zone['name'], 'accountId': zone['account']['id']}
        records = api('/zones/' + zone['id'] + '/dns_records?name=mail.becoreops.com')
        report['mailHostRecords'] = [{'type': x['type'], 'content': x['content'], 'proxied': x.get('proxied')} for x in records]
        secrets = api('/accounts/' + zone['account']['id'] + '/workers/scripts/becore-tickets/secrets')
        report['workerSecretsManageable'] = isinstance(secrets, list)
    except Exception as error:
        report['cloudflareCheckError'] = type(error).__name__
        if hasattr(error, 'code'): report['cloudflareCheckStatus'] = error.code
print(json.dumps(report, indent=2))
