import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { readOwnerInput, runSyntheticResearchTest } from '../scripts/send-synthetic-research-test.mjs';

const schema = fs.readFileSync(new URL('../db/proposed/research-v1.sql', import.meta.url), 'utf8');
const ownerEmail = 'synthetic-owner@example.invalid';
const input = (value = { ownerEmail }) => Readable.from([JSON.stringify(value)]);
function fixture(t, ddl = schema) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-operator-'));
  const databasePath = path.join(dir, 'existing.sqlite');
  const db = new Database(databasePath);
  db.exec(ddl);
  db.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { databasePath, env: { NODE_ENV: 'production', BUBBLEWASH_DATABASE_PATH: databasePath, BUBBLEWASH_RESEARCH_RESEND_KEY: 'synthetic-key' } };
}
const refusedTransport = async () => { throw new Error('Network is forbidden in this test.'); };
const run = (options) => runSyntheticResearchTest({ mode: '--send', input: input(), send: refusedTransport, ...options });

test('private input is bounded, single-recipient JSON only, with timeout', async () => {
  assert.equal(await readOwnerInput(input()), ownerEmail);
  for (const value of [null, [], {}, { ownerEmail, cc: 'extra@example.invalid' }, { ownerEmail: 'a@example.invalid,b@example.invalid' }, { ownerEmail: 'a@example.invalid\r\n' }, { ownerEmail: 'x'.repeat(255) }]) {
    await assert.rejects(readOwnerInput(input(value)));
  }
  await assert.rejects(readOwnerInput(Readable.from([' '.repeat(1025)])));
  const terminal = input(); terminal.isTTY = true;
  await assert.rejects(readOwnerInput(terminal));
  await assert.rejects(readOwnerInput(new PassThrough(), 5));
});

test('check is read-only and never imports or sends via the provider', async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.databasePath);
  assert.deepEqual(await run({ ...f, mode: '--check' }), { attempted: false, status: 'ready' });
  assert.deepEqual(fs.readFileSync(f.databasePath), before);
});

test('missing database, schema drift, unexpected trigger and foreign-key damage block before any send', async (t) => {
  for (const ddl of ['', schema.replace('DEFAULT 0', 'DEFAULT 1'), schema + "CREATE TRIGGER unexpected AFTER INSERT ON research_responses BEGIN SELECT 1; END;", schema + "PRAGMA foreign_keys=OFF; INSERT INTO research_notification_outbox(response_id) VALUES('missing');"]) {
    const f = fixture(t, ddl);
    let calls = 0;
    assert.deepEqual(await run({ ...f, send: async () => { calls++; } }), { attempted: false, status: 'blocked' });
    assert.equal(calls, 0);
  }
  const f = fixture(t);
  fs.unlinkSync(f.databasePath);
  assert.deepEqual(await run(f), { attempted: false, status: 'blocked' });
  assert.equal(fs.existsSync(f.databasePath), false);
});

test('production, exact installed database and dedicated installed key are required', async (t) => {
  const f = fixture(t);
  const other = fixture(t);
  for (const env of [ { ...f.env, NODE_ENV: 'development' }, { ...f.env, BUBBLEWASH_DATABASE_PATH: other.databasePath }, { ...f.env, BUBBLEWASH_RESEARCH_RESEND_KEY: '', BUBBLEWASH_OWNER_RESEND_KEY: 'not-permitted' }, { ...f.env, BUBBLEWASH_RESEARCH_RESEND_KEY: 'bad\nkey' } ]) {
    assert.deepEqual(await run({ ...f, env }), { attempted: false, status: 'blocked' });
  }
  assert.deepEqual(await run({ ...f, databasePath: 'relative.sqlite' }), { attempted: false, status: 'blocked' });
  assert.deepEqual(await run({ ...f, mode: '--retry' }), { attempted: false, status: 'blocked' });
});

