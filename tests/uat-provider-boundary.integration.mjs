import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bubblewash-uat-providers-'));
process.env.BUBBLEWASH_DATABASE_PATH = path.join(directory, 'synthetic.sqlite');
process.env.BUBBLEWASH_UAT_ENABLED = 'true';
// Deliberately unsafe config: last-mile UAT guards must still prevent egress.
Object.assign(process.env, {
  RESEND_API_KEY: 'synthetic', PAYSTACK_SECRET_KEY: 'synthetic', WHATSAPP_ACCESS_TOKEN: 'synthetic',
  WHATSAPP_PHONE_NUMBER_ID: 'synthetic', WHATSAPP_API_VERSION: 'v23.0', WHATSAPP_EARLY_ACCESS_TEMPLATE: 'synthetic',
  BUBBLEWASH_RESEARCH_EMAIL_ENABLED: 'true', BUBBLEWASH_RESEARCH_RESEND_KEY: 'synthetic',
  NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'true',
});
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('No external request allowed'); };
try {
  const payment = await import('../src/lib/payments.ts');
  assert.equal(payment.paystackConfigured(), false);
  await assert.rejects(payment.initializePaystackCheckout({}), /disabled in UAT/);
  await assert.rejects(payment.verifyPaystackCheckout('synthetic'), /disabled in UAT/);
  const research = await import('../src/lib/research/provider.ts');
  assert.equal(research.researchEmailReady(), false);
  assert.deepEqual(await research.createResearchTransport('synthetic')({}), { status: 'not-accepted', retryable: false });
  await assert.rejects(research.sendSyntheticResearchTest(null, 'synthetic', 'owner@example.invalid'), /disabled in UAT/);
  const notifications = await import('../src/lib/notifications.ts');
  await notifications.dispatchEarlyAccessConfirmation({ id: 'synthetic-uat', firstName: 'Synthetic', area: 'Synthetic Area', email: 'test@example.invalid', phone: '0200000000' });
  await notifications.processNotificationOutbox();
  assert.equal(calls, 0, 'no email, WhatsApp, research or payment egress');
  console.log('UAT provider boundary: zero external requests');
} finally {
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
}
