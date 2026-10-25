import test from 'node:test';
import { register } from 'node:module';
register('./alias-loader.mjs', import.meta.url);
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('synthetic invoices match each quoted pickup including fractional rounding and custom fee confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bubblewash-price-parity-'));
  process.env.BUBBLEWASH_DATABASE_PATH = join(directory, 'isolated.sqlite');
  const { appendSubmissionRecord, getDatabase } = await import('../src/lib/data-store.ts');
  const { freezePricing, issueIntakeInvoice } = await import('../src/lib/billing.ts');
  const { calculateQuote, plans, zones, addons } = await import('../src/lib/pricing.ts');
  let counter = 0;
  try {
    for (const plan of plans) for (const zone of Object.keys(zones)) {
      for (const selected of [[], ['ironing'], ['premium'], ['stain'], ['express'], ['premium', 'stain', 'express'], ['weekend'], ['extraPickup'], ['weekend', 'extraPickup'], ['premium', 'stain', 'express', 'weekend', 'extraPickup']]) {
        for (const kg of [plan.bands[0].min, 60.01, 100.03, 150.01]) {
          const id = `BW-PRICEPARITY${++counter}`;
          const quote = calculateQuote(plan.name, kg, selected, zone);
          appendSubmissionRecord({ id, createdAt: '2026-10-01T12:00:00.000Z', data: { submissionType: 'pickup-booking', email: `synthetic-${counter}@example.invalid`, company: 'Synthetic invoice parity', plan: plan.name, zone, addons: selected, pricingSnapshot: freezePricing(plan.name, zone) } });
          const confirmedRouteMinor = zone === 'custom' ? (counter % 2 ? 4200 : 0) : zones[zone].fee * 100;
          if (zone === 'custom') {
            assert.throws(() => issueIntakeInvoice(id, kg), /Confirm the custom route fee/);
            getDatabase().prepare('INSERT INTO order_route_fees (order_id, amount_minor, actor, note, created_at) VALUES (?, ?, ?, ?, ?)').run(id, confirmedRouteMinor, 'synthetic', 'synthetic confirmed route', '2026-10-01T12:00:00.000Z');
          }
          const invoice = issueIntakeInvoice(id, kg);
          const actualPickup = Math.max(45000, Math.round(quote.processingPerPickup * 100) + Math.round(quote.addonsPerPickup * 100) + confirmedRouteMinor + selected.reduce((sum, key) => sum + ('fixed' in addons[key] ? addons[key].fixed * 100 : 0), 0));
          assert.equal(invoice.totalMinor, quote.subscription * 100 + actualPickup, `${plan.name}, ${zone}, ${kg}, ${selected}`);
        }
      }
    }
  } finally { getDatabase().close(); rmSync(directory, { recursive: true, force: true }); }
});
