import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertUatEnvironment, assertUatProviderTrafficDisabled } from '../src/lib/uat-environment.ts';

const root = mkdtempSync(path.join(tmpdir(), 'bubblewash-uat-environment-'));
const outside = mkdtempSync(path.join(tmpdir(), 'bubblewash-other-'));
const valid = {
  BUBBLEWASH_UAT_ENABLED: 'true', BUBBLEWASH_UAT_ISOLATION_CONFIRMED: 'true',
  BUBBLEWASH_PUBLIC_URL: 'https://uat.example.invalid',
  BUBBLEWASH_DATABASE_PATH: path.join(root, 'uat.sqlite'), BUBBLEWASH_UAT_DATA_ROOT: root,
  NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: 'false',
  NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'false',
  BUBBLEWASH_RESEARCH_EMAIL_ENABLED: 'false', BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true',
};

test('isolated explicit configuration is accepted, absent/malformed settings fail closed', () => {
  assert.doesNotThrow(() => assertUatEnvironment(valid));
  for (const key of Object.keys(valid)) assert.throws(() => assertUatEnvironment({ ...valid, [key]: '' }), /isolated UAT/);
  for (const BUBBLEWASH_PUBLIC_URL of ['https://bubblewash.co', 'https://staff.bubblewash.co', 'https://www.bubblewash.co.', 'http://uat.example.invalid', 'https://user:secret@uat.example.invalid', 'https://uat.example.invalid/path', 'https://uat.example.invalid/?token=secret']) {
    assert.throws(() => assertUatEnvironment({ ...valid, BUBBLEWASH_PUBLIC_URL }), /isolated UAT/);
  }
  assert.doesNotThrow(() => assertUatEnvironment({ ...valid, BUBBLEWASH_PUBLIC_URL: 'http://127.0.0.1:3000' }));
});

test('credential, provider flag, relative path, production path and symlink mistakes are rejected', () => {
  for (const key of ['PAYSTACK_SECRET_KEY', 'RESEND_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'BUBBLEWASH_RESEARCH_RESEND_KEY', 'BUBBLEWASH_OWNER_RESEND_KEY', 'NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL', 'NEXT_PUBLIC_BUBBLEWASH_WHATSAPP']) {
    assert.throws(() => assertUatEnvironment({ ...valid, [key]: 'synthetic-not-a-real-secret' }), /isolated UAT/);
  }
  for (const key of ['NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED', 'NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED', 'BUBBLEWASH_RESEARCH_EMAIL_ENABLED']) {
    assert.throws(() => assertUatEnvironment({ ...valid, [key]: 'true' }), /isolated UAT/);
  }
  for (const database of ['uat.sqlite', '/var/lib/bubblewash/bubblewash.sqlite', path.join(outside, 'outside.sqlite')]) {
    assert.throws(() => assertUatEnvironment({ ...valid, BUBBLEWASH_DATABASE_PATH: database }), /isolated UAT/);
  }
  writeFileSync(path.join(outside, 'outside.sqlite'), 'synthetic');
  symlinkSync(path.join(outside, 'outside.sqlite'), path.join(root, 'escape.sqlite'));
  assert.throws(() => assertUatEnvironment({ ...valid, BUBBLEWASH_DATABASE_PATH: path.join(root, 'escape.sqlite') }), /isolated UAT/);
});

test('UAT blocks provider calls even with an otherwise invalid configuration', () => {
  assert.throws(() => assertUatProviderTrafficDisabled({ BUBBLEWASH_UAT_ENABLED: 'true', RESEND_API_KEY: 'synthetic' }), /disabled in UAT/);
  assert.doesNotThrow(() => assertUatProviderTrafficDisabled({}));
});

test.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
