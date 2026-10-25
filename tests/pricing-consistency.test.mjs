import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote, plans, zones, addons } from '../src/lib/pricing.ts';

test('fractional processing and express use invoice minor-unit rounding', () => {
  const quote = calculateQuote('Weekly', 60.01);
  assert.equal(quote.processingPerPickup, 930.16);
  assert.equal(quote.estimatedMonthlyTotal, 4970.64);
  for (const plan of plans) for (const band of plan.bands) {
    for (const kg of [band.min, band.min + .01, band.min + .03, band.min + .5]) {
      for (const zone of Object.keys(zones)) for (const selected of [[], ['ironing'], ['premium'], ['stain'], ['express'], ['ironing', 'stain', 'express'], ['premium', 'stain', 'express']]) {
        const q = calculateQuote(plan.name, kg, selected, zone);
        const processing = Math.round(kg * q.ratePerKg * 100);
        const extras = selected.reduce((sum, key) => {
          const item = addons[key];
          return sum + Math.round('perKg' in item ? kg * item.perKg * 100 : processing * item.percent);
        }, 0);
        const pickup = Math.max(45000, processing + extras + zones[zone].fee * 100);
        assert.equal(Math.round(q.perPickupTotal * 100), pickup);
        assert.equal(Math.round(q.estimatedMonthlyTotal * 100), plan.subscription * 100 + plan.monthlyPickups * pickup);
        assert.equal(q.routeFeePending, zone === 'custom');
      }
    }
  }
});

test('plan rates, minimums, monthly caps and core route remain unchanged', () => {
  assert.deepEqual(plans.map(p => [p.subscription, p.monthlyPickups]), [[1250,4],[2250,8],[3250,12],[4750,22]]);
  assert.equal(zones.core.fee, 0);
  assert.equal(calculateQuote('Weekly',20).estimatedMonthlyTotal,3050);
  for (const plan of plans) {
    assert.throws(() => calculateQuote(plan.name, plan.bands[0].min - .01));
    for (const [index, band] of plan.bands.entries()) {
      assert.equal(calculateQuote(plan.name,band.min).ratePerKg,band.rate);
      if (index) assert.equal(calculateQuote(plan.name,band.min-.01).ratePerKg,plan.bands[index-1].rate);
    }
  }
  assert.throws(() => calculateQuote('Weekly',60,['premium','ironing']));
});

test('occasional services are excluded, never multiplied or assumed to be extra loads', () => {
  for (const plan of plans) for (const zone of Object.keys(zones)) {
    for (const kg of [plan.bands[0].min, 60.01, 150.03]) {
      for (const recurring of [[], ['ironing'], ['premium'], ['stain'], ['express'], ['premium', 'stain', 'express']]) {
        const base = calculateQuote(plan.name, kg, recurring, zone);
        for (const occasional of [['weekend'], ['extraPickup'], ['weekend', 'extraPickup']]) {
          const quote = calculateQuote(plan.name, kg, [...recurring, ...occasional], zone);
          assert.equal(quote.estimatedMonthlyTotal, base.estimatedMonthlyTotal);
          assert.equal(quote.perPickupTotal, base.perPickupTotal);
          assert.deepEqual(quote.addonLines, base.addonLines);
          assert.deepEqual(quote.occasionalLines.map(line => [line.key, line.fee]), occasional.map(key => [key, addons[key].fixed]));
        }
      }
    }
  }
});