test('real helper saves first, targets fixed To and private owner CC, and never resends', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const send = async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.resend.com/emails');
    const db = new Database(f.databasePath, { readonly: true, fileMustExist: true });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM research_responses').get().n, 1);
    assert.deepEqual(db.prepare('SELECT state,attempts FROM research_notification_outbox').get(), { state: 'sending', attempts: 1 });
    assert.doesNotMatch(db.prepare('SELECT payload FROM research_responses').get().payload, /synthetic-owner/);
    db.close();
    const body = JSON.parse(request.body);
    assert.deepEqual(body.to, ['info@bubblewash.co']);
    assert.deepEqual(body.cc, [ownerEmail]);
    assert.match(body.subject, /^\[TEST ONLY\]/);
    assert.match(body.text, /TEST ONLY — SYNTHETIC/);
    return Response.json({ id: 'synthetic-provider-id' });
  };
  assert.deepEqual(await run({ ...f, send }), { attempted: true, status: 'accepted' });
  assert.deepEqual(await run({ ...f, send }), { attempted: false, status: 'already-attempted' });
  assert.deepEqual(await run({ ...f, mode: '--check', send }), { attempted: false, status: 'already-attempted' });
  assert.equal(calls, 1);
});

test('uncertain and rejected provider outcomes consume the attempt permanently', async (t) => {
  for (const outcome of ['throw', 429, 500]) {
    const f = fixture(t);
    let calls = 0;
    const send = async () => { calls++; if (outcome === 'throw') throw new Error('secret-private-provider-error'); return new Response('{}', { status: outcome }); };
    assert.deepEqual(await run({ ...f, send }), { attempted: true, status: 'review-required' });
    assert.deepEqual(await run({ ...f, send }), { attempted: false, status: 'already-attempted' });
    assert.equal(calls, 1);
  }
});

test('post-send persistence failure is unknown, not a false no-attempt result', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const send = async () => {
    calls++;
    const db = new Database(f.databasePath);
    db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON research_notification_outbox BEGIN SELECT RAISE(FAIL, 'sensitive-detail'); END;");
    db.close();
    return Response.json({ id: 'synthetic-provider-id' });
  };
  assert.deepEqual(await run({ ...f, send }), { attempted: null, status: 'review-required' });
  const db = new Database(f.databasePath); db.exec('DROP TRIGGER fail_update'); db.close();
  assert.deepEqual(await run({ ...f, send }), { attempted: false, status: 'already-attempted' });
  assert.equal(calls, 1);
});

test('CLI rejects arbitrary flags and prints no private values or error details', (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['--conditions=react-server', '--experimental-strip-types', '--experimental-loader=./tests/alias-loader.mjs', 'scripts/send-synthetic-research-test.mjs', '--send', '--database', f.databasePath, '--owner', ownerEmail], { cwd: process.cwd(), env: { ...process.env, ...f.env }, input: JSON.stringify({ ownerEmail }), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { attempted: false, status: 'blocked' });
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-owner|synthetic-key/);
});

test('two concurrent operator invocations share the durable single attempt', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const send = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ id: 'synthetic-concurrent-id' });
  };
  const results = await Promise.all([run({ ...f, send }), run({ ...f, send })]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.status).sort(), ['accepted', 'already-attempted']);
});

test('CLI read-only check and invalid input expose only coarse output; wrong cwd blocks', (t) => {
  const f = fixture(t);
  const args = ['--conditions=react-server', '--experimental-strip-types', '--experimental-loader=./tests/alias-loader.mjs', 'scripts/send-synthetic-research-test.mjs', '--check', '--database', f.databasePath];
  for (const [privateInput, status] of [[JSON.stringify({ ownerEmail }), 'ready'], ['sensitive-invalid-json', 'blocked']]) {
    const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...f.env }, input: privateInput, encoding: 'utf8' });
    assert.equal(result.status, status === 'ready' ? 0 : 1);
    assert.deepEqual(JSON.parse(result.stdout), { attempted: false, status });
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-owner|synthetic-key|sensitive-invalid-json/);
  }
  const result = spawnSync(process.execPath, [path.resolve('scripts/send-synthetic-research-test.mjs'), '--check', '--database', f.databasePath], { cwd: path.dirname(f.databasePath), env: { ...process.env, ...f.env }, input: JSON.stringify({ ownerEmail }), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { attempted: false, status: 'blocked' });
});
