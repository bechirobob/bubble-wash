import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldShowOpening } from '../src/lib/opening-intro.ts';
const base = { href: 'https://bubblewash.co/', navigationHref: 'https://bubblewash.co/', navigationType: 'navigate', reducedMotion: false, visible: true, alreadyPlayed: false };
test('fresh clean home and reload qualify', () => {
 assert.equal(shouldShowOpening(base), true);
 assert.equal(shouldShowOpening({...base, navigationType: 'reload'}), true);
});
for (const href of ['/book','/checkout','/early-access','/track','/manage','/?ref=survey','/#how-it-works','/services']) {
 test(`bypasses critical or deep entry ${href}`, () => assert.equal(shouldShowOpening({...base, href: 'https://bubblewash.co'+href}), false));
}
for (const patch of [
 {navigationType:'back_forward'}, {navigationType:undefined}, {navigationHref:undefined},
 {navigationHref:'https://bubblewash.co/book'}, {navigationHref:'https://bubblewash.co/?resume=1'},
 {navigationHref:'https://bubblewash.co/#how-it-works'}, {navigationHref:'https://example.com/'},
 {reducedMotion:true}, {visible:false}, {alreadyPlayed:true}, {href:'invalid'},
]) test(`fails closed ${JSON.stringify(patch)}`, () => assert.equal(shouldShowOpening({...base,...patch}), false));

for (const path of ['/survey', '/survey/', '/survey/consumer', '/survey/consumer-interview', '/survey/business-interview', '/survey/vendor-interview']) {
 test(`fresh survey entry qualifies ${path}`, () => {
  const href = 'https://bubblewash.co' + path;
  assert.equal(shouldShowOpening({...base, href, navigationHref: href}), true);
  assert.equal(shouldShowOpening({...base, href: href+'?source=invite#start', navigationHref: href+'?source=invite'}), true);
  assert.equal(shouldShowOpening({...base, href, navigationHref: href, navigationType: 'reload'}), true);
  for (const restriction of [{alreadyPlayed: true}, {reducedMotion: true}, {visible: false}, {navigationType: 'back_forward'}]) {
   assert.equal(shouldShowOpening({...base, href, navigationHref: href, ...restriction}), false);
  }
 });
}
for (const [initial, current] of [['/survey', '/survey/consumer'], ['/survey/consumer', '/survey/vendor-interview'], ['/', '/survey'], ['/track', '/survey/consumer']]) {
 test(`SPA transition never starts a new intro ${initial} to ${current}`, () => {
  assert.equal(shouldShowOpening({...base, href:'https://bubblewash.co'+current, navigationHref:'https://bubblewash.co'+initial}), false);
 });
}
for (const path of ['/survey/no-such-questionnaire', '/survey/consumer/step-2', '/survey-admin', '/api/research/responses']) {
 test(`unrecognized survey-adjacent path bypasses ${path}`, () => {
  const href='https://bubblewash.co'+path;
  assert.equal(shouldShowOpening({...base, href, navigationHref:href}), false);
 });
}
