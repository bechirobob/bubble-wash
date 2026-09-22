"""Read-only mail feasibility checks. No messages, authentication or changes."""
import concurrent.futures
import json
import re
import shutil
import smtplib
import socket
import ssl
import subprocess
import urllib.parse
import urllib.request


def dns(name, kind):
    try:
        url = 'https://dns.google/resolve?' + urllib.parse.urlencode({'name': name, 'type': kind})
        with urllib.request.urlopen(url, timeout=7) as response:
            data = json.load(response)
        return {'status': data.get('Status'), 'answers': [a['data'] for a in data.get('Answer', [])]}
    except Exception as error:
        return {'error': type(error).__name__}


def smtp_probe(domain):
    result = {'recipient_provider': domain, 'message_sent': False}
    records = dns(domain, 'MX')
    choices = []
    for record in records.get('answers', []):
        parts = record.split()
        if len(parts) == 2 and parts[0].isdigit():
            choices.append((int(parts[0]), parts[1].rstrip('.')))
    if not choices:
        return {**result, 'mx_lookup': records}
    target = min(choices)[1]
    result['mx'] = target
    client = None
    try:
        client = smtplib.SMTP(host=target, port=25, timeout=8, local_hostname='tickets.becoreops.com')
        result['port_25'] = 'reachable'
        result['greeting_code'] = 220
        code, _ = client.ehlo()
        result['ehlo_code'] = code
        result['starttls_offered'] = client.has_extn('starttls')
        if client.has_extn('starttls'):
            code, _ = client.starttls(context=ssl.create_default_context())
            result['tls_code'] = code
        client.quit()
    except Exception as error:
        result['error'] = type(error).__name__
        if isinstance(error, OSError):
            result['errno'] = error.errno
        if isinstance(error, smtplib.SMTPResponseException):
            result['smtp_code'] = error.smtp_code
            result['smtp_reason'] = error.smtp_error.decode('utf-8', errors='replace')[:300]
    finally:
        if client is not None:
            client.close()
    return result


def service(name):
    result = subprocess.run(['systemctl', 'is-active', name], capture_output=True, text=True, timeout=5)
    return result.stdout.strip() or 'not-found'


report = {
    'read_only': True,
    'messages_sent': 0,
    'mail_commands': {name: bool(shutil.which(name)) for name in ['postfix', 'postconf', 'exim4', 'sendmail', 'opendkim', 'docker']},
    'mail_services': {name: service(name) for name in ['postfix', 'exim4', 'opendkim', 'stalwart', 'docker']},
}
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    futures = {executor.submit(dns, name, kind): label for label, name, kind in [
        ('vps_reverse_dns', '137.20.195.51.in-addr.arpa', 'PTR'),
        ('root_spf', 'becoreops.com', 'TXT'),
        ('root_dmarc', '_dmarc.becoreops.com', 'TXT'),
        ('mail_hostname', 'mail.becoreops.com', 'A'),
    ]}
    probes = [executor.submit(smtp_probe, domain) for domain in ['gmail.com', 'outlook.com', 'yahoo.com']]
    report['dns'] = {label: future.result() for future, label in futures.items()}
    report['smtp'] = [future.result() for future in probes]
for label, prefix in [('root_spf', 'v=spf1'), ('root_dmarc', 'v=DMARC1')]:
    if 'answers' in report['dns'][label]:
        report['dns'][label]['answers'] = [x for x in report['dns'][label]['answers'] if prefix in x]
ptr = report['dns']['vps_reverse_dns'].get('answers', [])
if ptr:
    report['dns']['reverse_name_forward_dns'] = dns(ptr[0].rstrip('.'), 'A')
listeners = subprocess.run(['ss', '-H', '-ltn'], capture_output=True, text=True, timeout=5)
report['smtp_listeners'] = [line.split()[3] for line in listeners.stdout.splitlines() if len(line.split()) > 3 and line.split()[3].rsplit(':', 1)[-1] in ['25', '465', '587']]
processes = subprocess.run(['ss', '-H', '-ltnp'], capture_output=True, text=True, timeout=5)
report['smtp_processes'] = []
for line in processes.stdout.splitlines():
    if len(line.split()) > 3 and line.split()[3].rsplit(':', 1)[-1] in ['25', '465', '587']:
        for name, pid in re.findall(r'\("([^\"]+)",pid=(\d+)', line):
            report['smtp_processes'].append({'name': name, 'pid': pid})
units = subprocess.run(['systemctl', 'list-units', '--all', '--type=service', '--no-legend', '--plain'], capture_output=True, text=True, timeout=5)
report['mail_service_units'] = [line.split()[0] for line in units.stdout.splitlines() if line.split() and any(word in line.split()[0].lower() for word in ['mail', 'smtp', 'relay'])]
if shutil.which('docker'):
    containers = subprocess.run(['docker', 'ps', '--format', '{{.Image}} {{.Ports}}'], capture_output=True, text=True, timeout=5)
    report['mail_containers'] = [line for line in containers.stdout.splitlines() if any(word in line.lower() for word in ['mail', 'postfix', 'exim', 'stalwart', ':587->', ':25->', ':465->'])]
print(json.dumps(report, indent=2))
