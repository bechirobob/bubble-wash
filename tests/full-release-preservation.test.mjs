import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('inherited retention never purges newly introduced worklist receipts or ownership', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bubblewash-full-retention-'));
  process.env.BUBBLEWASH_DATABASE_PATH = path.join(dir, 'synthetic.sqlite');
  const { automationDatabase } = await import('../src/lib/automation-store.ts');
  const { purgeOperationalData } = await import('../src/lib/data-store.ts');
  const db = automationDatabase();
  try {
    db.prepare('INSERT INTO operational_command_receipts VALUES (?,?,?,?,?)').run('synthetic', 'request', 'hash', '{}', '2020-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO operational_work_ownership VALUES (?,?,?,?,?,?,?)').run('item', 'synthetic@example.invalid', '2020-01-01', 'synthetic', 1, '2020-01-01', 'old-order');
    db.prepare('INSERT INTO submissions VALUES (?,?,?,?)').run('old-order', '2020-01-01T00:00:00.000Z', 'synthetic', JSON.stringify({ submissionType: 'pickup-booking' }));
    db.prepare('INSERT INTO submissions VALUES (?,?,?,?)').run('old-close', '2020-01-02T00:00:00.000Z', 'synthetic', JSON.stringify({ submissionType: 'admin-operation', actionType: 'Close order', orderId: 'old-order' }));
    const tables = ['operational_command_receipts', 'operational_work_ownership'];
    const before = tables.map(table => db.prepare(`SELECT rowid,* FROM ${table}`).all());
    const result = purgeOperationalData(Date.parse('2026-10-24T00:00:00.000Z'), '');
    assert.equal(result.closedOrderRecords, 2, 'the existing closed-order retention still runs');
    assert.deepEqual(tables.map(table => db.prepare(`SELECT rowid,* FROM ${table}`).all()), before);
    assert.equal(Object.hasOwn(result, 'operationalCommandReceipts'), false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
