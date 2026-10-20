#!/usr/bin/env python3
"""Read-only aggregate inventory. Never emits records, identities, or credentials."""
import json
import pathlib
import sqlite3
import sys
from urllib.parse import quote


def inventory(database_path):
    path = pathlib.Path(database_path)
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        raise ValueError('An existing absolute regular database path is required.')
    connection = sqlite3.connect('file:' + quote(str(path), safe='/') + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA query_only = ON')
        connection.execute('BEGIN')
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {}
        for name in tables:
            identifier = '"' + name.replace('"', '""') + '"'
            counts[name] = connection.execute('SELECT count(*) FROM ' + identifier).fetchone()[0]
        staff = {}
        if 'staff_accounts' in tables:
            # Emit only fixed role buckets, never arbitrary row data.
            for role in ('admin', 'vendor', 'driver', 'support'):
                staff[role] = connection.execute('SELECT count(*) FROM staff_accounts WHERE role = ?', (role,)).fetchone()[0]
            staff['other'] = connection.execute("SELECT count(*) FROM staff_accounts WHERE role NOT IN ('admin','vendor','driver','support') OR role IS NULL").fetchone()[0]
        return {'readOnly': True, 'tableCounts': counts, 'staffRoleCounts': staff,
                'integrityOk': connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok',
                'resetExecuted': False,
                'scope': 'Inventory only. Any separately approved fresh reset removes operational data and nonadmin staff, preserving admin authentication, service settings and infrastructure credentials. Historical archives are excluded.'}
    finally:
        connection.close()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: inventory-stale-data.py /absolute/database.sqlite')
    print(json.dumps(inventory(sys.argv[1]), sort_keys=True))
